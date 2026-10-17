#!/bin/sh
# Real PostgreSQL verification, independently runnable when other registries are unavailable.
set -eu
cd "$(dirname "$0")/.."
umask 077
verification_dir=$(mktemp -d "${TMPDIR:-/tmp}/daylight-migration-check.XXXXXX")
project="daylight-migration-$(openssl rand -hex 6)"
log_dir="${DAYLIGHT_VERIFY_LOG_DIR:-deploy/verification/$project}"
mkdir -p "$log_dir"
compose() { docker compose --env-file "$verification_dir/env" -p "$project" "$@"; }
cleanup() {
  compose logs --no-color > "$log_dir/services.log" 2>&1 || true
  compose down --volumes --remove-orphans
  rm -rf "$verification_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
{
  for key in POSTGRES_PASSWORD REDIS_PASSWORD RABBITMQ_PASSWORD MINIO_ROOT_PASSWORD DAYLIGHT_JWT_SECRET; do
    printf '%s=%s\n' "$key" "$(openssl rand -hex 32)"
  done
  printf '%s\n' 'MINIO_ROOT_USER=daylight-check' 'DAYLIGHT_PORT=0'
  printf 'DAYLIGHT_IMAGE=%s\n' "${DAYLIGHT_VERIFY_IMAGE:-daylight:$project}"
} > "$verification_dir/env"
compose build api
compose up -d --wait --wait-timeout 120 postgres
compose run --rm --no-deps migrate
compose run --rm --no-deps --entrypoint node migrate --input-type=module -e '
  import assert from "node:assert/strict";
  import { spawnSync } from "node:child_process";
  import pg from "pg";
  import { createCanvas } from "@napi-rs/canvas";
  const pool = new pg.Pool({connectionString:process.env.DAYLIGHT_DATABASE_URL});
  const snapshot = async () => (await pool.query("SELECT payload, version::text, updated_at::text FROM app_settings WHERE id=$1", ["default"])).rows;
  const rerun = (script) => {
    const result = spawnSync(process.execPath, [script], {stdio:"inherit",timeout:60000});
    assert.equal(result.status,0);
  };
  try {
    const initial = await snapshot();
    assert.equal(initial.length,1);
    assert.deepEqual(initial[0].payload.mailboxes,[]);
    assert.equal(initial[0].payload.apiKey,"");
    rerun("scripts/migrate.js");
    assert.deepEqual(await snapshot(),initial);
    await pool.query("UPDATE app_settings SET payload=$1::jsonb, version=version+1 WHERE id=$2", [JSON.stringify({mailboxes:[],verificationMarker:"preserve-existing"}),"default"]);
    const customized = await snapshot();
    rerun("scripts/migrate.js");
    rerun("scripts/bootstrap-settings.js");
    assert.deepEqual(await snapshot(),customized);
    console.log("PASS: fresh bootstrap and repeated migrations preserve payload, version and timestamp");
    await import("pdfjs-dist/legacy/build/pdf.mjs");
    await import("tesseract.js");
    assert.ok(createCanvas(8,8).toBuffer("image/png").length>0);
    assert.equal(process.getuid(),1000);
    console.log("PASS: native canvas rendering, PDF.js/Tesseract imports, UID 1000; Node",process.version);
  } finally { await pool.end(); }
'
printf '%s\n' 'Isolated real PostgreSQL migration checks passed.'
