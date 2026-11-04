import dotenv from 'dotenv';
import type { NextConfig } from 'next';
dotenv.config({ path: new URL('../../.env', import.meta.url), quiet: true });
const config: NextConfig = { async headers(){ return [{ source:'/(.*)', headers:[{key:'Referrer-Policy',value:'no-referrer'},{key:'X-Content-Type-Options',value:'nosniff'},{key:'X-Frame-Options',value:'DENY'}] }]; } };
export default config;
