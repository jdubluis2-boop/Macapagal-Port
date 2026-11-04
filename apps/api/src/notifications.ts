import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import type { AppContext } from './context.js';
import { config } from './config.js';
import {sendSms} from './sms.js';

const uuid = z.string().uuid();
const unavailable = (message: string, statusCode = 404) => Object.assign(new Error(message), { statusCode });
export function registerNotificationRoutes(app: FastifyInstance, ctx: AppContext) {
 app.get('/notifications', async req => {
  const user = await ctx.auth(req);
  const query = z.object({ before: z.iso.datetime().optional() }).parse(req.query);
  return { notifications: await ctx.db.notification.findMany({ where: { userId: user.id, ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }) };
 });
 app.post('/notifications/:id/read', async req => {
  const user = await ctx.auth(req);
  const id = uuid.parse((req.params as { id: string }).id);
  const changed = await ctx.db.notification.updateMany({ where: { id, userId: user.id }, data: { readAt: ctx.now() } });
  if (!changed.count) throw unavailable('Notification not found');
  return { message: 'Notification marked as read' };
 });
}

/** Notifications are a durable outbox. The database lease makes duplicate jobs harmless. */
export async function processNotificationJob(ctx: AppContext, job: { name: string; data: unknown }) {
 const data = z.object({ notificationId: uuid }).parse(job.data);
 const now = ctx.now();
 const claimed = await ctx.db.notification.updateMany({
  where: { id: data.notificationId, deliveredAt: null, attempts: { lt: 10 }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
  data: { attempts: { increment: 1 }, nextAttemptAt: new Date(+now + 300000) },
 });
 if (!claimed.count) return;
 const notification = await ctx.db.notification.findUnique({ where: { id: data.notificationId }, include: { user: { select: { email: true, mobile: true } } } });
 if (!notification) return;
 const payload = notification.payload && typeof notification.payload === 'object' && !Array.isArray(notification.payload) ? notification.payload as Record<string, unknown> : {};
 const message = typeof payload.message === 'string' ? payload.message : `Your Macapagal Port account has an update: ${notification.kind.replaceAll('_', ' ').toLowerCase()}. Sign in to review the details.`;
 const transport = nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_PORT === 465, ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}), connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
 try {
  await transport.sendMail({ from: config.MAIL_FROM, to: notification.user.email, subject: 'Macapagal Port travel update', text: `${message}\n\nReview your bookings: ${config.WEB_ORIGIN}/bookings\n${config.SMS_PROVIDER==='disabled'?'SMS delivery is not configured; this notification is delivered by email and in your account.':'Review your mobile messages for the separate SMS notification.'}` });
  const sms=await sendSms(notification.user.mobile,`${message} Review: ${config.WEB_ORIGIN}/bookings`);
  await ctx.db.notification.update({ where: { id: notification.id }, data: { deliveredAt: ctx.now(), nextAttemptAt: null, payload:{...payload,delivery:{email:'DELIVERED',sms:sms.status,...(sms.providerReference?{smsReference:sms.providerReference}:{})}} } });
  ctx.emit(`user:${notification.userId}`, 'notification.updated', { id: notification.id, deliveredAt: ctx.now().toISOString() });
 } catch {
  // Do not log provider responses, email addresses, or tokens.
  await ctx.db.notification.update({ where: { id: notification.id }, data: { nextAttemptAt: new Date(+ctx.now() + Math.min(3600000, 30000 * 2 ** (notification.attempts - 1))) } });
  throw unavailable('Notification delivery temporarily unavailable', 503);
 } finally { transport.close(); }
}
export async function sweepNotifications(ctx: AppContext) {
 const pending = await ctx.db.notification.findMany({ where: { deliveredAt: null, attempts: { lt: 10 }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: ctx.now() } }] }, select: { id: true }, take: 100, orderBy: { createdAt: 'asc' } });
 for (const row of pending) await ctx.jobs.add('notification.deliver', { notificationId: row.id }, { jobId: `notification-${row.id}-${Math.floor(+ctx.now() / 30000)}`, attempts: 3, backoff: { type: 'exponential', delay: 30000 }, removeOnComplete: true, removeOnFail: 100 });
}
