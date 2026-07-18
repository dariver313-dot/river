const path = require("path");
const APP_DIR = __dirname;

require("dotenv").config({ path: path.join(APP_DIR, ".env"), quiet: true });

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const fs = require("fs");
const https = require("https");
const express = require("express");
const axios = require("axios");
const Database = require("better-sqlite3");
const { Telegraf } = require("telegraf");

const USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const PROCESS_STARTED_AT = Date.now();

function safeParseInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envString(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function envBool(name, fallback = false) {
  const value = envString(name, fallback ? "1" : "0").toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function envPath(name, fallback) {
  const value = envString(name, fallback);
  return path.isAbsolute(value) ? value : path.join(APP_DIR, value);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeAddress(value) {
  return String(value || "").trim();
}

function isValidTronBase58Address(value) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(value || "").trim());
}

function splitConfigList(value) {
  return String(value || "")
    .split(/[\n,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function parseWatchTargetEntry(entry, index) {
  let label = "";
  let address = "";
  const colon = entry.indexOf(":");
  const equal = entry.indexOf("=");
  const delimiter = colon < 0 ? equal : (equal < 0 ? colon : Math.min(colon, equal));

  if (delimiter >= 0) {
    const left = entry.slice(0, delimiter).trim();
    const right = entry.slice(delimiter + 1).trim();
    if (isValidTronBase58Address(left)) {
      address = left;
      label = right;
    } else {
      label = left;
      address = right;
    }
  } else {
    address = entry;
  }

  return {
    label: (label || `USDT${index + 1}`).slice(0, 32),
    address: normalizeAddress(address),
    raw: entry,
  };
}

function parseWatchTargets() {
  const rawEntries = splitConfigList(process.env.WATCH_ADDRESSES);
  const targets = [];
  const invalid = [];
  const seen = new Set();

  rawEntries.forEach((entry, index) => {
    const target = parseWatchTargetEntry(entry, index);
    if (!isValidTronBase58Address(target.address)) {
      invalid.push(target.raw);
      return;
    }
    if (seen.has(target.address)) return;
    seen.add(target.address);
    targets.push({ label: target.label, address: target.address });
  });

  return { targets, invalid };
}

const watchConfig = parseWatchTargets();

const CFG = {
  TELEGRAM_BOT_TOKEN: envString("TELEGRAM_BOT_TOKEN"),
  ADMIN_ID: safeParseInt(process.env.ADMIN_ID, 0),
  PORT: safeParseInt(process.env.PORT, 3289),
  HEALTH_HOST: envString("HEALTH_HOST", "127.0.0.1"),
  DB_PATH: envPath("DB_PATH", "tron_monitor.db"),
  REQUIRE_EXISTING_DB: envBool("REQUIRE_EXISTING_DB", false),

  TRONGRID_BASE_URL: envString("TRONGRID_BASE_URL", "https://api.trongrid.io").replace(/\/+$/, ""),
  TRONGRID_API_KEY: envString("TRONGRID_API_KEY"),
  TRON_USDT_CONTRACT: normalizeAddress(process.env.TRON_USDT_CONTRACT || USDT_TRC20),
  WATCH_TARGETS: watchConfig.targets,
  POLL_INTERVAL_MS: clamp(safeParseInt(process.env.POLL_INTERVAL_MS, 10000), 5000, 300000),
  TRONGRID_LIMIT: clamp(safeParseInt(process.env.TRONGRID_LIMIT, 100), 20, 200),
  API_TIMEOUT: safeParseInt(process.env.API_TIMEOUT, 12000),
  PENDING_NOTIFY_LIMIT: clamp(safeParseInt(process.env.PENDING_NOTIFY_LIMIT, 50), 10, 500),
  NOTIFICATION_RETENTION_DAYS: clamp(safeParseInt(process.env.NOTIFICATION_RETENTION_DAYS, 30), 7, 3650),
  DB_MAINTENANCE_INTERVAL_MS: clamp(safeParseInt(process.env.DB_MAINTENANCE_INTERVAL_MS, 3600000), 60000, 86400000),
};

const log = {
  info(message, meta) { console.log(`[${new Date().toISOString()}] [INFO] ${message}${meta ? " " + JSON.stringify(meta) : ""}`); },
  warn(message, meta) { console.warn(`[${new Date().toISOString()}] [WARN] ${message}${meta ? " " + JSON.stringify(meta) : ""}`); },
  error(message, meta) { console.error(`[${new Date().toISOString()}] [ERROR] ${message}${meta ? " " + JSON.stringify(meta) : ""}`); },
  fatal(message, meta) { console.error(`[${new Date().toISOString()}] [FATAL] ${message}${meta ? " " + JSON.stringify(meta) : ""}`); },
};

if (!CFG.TELEGRAM_BOT_TOKEN) {
  log.fatal("TELEGRAM_BOT_TOKEN 未设置");
  process.exit(1);
}
if (!CFG.ADMIN_ID) {
  log.fatal("ADMIN_ID 未设置，不能启动");
  process.exit(1);
}
if (watchConfig.invalid.length) {
  log.fatal("WATCH_ADDRESSES 中存在格式不正确的地址", { invalid: watchConfig.invalid });
  process.exit(1);
}
if (!CFG.WATCH_TARGETS.length) {
  log.fatal("WATCH_ADDRESSES 未设置；格式示例：USDT1:Txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  process.exit(1);
}
if (!isValidTronBase58Address(CFG.TRON_USDT_CONTRACT)) {
  log.fatal("TRON_USDT_CONTRACT 格式不正确", { contract: CFG.TRON_USDT_CONTRACT });
  process.exit(1);
}
if (!CFG.TRONGRID_API_KEY) {
  log.warn("TRONGRID_API_KEY 未设置，TronGrid 可能会严格限流");
}

fs.mkdirSync(path.dirname(CFG.DB_PATH), { recursive: true });
const dbExistedAtBoot = fs.existsSync(CFG.DB_PATH);
log.info("数据库路径已确认", { path: CFG.DB_PATH, existed: dbExistedAtBoot });
if (CFG.REQUIRE_EXISTING_DB && !dbExistedAtBoot) {
  log.fatal("数据库文件不存在，已拒绝启动；如为首次部署，请先将 REQUIRE_EXISTING_DB 设为 0", { path: CFG.DB_PATH });
  process.exit(1);
}

const db = new Database(CFG.DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = FULL");
db.pragma("foreign_keys = ON");
db.pragma("wal_autocheckpoint = 1000");

db.exec(`
  CREATE TABLE IF NOT EXISTS notify_chats (
    chat_id TEXT PRIMARY KEY,
    title TEXT,
    type TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY,
    watch_address TEXT NOT NULL,
    watch_label TEXT NOT NULL,
    tx_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    amount TEXT NOT NULL,
    symbol TEXT NOT NULL DEFAULT 'USDT',
    counterparty TEXT NOT NULL,
    block_timestamp INTEGER NOT NULL,
    baseline INTEGER NOT NULL DEFAULT 0,
    raw_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transfer_notifications (
    id TEXT PRIMARY KEY,
    transfer_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    chat_title TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sent_at INTEGER,
    UNIQUE(transfer_id, chat_id),
    FOREIGN KEY(transfer_id) REFERENCES transfers(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_transfers_block_timestamp
    ON transfers(block_timestamp);
  CREATE INDEX IF NOT EXISTS idx_transfer_notifications_status
    ON transfer_notifications(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_transfer_notifications_chat
    ON transfer_notifications(chat_id, status);
`);

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
}

function ensureColumn(table, column, definition) {
  if (!tableColumns(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

ensureColumn("notify_chats", "enabled", "enabled INTEGER NOT NULL DEFAULT 0");
ensureColumn("transfer_notifications", "sent_at", "sent_at INTEGER");

const stmt = {
  upsertChat: db.prepare(`
    INSERT INTO notify_chats (chat_id, title, type, enabled, source, updated_at)
    VALUES (@chat_id, @title, @type, COALESCE((SELECT enabled FROM notify_chats WHERE chat_id = @chat_id), 0), @source, @updated_at)
    ON CONFLICT(chat_id) DO UPDATE SET
      title = excluded.title,
      type = excluded.type,
      source = excluded.source,
      updated_at = excluded.updated_at
  `),
  enableChat: db.prepare("UPDATE notify_chats SET enabled = 1, source = 'enable', updated_at = ? WHERE chat_id = ?"),
  disableChat: db.prepare("UPDATE notify_chats SET enabled = 0, source = ?, updated_at = ? WHERE chat_id = ?"),
  chatById: db.prepare("SELECT * FROM notify_chats WHERE chat_id = ?"),
  enabledChats: db.prepare("SELECT * FROM notify_chats WHERE enabled = 1 ORDER BY updated_at ASC"),
  enabledChatCount: db.prepare("SELECT COUNT(*) AS count FROM notify_chats WHERE enabled = 1"),

  transferById: db.prepare("SELECT * FROM transfers WHERE id = ?"),
  insertTransfer: db.prepare(`
    INSERT OR IGNORE INTO transfers (
      id, watch_address, watch_label, tx_id, direction, amount, symbol,
      counterparty, block_timestamp, baseline, raw_json, created_at
    )
    VALUES (
      @id, @watch_address, @watch_label, @tx_id, @direction, @amount, @symbol,
      @counterparty, @block_timestamp, @baseline, @raw_json, @created_at
    )
  `),

  insertNotification: db.prepare(`
    INSERT OR IGNORE INTO transfer_notifications (
      id, transfer_id, chat_id, chat_title, status, attempts, created_at, updated_at
    )
    VALUES (@id, @transfer_id, @chat_id, @chat_title, 'pending', 0, @created_at, @updated_at)
  `),
  pendingNotifications: db.prepare(`
    SELECT n.*, t.watch_label, t.watch_address, t.tx_id, t.direction, t.amount, t.symbol,
      t.counterparty, t.block_timestamp
    FROM transfer_notifications n
    JOIN transfers t ON t.id = n.transfer_id
    WHERE n.status = 'pending'
    ORDER BY n.created_at ASC
    LIMIT ?
  `),
  pendingNotificationCount: db.prepare("SELECT COUNT(*) AS count FROM transfer_notifications WHERE status = 'pending'"),
  markNotificationSent: db.prepare(`
    UPDATE transfer_notifications
    SET status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = ?, sent_at = ?
    WHERE id = ?
  `),
  markNotificationFailed: db.prepare(`
    UPDATE transfer_notifications
    SET attempts = attempts + 1, last_error = ?, updated_at = ?
    WHERE id = ?
  `),
  skipChatPending: db.prepare(`
    UPDATE transfer_notifications
    SET status = 'skipped', last_error = ?, updated_at = ?
    WHERE chat_id = ? AND status = 'pending'
  `),
  skipAllPending: db.prepare(`
    UPDATE transfer_notifications
    SET status = 'skipped', last_error = ?, updated_at = ?
    WHERE status = 'pending'
  `),
  cleanupNotifications: db.prepare(`
    DELETE FROM transfer_notifications
    WHERE status IN ('sent', 'skipped') AND updated_at < ?
  `),
};

const skippedAtBoot = stmt.skipAllPending.run("机器人重启，旧待通知已静默跳过", Date.now()).changes;
if (skippedAtBoot > 0) {
  log.warn("重启时发现旧待通知，已按启动静默规则跳过", { count: skippedAtBoot });
}

const tron = axios.create({
  baseURL: CFG.TRONGRID_BASE_URL,
  timeout: CFG.API_TIMEOUT,
  headers: CFG.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": CFG.TRONGRID_API_KEY } : {},
});

function registerChat(chat, source) {
  if (!chat?.id) return;
  const title = chat.title || chat.username || chat.first_name || String(chat.id);
  stmt.upsertChat.run({
    chat_id: String(chat.id),
    title,
    type: chat.type || "",
    source,
    updated_at: Date.now(),
  });
  log.info("会话已登记", { chatId: String(chat.id), title, source });
}

function adminOnly(ctx) {
  if (ctx.from?.id === CFG.ADMIN_ID) return true;
  ctx.reply("只有管理员可以执行这个命令。").catch(() => {});
  return false;
}

function disableChat(chatId, reason) {
  const now = Date.now();
  stmt.disableChat.run(reason, now, String(chatId));
  const skipped = stmt.skipChatPending.run(reason, now, String(chatId)).changes;
  log.info("通知群已关闭", { chatId: String(chatId), reason, skippedPending: skipped });
}

function transferId(tx, target, direction) {
  return `${target.address}:${tx.transaction_id || tx.tx_id || ""}:${direction}`;
}

function notificationId(transferIdValue, chatId) {
  return `${transferIdValue}:${chatId}`;
}

function formatTokenAmount(rawValue, decimals) {
  const rawText = String(rawValue ?? "0");
  const decimalCount = clamp(safeParseInt(decimals, 6), 0, 30);
  try {
    const raw = BigInt(rawText);
    const base = 10n ** BigInt(decimalCount);
    const whole = raw / base;
    const fraction = raw % base;
    if (fraction === 0n) return whole.toString();
    const fractionText = fraction.toString().padStart(decimalCount, "0").replace(/0+$/, "");
    return `${whole}.${fractionText}`;
  } catch {
    const n = Number(rawText);
    if (!Number.isFinite(n)) return rawText;
    return (n / (10 ** decimalCount)).toFixed(decimalCount).replace(/\.?0+$/, "");
  }
}

function formatBjTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(n)).replace(/\//g, "-");
}

function shortTxId(txId) {
  const text = String(txId || "");
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-8)}`;
}

function classifyTransfer(tx, target) {
  const from = normalizeAddress(tx.from);
  const to = normalizeAddress(tx.to);
  const watch = target.address;
  const txId = String(tx.transaction_id || tx.tx_id || "").trim();
  const blockTimestamp = Number(tx.block_timestamp || 0);

  if (!txId || !Number.isFinite(blockTimestamp) || blockTimestamp <= 0) return null;

  let direction = "";
  let counterparty = "";
  if (to === watch && from !== watch) {
    direction = "in";
    counterparty = from;
  } else if (from === watch && to !== watch) {
    direction = "out";
    counterparty = to;
  } else {
    return null;
  }

  const tokenInfo = tx.token_info || {};
  return {
    id: transferId(tx, target, direction),
    watch_address: watch,
    watch_label: target.label,
    tx_id: txId,
    direction,
    amount: formatTokenAmount(tx.value, tokenInfo.decimals ?? 6),
    symbol: tokenInfo.symbol || "USDT",
    counterparty,
    block_timestamp: blockTimestamp,
    raw_json: JSON.stringify(tx),
  };
}

function buildTransferMessage(row) {
  const isIncome = row.direction === "in";
  const title = `${row.watch_label} ${isIncome ? "收入通知" : "支出通知"}`;
  const amount = `${isIncome ? "+" : "-"}${row.amount} ${row.symbol || "USDT"}`;
  const counterpartyLabel = isIncome ? "来源" : "去向";
  const txId = row.tx_id || "";
  const scanUrl = txId ? `https://tronscan.org/#/transaction/${txId}` : "";

  return [
    title,
    `监听地址：${row.watch_address}`,
    `金额：${amount}`,
    `${counterpartyLabel}：${row.counterparty || "-"}`,
    `时间：${formatBjTime(row.block_timestamp)}`,
    `TxID：${shortTxId(txId)}`,
    scanUrl,
  ].filter(Boolean).join("\n");
}

async function fetchLatestTransfers(target) {
  const response = await tron.get(`/v1/accounts/${target.address}/transactions/trc20`, {
    params: {
      limit: CFG.TRONGRID_LIMIT,
      only_confirmed: true,
      contract_address: CFG.TRON_USDT_CONTRACT,
      order_by: "block_timestamp,desc",
    },
  });
  const payload = response.data || {};
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function saveTransfer(row, baseline) {
  stmt.insertTransfer.run({
    ...row,
    baseline: baseline ? 1 : 0,
    created_at: Date.now(),
  });
}

function createNotificationTasks(transferIdValue) {
  const chats = stmt.enabledChats.all();
  const now = Date.now();
  for (const chat of chats) {
    stmt.insertNotification.run({
      id: notificationId(transferIdValue, chat.chat_id),
      transfer_id: transferIdValue,
      chat_id: chat.chat_id,
      chat_title: chat.title,
      created_at: now,
      updated_at: now,
    });
  }
  return chats.length;
}

function isPermanentTelegramError(error) {
  const text = String(error?.response?.description || error?.message || error || "").toLowerCase();
  return text.includes("bot was blocked")
    || text.includes("chat not found")
    || text.includes("kicked")
    || text.includes("forbidden");
}

async function flushPendingNotifications() {
  const tasks = stmt.pendingNotifications.all(CFG.PENDING_NOTIFY_LIMIT);
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const task of tasks) {
    const chat = stmt.chatById.get(task.chat_id);
    if (!chat?.enabled) {
      stmt.skipChatPending.run("通知群已关闭", Date.now(), task.chat_id);
      skipped += 1;
      continue;
    }

    try {
      await bot.telegram.sendMessage(task.chat_id, buildTransferMessage(task), {
        disable_web_page_preview: true,
      });
      const now = Date.now();
      stmt.markNotificationSent.run(now, now, task.id);
      sent += 1;
    } catch (e) {
      const message = e?.response?.description || e?.message || String(e);
      if (isPermanentTelegramError(e)) {
        disableChat(task.chat_id, message);
        skipped += 1;
        continue;
      }
      stmt.markNotificationFailed.run(message.slice(0, 500), Date.now(), task.id);
      failed += 1;
      log.warn("Telegram 通知发送失败，下轮重试", {
        chatId: task.chat_id,
        transferId: task.transfer_id,
        err: message,
      });
    }
  }

  return { sent, failed, skipped };
}

let isPolling = false;
let lastPollAt = 0;
let lastPollError = "";
let lastMaintenanceAt = 0;
const bootstrapPending = new Set(CFG.WATCH_TARGETS.map(t => t.address));

const cleanupOldData = db.transaction((cutoff) => {
  stmt.cleanupNotifications.run(cutoff);
});

function runDatabaseMaintenance(force = false) {
  const now = Date.now();
  if (!force && now - lastMaintenanceAt < CFG.DB_MAINTENANCE_INTERVAL_MS) return;
  lastMaintenanceAt = now;
  const cutoff = now - CFG.NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    cleanupOldData(cutoff);
    db.pragma("wal_checkpoint(PASSIVE)");
  } catch (e) {
    log.warn("数据库维护失败", { err: e?.message || String(e) });
  }
}

async function pollOnce() {
  if (isPolling) return;
  isPolling = true;
  const errors = [];
  let discovered = 0;
  let queued = 0;

  try {
    for (const target of CFG.WATCH_TARGETS) {
      try {
        const latest = await fetchLatestTransfers(target);
        if (latest.length >= CFG.TRONGRID_LIMIT) {
          const message = `${target.label}:最近流水达到拉取上限，请关注是否高频漏查`;
          errors.push(message);
          log.warn("TronGrid 返回数量达到单轮上限，极高频地址可能漏查", {
            label: target.label,
            address: target.address,
            limit: CFG.TRONGRID_LIMIT,
          });
        }
        const ordered = latest
          .map(tx => classifyTransfer(tx, target))
          .filter(Boolean)
          .sort((a, b) => a.block_timestamp - b.block_timestamp);

        const isBootstrap = bootstrapPending.has(target.address);
        let baselineCount = 0;
        let newCount = 0;
        let queuedForTarget = 0;

        for (const row of ordered) {
          if (stmt.transferById.get(row.id)) continue;

          const shouldSilence = isBootstrap || row.block_timestamp <= PROCESS_STARTED_AT;
          saveTransfer(row, shouldSilence);

          if (shouldSilence) {
            baselineCount += 1;
            continue;
          }

          const taskCount = createNotificationTasks(row.id);
          discovered += 1;
          queued += taskCount;
          queuedForTarget += taskCount;
          newCount += 1;
          log.info("发现新 USDT 流水", {
            label: row.watch_label,
            direction: row.direction,
            amount: row.amount,
            txId: row.tx_id,
            notifyChats: taskCount,
          });
        }

        if (isBootstrap) {
          bootstrapPending.delete(target.address);
          log.info("启动基准已建立，本次查询到的流水全部静默", {
            label: target.label,
            address: target.address,
            baselineCount,
          });
        }

        if (newCount > 0 && queuedForTarget === 0) {
          log.warn("发现新流水，但当前没有已开启的通知群", { label: target.label, count: newCount });
        }
      } catch (e) {
        const err = e?.response?.data?.error || e?.response?.data?.Error || e?.message || String(e);
        errors.push(`${target.label}:${err}`);
        log.warn("TronGrid 查询失败", { label: target.label, address: target.address, err });
      }
    }

    const notifyResult = await flushPendingNotifications();
    if (notifyResult.failed > 0) errors.push(`通知发送失败:${notifyResult.failed}`);
    if (discovered > 0 || queued > 0 || notifyResult.sent > 0 || notifyResult.failed > 0 || notifyResult.skipped > 0) {
      log.info("本轮处理完成", {
        discovered,
        queued,
        sent: notifyResult.sent,
        failed: notifyResult.failed,
        skipped: notifyResult.skipped,
        pending: stmt.pendingNotificationCount.get()?.count || 0,
      });
    }

    lastPollError = errors.join("; ");
    lastPollAt = Date.now();
    runDatabaseMaintenance(false);
  } finally {
    isPolling = false;
  }
}

const bot = new Telegraf(CFG.TELEGRAM_BOT_TOKEN, {
  telegram: { agent: new https.Agent({ keepAlive: true, timeout: 30000 }) },
});

bot.catch((err) => {
  log.error("Telegram Bot 错误", { err: err?.message || String(err) });
});

bot.on("my_chat_member", async (ctx) => {
  const update = ctx.update.my_chat_member;
  const chat = update?.chat;
  const member = update?.new_chat_member;
  const status = member?.status;
  if (!chat || !member || member.user?.id !== ctx.botInfo.id) return;

  if (["member", "administrator"].includes(status)) {
    registerChat(chat, "added");
    await ctx.telegram.sendMessage(chat.id, "已登记本群。需要通知时，请管理员发送 /enable_notify。").catch(() => {});
  } else if (["left", "kicked"].includes(status)) {
    disableChat(chat.id, `机器人状态变更：${status}`);
  }
});

bot.start(async (ctx) => {
  registerChat(ctx.chat, "start");
  if (["group", "supergroup"].includes(ctx.chat?.type)) {
    await ctx.reply("已登记本群。需要通知时，请管理员发送 /enable_notify。").catch(() => {});
  } else {
    await ctx.reply("把机器人拉进群后，在目标群由管理员发送 /enable_notify 才会开启通知。").catch(() => {});
  }
});

bot.command("enable_notify", async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) {
    await ctx.reply("请在需要接收通知的群里执行这个命令。").catch(() => {});
    return;
  }
  if (!adminOnly(ctx)) return;

  registerChat(ctx.chat, "enable");
  stmt.enableChat.run(Date.now(), String(ctx.chat.id));
  await ctx.reply("已开启本群 USDT 收支通知。").catch(() => {});
});

bot.command("disable_notify", async (ctx) => {
  if (!["group", "supergroup"].includes(ctx.chat?.type)) {
    await ctx.reply("请在群里执行这个命令。").catch(() => {});
    return;
  }
  if (!adminOnly(ctx)) return;

  registerChat(ctx.chat, "disable");
  disableChat(ctx.chat.id, "管理员关闭通知群");
  await ctx.reply("已关闭本群 USDT 收支通知。").catch(() => {});
});

bot.command("status", async (ctx) => {
  if (ctx.from?.id !== CFG.ADMIN_ID) return;

  const isGroupChat = ["group", "supergroup"].includes(ctx.chat?.type);
  const currentChat = ctx.chat?.id ? stmt.chatById.get(String(ctx.chat.id)) : null;
  const targetLines = CFG.WATCH_TARGETS.map(t => `- ${t.label}：${t.address}`);
  const lines = [
    "USDT 收支监听状态",
    isGroupChat ? `监听地址数量：${CFG.WATCH_TARGETS.length}` : `监听地址：\n${targetLines.join("\n")}`,
    `通知群数：${stmt.enabledChatCount.get()?.count || 0}`,
    `当前会话通知：${isGroupChat ? (currentChat?.enabled ? "已开启" : "未开启") : "私聊"}`,
    `待发送通知：${stmt.pendingNotificationCount.get()?.count || 0}`,
    `轮询间隔：${Math.round(CFG.POLL_INTERVAL_MS / 1000)} 秒`,
    `启动基准：${bootstrapPending.size ? "建立中" : "已建立"}`,
    `最近轮询：${lastPollAt ? formatBjTime(lastPollAt) : "尚未轮询"}`,
    `最近错误：${lastPollError || "无"}`,
  ];
  await ctx.reply(lines.join("\n")).catch(() => {});
});

const app = express();
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    watchAddressCount: CFG.WATCH_TARGETS.length,
    notifyChats: stmt.enabledChatCount.get()?.count || 0,
    pendingNotifications: stmt.pendingNotificationCount.get()?.count || 0,
    bootstrapDone: bootstrapPending.size === 0,
    lastPollAt,
    lastPollOk: !lastPollError,
  });
});

