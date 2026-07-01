# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (hot-reload with tsx watch)
npm run dev

# Production start
npm run start

# Database operations
npm run db:push      # Sync Prisma schema to SQLite
npm run db:generate  # Regenerate Prisma client
npm run db:studio    # Open Prisma Studio GUI

# Type-check only (no emit)
npx tsc --noEmit
```

## Architecture

This is a **Telegram risk-control monitoring bot** (提现风控提醒机器人) v5.0. It monitors withdrawal orders from a gambling platform API, evaluates them against risk rules, and sends alerts to a Telegram group.

### Data flow

1. **Polling** (`index.ts`) — Fetches pending withdrawal orders from the platform API every N seconds. On completion, it also triggers `recoverCompletedOrders` to detect missed orders.
2. **Evaluation** (`evaluator.ts`) — For each order, fetches member details, bet records, withdrawal history, payment orders, and third-party game orders from the platform API. Caches results in multiple `LRUCache` instances. Results are fed into the rule engine.
3. **Rule engine** (`rule-engine.ts`) — Iterates all enabled `RiskRule` instances (defined in `rules.ts`), runs each rule's `evaluate()` against the `RuleContext`, accumulates scores grouped by risk category (identity/association/behavior/marking), and computes a final risk level: LOW / MEDIUM / HIGH / CRITICAL.
4. **Notification** (`telegram.ts`) — Sends risk alerts to a Telegram group via grammy bot. High/CRITICAL/MEDIUM orders get inline keyboards for manual review, hedge-check queries, and association queries. Orders with betting violations (R24-R27) that remain unreviewed for 3 minutes get auto-reviewed.
5. **Persistence** (`db.ts`) — SQLite via Prisma. All evaluated orders are stored in `RiskEval`. Member and agent profiles (`MemberProfile`, `AgentProfile`) track evaluation history over time. `RuleFeedback` records human review actions. `BotConfig` stores runtime state (token, notify chat ID, rule toggle states).
6. **HTTP server** (`server.ts`) — Exposes `/health`, `/api/status`, `/api/evals`, and `/api/rules` endpoints. Protected by crypto.timingSafeEqual token auth. The server depends on module-level state via `ServerDeps` interface injection.
7. **Auto-login** (`auto-login.ts`, `totp.ts`, `rsa-encrypt.ts`) — Automatic two-step login + TOTP 2FA when token expires. MD5+RSA-2048 password encryption and TOTP code generation using only Node.js built-in `crypto`.

### Key files

| File | Purpose |
|---|---|
| `index.ts` | Entry point — wires all modules together, runs polling/recovery/watchdog timers |
| `evaluator.ts` | Fetches and caches all member data needed for rule evaluation |
| `rules.ts` | ~30 risk rule definitions (R01–R40) — identity, association, behavior, marking groups |
| `rule-engine.ts` | Executes rules, handles handled-rule caching, group score capping |
| `telegram.ts` | Grammy bot — token setup, commands, alert sending, callback handling, auto-review |
| `api-client.ts` | Axios wrapper for platform REST API with retry, rate limiting, connection pooling, auto-login on 401 |
| `db.ts` | Prisma/SQLite setup with schema verification, DDL fallback, corruption auto-recovery, connection_limit=1 |
| `server.ts` | HTTP server for health checks and rule management |
| `auto-login.ts` | Two-step login orchestrator (login → TOTP 2FA → token) with concurrent dedup and exponential backoff |
| `totp.ts` | TOTP 6-digit code generator (RFC 6238, zero deps) |
| `rsa-encrypt.ts` | Password encryption: MD5 → RSA-2048 PKCS#1 v1.5 → Base64 (zero deps) |
| `lhc-checker.ts` / `ssc-checker.ts` / `k3-checker.ts` / `pk10-checker.ts` | Lottery-specific bet pattern analyzers for R24 (mutual-direction bets) and R25 (coverage limit) rules |
| `constants.ts` | Agent whitelist management (env → DB override) |
| `types.ts` | Shared TypeScript interfaces for API responses and domain objects |

### Deduplication / concurrency

- **evaluatedOrderCache**: LRU cache prevents re-evaluating the same order across concurrent evaluation paths.
- **evaluatingMembers**: Promise-sharing map ensures the same member is never evaluated concurrently.
- **notifyingLocks**: Per-order promise map serializes notifications to avoid duplicate alerts.
- **handledRulesCache**: Prevents rules already marked as "reviewed" from re-firing on the same order.
- **reviewedPeriodKeys**: Prevents re-alerting on lottery period numbers that have already been reviewed.

### Risk level thresholds

- **LOW**: totalScore < 15
- **MEDIUM**: totalScore >= 15
- **HIGH**: totalScore >= 30
- **CRITICAL**: totalScore >= 50

Group scores are capped: identity/association/behavior/marking at 80, environment at 60.

### Environment variables

Required: `API_BASE_URL`, `TELEGRAM_BOT_TOKEN`, `DATABASE_URL` (auto-generated for SQLite if unset).  
Optional (auto-login): `AUTO_LOGIN_ACCOUNT`, `AUTO_LOGIN_PASSWORD`, `TOTP_SECRET`, `RSA_PUBLIC_KEY`.  
Optional: `POLL_INTERVAL`, `TZ_OFFSET`, `PORT`, `LOG_LEVEL`, `ENCRYPTION_KEY`, `PROXY_BLACKLIST`, `AGENT_WHITELIST`, `RISK_REMARK_KEYWORDS`, `CORS_ORIGIN`, `API_TIMEOUT`, `API_CONNECT_TIMEOUT`.

### Auto-login

When `AUTO_LOGIN_ACCOUNT` / `AUTO_LOGIN_PASSWORD` / `TOTP_SECRET` / `RSA_PUBLIC_KEY` are set, the bot will:
- On startup: validate the saved token via `checkHealth()`, and if expired, perform the two-step login + TOTP 2FA flow automatically.
- Every 11 hours: proactively renew the token before the ~12h expiry.
- On any API 401: attempt auto-login once and retry the failed request.
- Fallback: if auto-login fails 3 times, clear the token and wait for manual input in Telegram (existing behavior).

Encryption: MD5(password) → RSA-2048 PKCS#1 v1.5 → Base64 URL-encoded. TOTP: standard 30s window, 6-digit, HMAC-SHA1. All implemented with Node.js built-in `crypto` — zero external dependencies.

### Database

SQLite via Prisma with WAL mode and `busy_timeout=5000`. Schema is synced via `prisma db push` on startup with an inline DDL fallback. Tables: `RiskEval`, `RuleFeedback`, `BotConfig`, `MemberProfile`, `AgentProfile`. DB file lives at `prisma/db/riskbot.db` by default.
