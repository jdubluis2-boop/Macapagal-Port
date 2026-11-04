#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module <<'JS'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (!existsSync('.env')) {
 const template=readFileSync('.env.example','utf8')
  .replace('replace-with-at-least-32-random-characters',randomBytes(48).toString('base64url'))
  .replace('replace-with-another-32-random-characters',randomBytes(48).toString('base64url'));
 writeFileSync('.env',template,{mode:0o600,flag:'wx'});
}
JS
npm ci --no-audit --no-fund
docker compose up -d --wait
npm run db:generate
npm run db:migrate
npm run db:seed
