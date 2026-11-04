'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
type Mode = 'register' | 'sign-in' | 'verify-email' | 'forgot-password' | 'reset-password' | 'account';
const titles: Record<Mode,string> = { register:'Create your account', 'sign-in':'Welcome back', 'verify-email':'Verify your email', 'forgot-password':'Forgot your password?', 'reset-password':'Choose a new password', account:'Your passenger account' };
const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export default function AuthForm({ mode }: { mode: Mode }) {
 const [oauth,setOauth]=useState<{google:boolean;facebook:boolean}>({google:false,facebook:false});
 useEffect(()=>{if(mode!=='sign-in')return;const controller=new AbortController();fetch(`${api}/auth/oauth/config`,{signal:controller.signal,credentials:'include'}).then(response=>response.ok?response.json():null).then(result=>{if(result&&!controller.signal.aborted)setOauth({google:result.google===true,facebook:result.facebook===true});}).catch(()=>{});return()=>controller.abort();},[mode]);
 const [busy,setBusy]=useState(false), [message,setMessage]=useState(''), [error,setError]=useState(false), [show,setShow]=useState(false), [email,setEmail]=useState(''), [user,setUser]=useState<{fullName:string;email:string;verified:boolean;role:string}|null>(null);
 async function request(path:string, body?:unknown) {
  const response = await fetch(`${api}${path}`, { method:body === undefined?'GET':'POST', credentials:'include', headers:body === undefined?{}:{'Content-Type':'application/json'}, ...(body === undefined?{}:{body:JSON.stringify(body)}) });
  const result = await response.json();
  if(!response.ok) throw new Error(result.issues?.map((i:{field:string;message:string})=>`${i.field}: ${i.message}`).join('. ') || result.message || 'Please try again');
  return result;
 }
 useEffect(()=>{ if(mode==='account'){request('/auth/me').then(d=>{setUser(d.user);sessionStorage.setItem('verificationEmail',d.user.email);}).catch(e=>{setError(true);setMessage(e.message)});} else if(mode==='verify-email') setEmail(sessionStorage.getItem('verificationEmail')??''); },[mode]);
 async function submit(event:React.FormEvent<HTMLFormElement>) {
  event.preventDefault();setBusy(true);setMessage('');setError(false);
  const fields=Object.fromEntries(new FormData(event.currentTarget));
  try {
   if(mode==='register') { const result=await request('/auth/register',{...fields,consent:fields.consent==='on'});sessionStorage.setItem('verificationEmail',String(fields.email));setMessage(result.message);window.location.assign('/verify-email'); }
   else if(mode==='sign-in') { await request('/auth/login',fields);window.location.assign('/account'); }
   else if(mode==='verify-email') setMessage((await request('/auth/verify',fields)).message);
   else if(mode==='forgot-password') setMessage((await request('/auth/forgot-password',fields)).message);
   else if(mode==='reset-password') { const token=new URLSearchParams(window.location.search).get('token');setMessage((await request('/auth/reset-password',{...fields,token})).message); }
  } catch(e){setError(true);setMessage(e instanceof Error?e.message:'Unable to connect. Please try again.');} finally{setBusy(false);}
 }
 async function action(path:string, body:unknown) {setBusy(true);setError(false);try{setMessage((await request(path,body)).message);if(path==='/auth/logout')window.location.assign('/sign-in');}catch(e){setError(true);setMessage(e instanceof Error?e.message:'Please try again');}finally{setBusy(false);}}
 return <section className="card"><span className="eyebrow">Passenger services</span><h1>{titles[mode]}</h1><p>{mode==='register'?'Use your full name exactly as shown on your government-issued ID.':mode==='verify-email'?'Enter the 6-digit code sent to your email. It expires in 10 minutes.':mode==='account'?'Manage your account and email verification.':'Secure access to your Macapagal Port account.'}</p>
 {message&&<div role={error?'alert':'status'} className={`status ${error?'error':''}`}>{message}</div>}
 {mode==='account'?user?<><h2>{user.fullName}</h2><p>{user.email}</p><div className="status">{user.verified?'Email verified. Your account is ready for booking.':'Email not verified. You must verify before booking.'}</div>{!user.verified&&<Link className="button" href="/verify-email">Verify email</Link>}{!user.verified&&<form onSubmit={async e=>{e.preventDefault();const fields=Object.fromEntries(new FormData(e.currentTarget));await action('/auth/change-email',fields);sessionStorage.setItem('verificationEmail',String(fields.email));}}><label>Correct email address<input type="email" name="email" required/></label><label>Confirm your password<input type="password" name="password" autoComplete="current-password" required/></label><button type="submit" disabled={busy}>Change email</button></form>}<p><Link href="/bookings">My bookings</Link> · <Link href="/tickets">My e-tickets</Link>{user.role!=='PASSENGER'&&<> · <Link href="/staff">Staff dashboard</Link></>}</p><button disabled={busy} onClick={()=>action('/auth/logout',{})}>Sign out</button></>:<p>{message?'':'Loading account…'}</p>:<form onSubmit={submit}>
 {mode==='register'&&<><label>Full name as on ID<input name="fullName" autoComplete="name" required minLength={2} maxLength={160}/></label><label>Philippine mobile<input name="mobile" type="tel" autoComplete="tel" placeholder="+63 9XX XXX XXXX" required/></label></>}
 {mode!=='reset-password'&&<label>Email address<input type="email" name="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} required maxLength={254}/></label>}
 {['register','sign-in','reset-password'].includes(mode)&&<><label>Password<input name="password" type={show?'text':'password'} autoComplete={mode==='sign-in'?'current-password':'new-password'} minLength={mode==='sign-in'?1:8} maxLength={128} required/></label><button className="text-button" type="button" aria-pressed={show} onClick={()=>setShow(!show)}>{show?'Hide':'Show'} password</button>{mode!=='sign-in'&&<><p>At least 8 characters, including a number.</p><label>Confirm password<input type={show?'text':'password'} name="confirmPassword" autoComplete="new-password" required/></label></>}</>}
 {mode==='verify-email'&&<label>Verification code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></label>}
 {mode==='register'&&<label><input type="checkbox" name="consent" required/>I agree to the <Link href="/terms">terms</Link> and <Link href="/privacy">privacy notice</Link>.</label>}
 <button type="submit" disabled={busy}>{busy?'Please wait…':mode==='register'?'Create account':mode==='sign-in'?'Sign in':mode==='verify-email'?'Verify email':mode==='forgot-password'?'Send reset link':'Update password'}</button>
 {mode==='verify-email'&&<p>Wrong email address? <Link href="/account">Sign in and change it in your account</Link>.</p>}{mode==='verify-email'&&<button className="text-button" type="button" disabled={busy||!email} onClick={()=>action('/auth/resend',{email})}>Resend code (at most once per minute)</button>}
 </form>}
 {mode==='sign-in'&&(oauth.google||oauth.facebook)&&<div className="oauth-buttons">{oauth.google&&<a className="secondary-button" href={`${api}/auth/oauth/google/start`}>Continue with Google</a>}{oauth.facebook&&<a className="secondary-button" href={`${api}/auth/oauth/facebook/start`}>Continue with Facebook</a>}</div>}
 <div className="links"><Link href="/sign-in">Sign in</Link>{mode==='sign-in'?<><Link href="/forgot-password">Forgot password?</Link><Link href="/register">Register</Link></>:<Link href="/">Back to home</Link>}</div></section>;
}
