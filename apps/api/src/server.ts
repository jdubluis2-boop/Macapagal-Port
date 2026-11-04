import { buildApp } from './app.js';
import { config } from './config.js';
const app = await buildApp({ workers: true });
await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
