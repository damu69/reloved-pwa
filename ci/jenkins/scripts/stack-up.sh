#!/usr/bin/env bash
# Starts a throwaway copy of the whole app for browser, load and security tests:
#   fresh database "e2e" -> migrations -> API on :4000 -> seed data -> test web server on :5173
# Used by the Jenkinsfile and by e2e/README. Needs: node 22, psql, the server and e2e dependencies installed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN="$ROOT/.stack"; mkdir -p "$RUN"
export PGHOST="${PGHOST:-postgres}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"

psql -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists e2e with (force)" -c "create database e2e"

cd "$ROOT/server"
export NODE_ENV=development PORT=4000 LOG_LEVEL=warn
export DATABASE_URL="postgres://$PGUSER:$PGPASSWORD@$PGHOST:5432/e2e"
export JWT_SECRET="e2e-only-secret-that-is-long-enough-0123456789"
export DATA_ENCRYPTION_KEY="$(node -e "console.log(Buffer.alloc(32,9).toString('base64'))")"
export COOKIE_SECURE=false CORS_ORIGINS=http://localhost:5173 TRUST_PROXY_HOPS=1
export STORAGE_DRIVER=local STORAGE_LOCAL_DIR="$RUN/storage" PAYMENT_PROVIDER=none

npx tsx src/scripts/migrate.ts
nohup npx tsx src/server.ts > "$RUN/api.log" 2>&1 &
echo $! > "$RUN/api.pid"
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:4000/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:4000/health >/dev/null || { echo "API did not start"; cat "$RUN/api.log"; exit 1; }

cd "$ROOT/e2e"
API_URL=http://127.0.0.1:4000 node seed.mjs
nohup node web.mjs > "$RUN/web.log" 2>&1 &
echo $! > "$RUN/web.pid"
for _ in $(seq 1 30); do curl -sf http://localhost:5173/ >/dev/null && break; sleep 1; done
curl -sf http://localhost:5173/ >/dev/null || { echo "web server did not start"; cat "$RUN/web.log"; exit 1; }
echo "stack is up: web http://localhost:5173, api http://127.0.0.1:4000"