let server = null;
let timer = null;
let isShuttingDown = false;

function launchTelegramBot() {
  return new Promise((resolve, reject) => {
    let ready = false;
    bot.launch({ allowedUpdates: ["message", "my_chat_member"] }, () => {
      ready = true;
      log.info("Telegram 机器人已启动", {
        watchAddressCount: CFG.WATCH_TARGETS.length,
        pollIntervalMs: CFG.POLL_INTERVAL_MS,
        notifyChats: stmt.enabledChatCount.get()?.count || 0,
      });
      resolve();
    }).catch((e) => {
      if (ready) exitAfterFatal("Telegram 机器人运行异常", e);
      else reject(e);
    });
  });
}

async function start() {
  server = app.listen(CFG.PORT, CFG.HEALTH_HOST, () => {
    log.info("健康检查服务已启动", { host: CFG.HEALTH_HOST, port: CFG.PORT });
  });
  await launchTelegramBot();
  await pollOnce();
  timer = setInterval(() => { pollOnce().catch(() => {}); }, CFG.POLL_INTERVAL_MS);
  log.info("TronGrid 轮询已启动", { pollIntervalMs: CFG.POLL_INTERVAL_MS });
}

async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info("正在停止服务", { signal });
  if (timer) clearInterval(timer);
  try { bot.stop(signal); } catch {}
  if (server) await new Promise(resolve => server.close(resolve));
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  try { db.close(); } catch {}
  process.exit(exitCode);
}

function exitAfterFatal(reason, e) {
  log.fatal(reason, { err: e?.message || String(e) });
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref?.();
  shutdown(reason, 1).catch(() => process.exit(1));
}

process.once("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
process.once("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("uncaughtException", (e) => exitAfterFatal("未捕获异常", e));
process.on("unhandledRejection", (e) => exitAfterFatal("未处理 Promise 拒绝", e));

start().catch((e) => {
  log.fatal("启动失败", { err: e?.message || String(e) });
  process.exit(1);
});
