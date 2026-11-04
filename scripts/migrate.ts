/** Apply checked-in Prisma SQL without native CLI engines. All migrations are atomic. */
import 'dotenv/config';
import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
 await client.query("SELECT pg_advisory_lock(734198221)");
 await client.query('CREATE TABLE IF NOT EXISTS "_macapagal_migrations" (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
 const dirs = (await readdir(new URL('../prisma/migrations/',import.meta.url),{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort();
 for (const name of dirs) {
  const sql = await readFile(new URL(`../prisma/migrations/${name}/migration.sql`,import.meta.url),'utf8');
  if (!sql.trim()) throw new Error(`Empty migration: ${name}`);
  const checksum=createHash('sha256').update(sql).digest('hex');
  const old=await client.query('SELECT checksum FROM "_macapagal_migrations" WHERE name=$1',[name]);
  if (old.rows.length) { if(old.rows[0].checksum!==checksum)throw new Error(`Applied migration was modified: ${name}`);continue; }
  await client.query('BEGIN');
  try { await client.query(sql); await client.query('INSERT INTO "_macapagal_migrations" (name,checksum) VALUES ($1,$2)',[name,checksum]); await client.query('COMMIT');console.log(`Applied ${name}`); }
  catch(e){await client.query('ROLLBACK');throw e;}
 }
} finally { await client.query('SELECT pg_advisory_unlock(734198221)');await client.end(); }
