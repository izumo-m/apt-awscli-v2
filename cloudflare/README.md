# Cloudflare Worker — Source and Local Dev

This directory contains the Worker script source (`index.js`) and a minimal
Wrangler harness for **local development and live log inspection only**.

## Production deployment is managed by Pulumi

The Worker is deployed by `pulumi up` from `../pulumi/`, which uploads
`index.js` as the `apt-awscli-v2-proxy` Worker and binds `ORIGIN_BASE_URL`
from `aptAwscliV2:s3Uri`. **Do not run `wrangler deploy` from this
directory** — it is intentionally not exposed in `package.json`.

See [`../pulumi/README.md`](../pulumi/README.md) §Cloudflare Operations for
deployment, custom domain setup, token permissions, and cache purge.

## Files

| File           | Purpose                                                                              |
|----------------|--------------------------------------------------------------------------------------|
| `index.js`     | Worker source (master). Pulumi reads this file at `pulumi up` time.                  |
| `wrangler.toml`| Minimal config for `wrangler dev` / `wrangler tail`. No deploy settings here.        |
| `package.json` | Pins wrangler and exposes `dev` / `tail` / `whoami`.                                 |
| `.dev.vars`    | Gitignored. Holds `ORIGIN_BASE_URL` for local `wrangler dev`.                        |
| `.dev.vars.example` | Template for `.dev.vars`.                                                       |

## Local Development

```bash
cd cloudflare
npm ci
cp .dev.vars.example .dev.vars   # then edit with your S3 origin URL
npm run dev                       # http://localhost:8787
```

`.dev.vars` is gitignored. Example contents:

```
ORIGIN_BASE_URL=https://your-bucket.s3.amazonaws.com/apt
```

## Live Log Inspection (production)

```bash
cd cloudflare
npm run tail          # streams console.log output from the deployed Worker
```

Requires you to be authenticated:

```bash
npm run whoami
# If not logged in:
npx wrangler login    # opens browser for OAuth (operator-only, one-time)
```

## Debugging Workflow

```
1. Edit cloudflare/index.js
        ↓
2. cd cloudflare && npm run dev          # localhost:8787, validate behavior
        ↓ (looks good)
3. cd ../pulumi && pulumi preview        # confirms Worker content hash diff
        ↓
4. pulumi up                              # deploys via Pulumi
        ↓
5. (optional) cd ../cloudflare && npm run tail   # observe production logs
6. curl -I https://<your-custom-domain>/         # smoke-test
```

`wrangler dev` reads `wrangler.toml` for the script name / module entry, so
the local environment matches production except for bindings (which come
from `.dev.vars` locally instead of from Pulumi).
