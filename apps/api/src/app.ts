import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '@prisma/client';
import { Redis } from 'ioredis';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { createHmac, randomInt, randomBytes } from 'node:crypto';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { registration, login, email, password } from './validation.js';
import { registerSailingRoutes } from './sailings.js';
import { Server as SocketServer } from 'socket.io';
import type { AppContext } from './context.js';
import { encrypt, decrypt } from './encryption.js';
import { createQueue, startRuntime } from './runtime.js';
import { registerBookingRoutes } from './bookings.js';
import { registerPaymentRoutes } from './payments.js';
import { registerTicketRoutes } from './tickets.js';
import { registerRefundRoutes } from './refunds.js';
import { registerStaffRoutes } from './staff.js';
import { registerNotificationRoutes } from './notifications.js';
import { registerOAuthRoutes } from './oauth.js';


export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
const mail = nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_PORT === 465, ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}) });
const digest = (value: string) => createHmac('sha256', config.TOKEN_PEPPER).update(value).digest('hex');
const publicUser = (u: { id: string; email: string; fullName: string; role: string; verifiedAt: Date | null }) => ({ id: u.id, email: u.email, fullName: u.fullName, role: u.role, verified: !!u.verifiedAt });
class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
const generic = { message: 'If the account is eligible, an email has been sent. Check your inbox.' };
// Every auth mutation for an existing user locks the same row, including reset/login races.
async function lock(tx: Prisma.TransactionClient, id: string) { await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id}::uuid FOR UPDATE`; }
async function verification(tx: Prisma.TransactionClient, user: { id: string; email: string }) {
  const code = randomInt(0, 1000000).toString().padStart(6, '0');
  await tx.emailVerification.upsert({ where: { userId: user.id }, create: { userId: user.id, codeHash: digest(`${user.id}:${code}`), expiresAt: new Date(Date.now() + 600000) }, update: { codeHash: digest(`${user.id}:${code}`), attempts: 0, sentAt: new Date(), expiresAt: new Date(Date.now() + 600000) } });
  await mail.sendMail({ from: config.MAIL_FROM, to: user.email, subject: 'Verify your Macapagal Port email', text: `Your verification code is ${code}. It expires in 10 minutes. Do not share this code.` });
}
export async function buildApp(options: { now?: () => Date; workers?: boolean } = {}) {
 const app = Fastify({ logger: config.NODE_ENV === 'test' ? false : { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'], level: 'info' }, bodyLimit: 16384, trustProxy: false });
 await app.register(cookie);
 await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
 await app.register(rateLimit, { redis, nameSpace: config.NODE_ENV === 'test' ? `mp-test-${randomBytes(8).toString('hex')}:` : 'macapagal:', max: config.NODE_ENV === 'test' ? 1000 : config.HTTP_RATE_LIMIT_MAX, timeWindow: '1 minute' });
 app.addHook('onRequest', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Frame-Options', 'DENY');
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && !req.url.split('?')[0].startsWith('/payments/webhook/') && req.headers.origin !== config.WEB_ORIGIN) throw new HttpError(403, 'Untrusted request origin');
 });
 app.setErrorHandler((err, req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ message: 'Please check your details', issues: err.issues.map(i => ({ field: i.path.join('.'), message: i.message })) });
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
   const status = err.code === 'P2025' ? 404 : ['P2002','P2003','P2034'].includes(err.code) ? 409 : 500;
   return reply.code(status).send({ message: status === 404 ? 'Record not found' : status === 409 ? 'The record changed or conflicts with an existing record. Refresh and retry.' : 'Service unavailable. Please try again.' });
  }
  const failure = err as Error & { statusCode?: number };
  const status = typeof failure.statusCode === 'number' ? failure.statusCode : 500;
  if (status >= 500) req.log.error({ errorType: failure.name }, 'Request failed');
  return reply.code(status).send({ message: status >= 500 ? 'Service unavailable. Please try again.' : failure.message });
 });
 const auth = async (req: { cookies: Record<string, string | undefined> }) => {
  try {
   const { payload } = await jwtVerify(req.cookies.mp_session ?? '', new TextEncoder().encode(config.JWT_SECRET), { algorithms: ['HS256'], issuer: 'macapagal-api', audience: 'macapagal-web' });
   if (typeof payload.sid !== 'string' || typeof payload.sub !== 'string') throw new Error();
   const session = await db.session.findUnique({ where: { id: payload.sid }, include: { user: true } });
   if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt <= new Date()) throw new Error();
   return session;
  } catch { throw new HttpError(401, 'Please sign in'); }
 };
 const jobs = createQueue();
 const io = new SocketServer(app.server, { cors: { origin: config.WEB_ORIGIN, credentials: true }, allowRequest: (request, done) => done(null, !request.headers.origin || request.headers.origin === config.WEB_ORIGIN), maxHttpBufferSize: 16384 });
 const ctx: AppContext = {
  db, redis, jobs, now: options.now ?? (() => new Date()), encrypt, decrypt,
  auth: async req => (await auth(req)).user,
  verified: async req => { const user = (await auth(req)).user; if (!user.verifiedAt) throw new HttpError(403, 'Verify your email before booking'); return user; },
  staff: async (req, roles) => { const user = (await auth(req)).user; if (!roles.includes(user.role)) throw new HttpError(403, 'Staff permission required'); return user; },
  emit: (room, event, payload) => { io.to(room).emit(event, payload); },
 };
 io.use(async (socket,next) => {
  try { const session = await auth({cookies:app.parseCookie(socket.handshake.headers.cookie ?? '')}); socket.data.sessionId=session.id; socket.data.userId=session.userId; socket.data.expiresAt=+session.expiresAt; } catch { /* Public observers have no personal room. */ }
  next();
 });
 io.on('connection', socket => {
  const serverTime = ctx.now().toISOString();
  socket.emit('server.time', { serverTime, serverTimeMs: +ctx.now() });
  if(socket.data.userId){
   socket.join(`user:${socket.data.userId}`);
   const timer=setTimeout(()=>socket.disconnect(true),Math.max(1,socket.data.expiresAt-Date.now()));
   socket.once('disconnect',()=>clearTimeout(timer));
  }
  let subscriptions = 0;
  socket.on('subscribe', async (payload: unknown) => {
   if (subscriptions++ >= 8) return socket.emit('subscription.error', { message: 'Subscription limit reached' });
   try {
   const parsed = z.object({ sailingId: z.uuid().optional(), origin: z.string().max(100).optional(), destination: z.string().max(100).optional(), date: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).optional() }).safeParse(payload);
   if (!parsed.success) return;
   const data = parsed.data;
   if (data.sailingId) {
    const sailing = await db.sailing.findFirst({ where: { id: data.sailingId, published: true }, select: { id: true } });
    if (!sailing) return;
    await socket.join(`sailing:${sailing.id}`);
    const seats = await db.sailingSeat.findMany({ where: { sailingId: sailing.id }, select: { seatId: true, state: true, version: true } });
    socket.emit('seats.snapshot', { sailingId: sailing.id, serverTime: ctx.now().toISOString(), seats });
   } else if (data.origin && data.destination && data.date) { await socket.join(`route:${data.origin}:${data.destination}:${data.date}`); }
   } catch { socket.emit('subscription.error',{message:'Unable to load the live snapshot; retry or refresh.'}); }
  });
 });
 registerBookingRoutes(app, ctx);
 registerPaymentRoutes(app, ctx);
 registerTicketRoutes(app, ctx);
 registerRefundRoutes(app, ctx);
 registerStaffRoutes(app, ctx);
 registerNotificationRoutes(app, ctx);
 registerOAuthRoutes(app,ctx,async user => { await db.$transaction(tx => verification(tx,user),{timeout:15000}); });
 const stopRuntime = options.workers && config.ENABLE_WORKERS === 'true' ? await startRuntime(ctx, app.log) : undefined;
 const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
 registerSailingRoutes(app, db, { now: options.now ?? (() => new Date()), cutoffMinutes: config.BOOKING_CUTOFF_MINUTES });
 app.get('/health', async () => { await db.$queryRaw`SELECT 1`; await redis.ping(); return { status: 'ok' }; });
 app.post('/auth/register', limited, async (req, reply) => {
  const data = registration.parse(req.body);
  const passwordHash = await argon2.hash(data.password, { type: argon2.argon2id });
  try {
   await db.$transaction(async tx => {
    const user = await tx.user.create({ data: { email: data.email, fullName: data.fullName, mobile: data.mobile, passwordHash, consentAt: new Date() } });
    await verification(tx, user);
    await tx.auditLog.create({ data: { actorId: user.id, action: 'ACCOUNT_REGISTERED', entityId: user.id, metadata: {} } });
   }, { timeout: 15000 });
  } catch (e) { if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e; }
  return reply.code(202).send(generic);
 });
 app.post('/auth/verify', limited, async req => {
  const data = z.object({ email, code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  const ok = await db.$transaction(async tx => {
   const user = await tx.user.findUnique({ where: { email: data.email } });
   if (!user) return false;
   await lock(tx, user.id);
   const v = await tx.emailVerification.findUnique({ where: { userId: user.id } });
   if (!v || v.expiresAt <= new Date() || v.attempts >= 5) return false;
   await tx.emailVerification.update({ where: { userId: user.id }, data: { attempts: { increment: 1 } } });
   if (v.codeHash !== digest(`${user.id}:${data.code}`)) return false;
   await tx.user.update({ where: { id: user.id }, data: { verifiedAt: new Date() } });
   await tx.emailVerification.delete({ where: { userId: user.id } });
   await tx.auditLog.create({ data: { actorId: user.id, action: 'EMAIL_VERIFIED', entityId: user.id, metadata: {} } });
   return true;
  });
  if (!ok) throw new HttpError(400, 'Invalid or expired verification code');
  return { message: 'Email verified. You can now sign in.' };
 });
 app.post('/auth/resend', limited, async req => {
  const data = z.object({ email }).parse(req.body);
  await db.$transaction(async tx => {
   const found = await tx.user.findUnique({ where: { email: data.email } });
   if (!found) return;
   await lock(tx, found.id);
   const user = await tx.user.findUniqueOrThrow({ where: { id: found.id } });
   const old = await tx.emailVerification.findUnique({ where: { userId: user.id } });
   if (user.verifiedAt || (old && Date.now() - old.sentAt.getTime() < 60000)) return;
   await verification(tx, user);
  }, { timeout: 15000 });
  return generic;
 });
 app.post('/auth/change-email', limited, async req => {
  const session = await auth(req);
  const data = z.object({ email, password: z.string().min(1).max(128) }).parse(req.body);
  try {
   await db.$transaction(async tx => {
    await lock(tx, session.userId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: session.userId } });
    if (user.verifiedAt) throw new HttpError(409, 'This address is already verified');
    if (!await argon2.verify(user.passwordHash, data.password)) throw new HttpError(401, 'Invalid password');
    const updated = await tx.user.update({ where: { id: user.id }, data: { email: data.email } });
    await verification(tx, updated);
    await tx.auditLog.create({ data: { actorId: user.id, action: 'EMAIL_CHANGED', entityId: user.id, metadata: {} } });
   }, { timeout: 15000 });
  } catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new HttpError(409, 'Unable to use that email address');throw e; }
  return { message: 'Email updated. Check the new address for your verification code.' };
 });
 app.post('/auth/login', limited, async (req, reply) => {
  const data = login.parse(req.body);
  const found = await db.user.findUnique({ where: { email: data.email } });
  if (!found) { await argon2.hash(data.password); throw new HttpError(401, 'Invalid email or password'); }
  const result = await db.$transaction(async tx => {
   await lock(tx, found.id);
   const user = await tx.user.findUniqueOrThrow({ where: { id: found.id } });
   if (user.lockedUntil && user.lockedUntil > new Date()) return null;
   if (!await argon2.verify(user.passwordHash, data.password)) {
    const failures = user.failedLogins + 1;
    await tx.user.update({ where: { id: user.id }, data: { failedLogins: failures, lockedUntil: failures >= 5 ? new Date(Date.now() + 900000) : null } });
    return null;
   }
   await tx.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
   const session = await tx.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 86400000) } });
   return { user, session };
  });
  if (!result) throw new HttpError(401, 'Invalid email or password');
  const token = await new SignJWT({ sid: result.session.id }).setProtectedHeader({ alg: 'HS256' }).setSubject(result.user.id).setIssuer('macapagal-api').setAudience('macapagal-web').setIssuedAt().setExpirationTime('24h').sign(new TextEncoder().encode(config.JWT_SECRET));
  reply.setCookie('mp_session', token, { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 86400 });
  return { user: publicUser(result.user) };
 });
 app.get('/auth/me', async req => ({ user: publicUser((await auth(req)).user) }));
 app.get('/auth/booking-access', async req => {
  const session = await auth(req);
  if (!session.user.verifiedAt) throw new HttpError(403, 'Verify your email before booking');
  return { allowed: true };
 });
 app.post('/auth/logout', async (req, reply) => {
  const session = await auth(req);
  await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  for(const socket of await io.in(`user:${session.userId}`).fetchSockets())if(socket.data.sessionId===session.id)socket.disconnect(true);
  reply.clearCookie('mp_session', { path: '/' });
  return { message: 'Signed out' };
 });
 app.post('/auth/forgot-password', limited, async req => {
  const data = z.object({ email }).parse(req.body);
  await db.$transaction(async tx => {
   const user = await tx.user.findUnique({ where: { email: data.email } });
   if (!user) return;
   await lock(tx, user.id);
   const token = randomBytes(32).toString('base64url');
   await tx.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
   await tx.passwordReset.create({ data: { userId: user.id, tokenHash: digest(token), expiresAt: new Date(Date.now() + 1800000) } });
   await mail.sendMail({ from: config.MAIL_FROM, to: user.email, subject: 'Reset your Macapagal Port password', text: `Reset your password: ${config.WEB_ORIGIN}/reset-password?token=${token}\nThis single-use link expires in 30 minutes. If you did not request it, ignore this email.` });
  }, { timeout: 15000 }).catch(() => { req.log.error({ errorType: 'PasswordRecoveryUnavailable' }, 'Password recovery could not be delivered'); });
  return generic;
 });
 app.post('/auth/reset-password', limited, async req => {
  const data = z.object({ token: z.string().min(32).max(128), password, confirmPassword: z.string() }).refine(d => d.password === d.confirmPassword, 'Passwords must match').parse(req.body);
  const hash = await argon2.hash(data.password, { type: argon2.argon2id });
  const ok = await db.$transaction(async tx => {
   const reset = await tx.passwordReset.findUnique({ where: { tokenHash: digest(data.token) } });
   if (!reset) return false;
   await lock(tx, reset.userId);
   const claimed = await tx.passwordReset.updateMany({ where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
   if (claimed.count !== 1) return false;
   await tx.user.update({ where: { id: reset.userId }, data: { passwordHash: hash, failedLogins: 0, lockedUntil: null } });
   await tx.session.updateMany({ where: { userId: reset.userId, revokedAt: null }, data: { revokedAt: new Date() } });
   await tx.auditLog.create({ data: { actorId: reset.userId, action: 'PASSWORD_RESET', entityId: reset.userId, metadata: {} } });
   return true;
  });
  if (!ok) throw new HttpError(400, 'Invalid or expired reset link');
  // Database session checks remain authoritative for subsequent reconnects.
  const reset=await db.passwordReset.findUnique({where:{tokenHash:digest(data.token)},select:{userId:true}});
  if(reset)io.in(`user:${reset.userId}`).disconnectSockets(true);
  return { message: 'Password updated. Please sign in.' };
 });
 app.addHook('onClose', async () => { await stopRuntime?.(); io.close(); await jobs.close(); await db.$disconnect(); await redis.quit(); mail.close(); });
 return app;
}
