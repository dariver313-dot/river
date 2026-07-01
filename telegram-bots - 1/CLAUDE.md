# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Each service is independently developed. Run these from the service's own directory.

### TypeScript bots (AB_Riskbot, TG_Riskbot) — pnpm

```bash
pnpm install           # First time: installs deps + runs postinstall (prisma generate in AB_Riskbot)
pnpm dev               # Hot-reload via tsx watch
pnpm start             # Production (tsx)
pnpm db:push           # Sync Prisma schema → SQLite (TG_Riskbot auto-runs this on startup)
pnpm db:generate       # Regenerate Prisma client
pnpm db:studio         # Open Prisma Studio GUI
npx tsc --noEmit       # Type-check only
```

### auth-service — npm

```bash
npm install            # First time setup
npm run build          # TypeScript → dist/ (tsc)
npm start              # Run built output (node dist/index.js)
npm run dev            # Dev mode (ts-node)
npx ts-node src/encrypt.ts  # Generate AES-256-GCM encrypted values for *_ENC .env vars
```

### JS recharge bots (TG_Aobo, TG_Robot, TG_Tianyou) — pnpm or npm

```bash
pnpm install           # First time: better-sqlite3 is a native module, needs build tools (Python, C++ compiler)
pnpm dev               # Hot-reload via nodemon (watches app.js + .env via nodemon.json)
pnpm start             # Production (node)
pnpm run prod          # Production with NODE_ENV=production

# PM2 (TG_Aobo and TG_Tianyou only — TG_Robot does not use PM2)
pnpm run pm2:start     # Start via PM2
pnpm run pm2:stop     # Stop PM2 process
pnpm run pm2:restart  # Restart PM2 process
pnpm run pm2:logs     # Tail PM2 logs
```

All JS bots use `nodemon.json` to watch `.env` for changes and auto-restart on config edits.

There are no tests, no lint, and no CI/CD in any of the projects.

## Monorepo Overview

This is a **gambling-platform operations toolkit** — a collection of 6 Node.js services that automate recharge (加款) operations and risk-control (风控) monitoring for two downstream gaming platforms via Telegram bots.

### Two platforms

| | Platform A (澳博体系) | Platform B (娱乐城体系) |
|---|---|---|
| Auth mechanism | Bearer JWT | Session cookie + SM4-encrypted responses |
| Recharge bot | `TG_Aobo` | `TG_Robot` |
| Risk-control bot | `AB_Riskbot` | `TG_Riskbot` |

The `auth-service` is a **centralized token proxy** — it holds and refreshes platform auth tokens so that downstream bots never manage tokens directly. `TG_Aobo` and `TG_Robot` route all API calls through it. `AB_Riskbot` and `TG_Riskbot` also proxy through auth-service via `auth-client.ts`. `TG_Tianyou` is the exception — it's a standalone recharge bot that manages its own tokens and talks directly to its platform API.

### Service map

```
                    ┌──────────────┐
                    │ auth-service  │  Port 3100, TypeScript/Express
                    │ token proxy   │  Manages Platform A + B tokens
                    └──┬────────┬──┘
                       │        │
          ┌────────────┘        └────────────┐
          ▼                                  ▼
    ┌──────────┐                      ┌──────────┐
    │ TG_Aobo  │  Port 40003          │ TG_Robot │  Port 40001
    │ recharge │  Plain JS/Telegraf   │ recharge │  Plain JS/Telegraf
    │ PlatformA│                      │ PlatformB│
    └──────────┘                      └──────────┘

    ┌──────────┐                      ┌──────────┐
    │AB_Riskbot│  Port 40004          │TG_Riskbot│  Port 40002
    │ risk ctrl│  TypeScript/grammy   │ risk ctrl│  TypeScript/grammy
    │ PlatformA│  + Prisma/SQLite     │ PlatformB│  + Prisma/SQLite + WebSocket
    └──────────┘                      └──────────┘

    ┌──────────┐
    │TG_Tianyou│  Port 3289
    │ recharge │  Plain JS/Telegraf
    │ standalone│ Direct API (no auth-service)
    └──────────┘
```

### Shared patterns across bots

All bots share a common architecture:
- **Telegram bot** (Telegraf for JS bots, grammy for TS bots) as the primary interface
- **Express HTTP server** with `/health` and `/` endpoints for process monitoring
- **SQLite** database with WAL mode for persistence (better-sqlite3 in JS bots, Prisma in TS bots)
- **Custom structured logging** with configurable log levels
- **Circuit breaker** for API failure handling
- **Concurrent execution** with configurable concurrency limits
- **SIGINT/SIGTERM** graceful shutdown with cleanup of HTTP agents, DB connections, and timers

### API proxy layering (risk bots only)

