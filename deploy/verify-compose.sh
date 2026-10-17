#!/bin/sh
# Run with: sh deploy/verify-compose.sh
# Owns only a new, randomly named Compose project; never mounts host business data.
set -eu
cd "$(dirname "$0")/.."
verification_dir=$(mktemp -d "${TMPDIR:-/tmp}/daylight-compose-check.XXXXXX")
project="daylight-check-$(openssl rand -hex 6)"
log_dir="${DAYLIGHT_VERIFY_LOG_DIR:-deploy/verification/$project}"
mkdir -p "$log_dir"
cleanup() {
  compose logs --no-color > "$log_dir/services.log" 2>&1 || true
  docker compose --env-file "$verification_dir/env" -p "$project" down --volumes --remove-orphans
  rm -rf "$verification_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
{
  for key in POSTGRES_PASSWORD REDIS_PASSWORD RABBITMQ_PASSWORD MINIO_ROOT_PASSWORD DAYLIGHT_JWT_SECRET; do
    printf '%s=%s\n' "$key" "$(openssl rand -hex 32)"
  done
  printf '%s\n' 'MINIO_ROOT_USER=daylight-check' 'DAYLIGHT_BIND_ADDRESS=127.0.0.1' 'DAYLIGHT_PORT=0'
  printf 'DAYLIGHT_IMAGE=%s\n' "${DAYLIGHT_VERIFY_IMAGE:-daylight:$project}"
} > "$verification_dir/env"
compose() { docker compose --env-file "$verification_dir/env" -p "$project" "$@"; }
compose config --quiet
compose build api
compose up -d --wait --wait-timeout 360
compose ps -a
compose exec -T api node --input-type=module -e '
  for (const path of ["/", "/app"]) {
    const r = await fetch(`http://127.0.0.1:3000${path}`);
    const html = await r.text();
    if (!r.ok || !html.includes("/assets/")) throw new Error(`Frontend failed: ${path}`);
  }
  console.log("Landing and app frontend passed");
'
# Read-only dependency and native PDF/OCR checks inside the actual runtime image.
compose exec -T api node --input-type=module -e '
  import { createCanvas } from "@napi-rs/canvas";
  await import("pdfjs-dist/legacy/build/pdf.mjs");
  await import("tesseract.js");
  if (createCanvas(8, 8).toBuffer("image/png").length === 0) throw new Error("Canvas failed");
  for (const path of ["/health/live", "/health/ready"]) {
    const response = await fetch(`http://127.0.0.1:3000${path}`);
    if (!response.ok) throw new Error(`Health failed: ${path}`);
  }
  console.log("API health and native PDF/canvas/OCR module loading passed");
'
for role in worker scheduler; do
  compose exec -T "$role" node --input-type=module -e '
    for (const path of ["/health/live", "/health/ready"]) {
      const response = await fetch(`http://127.0.0.1:3001${path}`);
      if (!response.ok) throw new Error(`Health failed: ${path}`);
    }
    console.log("Role liveness and readiness passed");
  '
done
compose run --rm --no-deps migrate
compose exec -T api node --input-type=module -e '
  import pg from "pg";
  const p = new pg.Pool({connectionString:process.env.DAYLIGHT_DATABASE_URL});
  const {rows}=await p.query("SELECT payload, version FROM app_settings WHERE id=$1",["default"]);
  if(rows.length!==1 || !Array.isArray(rows[0].payload.mailboxes)) throw new Error("Default settings missing");
  await p.end(); console.log("Explicit default settings bootstrap verified");
'
compose stop api worker scheduler
compose ps -a --format json > "$log_dir/stopped.json"
compose ps -a --format json | python3 -c 'import sys,json; rows=[json.loads(line) for line in sys.stdin if line.strip()]; roles=[r for r in rows if r["Service"] in ("api","worker","scheduler")]; assert len(roles)==3; assert all(r["State"]=="exited" and r["ExitCode"]==0 for r in roles); print("All application roles shut down with exit code 0")'
printf '%s\n' 'Isolated Compose startup, readiness, native module load and migration rerun passed.'
