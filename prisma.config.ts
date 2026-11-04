import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { PrismaPg } from '@prisma/adapter-pg';
process.env.PRISMA_CLIENT_ENGINE_TYPE = 'client';
export default defineConfig({
 schema: 'prisma/schema.prisma',
 migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
 experimental: { adapter: true },
 engine: 'js',
 adapter: async () => new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