Both risk bots use a two-layer API proxy:

1. **`auth-client.ts`** — thin auth-service proxy: auth headers, POST to auth-service endpoints, retries on failure. Nearly identical between AB_Riskbot and TG_Riskbot (only the default platform URL differs).
2. **`api-client.ts`** — wraps `auth-client.ts` with domain-specific field mapping (snake_case ↔ camelCase), type conversion, and business logic. Maintains the original `ApiClient` interface for compatibility with evaluator/rule-engine code.

### TG_Tianyou — key differences from other recharge bots

TG_Tianyou is standalone and differs from TG_Aobo/TG_Robot in several ways:
- **No auth-service dependency** — manages its own API tokens and talks directly to its platform API
- **Richer configuration** — uses a `CFG` object pattern with extensive remark aliases, two-group routing (Group A / Group B), and per-item business rules
- **No NODE_OPTIONS** in its start script (unlike all other services which set `--dns-result-order=ipv4first`)
- **Two Telegram groups** — routes low-risk items to Group A, high-risk items to Group B with separate confirmation flows
- **No SM4 crypto** (Platform B only) — TG_Robot is the only JS recharge bot with `gm-crypto` dependency

### Sub-project CLAUDE.md files

Each TypeScript project has its own detailed CLAUDE.md:
- `AB_Riskbot/CLAUDE.md` — Risk evaluation flow, rule engine, game checkers, LRU cache inventory, dedup strategy
- `TG_Riskbot/CLAUDE.md` — Same architecture, Platform B variant, WebSocket order processing, two-level review dedup
- `auth-service/CLAUDE.md` — Two-platform token proxy design, crypto modules, security properties

AB_Riskbot also has a custom Claude Code skill at `.claude/skills/run-ab-riskbot/` with a driver for pure-logic smoke testing (26 assertions, no network needed).

The three JS recharge bots (`TG_Aobo`, `TG_Robot`, `TG_Tianyou`) do not have their own CLAUDE.md files but share a near-identical monolithic `app.js` structure (~1800 lines each) covering: config → DB → HTTP client → API calls → message parser → classifier → executor → reporter → Telegram wrappers → bot setup → Express server → startup/shutdown.

## Key crypto decisions

- **Platform A**: RSA-2048 PKCS#1 v1.5 for password encryption, TOTP RFC 6238 for 2FA
- **Platform B**: SM4-ECB for both request encryption and response decryption, key derived via MD5
- **Token at rest** (TG_Riskbot/AB_Riskbot): AES-256-GCM with `ENCRYPTION_KEY` env var
- **auth-service**: Tokens are memory-only, auto-login on restart — never touch disk. Sensitive `.env` values use AES-256-GCM encryption (`*_ENC` suffix) decrypted at runtime by `AUTH_SECRET_KEY` (which is itself injected via process environment, never in `.env`).
- All crypto is implemented with Node.js built-in `crypto` module — zero external crypto dependencies (with the sole exception of `gm-crypto` / `sm-crypto-v2` as optional SM4 fallbacks in auth-service and TG_Riskbot).

## Development notes

- The three JS bots (`TG_Aobo`, `TG_Robot`, `TG_Tianyou`) are **plain JavaScript CommonJS** with `nodemon` for dev. Each has a `nodemon.json` that watches `app.js` and `.env`, and ignores `*.db` files.
- The TypeScript bots (`AB_Riskbot`, `TG_Riskbot`) use `tsx watch` for hot-reload.
- `auth-service` compiles TypeScript → `dist/` via `tsc`, then runs with `node dist/index.js`. Dev mode uses `ts-node`.
- **Package managers are mixed**: AB_Riskbot and TG_Riskbot use pnpm. auth-service uses npm. The JS bots (TG_Aobo, TG_Robot, TG_Tianyou) have both `pnpm-lock.yaml` and `package-lock.json` — pnpm is preferred for them, but either works.
- There is **no shared monorepo tooling** (no workspace config, no root package.json) — each service is independently installable and deployable.
- No test suites exist in any of the projects.
- Database schemas are auto-created on startup; the JS bots use raw DDL with `better-sqlite3` (native module, needs build tools), the TS bots use Prisma with inline DDL fallback in `db.ts` if `prisma db push` fails.
- All services use `NODE_OPTIONS=--dns-result-order=ipv4first` to force IPv4 DNS resolution (needed on IPv6-enabled hosts where the platform APIs only listen on IPv4). Exception: TG_Tianyou does not set this in its package.json scripts.
- TG_Riskbot has a **WebSocket client** (`ws-client.ts`) for real-time withdrawal push notifications — unique among the bots (others poll via HTTP only).
- Each service has a `.claude/settings.local.json` with pre-approved permissions for its common commands.
