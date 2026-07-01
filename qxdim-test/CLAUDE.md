# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

企讯达 (QXDIM) IM protocol SDK — a reverse-engineered Node.js implementation of the WildFireChat-based QXDIM instant messaging protocol. The package name published to npm is `qxdim`.

## Commands

```bash
# Apply 7 required MQTT monkey-patches (must run after npm install)
pnpm run patch                # verbose
node scripts/patch-mqtt.js --quiet   # silent (used as predev hook)

# TypeScript type-checking (no emit; source is JS, types are ambient only)
pnpm run typecheck            # tsc --noEmit

# Unit tests (no credentials required)
pnpm test                     # all unit tests (crypto 18 + proto 11 = 29)
pnpm run test:crypto          # AES encryption tests only
pnpm run test:proto           # protobuf codec tests only

# Integration tests (require QXDIM credentials via env vars, ts-node ESM loader)
pnpm run test:integration                     # all 4 test suites
pnpm run test:integration:sdk                 # QXDim SDK basics (6 items)
pnpm run test:integration:session             # Session cache (5 items)
pnpm run test:integration:reconnect           # Reconnection (4 items)
pnpm run test:integration:auto-relogin        # Auto re-login (3 items)

# Run the auto-reply bot (dev mode, requires .env)
pnpm dev                      # = node examples/auto-reply-bot.js (predev hook auto-patches)

# npm publish pipeline
pnpm run prepublishOnly       # typecheck + unit tests (runs before publish)
npm pack --dry-run            # preview published files
```

Integration tests require env vars: `QXDIM_COMPANY_CODE`, `QXDIM_MOBILE_A` / `QXDIM_PASSWORD_A` (and `_B` variants for dual-account tests). See `.env.example` for all configurable vars.

## Architecture

### ESM-only package

The project is `"type": "module"` — all source files use ES module syntax (`import`/`export`). The entry point is `src/index.js`, which re-exports everything from submodules. TypeScript types are ambient declarations only (`types/index.d.ts`, ~600 lines), not compiled from source. `tsconfig.json` is `noEmit: true` and only includes the `.d.ts` files + example TS file for validation — **JS source files are excluded from tsc**.

### Login flow (7-step pipeline)

The core login is in `src/protocol/auto-login.js` and follows the exact browser client behavior:

1. **DNS TXT resolution** (`company-resolve.js`): DoH query to `223.5.5.5` for `<companyCode>.qxdim.top` TXT records → 5 candidate appServer URLs
2. **`/query_company_server`** (`company-server.js`): POST to any candidate → `{appServerHost, imServerHost, proxyServerHost, companyName, ...}`
3. **`/pc_session`** (`pc-session.js`): POST to appServer with `flag:1, device_name:"pc", platform:5` → 5-min pre-session token + JSESSIONID cookie
4. **`/session_login/<token>`** (`session-login.js`): POST (empty body) to activate the pre-session
5. **`/login_pwd`** (`auto-login.js` → `loginWithPassword`): POST `{mobile, password, clientId, platform:5}` with `authToken: <pc_session_token>` header → `{userId, token (encrypted), userName, ...}`
6. **`/route`** (`route.js`): POST encrypted body with appId/appKey/cid/uid/p headers → `{host, wssPort, node, ...}`
7. **MQTT WSS connection** (`mqtt-client.js`): `wss://<host>:<wssPort>`, username=userId, password=AES(tokenPart1, tokenKey), protocolVersion=4 (MQTT 3.1.1)

### Crypto: AES-128-CBC with key-specific quirks

`src/crypto/aes.js` — the encryption has non-standard characteristics:
- **IV = Key** (initialization vector is the same as the encryption key)
- Messages are prefixed with a **4-byte hour-level timestamp** (big-endian, hours since 2018-01-01 UTC)
- Default key is a hardcoded 16-byte array `[0, 17, 34, 51, 68, 85, 102, 119, 120-127]`
- Plaintext is hex-encoded before AES encryption; ciphertext is Base64-encoded
- Supports SM4-CBC as an alternative cipher (toggled via `enableSM4()`/`disableSM4()`)
- Key derivation from strings: first 16 chars' charCodes, zero-padded

### MQTT layer: WildFireChat non-standard protocol

`src/protocol/mqtt-client.js` (`QXDimClient`) wraps `mqtt.js` and handles these protocol violations:

