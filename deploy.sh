#!/usr/bin/env bash
set -euo pipefail
wrangler d1 create pbe_db || true
wrangler r2 bucket create pbe-proofs || true
wrangler d1 execute pbe_db --local --file=./schema.sql || true
wrangler d1 execute pbe_db --file=./schema.sql
wrangler secret put TELNYX_API_KEY
wrangler secret put TELNYX_FROM_NUMBER
wrangler publish
