# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Telegram reminder bot — a single-file Node.js app (`app.js`) that sends scheduled reminders to Telegram chats. Uses long-polling (not webhooks).

## Commands

```bash
# Install dependencies
npm install

# Run the bot
node app.js

# Run with specific environment file
node --env-file=.env app.js
```

There are no tests, linters, or build steps in this project.

## Environment

- `BOT_TOKEN` — Telegram Bot API token (required)
- `TIMEZONE` — IANA timezone for trigger calculations (default: `Asia/Shanghai`)

## Architecture

### Tech stack
- **Telegraf 4** — Telegram Bot framework (polling mode via `bot.launch()`)
- **better-sqlite3** — Synchronous SQLite with WAL mode
- **dotenv** — Environment variable loading

### Database (`reminders.sqlite`, single table `reminders`)

The schema is auto-created via `CREATE TABLE IF NOT EXISTS`. Column migrations are done inline by checking `pragma table_info(reminders)`.

Key columns:
- `rule_type` — one of: `absolute` (one-time date), `daily`, `weekly`, `monthly`, `yearly`
- `rule_value` — the date/day/weekday/month-day string (format varies by type)
- `rule_time` — `HH:MM` trigger time (defaults to `00:00`, null for daily since time is in `rule_value`)
- `repeat_interval_minutes` — 0 = remind once; >0 = repeat every N minutes within the trigger day
- `last_remind_time` — Unix timestamp of last reminder sent (used to avoid duplicate sends and enforce repeat intervals)
- `last_completed_date` — `YYYY-MM-DD` string; when set to today, the reminder won't trigger again that day
- `target_user_id` / `target_user_name` — optional @mention targets in the reminder message

### Check loop

`scheduleCheck()` runs `checkAndRemind()` every `CHECK_INTERVAL_SECONDS` (30s). It:
1. Queries all "active" reminders (where `last_completed_date != today` and, for `absolute` type, `rule_value >= today`)
2. For each, calls `shouldRemind()` which checks: not snoozed, date match, time reached, and (for repeat) interval elapsed since last remind
3. Sends the reminder via Telegram, then either marks `last_remind_time` or auto-deletes one-shot absolute reminders

### Rule parsing

The `parseRule()` function converts user-facing rule strings into `{ruleType, ruleValue, ruleTime}`:
| Input pattern | Type | Example |
|---|---|---|
| `YYYY-MM-DD[@HH:MM]` | `absolute` | `2026-09-25@09:00` |
| `M-D[@HH:MM]` | `monthly` | `M-5@09:00` |
| `MM-DD[@HH:MM]` | `yearly` | `12-25@08:00` |
| `HH:MM` | `daily` | `20:00` |
| `W-D[@HH:MM]` | `weekly` | `W-3@14:30` (1=Mon…7=Sun) |

Repeat is specified as `every Nm` or `everyNm` after the rule.

### Command parsing flow

Input text → split on whitespace → `parseReminderParts()` extracts optional leading/trailing @users → `parseRule()` on the rule token → `parseRepeatParams()` on remaining tokens.

### User mention handling

Two sources of @user info:
1. **Text mentions**: `@username` tokens in the command text (stored as JSON array in `target_user_name`)
2. **Telegram entities**: `text_mention` or `mention` entities parsed via `getMentionedUserInfo()`

### Key design decisions
- **Synchronous DB**: better-sqlite3 is synchronous — all DB calls block the event loop briefly. This is acceptable given the bot's scale.
- **In-memory state**: `snoozeMap` (snooze timers), `rateLimitMap` (per-user rate limiting at 1 req/s), `userDisplayNameCache` (1-hour TTL) are all in-memory and lost on restart.
- **Graceful shutdown**: `SIGINT`/`SIGTERM` handlers clear timers, stop polling, and close the DB.
- **Pagination**: `/list` shows 5 reminders per page with inline keyboard navigation.
- **No migrations framework**: Schema changes are done by checking `pragma table_info` at startup and running `ALTER TABLE` for missing columns.
