#!/usr/bin/env bash
# Stops what stack-up.sh started. Safe to run when nothing is running.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
for f in web api; do
  [ -f "$ROOT/.stack/$f.pid" ] || continue
  pid="$(cat "$ROOT/.stack/$f.pid")"
  # npx starts a child process; stop the whole group so nothing is left holding the port.
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
done
exit 0
