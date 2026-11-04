import { z } from 'zod';
export const email = z.email().max(254).transform(v => v.trim().toLowerCase());
export const password = z.string().min(8).max(128).regex(/[0-9]/, 'Include at least one number');
export const mobile = z.string().transform(v => v.replace(/[\s()-]/g, '')).pipe(z.string().regex(/^\+639\d{9}$/, 'Use +63 9XX XXX XXXX'));
export const registration = z.object({ fullName: z.string().trim().min(2).max(160), email, mobile, password, confirmPassword: z.string(), consent: z.literal(true) }).refine(v => v.password === v.confirmPassword, { path: ['confirmPassword'], message: 'Passwords must match' });
export const login = z.object({ email, password: z.string().min(1).max(128) });
