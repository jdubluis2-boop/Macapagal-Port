import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
const key = createHash('sha256').update(config.DATA_ENCRYPTION_KEY).digest();
export function encrypt(value: unknown): string {
 const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
 const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
 return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
export function decrypt(ciphertext: string): any {
 const [version, nonce, tag, encrypted] = ciphertext.split('.');
 if (version !== 'v1' || !nonce || !tag || !encrypted) throw new Error('Invalid encrypted record');
 const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce,'base64url'));
 cipher.setAuthTag(Buffer.from(tag,'base64url'));
 return JSON.parse(Buffer.concat([cipher.update(Buffer.from(encrypted,'base64url')),cipher.final()]).toString('utf8'));
}
