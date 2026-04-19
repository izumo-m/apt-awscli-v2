# Cloudflare Worker — Wrangler Deploy Harness

Deploy the `apt-awscli-v2-proxy` Cloudflare Worker from this directory using Wrangler.

`index.js` in this directory is the source of truth. Run `npm run deploy` to upload it to Cloudflare.

## Scope

- **Code only.** This harness uploads the Worker script.
- **Not managed here:** custom domain (`apt-awscli-v2.masanao.site`), routes, plain-text vars, and secrets. They are configured in the Cloudflare dashboard and intentionally left out of `wrangler.toml` so `wrangler deploy` does not overwrite them.

## Prerequisites

- Node.js 18 or later
- A Cloudflare account that owns the `apt-awscli-v2-proxy` Worker
- One of:
  - Interactive: run `npm run login` (browser OAuth), **or**
  - CI / non-interactive: `CLOUDFLARE_API_TOKEN` with the `Edit Cloudflare Workers` template

## Initial Setup

```bash
cd cloudflare
npm ci
```

Export your Cloudflare account ID before running any Wrangler command:

```bash
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
```

`wrangler.toml` intentionally omits `account_id` so this harness stays reusable. Do not commit the value back into the file.

Then authenticate:

```bash
npm run whoami   # verify current auth
npm run login    # browser OAuth flow (skip if CLOUDFLARE_API_TOKEN is set)
```

## Deploy

```bash
npm run deploy
```

Uploads `index.js` as the Worker script. Dashboard-managed vars, secrets, custom domain, and routes are preserved (`keep_vars = true`; secrets and routes are never touched when not declared in `wrangler.toml`).

### Dry Run

```bash
npx wrangler deploy --dry-run --outdir dist
```

## Local Development

```bash
npm run dev
```

For local `wrangler dev`, create `.dev.vars` with your own `ORIGIN_BASE_URL` (git-ignored, never committed):

```
ORIGIN_BASE_URL=https://example-origin/apt
```

## Logs

```bash
npm run tail
```

## Post-Deploy Checks

```bash
curl -I https://apt-awscli-v2.masanao.site/
curl -fsSL https://apt-awscli-v2.masanao.site/public.key >/dev/null
```

In the dashboard, confirm the following were preserved after deployment:

- Settings → Variables: `ORIGIN_BASE_URL` is still present
- Settings → Variables: secrets are still present
- Triggers → Custom Domains: `apt-awscli-v2.masanao.site` is still bound

## Files

| File | Purpose |
|------|---------|
| `index.js` | Worker source (master). Do not edit on the dashboard; edit here and redeploy. |
| `wrangler.toml` | Wrangler configuration. Intentionally omits `account_id`, routes, vars, and secrets. |
| `package.json` | Pins the `wrangler` version and provides npm scripts. |
