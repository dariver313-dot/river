# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
tsx index.ts              # Start the bot
tsx watch index.ts        # Development with hot-reload
npx tsc --noEmit          # TypeScript type check only
npx prisma db push        # Sync schema to SQLite
npx prisma generate       # Regenerate Prisma client
npx prisma studio         # Open Prisma Studio GUI
```

**npm scripts**: `npm run dev` (watch mode), `npm start`, `npm run start:local`, `npm run db:push`, `npm run db:generate`, `npm run db:studio`.

## Architecture

This is a Telegram bot for **withdrawal risk control monitoring** on a gambling platform. It evaluates every withdrawal order against ~30 configurable risk rules and sends alerts to a Telegram group where admins can mark violations as reviewed.

### Data Flow

```
Withdrawal Order (WebSocket push OR HTTP polling)
  → evaluator.ts: fetch member details, bets, withdrawal history from platform API
  → Game checkers (lhc/ssc/k3/pk10-checker.ts): analyze bet patterns for R24/R25
  → rule-engine.ts: run all enabled rules, skip already-reviewed rules for this order
  → Save to RiskEval table + send Telegram notification
  → Admin clicks "人工审核" → RuleFeedback record → rule won't re-trigger for this order
```

### Rules Architecture (3-file split)

The rule system is split across three files for maintainability:

| File | Role |
|------|------|
| `rule-types.ts` | Interfaces: `RiskRule`, `RuleContext`, `RuleResult`, `EvaluationResult` |
| `rules.ts` | All rule definitions (~1400 lines) as `export const rules: RiskRule[]`. Each rule has: id, name, severity, weight, group, enabled flag, optional `precondition`, and `evaluate(ctx)` function. Helper functions for two-side detection, channel normalization, association scoring live here too. |
| `rule-engine.ts` | Execution engine: `evaluateRules()` iterates enabled rules, skips handled ones, aggregates group scores, computes risk level. Also manages per-order feedback and member periods explicitly cleared by an operator. |
| `risk-data-loader.ts` | Builds independent order-day, rolling lottery-history, recharge, and successful-withdrawal windows; fetches only data required by enabled rules and reports completeness. |

**Rule groups** and their max per-group score caps: `identity` (80), `association` (80), `behavior` (80), `environment` (60), `marking` (80). Group scores are capped individually, then summed for the total score.

**Risk level thresholds**: totalScore ≥ 50 → CRITICAL, ≥ 30 → HIGH, ≥ 15 → MEDIUM, else LOW.

### Key Files

| File | Role |
|------|------|
| `index.ts` | Main entry: env/config loading, HTTP server via `server.ts`, polling loop, WebSocket dispatch via `ws-client.ts`, notification pipeline with dedup (`notifyingLocks` map), retry tracking with LRU cache |
| `telegram.ts` | Telegram bot (grammy): `/bind` (bind chat ID), inline keyboards for "人工审核", "团体画像", and "团体对打", circuit breaker on TG failures (3 failures → 5min cooldown), rate limiting (1.5s per user) |
| `evaluator.ts` | Order evaluation pipeline: fetches member info, bets, withdrawals, third-party game orders, payment orders, recharge summaries from platform API. Builds `RuleContext` with all LRU caches. Also updates `MemberProfile`/`AgentProfile` aggregates after evaluation. |
| `api-client.ts` | Compatibility API client that delegates platform calls to `auth-client.ts` / auth-service, with login-log pagination and abort propagation |
| `ws-client.ts` | WebSocket client for real-time withdrawal push (ping/pong at 30s, exponential backoff 1s→60s, max 30 retries, domain resolution from API) |
| `server.ts` | HTTP server module extracted from index.ts. Uses `ServerDeps` interface for dependency injection. Provides routes documented below. |
| `db.ts` | Prisma/SQLite: auto-creates DB dir, migrates from legacy paths, DDL fallback on push failure. Corrupted DB files are archived and startup stops unless `ALLOW_DB_REBUILD=true` is explicitly set |
| `lhc-checker.ts` | LHC/六合彩 bet analysis: 特码, 正特, 两面, 半波, 尾数, 不中, etc. with per-amount grouping dedup |
| `ssc-checker.ts` | SSC/时时彩 bet analysis: 两面, 斗牛, 1-5球, 前中后 |
| `k3-checker.ts` | K3/快三 bet analysis: 和值, 独胆, 二不同号, 三不同号 |
| `pk10-checker.ts` | PK10/赛车/飞艇 bet analysis: 两面, 冠亚和, 1-5名, 6-10名, 特殊 |
| `utils.ts` | Time parsing (`parseTimeStr`), numeric formatting, proxy code extraction, and Beijing time formatting. |
| `sm4-crypto.ts` | SM4 ECB decryption for platform API responses |
| `constants.ts` | Agent whitelists (defaults + DB-backed reload from `BotConfig`) |
| `logger.ts` | Pino logger with colorized console output |
| `types.ts` | TypeScript interfaces for API responses, bets, members, orders |

### HTTP API Routes (server.ts)

All routes except `/` and `/health` require Bearer token auth (timing-safe comparison against API token).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Status overview: token status, eval count, last poll time, recent evals |
| GET | `/health` | Health check: API connectivity, WS status, cache sizes |
| GET | `/api/status` | Detailed status with high-risk eval count |
| GET | `/api/evals?page=N&pageSize=N&riskLevel=X` | Paginated evaluation results |
| GET | `/api/rules` | List all rules with id/name/enabled state |
| POST | `/api/rules` | Toggle rule enabled state (`{ruleId, enabled}`). Clears eval cache and persists to DB. |

### Database (SQLite via Prisma)

- **RiskEval** — one per order (`orderId` unique). Stores score, risk level, triggered rules JSON, notification status
- **RuleFeedback** — admin review records. Links to `RiskEval.id` via `evalId`. Used by `handledRules` to skip reviewed rules. Stores `periodInfo` for game-checker rules (R24/R25/R26/R27)
- **MemberProfile** / **AgentProfile** — aggregated risk statistics
- **BotConfig** — key-value store for notification and rule settings
- **SuccessfulWithdrawal** — idempotent successful-withdrawal ledger used for receiving-method and same-receiver history

### Two-Level Review Dedup (Critical for correctness)

1. **Per-order `handledRules`**: `rule-engine.ts:evaluateRules()` queries `RuleFeedback` records for the **current order's evalId** and skips those rules. This is per-order, NOT per-member — fixing a previous bug where reviewing one order would silence rules for all subsequent orders by the same member. The cache is warmed in `index.ts` with `warmHandledRulesCache()` using orderId as the cache key.

2. **Per-member `reviewedPeriodKeys`**: For game-checker rules (R24/R25), `evaluateRules()` also loads a per-member set of already-reviewed lottery periods from `RuleFeedback.periodInfo` plus periods from orders older than 5 minutes. This prevents new orders from the same member re-triggering R24/R25 for the same lottery period that was already manually reviewed. Cache managed by `getMemberReviewedPeriods()` / `invalidateMemberReviewedPeriods()`.

### Game Checker Patterns

All four checkers follow the same pattern:
- Parse `BetRecord.numbers` into prefixed segments
- R24 (对打): detect mutually exclusive attributes (大↔小, 单↔双, 龙↔虎) → score 40
- R25 (覆盖超限): count unique items, flag if over limit → score 15
- Return `{ twoSideViolations[], coverageViolations[], periodInfo, maxScoreR24, maxScoreR25 }`
- Results cached on `RuleContext._lhcResult` / `._sscResult` / `._k3Result` / `._pk10Result` to avoid double computation

Only `lhc-checker.ts` has per-amount grouping (特码/正特 compute `perAmt = totalAmt / (nums.length + 1)`). The other three checkers simply count unique items into `Set<string>` — they don't need same-amount dedup.

### WebSocket Order Processing

`index.ts` uses a concurrent queue (max 3 parallel evaluations) with LRU-based caching:
- `evaluatedOrderCache`: LRU of already-evaluated orderIds (2hr TTL)
- `evalRetryCount`: tracks retry attempts per order+source (max 3); expired entries get a LOW fallback record to avoid infinite retries
- `notifyingLocks`: Map-based CAS to prevent concurrent notifications for the same order
- `evaluatingMembers` map (in evaluator.ts) to prevent concurrent evaluation of the same member

### Key Concurrency Pattern

The `api-client.ts` uses a semaphore (max 60 concurrent requests) with a pending queue. The `evaluator.ts` deduplicates concurrent evaluations for the same member via `evaluatingMembers` map — second caller reuses the in-flight promise.

### LRU Cache Inventory

Evaluator has multiple LRU caches, all exported for use by other modules:
- `memberCache` (500 entries, 5min TTL) — member info
- `ipMemberCache` / `deviceMemberCache` (2000 entries, 1hr TTL) — IP/device association
- `receivingInfoCache` (5000 entries, 10min TTL) — receiving name+card → memberIds
- `agentWithdrawCache` (500 entries, 30min TTL) — proxy code → withdrawing members
- `payChannelCache` (5000 entries, 10min TTL) — payment channel → memberIds

### Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/bind` | Bind the current group as notification target |