- **PUBACK carries response payload**: Server appends protobuf-encoded response data after the standard PUBACK packet. Standard mqtt.js discards these bytes.
- **CONNACK carries `ConnectAckPayload`**: Server version/time info appended after CONNACK.
- **SUBACK flag bits are non-zero**: MQTT spec requires flags=0 for SUBACK; WFC violates this.
- **`reasonCode=10` is a custom success code**: Standard mqtt.js treats non-zero reasonCodes as errors.

These are handled by **7 monkey-patches** applied by `scripts/patch-mqtt.js` to `node_modules/mqtt-packet` and `node_modules/mqtt`. The patches are **idempotent** (detected via marker comments) and **required** — without them, message sending and receiving silently break. The `predev` npm hook auto-runs patching before `pnpm dev`.

### Two-tier API design

- **High-level**: `class QXDim` (`src/qxdim.js`) — one-line `login()`, `sendText()`, `sendImage()`, `sendVideo()`, `sendMedia()`, callback-based event model (`onMessage`, `onStatusChange`, `onReconnect`, `onKickedOff`, `onRelogin`), auto-reconnection, auto-re-login on token expiry. This is the **recommended API for new code**.
- **Low-level**: Individual functions exported from `src/index.js` — `autoLogin()`, `resolveCompanyAppServers()`, `queryCompanyServer()`, `getPcSession()`, `sessionLogin()`, `loginWithPassword()`, `requestRoute()`, `QXDimClient` (manual MQTT lifecycle), `parseMessageContent()`, etc. Use for diagnostics or when you need to control each step.

### Session persistence

`src/protocol/session-store.js` persists login state to `config/sessions/<normalized_mobile>.json`. This avoids re-running `/login_pwd` (which invalidates previous tokens) and prevents multi-device kick-off. Session files contain sensitive data (token, tokenKey, privateSecret) and are gitignored. Cache is trust-first (no TTL enforcement); on failure, the upper layer should `clearSession()` and retry.

### Message flow

1. **Sending**: `QXDim.sendText()` → `QXDimClient.sendMessage()` → protobuf-encode → AES-encrypt with tokenKey → PUBLISH to topic `MS` → server responds via PUBACK payload (protobuf `SendMessageResult`, decrypted with tokenKey)
2. **Receiving**: Server PUBLISHes to subscribed topics (`MS`, `MN`, `GMN`, `FN`, etc.) → payload is **plaintext protobuf** (not encrypted) → decode → dispatch to `onMessage` callbacks
3. **History pull**: PUBLISH to topic `MP` → PUBACK response contains `PullMessageResult` (fields: message=1, current=2, head=3 — note this is non-standard ordering)

### Module organization

| Directory | Purpose |
|---|---|
| `src/protocol/` | All HTTP API calls + MQTT client + session store |
| `src/crypto/` | AES-128-CBC / SM4 encryption |
| `src/proto/` | protobufjs dynamic loader (loads `proto/qxdim.proto` at runtime) |
| `src/utils/` | Message parser, HTTP helpers, input validation, logger |
| `src/ai/` | DeepSeek API client + conversation store + auto-reply bot |
| `tests/` | Unit tests (JS) + integration tests (TS, run via ts-node ESM) |
| `tools/` | Reverse-engineering / diagnostic CLI utilities |
| `scripts/` | `patch-mqtt.js` (7 monkey-patches) |
| `examples/` | Runnable demos (SDK usage, dual-account chat, E2E tests) |
| `config/` | `config.js` (gitignored) + `sessions/` (auto-generated, gitignored) |
| `proto/` | `qxdim.proto` — 129 message type definitions |
| `types/` | `index.d.ts` — ambient TypeScript declarations for the npm package |

### Key protocol constants

- **MQTT protocol version**: 4 (MQTT 3.1.1), not WFC-native 6
- **Platform ID**: 5 = Web
- **Content types**: Text=1, Voice=2, Image=3, Location=4, File=5, Video=6, Sticker=7, plus streaming text types (14-15), PTT types (21-24), etc. — full enum in `src/utils/message-parser.js`
- **Connection statuses**: UNCONNECTED=0, CONNECTING=1, CONNECTED=2, RECEIVING=3, KICKED_OFF=7 — in `src/protocol/mqtt-client.js`

### Phone number format

Must be `+86 <11-digit>` with a space between country code and number. Bare 11-digit numbers are rejected by the server as "invalid phone number."
