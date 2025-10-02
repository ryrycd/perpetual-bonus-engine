# Perpetual Bonus Engine (Cloudflare Workers)

This repo is ready to import into **Cloudflare Workers** via the dashboard (no terminal required).

## What it does
- Hosts a premium landing page (`public/index.html`)
- Captures phone + payment handle, texts the referral link
- Handles two-way SMS: waits for `DONE`, asks for MMS proof
- Stores proofs in R2, marks verified, rotates links atomically (Durable Object)
- Notifies operator via SMS when verified

## Deploy (dashboard-only)
1. **GitHub → New repository** → Upload these files (drag/drop). Commit.
2. **Cloudflare Dashboard → Workers → Get started → Import a repository** → pick this repo.
3. After the Worker is created:
   - **Settings → Variables**: add environment variables from `wrangler.toml` `[vars]` section.
   - **Settings → Secrets**: add `TELNYX_API_KEY` and `TELNYX_FROM_NUMBER`.
   - **Settings → D1 Databases**: create `pbe_db` and bind as `DB`.
   - **Settings → R2 buckets**: create `pbe-proofs` and bind as `PROOF_BUCKET`.
   - **Settings → Durable Objects**: add namespace `ROTATOR_DO` with class `Rotator`.
4. **D1 Console**: open `pbe_db` and paste `schema.sql` to create tables. Seed with your links:
   ```sql
   INSERT INTO links (url, threshold, position, active) VALUES
   ('https://www.acorns.com/invite/AAA111', 2, 1, 1),
   ('https://www.acorns.com/invite/BBB222', 2, 2, 0);
   ```
5. **Telnyx**: buy a toll-free number, enable SMS/MMS, create a Messaging Profile, set inbound webhook to:
   `https://<your-worker-subdomain>/hooks/telnyx` and set your API key in Secrets.
6. Visit the Worker URL to test. Scan a QR that points to your Worker URL.

> Optional CLI path is in `deploy.sh` if you prefer later.