### Encryption

- **Platform API**: SM4 ECB with PKCS#7 padding, key derived via MD5(token), responses Base64-encoded. Legacy protocol, cannot be changed.
- Platform tokens remain in `auth-service`; this bot stores no upstream platform token.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `AUTH_SERVICE_URL` | Yes | `http://localhost:3100/api/platform-b` | auth-service platform-b endpoint |
| `AUTH_API_KEY` | Yes | — | Bearer key accepted by auth-service |
| `ADMIN_USER_IDS` | No | `8373296041` | Telegram admin IDs allowed to bind chat, run heavy queries, and click review buttons |
| `WS_ENABLED` | No | `true` | Enable WebSocket push |
| `POLL_INTERVAL` | No | `25` | HTTP polling interval in seconds |
| `PORT` | No | `0` (random) | HTTP server port |
| `HOST` | No | `0.0.0.0` | HTTP bind address; use `127.0.0.1` when only local health checks are needed |
| `NOTIFY_CHAT_ID` | No | DB binding | Fixed Telegram notification chat; `/bind` persists it when omitted |
| `DATABASE_URL` | No | project SQLite file | Optional custom SQLite location |
| `TZ_OFFSET` | No | `8` | Timezone offset (UTC+8) |
| `RISK_FINGERPRINT_SECRET` | Yes | — | Dedicated HMAC secret for receiving-name/card fingerprints |
| `ALLOW_DB_REBUILD` | No | `false` | If `true`, archive corrupted SQLite files and rebuild a fresh DB; keep `false` in production unless recovery is intentional |
| `AUTH_CLIENT_CONCURRENCY` | No | `8` | Max concurrent normal auth-service requests |
| `AUTH_CLIENT_LOGIN_LOG_CONCURRENCY` | No | `2` | Max concurrent login-log requests |
| `WS_CONCURRENCY` | No | `3` | Max concurrent WebSocket order evaluations |
| `POLL_EVAL_MAX_CONCURRENCY` | No | `8` | Max concurrent HTTP polling order evaluations |
| `NOTIFY_CONCURRENCY` | No | `5` | Max concurrent risk notifications |
| `REPLAY_NOTIFY_CONCURRENCY` | No | `5` | Max concurrent retries for previously unnotified risk evaluations |
| `PREFETCH_BATCH_SIZE` | No | `10` | Batch size for member detail prefetch in polling mode |
| `DAILY_LOGIN_MAX_PAGES` | No | `3` | Pages fetched for automatic same-day IP/device association rules |
| `DAILY_LOGIN_PAGE_SIZE` | No | `50` | Page size for automatic same-day login association lookup |
| `PROFILE_LOGIN_MAX_PAGES` | No | `10` | Pages fetched by Telegram group-profile / hedge buttons |
| `PROFILE_LOGIN_PAGE_SIZE` | No | `50` | Page size for Telegram heavy login queries |
| `HEAVY_QUERY_CONCURRENCY` | No | `2` | Max concurrent Telegram group-profile / hedge button queries |
| `PROXY_BLACKLIST` | No | — | Comma-separated high-risk agent codes (R31) |
| `AGENT_WHITELIST` | No | hardcoded defaults | Comma-separated agent whitelist (overrides defaults) |
| `RISK_REMARK_KEYWORDS` | No | hardcoded defaults | Comma-separated keywords for suspicious remark detection (R17) |
| `CORS_ORIGIN` | No | `http://127.0.0.1:3000` | CORS origin for HTTP API |
