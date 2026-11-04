import dotenv from 'dotenv';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
dotenv.config({ path: new URL('../../../.env', import.meta.url), quiet: true });
const schema = z.object({
 DATABASE_URL: z.url(), REDIS_URL: z.url(), JWT_SECRET: z.string().min(32), TOKEN_PEPPER: z.string().min(32),
 WEB_ORIGIN: z.url().default('http://localhost:3000'), NODE_ENV: z.enum(['development','test','production']).default('development'),
 HTTP_RATE_LIMIT_MAX: z.coerce.number().int().min(60).max(10000).default(600),
 API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
 SMTP_HOST: z.string().default('127.0.0.1'), SMTP_PORT: z.coerce.number().default(1025), SMTP_USER: z.string().optional(), SMTP_PASSWORD: z.string().optional(), MAIL_FROM: z.string().default('Macapagal Port <tickets@localhost>'),
 BOOKING_CUTOFF_MINUTES: z.coerce.number().int().min(0).max(1440).default(60),
 SEAT_HOLD_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(600),
 SEAT_HOLD_EXTENSION_SECONDS: z.coerce.number().int().min(1).max(900).default(300),
 MAX_ACTIVE_HOLDS_PER_USER: z.coerce.number().int().min(1).max(10).default(2),
 MAX_ACTIVE_HOLDS_PER_IP: z.coerce.number().int().min(1).max(50).default(4),
 PAYMENT_PROVIDER: z.enum(['mock','disabled']).default('mock'),
 PAYMENT_WEBHOOK_SECRET: z.string().min(32).optional(),
 PAYMENT_PENDING_MAX_SECONDS: z.coerce.number().int().min(1).max(900).default(900),
 COUNTER_DEADLINE_MINUTES: z.coerce.number().int().min(0).max(1440).default(120),
 DATA_ENCRYPTION_KEY: z.string().min(32).optional(), DATA_RETENTION_DAYS: z.coerce.number().int().min(30).default(365),
 SMS_PROVIDER: z.enum(['disabled','twilio']).default('disabled'), TWILIO_ACCOUNT_SID:z.string().regex(/^AC[a-zA-Z0-9]{32}$/).optional(), TWILIO_AUTH_TOKEN:z.string().min(16).optional(), TWILIO_FROM_NUMBER:z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
 GOOGLE_CLIENT_ID: z.string().optional(), GOOGLE_CLIENT_SECRET: z.string().optional(), FACEBOOK_CLIENT_ID: z.string().optional(), FACEBOOK_CLIENT_SECRET: z.string().optional(), OAUTH_CALLBACK_ORIGIN: z.url().optional(),
 ENABLE_WORKERS: z.enum(['true','false']).default('true'),
});
const parsed = schema.parse(process.env);
export const config = { ...parsed,
 PAYMENT_WEBHOOK_SECRET: parsed.PAYMENT_WEBHOOK_SECRET ?? createHmac('sha256', parsed.TOKEN_PEPPER).update('macapagal:payment-webhook:v1').digest('hex'),
 DATA_ENCRYPTION_KEY: parsed.DATA_ENCRYPTION_KEY ?? createHmac('sha256', parsed.TOKEN_PEPPER).update('macapagal:data-encryption:v1').digest('hex'),
};
if (config.NODE_ENV === 'production') {
 if (!config.WEB_ORIGIN.startsWith('https://')) throw new Error('Production requires an HTTPS web origin');
 if (config.PAYMENT_PROVIDER === 'mock') throw new Error('Mock payments are forbidden in production. Set PAYMENT_PROVIDER=disabled until a verified adapter is configured.');
}
