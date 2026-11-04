import { Worker, Queue, type ConnectionOptions } from 'bullmq';
import type { AppContext } from './context.js';
import { config } from './config.js';
import {applyRetention} from './retention.js';
import { processBookingJob, sweepBookings } from './bookings.js';
import { processPaymentJob, reconcilePayments } from './payments.js';
import { processRefundJob } from './refunds.js';
import { processNotificationJob, sweepNotifications } from './notifications.js';
export function queueConnection(): ConnectionOptions {
 const url = new URL(config.REDIS_URL);
 return { host: url.hostname, port: Number(url.port || 6379), db: Number(url.pathname.slice(1) || 0),
  ...(url.password ? { password: decodeURIComponent(url.password) } : {}), ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
  ...(url.protocol === 'rediss:' ? { tls: {} } : {}), maxRetriesPerRequest: null };
}
export function createQueue() {
 return new Queue('macapagal', { connection: queueConnection(), defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 500, removeOnFail: 500 } });
}
export async function startRuntime(ctx: AppContext, log: { error: (...args: any[]) => void }) {
 const worker = new Worker('macapagal', async job => {
  if (job.name === 'retention.apply') return applyRetention(ctx);
  if (job.name === 'refunds.sweep') {
   const pending=await ctx.db.refund.findMany({where:{status:{in:['REQUESTED','PROCESSING']}},select:{id:true},take:200});
   for(const row of pending)await ctx.jobs.add('refund.process',{refundId:row.id},{jobId:`refund-recover-${row.id}-${Math.floor(+ctx.now()/30000)}`});
   return;
  }
  if (job.name === 'holds.sweep') return sweepBookings(ctx);
  if (job.name === 'payments.reconcile') return reconcilePayments(ctx);
  if (job.name === 'notifications.sweep') return sweepNotifications(ctx);
  if (job.name.startsWith('hold.')) return processBookingJob(ctx, job);
  if (job.name.startsWith('payment.')) return processPaymentJob(ctx, job);
  if (job.name.startsWith('refund.')) return processRefundJob(ctx, job);
  if (job.name.startsWith('notification.')) return processNotificationJob(ctx, job);
  throw new Error(`Unknown job kind: ${job.name}`);
 }, { connection: queueConnection(), concurrency: 4 });
 worker.on('error', () => log.error({ kind: 'worker' }, 'Background worker connection failed'));
 worker.on('failed', job => log.error({ jobName: job?.name, jobId: job?.id }, 'Background job failed; retained for retry'));
 await ctx.jobs.upsertJobScheduler('retention-daily',{every:86400000},{name:'retention.apply',data:{}});
 await ctx.jobs.upsertJobScheduler('refunds-sweeper',{every:30000},{name:'refunds.sweep',data:{}});
 await ctx.jobs.upsertJobScheduler('holds-sweeper', { every: 30000 }, { name: 'holds.sweep', data: {} });
 await ctx.jobs.upsertJobScheduler('payments-reconciler', { every: 120000 }, { name: 'payments.reconcile', data: {} });
 await ctx.jobs.upsertJobScheduler('notifications-sweeper', { every: 30000 }, { name: 'notifications.sweep', data: {} });
 const subscriber = ctx.redis.duplicate();
 subscriber.on('error', () => log.error({ kind: 'expiry-listener' }, 'Redis expiry listener unavailable; sweeper remains active'));
 // Key expiry accelerates recovery; the durable periodic sweep is still required.
 try {
  const existing = await ctx.redis.config('GET', 'notify-keyspace-events') as string[];
  await ctx.redis.config('SET', 'notify-keyspace-events', [...new Set(`${existing[1] ?? ''}Ex`)].join(''));
  await subscriber.psubscribe('__keyevent@*__:expired');
  subscriber.on('pmessage', (_pattern, _channel, key: string) => {
   if (key.startsWith('seat:')) ctx.jobs.add('holds.sweep', {}).catch(() => log.error({ kind: 'expiry-enqueue' }, 'Hold sweep enqueue failed'));
  });
 } catch { log.error({ kind: 'expiry-listener' }, 'Keyspace notifications unavailable; periodic sweep remains active'); }
 // Recovery is not deferred until the first scheduled interval after restart.
 await ctx.jobs.add('holds.sweep', {});
 await ctx.jobs.add('payments.reconcile', {});
 await ctx.jobs.add('notifications.sweep', {});
 return async () => { await subscriber.quit(); await worker.close(); };
}
