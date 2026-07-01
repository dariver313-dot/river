# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
npm run build          # TypeScript → dist/ (tsc)
npm start              # Run built output (node dist/index.js)
npm run dev            # Dev mode (ts-node src/index.ts)

# Encrypt sensitive values for .env
AUTH_SECRET_KEY=xxx npx ts-node src/encrypt.ts
```

There are no tests or lint configured.

## Architecture

This is a **unified authentication proxy** — it manages auth tokens for two downstream gaming platforms so that "robot" services (TG_Aobo, AB_Riskbot, TG_Robot, TG_Riskbot) never hold tokens directly. It runs as an Express server (default port 3100) and exposes proxied REST APIs behind Bearer API-key auth and per-endpoint rate limiting.

### Two-platform design

| | Platform A (澳博体系) | Platform B (娱乐城体系) |
|---|---|---|
| Auth header | `Authorization: Bearer <JWT>` | `X-AUTH-TOKEN` + Cookie |
| Login flow | POST login → POST verify2fa (TOTP) | POST /livepro/backmanager/login (TOTP + SM4-encrypted password) |
| Password encryption | RSA-2048 PKCS#1 v1.5 over MD5 hash | SM4-ECB with key = MD5(timestamp) |
| Response encoding | Plain JSON | SM4-ECB encrypted (key = MD5(token)), with fallback to plain JSON |
| Robots served | TG_Aobo (加款), AB_Riskbot (风控) | TG_Robot (加款), TG_Riskbot (风控) |

### Request flow

```
Robot client → [Bearer API Key auth + rate limit] → Express route → platform module → downstream platform API
                                                                       ↓
                                                              TokenManager (memory cache)
                                                                       ↓
                                                         auto-refresh on expiry / 401
```

- `src/index.ts` — Bootstrap: auto-login on startup, start Express, set up graceful shutdown.
- `src/api.ts` — All routes under `/api/`. Auth middleware (Bearer API key from `BOT_API_KEYS` env), in-memory rate limiting (finance 30/min, query 120/min, setToken 5/min), input validation, error sanitization.
- `src/token-manager.ts` — In-memory token store with per-platform keys (`platform_a`, `platform_b_robot`, `platform_b_risk`). Auto-refreshes every 2 hours (TTL is 4h). Concurrent refresh requests share a single Promise. Expired tokens trigger background refresh.
- `src/platforms/platform-a.ts` — Platform A proxied API calls. Uses Bearer JWT, URLSearchParams-style requests, parallel query limit of 3.
- `src/platforms/platform-b.ts` — Platform B proxied API calls. Uses X-AUTH-TOKEN, SM4 response decryption, retries on 429 with Retry-After, separate base URLs for robot vs risk.

### Crypto modules

- `src/totp.ts` — TOTP (RFC 6238) with zero external dependencies. Base32 decode + HMAC + dynamic truncation → 6-digit code.
- `src/rsa-encrypt.ts` — Login password encryption: MD5 → RSA-2048 PKCS#1 v1.5 → Base64. Compatible with frontend js-md5 + JSEncrypt.
- `src/sm4-crypto.ts` — SM4-ECB decryption for Platform B responses. Tries Node.js native `sm4-ecb` cipher first, falls back to `sm-crypto-v2` library. Key derived from `MD5(token)`.
- `src/crypto-utils.ts` — AES-256-GCM encrypt/decrypt for `.env` secrets. The `env()` helper reads `*_ENC` env vars (decrypting with `AUTH_SECRET_KEY`) and falls back to plain-text env vars for backward compatibility. Decryption results are cached.

### Security properties

- Tokens never touch disk (memory-only, restored via auto-login on restart).
- `AUTH_SECRET_KEY` is never written to `.env` — injected via process environment at startup.
- Sensitive `.env` values (passwords, TOTP secrets) should use the `_ENC` suffix with AES-256-GCM encrypted values (generate with `src/encrypt.ts`).
- API responses sanitize internal errors — stack traces never leak to clients.
- Security headers set on all responses (nosniff, DENY framing, XSS protection, no-cache).

### Key environment variables

See `.env.example` for the full list. The `crypto-utils.ts` `env()` function reads `*_ENC` (encrypted) before falling back to plain-text env vars.

