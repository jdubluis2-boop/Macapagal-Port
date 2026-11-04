import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT } from 'jose';
import { z } from 'zod';
import type { User } from '@prisma/client';
import type { AppContext } from './context.js';
import { config } from './config.js';
const fail=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode});
const provider=z.enum(['google','facebook']);
const configured=(p:string)=>!!(config.OAUTH_CALLBACK_ORIGIN&&(p==='google'?config.GOOGLE_CLIENT_ID&&config.GOOGLE_CLIENT_SECRET:config.FACEBOOK_CLIENT_ID&&config.FACEBOOK_CLIENT_SECRET));
async function jsonRequest(url:string, init?:RequestInit) {
 const response=await fetch(url,{...init,signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw fail(502,'Identity provider request failed. Please try again.');
 return await response.json() as Record<string,unknown>;
}
export function registerOAuthRoutes(app:FastifyInstance,ctx:AppContext,sendVerification:(user:{id:string;email:string})=>Promise<void>){
 app.get('/auth/oauth/config',async()=>({google:configured('google'),facebook:configured('facebook')}));
 app.get('/auth/oauth/:provider/start',async(req,reply)=>{
  const p=provider.parse((req.params as{provider:string}).provider);
  if(!configured(p))throw fail(503,'This sign-in provider is not configured');
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
  let linkUserId:string|undefined;
  try{linkUserId=(await ctx.auth(req)).id;}catch{/* A new sign-in is allowed. */}
  await ctx.redis.set(`oauth-state:${state}`,JSON.stringify({provider:p,verifier,linkUserId}), 'EX',600);
  reply.setCookie('mp_oauth_state',state,{path:'/',httpOnly:true,sameSite:'lax',secure:config.NODE_ENV==='production',maxAge:600});
  const url=new URL(p==='google'?'https://accounts.google.com/o/oauth2/v2/auth':'https://www.facebook.com/v22.0/dialog/oauth');
  const callback=`${config.OAUTH_CALLBACK_ORIGIN}/auth/oauth/${p}/callback`;
  for(const[key,value]of Object.entries({client_id:(p==='google'?config.GOOGLE_CLIENT_ID:config.FACEBOOK_CLIENT_ID)!,redirect_uri:callback,response_type:'code',scope:p==='google'?'openid email profile':'email,public_profile',state}))url.searchParams.set(key,value);
  if(p==='google'){url.searchParams.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'));url.searchParams.set('code_challenge_method','S256');}
  return reply.redirect(url.toString());
 });
 app.get('/auth/oauth/:provider/callback',async(req,reply)=>{
  const p=provider.parse((req.params as{provider:string}).provider);
  if(!configured(p))throw fail(503,'This sign-in provider is not configured');
  const query=z.object({code:z.string().min(1).max(4096),state:z.string().min(32).max(128)}).parse(req.query);
  if(req.cookies.mp_oauth_state!==query.state)throw fail(400,'Invalid sign-in state. Start again.');
  reply.clearCookie('mp_oauth_state',{path:'/'});
  const stored=await ctx.redis.getdel(`oauth-state:${query.state}`);
  if(!stored)throw fail(400,'Sign-in request expired. Start again.');
  const state=JSON.parse(stored)as{provider:string;verifier:string;linkUserId?:string};
  if(state.provider!==p)throw fail(400,'Invalid sign-in provider');
  const callback=`${config.OAUTH_CALLBACK_ORIGIN}/auth/oauth/${p}/callback`;
  const token=await jsonRequest(p==='google'?'https://oauth2.googleapis.com/token':'https://graph.facebook.com/v22.0/oauth/access_token',{
   method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:(p==='google'?config.GOOGLE_CLIENT_ID:config.FACEBOOK_CLIENT_ID)!,client_secret:(p==='google'?config.GOOGLE_CLIENT_SECRET:config.FACEBOOK_CLIENT_SECRET)!,code:query.code,grant_type:'authorization_code',redirect_uri:callback,...(p==='google'?{code_verifier:state.verifier}:{})}).toString(),
  });
  const accessToken=z.string().min(1).parse(token.access_token);
  const profile=await jsonRequest(p==='google'?'https://openidconnect.googleapis.com/v1/userinfo':'https://graph.facebook.com/v22.0/me?fields=id,name,email',{headers:{authorization:`Bearer ${accessToken}`}});
  const email=z.email().parse(profile.email).toLowerCase(),subject=z.string().min(1).parse(p==='google'?profile.sub:profile.id);
  const name=z.string().min(1).max(160).parse(profile.name);
  const verified=p==='google'&&profile.email_verified===true;
  let created=false;
  const user=await ctx.db.$transaction(async tx=>{
   const account=await tx.oAuthAccount.findUnique({where:{provider_subject:{provider:p,subject}},include:{user:true}});
   if(account)return account.user;
   let user=await tx.user.findUnique({where:{email}});
   // A matching email alone never silently links an existing password account.
   if(user&&state.linkUserId!==user.id)throw fail(409,'Sign in to your existing account first, then link this provider.');
   if(state.linkUserId&&(!user||user.id!==state.linkUserId))throw fail(409,'The identity provider email must match your signed-in account.');
   if(!user){user=await tx.user.create({data:{email,fullName:name,mobile:'',passwordHash:await argon2.hash(randomBytes(48).toString('base64url')),consentAt:ctx.now(),verifiedAt:verified?ctx.now():null}});created=true;}
   await tx.oAuthAccount.create({data:{provider:p,subject,userId:user.id}});
   await tx.auditLog.create({data:{actorId:user.id,action:'OAUTH_ACCOUNT_LINKED',entityId:user.id,metadata:{provider:p}}});
   return user;
  },{timeout:15000});
  if(user.lockedUntil&&user.lockedUntil>ctx.now())throw fail(401,'Account temporarily locked');
  if(created&&!user.verifiedAt)await sendVerification(user);
  await session(ctx,user,reply);
  return reply.redirect(`${config.WEB_ORIGIN}/account`);
 });
}
async function session(ctx:AppContext,user:User,reply:FastifyReply){
 const row=await ctx.db.session.create({data:{userId:user.id,expiresAt:new Date(+ctx.now()+86400000)}});
 const token=await new SignJWT({sid:row.id}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuer('macapagal-api').setAudience('macapagal-web').setIssuedAt().setExpirationTime('24h').sign(new TextEncoder().encode(config.JWT_SECRET));
 reply.setCookie('mp_session',token,{path:'/',httpOnly:true,sameSite:'lax',secure:config.NODE_ENV==='production',maxAge:86400});
}
