require("dotenv").config();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const express = require("express");
const http = require("http");
const https = require("https");
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

// ================================================================
//  Auth Service 配置
// ================================================================
const AUTH_SERVICE_URL = (process.env.AUTH_SERVICE_URL || "http://localhost:3100/api/platform-b").replace(/\/+$/, "");
const AUTH_API_KEY = process.env.AUTH_API_KEY || "";
const LOTTERY_GAMES = new Set(
  (process.env.LOTTERY_GAMES || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);
const authApiAgent = new http.Agent({ keepAlive: true, maxSockets: 20, timeout: 5000 });
const authApiAgentS = new https.Agent({ keepAlive: true, maxSockets: 20, timeout: 5000 });

function authHeaders() {
  return { Authorization: `Bearer ${AUTH_API_KEY}`, "Content-Type": "application/json" };
}

// ================================================================
//  0. TIMEZONE — 北京时间工具函数（需在 LOGGING 之前定义）
// ================================================================
function safeNow() {
  try {
    const d = new Date();
    const utc = d.getTime() + d.getTimezoneOffset() * 60000;
    const bj = new Date(utc + 8 * 3600000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${bj.getFullYear()}-${pad(bj.getMonth() + 1)}-${pad(bj.getDate())} ${pad(bj.getHours())}:${pad(bj.getMinutes())}:${pad(bj.getSeconds())}`;
  } catch {
    try { const d = new Date(); return d.toISOString().replace("T", " ").slice(0, 19); } catch { return "---"; }
  }
}

// ================================================================
//  1. LOGGING
// ================================================================
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };
const logLevel = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LEVELS.INFO;

function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

const log = {
  _ts() { try { return safeNow(); } catch { return "---"; } },
  _f(lvl, msg, meta) {
    try {
      const ts = this._ts();
      const m = meta ? ` ${safeStringify(meta)}` : "";
      const line = `[${ts}] [${lvl}]${m} ${msg}`;
      if (lvl === "ERROR" || lvl === "FATAL") {
        try { console.error(line); } catch {}
      } else {
        try { console.log(line); } catch {}
      }
    } catch {}
  },
  debug(msg, meta) { if (logLevel <= 0) this._f("DEBUG", msg, meta); },
  info(msg, meta) { if (logLevel <= 1) this._f("INFO", msg, meta); },
  warn(msg, meta) { if (logLevel <= 2) this._f("WARN", msg, meta); },
  error(msg, meta) { if (logLevel <= 3) this._f("ERROR", msg, meta); },
  fatal(msg, meta) { this._f("FATAL", msg, meta); },
};

// ================================================================
//  2. CONFIG
// ================================================================
function safeParseInt(val, fallback) {
  try { const n = parseInt(val, 10); return isNaN(n) ? fallback : n; } catch { return fallback; }
}

function parseRemarkAliases(raw) {
  const aliases = {};
  for (const pair of String(raw || "").split(",")) {
    const [from, to] = pair.split(":").map(s => String(s || "").trim());
    if (from && to) aliases[from] = to;
  }
  return aliases;
}

const CFG = {
  ADMIN_ID: (() => { try { const v = process.env.ADMIN_ID; if (!v) return null; const n = parseInt(v, 10); return isNaN(n) ? null : n; } catch { return null; } })(),
  GROUP_A_ID: (() => { try { const v = process.env.GROUP_A_ID; return v ? parseInt(v, 10) : null; } catch { return null; } })(),
  GROUP_B_ID: (() => { try { const v = process.env.GROUP_B_ID; return v ? parseInt(v, 10) : null; } catch { return null; } })(),
  TARGET_CHAT_ID: (() => { try { const v = process.env.TARGET_CHAT_ID; return v ? parseInt(v, 10) : null; } catch { return null; } })(),
  PORT: safeParseInt(process.env.PORT, 3023),
  API_TIMEOUT: safeParseInt(process.env.API_TIMEOUT, 10000),

  AMOUNT_CONFIRM: safeParseInt(process.env.AMOUNT_CONFIRM, 800),
  AMOUNT_MAX: safeParseInt(process.env.AMOUNT_MAX, 2000),
  SAFE_REMARKS: (process.env.SAFE_REMARKS || "").split(",").map(s => s.trim()).filter(Boolean),
  CONCURRENCY: safeParseInt(process.env.CONCURRENCY, 5),
  API_RETRY: safeParseInt(process.env.API_RETRY, 2),
  CONFIRM_EXPIRE_MS: safeParseInt(process.env.CONFIRM_EXPIRE_MS, 5 * 60 * 1000),

  // 风控阈值（可配置化）
  GIFT_RATIO_THRESHOLD: parseFloat(process.env.GIFT_RATIO_THRESHOLD || "0.15"),
  BET_CONCENTRATION_THRESHOLD: parseFloat(process.env.BET_CONCENTRATION_THRESHOLD || "0.20"),
  MIN_RECHARGE_FOR_RATIO: safeParseInt(process.env.MIN_RECHARGE_FOR_RATIO, 300),
  HIGH_LOSS_EXEMPT: safeParseInt(process.env.HIGH_LOSS_EXEMPT, 50000),
  WEEK_RECHARGE_LIMIT: safeParseInt(process.env.WEEK_RECHARGE_LIMIT, 3),
  SCHEDULE_START_HOUR: safeParseInt(process.env.SCHEDULE_START_HOUR, 12),

  MAX_PENDING: safeParseInt(process.env.MAX_PENDING, 500),
  MAX_MSG_LENGTH: safeParseInt(process.env.MAX_MSG_LENGTH, 4096),
  MAX_ENTRIES: safeParseInt(process.env.MAX_ENTRIES, 20),
  DB_BUSY_MS: safeParseInt(process.env.DB_BUSY_MS, 5000),
  SHUTDOWN_MS: safeParseInt(process.env.SHUTDOWN_MS, 10000),
  BOT_LAUNCH_RETRIES: safeParseInt(process.env.BOT_LAUNCH_RETRIES, 3),
  AUTH_RECHECK_MS: safeParseInt(process.env.AUTH_RECHECK_MS, 30000),

  // 大客绿通 / 新会员保护
  BIG_LOSS_GREEN_THRESHOLD: safeParseInt(process.env.BIG_LOSS_GREEN_THRESHOLD, 50000),
  PERIOD_PROFIT_BLOCK: safeParseInt(process.env.PERIOD_PROFIT_BLOCK, 0),
  NEW_MEMBER_DAYS: safeParseInt(process.env.NEW_MEMBER_DAYS, 7),
  NEW_MEMBER_MIN_RECHARGE_TIMES: safeParseInt(process.env.NEW_MEMBER_MIN_RECHARGE_TIMES, 3),
  NEW_MEMBER_MIN_RECHARGE: safeParseInt(process.env.NEW_MEMBER_MIN_RECHARGE, 1000),
  NEW_MEMBER_AUTO_MAX: safeParseInt(process.env.NEW_MEMBER_AUTO_MAX, 68),
  // 频率限制（每用户每分钟最大消息数）
  RATE_LIMIT_PER_MIN: safeParseInt(process.env.RATE_LIMIT_PER_MIN, 10),
  // 风控只读 API 的全局最大并发数（所有批次和规则共享）
  RISK_API_CONCURRENCY: safeParseInt(process.env.RISK_API_CONCURRENCY, 8),
  // 启动时是否丢弃积压更新
  DROP_PENDING_UPDATES: process.env.DROP_PENDING_UPDATES !== "false",

  REMARK_ALIASES: {
    "周": "周卡",
    "企": "企迅达",
    "企讯": "企迅达",
    "神": "神秘",
    "充": "充值",
    "sc": "首存",
    "转": "转移",
    "电子": "电子棋牌捕鱼",
    "亏": "亏损",
    "运": "转运",
    "下载": "下载APP",
    "app": "下载APP",
    "介": "推荐",
    "介绍": "推荐",
    "介绍下级": "推荐",
    "预测一码": "预测",
    "推荐下级": "推荐",
    "包赔": "包赔",
    "赔": "包赔",
    "包": "包赔",
    ...parseRemarkAliases(process.env.REMARK_ALIASES),
  },
};


if (!process.env.AUTH_SERVICE_URL) { log.fatal("AUTH_SERVICE_URL 未设置"); process.exit(1); }
if (!process.env.TELEGRAM_BOT_TOKEN) { log.fatal("TELEGRAM_BOT_TOKEN 未设置"); process.exit(1); }
if (!AUTH_API_KEY) { log.fatal("AUTH_API_KEY 未设置, 无法连接 auth-service"); process.exit(1); }

log.info("配置加载完成", {
  admin: CFG.ADMIN_ID,
  gA: CFG.GROUP_A_ID,
  gB: CFG.GROUP_B_ID,
  port: CFG.PORT,
  riskQueryConcurrency: CFG.RISK_API_CONCURRENCY,
});

// ================================================================
//  3. HTTP AGENTS
// ================================================================
const tgHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, timeout: 30000 });

// ================================================================
//  4. DATABASE
// ================================================================
let db = null;

function initDB() {
  try {
    db = new Database(path.resolve(__dirname, "data.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = " + CFG.DB_BUSY_MS);
    db.pragma("synchronous = NORMAL");

    // 仅保留 system_config 表（机器人自身状态）
    // tx_log 表已移除：当天加款记录改用后台 accountChangeList 接口查询
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT);
    `);

    log.info("数据库就绪", { mode: "WAL", tables: ["system_config"] });
    return true;
  } catch (e) {
    log.fatal("数据库初始化失败", { err: e?.message || String(e) });
    return false;
  }
}

const DB = {
  _safe(fn) {
    try { return fn(); } catch (e) { log.error("DB操作错误", { err: e?.message || String(e) }); return undefined; }
  },

  _isAlive() { try { return db && db.open; } catch { return false; } },

  // 注：tx_log 表已移除，当天加款记录改用后台 accountChangeList 接口查询（见 riskCheckTodayRecharges）
  // 此处仅保留 system_config 表，用于机器人自身状态（auto_forward / auto_forward_schedule）

  getAutoForward() {
    if (!this._isAlive()) return false;
    return this._safe(() => {
      const r = db.prepare("SELECT value FROM system_config WHERE key=?").get("auto_forward");
      return (r && typeof r.value === "string") ? r.value === "true" : false;
    }) ?? false;
  },

  saveAutoForward(val) {
    if (!this._isAlive()) return;
    this._safe(() => db.prepare("REPLACE INTO system_config VALUES(?,?)").run("auto_forward", String(Boolean(val))));
  },

  getAutoForwardSchedule() {
    if (!this._isAlive()) return false;
    return this._safe(() => {
      const r = db.prepare("SELECT value FROM system_config WHERE key=?").get("auto_forward_schedule");
      return (r && typeof r.value === "string") ? r.value === "true" : false;
    }) ?? false;
  },

  saveAutoForwardSchedule(val) {
    if (!this._isAlive()) return;
    this._safe(() => db.prepare("REPLACE INTO system_config VALUES(?,?)").run("auto_forward_schedule", String(Boolean(val))));
  },

  close() {
    try { if (db && db.open) db.close(); } catch (e) { log.warn("DB关闭异常", { err: e?.message }); }
    db = null;
  },
};

// ================================================================
//  7a. API — 用户查询（auth-service）
// ================================================================
async function checkUserExists(members) {
  if (!Array.isArray(members) || members.length === 0) {
    return { map: new Map(), tokenExpired: false, networkError: false };
  }
  if (!GLOBAL_TOKEN) {
    return { map: new Map(), tokenExpired: false, networkError: true };
  }
  const uniqueMembers = [...new Set(members.map(m => String(m).trim()).filter(Boolean))];
  const resultMap = new Map();
  try {
    const res = await axios.post(`${AUTH_SERVICE_URL}/checkUser`, { members: uniqueMembers }, {
      headers: authHeaders(), httpAgent: authApiAgent, httpsAgent: authApiAgentS, timeout: CFG.API_TIMEOUT,
    });
    // 软错误检测：auth-service 返回 200 但 success=false 时，data 为空会导致所有用户被误判为"存在"
    // 必须返回 networkError 触发上层降级，避免给不存在的用户加款
    if (res.data && typeof res.data === "object" && res.data.success === false) {
      log.warn("checkUserExists 软错误", { err: res.data.err || res.data.error || "unknown" });
      return { map: resultMap, tokenExpired: false, networkError: true };
    }
    const data = res.data?.data;
    if (data && typeof data === "object") {
      for (const [account, info] of Object.entries(data)) resultMap.set(account, info);
    }
    return { map: resultMap, tokenExpired: false, networkError: false };
  } catch (e) {
    const status = e.response?.status;
    if (status === 401) return { map: resultMap, tokenExpired: true, networkError: false };
    if (status === 403) return { map: resultMap, authError: true, networkError: false };
    return { map: resultMap, tokenExpired: false, networkError: true };
  }
}

// ================================================================
//  7b. API — 加款接口（auth-service）
// ================================================================
async function apiAddBalance(member, remark, amount, requestId) {
  if (!member || typeof member !== "string") return { ok: false, err: "用户名为空" };
  if (!remark || typeof remark !== "string") return { ok: false, err: "备注为空" };
  if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) return { ok: false, err: "金额无效" };
  if (!GLOBAL_TOKEN) return { ok: false, err: "auth-service 未连接" };
  try {
    // 幂等键使用单次操作 ID，避免同一小时内同会员/备注/金额的第二笔合法加款被误判为旧请求。
    const idemSource = requestId ? String(requestId) : crypto.randomBytes(12).toString("hex");
    const idemKey = crypto.createHash('sha256').update(idemSource).digest('hex');
    const res = await axios.post(`${AUTH_SERVICE_URL}/recharge`, { member: member.trim(), remark: remark.trim(), amount }, {
      headers: { ...authHeaders(), 'X-Idempotency-Key': idemKey }, httpAgent: authApiAgent, httpsAgent: authApiAgentS, timeout: CFG.API_TIMEOUT + 5000,
    });
    const data = res.data;
    // 校验响应格式，确保返回标准 { ok, err } 结构
    // 兼容 auth-service 两种响应格式：{ ok: true, ... } 和 { success: true, ... }
    if (data && typeof data === "object" && typeof data.ok === "boolean") return data;
    if (data && typeof data === "object" && data.success === true) return { ok: true, data: data.data };
    if (data && typeof data === "object" && data.success === false) return { ok: false, err: data.error || "加款响应格式异常" };
    return { ok: false, err: data?.error || "加款响应格式异常" };
  } catch (e) {
    const status = e.response?.status;
    // auth-service 返回 401 = API Key 无效/缺失, 403 = 金融权限不足
    if (status === 401) return { ok: false, err: "API Key 无效或缺失, 请联系管理员" };
    if (status === 403) return { ok: false, err: e.response?.data?.error || "金融权限不足, 请检查 AUTH_API_KEY 权限" };
    return { ok: false, err: e.response?.data?.error || e.message || "加款失败" };
  }
}

// ================================================================
//  7c. API — 按真实姓名查询用户（auth-service）
// ================================================================
async function apiCheckOldUsers(realname) {
  if (!realname || typeof realname !== "string" || !realname.trim()) {
    return { ok: false, err: "姓名为空" };
  }
  try {
    const res = await axios.post(`${AUTH_SERVICE_URL}/checkOldUsers`, { realname: realname.trim() }, {
      headers: authHeaders(), httpAgent: authApiAgent, httpsAgent: authApiAgentS, timeout: CFG.API_TIMEOUT,
    });
    const raw = res.data;
    // 兼容两种响应格式：{ success: true, data: {...} }（apiQuery 风格）和 { ok: true, data: {...} }（apiAddBalance 风格）
    // 仅显式 false 触发错误，避免 undefined 被误判
    if (raw && raw.success === false) return { ok: false, err: raw.error || raw.err || "查询失败" };
    if (raw && raw.ok === false) return { ok: false, err: raw.err || raw.error || "查询失败" };
    const inner = raw?.data || {};
    const rawItems = inner.items || [];
    // auth-service 使用 /getAllUsersByCondition 接口, 字段名可能与旧版不同
    // 此处对每个 item 做字段归一化, 兼容多种可能的字段名
    const items = rawItems.map(u => {
      const item = {
        memberName:   u.memberName   || u.member_name   || u.account   || "未知",
        profitAndLoss: u.profitAndLoss ?? u.depositAndDrawDiff ?? u.profit_and_loss ?? 0,
        freezeStatus:  u.freezeStatus  ?? u.accountStatus ?? u.status ?? 1,
        latestLoginIp: u.latestLoginIp || u.lastLoginIp  || u.loginIp || "未知",
        latestLoginAddress: u.latestLoginAddress || u.lastLoginIpAddress || u.loginAddress || "未知",
        remark:       u.remark        || u.remarkText    || "无",
      };
      // 关键字段缺失时记录警告
      if (!u.memberName && !u.member_name && !u.account) log.warn("apiCheckOldUsers: memberName 字段缺失", { rawKeys: Object.keys(u) });
      return item;
    });
    return { ok: true, items, totalNum: inner.totalNum || inner.total || items.length };
  } catch (e) {
    const status = e.response?.status;
    // 与 checkUserExists 保持一致：401/403 返回标识供调用方降级 GLOBAL_TOKEN
    if (status === 401) return { ok: false, err: "API Key 无效或缺失", tokenExpired: true };
    if (status === 403) return { ok: false, err: "权限不足", authError: true };
    return { ok: false, err: e.response?.data?.error || e.message || "查询失败" };
  }
}

// ================================================================
//  7e. API — 通用查询封装（调用 auth-service 新增端点）
// ================================================================
// 并发限制器：限制同时执行的 Promise 数量，避免 N 峰值并发打垮 auth-service
async function pLimit(items, limit, fn) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); } catch (e) { results[i] = undefined; }
    }
  }
  const workerCount = Math.max(1, Math.min(safeParseInt(limit, 1), items.length));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

// 共享异步队列：多个风控检查同时发起时，仍将总请求数限制在一个可控范围内。
function createAsyncLimiter(limit) {
  const maxConcurrency = Math.max(1, safeParseInt(limit, 1));
  const queue = [];
  let active = 0;

  function drain() {
    while (active < maxConcurrency && queue.length) {
      const task = queue.shift();
      active += 1;
      Promise.resolve()
        .then(task.fn)
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}

// 带重试的 apiQuery（CFG.API_RETRY 次重试，仅对网络错误和 429 重试）
function queryBusinessError(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.success === false) return payload.msg || payload.error || payload.message || "后台返回失败";
  if (payload.code !== undefined && payload.code !== null && String(payload.code) !== "200") {
    return payload.msg || payload.error || payload.message || `后台返回异常(${payload.code})`;
  }
  const inner = payload.data;
  if (inner && typeof inner === "object") {
    if (inner.success === false) return inner.msg || inner.error || inner.message || "后台返回失败";
    if (inner.code !== undefined && inner.code !== null && String(inner.code) !== "200") {
      return inner.msg || inner.error || inner.message || `后台返回异常(${inner.code})`;
    }
  }
  return null;
}

async function apiQuery(endpoint, body = {}) {
  if (!GLOBAL_TOKEN) return { ok: false, err: "auth-service 未连接" };
  let lastErr = null;
  for (let attempt = 0; attempt <= CFG.API_RETRY; attempt++) {
    try {
      const res = await axios.post(`${AUTH_SERVICE_URL}${endpoint}`, body, {
        headers: authHeaders(), httpAgent: authApiAgent, httpsAgent: authApiAgentS, timeout: CFG.API_TIMEOUT,
      });
      if (!res.data?.success) return { ok: false, err: res.data?.error || "查询失败" };
      const businessErr = queryBusinessError(res.data.data);
      if (businessErr) return { ok: false, err: businessErr };
      return { ok: true, data: res.data.data };
    } catch (e) {
      const status = e.response?.status;
      // 401/403：降级并调度探测恢复，避免系统永久瘫痪
      if (status === 401) { GLOBAL_TOKEN = false; scheduleAuthRecheck(); return { ok: false, err: "API Key 无效" }; }
      if (status === 403) { scheduleAuthRecheck(); return { ok: false, err: "权限不足" }; }
      if (status === 429) {
        if (attempt < CFG.API_RETRY) { await sleep(500 * (attempt + 1)); continue; }
        return { ok: false, err: "请求过于频繁, 请稍后", rateLimited: true };
      }
      // 网络错误重试
      if (attempt < CFG.API_RETRY) { await sleep(300 * (attempt + 1)); continue; }
      return { ok: false, err: e.response?.data?.error || e.message || "查询失败" };
    }
  }
  return { ok: false, err: lastErr || "查询失败" };
}

// 所有风控只读查询共用此队列；不同检查可以并发，但不会叠加冲击 auth-service。
const limitRiskQuery = createAsyncLimiter(CFG.RISK_API_CONCURRENCY);
function riskApiQuery(endpoint, body = {}) {
  return limitRiskQuery(() => apiQuery(endpoint, body)).catch((e) => {
    log.warn("风控查询执行异常", { endpoint, err: e?.message || String(e) });
    return { ok: false, err: "查询异常" };
  });
}

// ================================================================
//  7f. 风控预检函数
// ================================================================

function money(v, fallback = 0) {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function normalizeOverallLoss(d) {
  const backendPnl = money(d?.profitAndLoss, NaN);
  if (Number.isFinite(backendPnl)) {
    // 平台B: profitAndLoss 正数=盈利，负数=亏损；机器人内部统一为正数=输钱。
    return -backendPnl;
  }
  const sumRecharge = money(d?.sumRecharge, 0);
  const sumWithdraw = Math.abs(money(d?.sumWithdraw, 0));
  const balance = money(d?.balance, 0);
  return sumRecharge - sumWithdraw - balance;
}

function isNewMemberByDetail(d, now = Date.now()) {
  const createTime = Number(d?.createTime || 0);
  const ageDays = createTime > 0 ? (now - createTime) / 86400000 : Infinity;
  const sumRecharge = money(d?.sumRecharge, 0);
  const sumRechargeTimes = Number(d?.sumRechargeTimes || 0);
  const reasons = [];
  if (Number.isFinite(ageDays) && ageDays < CFG.NEW_MEMBER_DAYS) reasons.push(`注册${Math.max(0, Math.floor(ageDays))}天`);
  if (sumRechargeTimes < CFG.NEW_MEMBER_MIN_RECHARGE_TIMES) reasons.push(`充值${sumRechargeTimes}次`);
  if (sumRecharge < CFG.NEW_MEMBER_MIN_RECHARGE) reasons.push(`总充${Math.round(sumRecharge)}`);
  return { isNewMember: reasons.length > 0, reasons, ageDays, sumRecharge, sumRechargeTimes };
}

function isGreenPassMember(member, memberInfoMap, periodProfitMap, associationMap) {
  const info = memberInfoMap?.get(member);
  if (!info || info.riskCheckFailed || info.isNewMember) return false;
  if (!Number.isFinite(info.profitAndLoss) || info.profitAndLoss < CFG.BIG_LOSS_GREEN_THRESHOLD) return false;
  const period = periodProfitMap?.get(member);
  if (!period || period.riskCheckFailed) return false;
  if (Number.isFinite(period.periodProfit) && period.periodProfit > CFG.PERIOD_PROFIT_BLOCK) return false;
  const assoc = associationMap?.get(member);
  if (assoc && (assoc.riskCheckFailed || assoc.triggered)) return false;
  return true;
}

// 需求 1：总赠送金额 / 总充值金额 占比 > 15%
//   分子 = sumPromotion + sumRecvTips + sumRecvRedPackage + sumRedPackage + sumRecommendBouns + sumRebate + 本次加款金额
//   分母 = sumRecharge
//   sumRecharge < 300 跳过（避免新会员噪音）
async function riskCheckGiftRatio(entries, query = riskApiQuery) {
  const result = new Map();
  if (!Array.isArray(entries) || entries.length === 0) return result;
  // 与 classifyEntries 保持一致的去重逻辑,避免重复行导致 currentAmount 偏大误触发人工审核
  const seen = new Set();
  const dedupedEntries = entries.filter(e => {
    if (!e || !e.member || !e.remark) return false;
    const key = `${String(e.member).trim()}|${String(e.remark).trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const members = [...new Set(dedupedEntries.map(e => String(e.member || "").trim()).filter(Boolean))];
  await pLimit(members, CFG.RISK_API_CONCURRENCY, async (m) => {
    const info = await query("/memberInfo", { memberName: m });
    if (!info.ok) {
      result.set(m, { riskCheckFailed: true, riskCheckName: "会员资料" });
      return;
    }
    const items = Array.isArray(info.data?.items) ? info.data.items : [];
    const d = items.find(it => String(it?.memberName || "").trim() === m);
    if (!d) {
      result.set(m, { riskCheckFailed: true, riskCheckName: "会员资料" });
      return;
    }
    const sumRecharge = parseFloat(d.sumRecharge || 0);
    const profitAndLoss = Math.round(normalizeOverallLoss(d));
    const newMember = isNewMemberByDetail(d);
    const base = {
      profitAndLoss,
      isNewMember: newMember.isNewMember,
      newMemberReasons: newMember.reasons,
      latestLoginIp: d.latestLoginIp || d.lastLoginIp || d.loginIp || "",
      latestLoginDevice: d.latestLoginDevice || d.lastLoginDevice || d.device || "",
      freezeStatus: d.freezeStatus,
    };
    if (!Number.isFinite(sumRecharge) || sumRecharge < CFG.MIN_RECHARGE_FOR_RATIO) {
      result.set(m, base);
      return;
    }
    const gift = parseFloat(d.sumPromotion || 0) + parseFloat(d.sumRecvTips || 0)
               + parseFloat(d.sumRecvRedPackage || 0) + parseFloat(d.sumRedPackage || 0)
               + parseFloat(d.sumRecommendBouns || 0) + parseFloat(d.sumRebate || 0);
    const entryForMember = dedupedEntries.filter(e => String(e.member).trim() === m);
    const currentAmount = entryForMember.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const ratio = (gift + currentAmount) / sumRecharge;
    if (ratio > CFG.GIFT_RATIO_THRESHOLD) {
      result.set(m, { ...base, ratio, gift, sumRecharge, currentAmount });
    } else {
      result.set(m, base);
    }
  });
  return result;
}

// 需求 2：官彩投注占比 > 20%
//   分子 = 官彩游戏投注额 + 三方游戏投注额（官彩名单来自 .env LOTTERY_GAMES）
//   分母 = cpReport 全部投注额 + thirdReport 全部投注额
function get7DayDateRange() {
  const now = new Date();
  // 以北京时区计算近7天日期（避免UTC偏差导致漏掉当天）
  const bjNow = new Date(now.getTime() + 8 * 3600000);
  const end = new Date(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate());
  const start = new Date(end);
  start.setDate(start.getDate() - 6); // 含今天共7天
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { startTime: fmt(start), endTime: fmt(end) };
}

async function riskCheckBetConcentration(entries, query = riskApiQuery) {
  const result = new Map();
  if (!Array.isArray(entries) || entries.length === 0) return result;
  const { startTime, endTime } = get7DayDateRange();
  const members = [...new Set(entries.map(e => String(e.member || "").trim()).filter(Boolean))];
  await pLimit(members, CFG.RISK_API_CONCURRENCY, async (m) => {
    const [cpRes, thirdRes] = await Promise.all([
      query("/cpReport", { memberName: m, startTime, endTime }),
      query("/thirdReport", { memberName: m, startTime, endTime }),
    ]);
    if (!cpRes.ok || !thirdRes.ok || cpRes.rateLimited || thirdRes.rateLimited) {
      result.set(m, { riskCheckFailed: true, riskCheckName: "投注占比" });
      return;
    }
    const cpItems = (cpRes.ok && cpRes.data?.items) ? cpRes.data.items : [];
    const thirdItems = (thirdRes.ok && thirdRes.data?.items) ? thirdRes.data.items : [];
    const matchedBet = cpItems.reduce((s, i) => {
      const name = String(i.lotteryName || "").trim();
      return s + (LOTTERY_GAMES.has(name) ? parseFloat(i.betAmount || 0) : 0);
    }, 0);
    const cpTotal = cpItems.reduce((s, i) => s + parseFloat(i.betAmount || 0), 0);
    const thirdTotal = thirdItems.reduce((s, i) => s + parseFloat(i.betAmount || 0), 0);
    const numerator = matchedBet + thirdTotal;
    const denominator = cpTotal + thirdTotal;
    if (denominator > 0 && numerator / denominator > CFG.BET_CONCENTRATION_THRESHOLD) {
      result.set(m, { matchedBet, thirdTotal, cpTotal, denominator, ratio: numerator / denominator });
    }
  });
  return result;
}

// 需求 3：近七日除"周卡"外加款次数 > 3
//   时间范围：近7天起始 00:00 北京时间 ~ 现在（含今天共7天）
//   过滤：operatorRemark 包含"周卡"的记录排除
//   数据来源：auth-service /accountChangeList（平台后台 accountChange/List，transType=174）
function get7DayTimestampRange() {
  const now = new Date();
  // 北京时区计算近7天起始 00:00
  const bjNow = new Date(now.getTime() + 8 * 3600000);
  const todayBj = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate()));
  const startBj = new Date(todayBj);
  startBj.setUTCDate(startBj.getUTCDate() - 6); // 含今天共7天
  // 转回 UTC 毫秒时间戳（北京 00:00 = UTC 前一天 16:00）
  const startTime = startBj.getTime() - 8 * 3600000;
  const endTime = now.getTime();
  return { startTime, endTime };
}

// 当天时间范围（北京 00:00 ~ 现在），用于查询当天加款记录做查重和当天次数
function getTodayTimestampRange() {
  const now = new Date();
  const bjNow = new Date(now.getTime() + 8 * 3600000);
  const todayBj = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate()));
  // 北京 00:00 = UTC 前一天 16:00
  const startTime = todayBj.getTime() - 8 * 3600000;
  const endTime = now.getTime();
  return { startTime, endTime };
}

// 一次查询近七日加款记录，客户端过滤出今天的（避免 accountChangeList 重复查询）
// 返回 { weekRechargeMap: Map<member, {count}>, todayRechargeMap: Map<member, items[]> }
async function fetchRechargeRecords(entries, query = riskApiQuery) {
  const weekRechargeMap = new Map();
  const todayRechargeMap = new Map();
  if (!Array.isArray(entries) || entries.length === 0) return { weekRechargeMap, todayRechargeMap };

  const { startTime, endTime } = get7DayTimestampRange();
  const todayStart = getTodayTimestampRange().startTime;
  const members = [...new Set(entries.map(e => String(e.member || "").trim()).filter(Boolean))];

  await pLimit(members, CFG.RISK_API_CONCURRENCY, async (m) => {
    const res = await query("/accountChangeList", { memberName: m, startTime, endTime, transTypeList: [174] });
    if (!res.ok) {
      log.warn("加款记录查询失败，查重和频率检查将失效", { member: m, err: res.err });
      todayRechargeMap.set(m, []);
      weekRechargeMap.set(m, { count: 0, riskCheckFailed: true, riskCheckName: "加款记录" });
      return;
    }
    const items = res.data?.items || [];

    // 近七日次数（排除备注包含"周卡"的记录）
    const weekCount = items.filter(i => {
      const op1 = String(i.operatorRemark || "");
      const op2 = String(i.remark || "");
      return !op1.includes("周卡") && !op2.includes("周卡");
    }).length;
    if (weekCount >= CFG.WEEK_RECHARGE_LIMIT) weekRechargeMap.set(m, { count: weekCount });

    // 从近七日记录中过滤出今天的
    let hasTimeField = false;
    const todayItems = items.filter(i => {
      const t = i.createTime ?? i.createdTime ?? i.created_at ?? i.operationTime;
      if (t !== undefined && t !== null) {
        hasTimeField = true;
        if (typeof t === "number") return t >= todayStart;
        if (typeof t === "string") {
          const ms = Date.parse(t);
          return !isNaN(ms) && ms >= todayStart;
        }
      }
      return false;
    });
    todayRechargeMap.set(m, hasTimeField ? todayItems : []);
  });

  return { weekRechargeMap, todayRechargeMap };
}

async function riskCheckPeriodProfit(entries, query = riskApiQuery) {
  const result = new Map();
  if (!Array.isArray(entries) || entries.length === 0) return result;
  const { startTime, endTime } = get7DayDateRange();
  const members = [...new Set(entries.map(e => String(e.member || "").trim()).filter(Boolean))];

  await pLimit(members, CFG.RISK_API_CONCURRENCY, async (m) => {
    try {
      const res = await query("/memberInOutReport", { memberName: m, startTime, endTime });
      if (!res.ok) {
        result.set(m, { riskCheckFailed: true, riskCheckName: "周期输赢" });
        return;
      }
      const d = res.data?.data || res.data || {};
      if (d.profit === undefined || d.profit === null || !Number.isFinite(money(d.profit, NaN))) {
        result.set(m, { riskCheckFailed: true, riskCheckName: "周期输赢" });
        return;
      }
      const periodProfit = money(d.profit, 0); // 平台B：正数=盈利，负数=亏损
      result.set(m, { periodProfit, startTime, endTime });
    } catch {
      result.set(m, { riskCheckFailed: true, riskCheckName: "周期输赢" });
    }
  });
  return result;
}

// 同一会员的只读风控数据一次性并发查询，缩短单笔加款的等待时间。
// 绿通仅影响结果采用，不影响查询发起，避免因分阶段等待而拖慢整笔处理。
async function runRiskPreChecks(entries) {
  const [giftRatioMap, rechargeRecords, allPeriodProfitMap, allBetConcentrationMap] = await Promise.all([
    riskCheckGiftRatio(entries),
    fetchRechargeRecords(entries),
    riskCheckPeriodProfit(entries),
    riskCheckBetConcentration(entries),
  ]);
  const greenProbeMembers = new Set();
  for (const e of entries || []) {
    const m = String(e?.member || "").trim();
    const info = giftRatioMap.get(m);
    if (info && !info.riskCheckFailed && !info.isNewMember
      && Number.isFinite(info.profitAndLoss)
      && info.profitAndLoss >= CFG.BIG_LOSS_GREEN_THRESHOLD) {
      greenProbeMembers.add(m);
    }
  }

  // 与原有规则保持一致：周期输赢仅用于绿通候选，非候选的预取结果不参与分类。
  const periodProfitMap = new Map();
  for (const member of greenProbeMembers) {
    if (allPeriodProfitMap.has(member)) periodProfitMap.set(member, allPeriodProfitMap.get(member));
  }

  const associationMap = new Map();
  // 绿通会员虽已完成预取，也不采用投注结果或失败状态，保持原先的豁免语义。
  const betConcentrationMap = new Map();
  for (const [member, result] of allBetConcentrationMap) {
    if (!isGreenPassMember(member, giftRatioMap, periodProfitMap, associationMap)) {
      betConcentrationMap.set(member, result);
    }
  }

  return {
    giftRatioMap,
    betConcentrationMap,
    weekRechargeMap: rechargeRecords.weekRechargeMap,
    todayRechargeMap: rechargeRecords.todayRechargeMap,
    periodProfitMap,
    associationMap,
  };
}

// ================================================================
//  8. PARSER
// ================================================================
const SPACED_LINE_RE = /^\s*([a-zA-Z0-9_]+)\s+([a-zA-Z\u4e00-\u9fa5]+)\s+([1-9]\d*)\s*$/;
const COMPACT_CN_LINE_RE = /^\s*([a-zA-Z0-9_]+)\s*([\u4e00-\u9fa5]+)\s*([1-9]\d*)\s*$/;

function normalizeEntryLine(line) {
  return String(line || "").replace(/[，、；]/g, " ").trim();
}

function parseEntryLine(line) {
  const normalized = normalizeEntryLine(line);
  if (!normalized) return null;
  let m = SPACED_LINE_RE.exec(normalized);
  if (!m) m = COMPACT_CN_LINE_RE.exec(normalized);
  if (!m) return null;
  const member = String(m[1] || "").trim();
  const rawRemark = String(m[2] || "").trim();
  const amountStr = String(m[3] || "").trim();
  if (!member || !rawRemark || !amountStr) return null;
  if (/[0-9]/.test(rawRemark)) return null;
  const amount = parseInt(amountStr, 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const remarkLower = rawRemark.toLowerCase();
  const aliased = CFG.REMARK_ALIASES[remarkLower] || CFG.REMARK_ALIASES[rawRemark];
  const remark = aliased || rawRemark;
  return { member, remark, amount, rawRemark };
}

function looksLikeEntry(line) {
  if (!line || typeof line !== "string") return false;
  const t = line.trim();
  if (!t || t.length < 3) return false;
  if (!/^[a-zA-Z0-9_]/.test(t)) return false;
  if (!/\d\s*$/.test(t)) return false;
  if (/^[a-zA-Z0-9]+$/.test(t)) return false;
  return true;
}

function diagnoseLine(line) {
  if (!line || typeof line !== "string") return null;
  // 统一规范化：中文逗号、顿号、分号替换为空格，避免用户混用导致匹配失败
  const t = line.trim().replace(/[，、；]/g, " ");
  if (!t) return null;

  if (parseEntryLine(t)) return null;

  const normalized = normalizeEntryLine(t);
  if (/^[a-zA-Z0-9_]+[a-zA-Z]+[1-9]\d*$/.test(normalized) && !/\s/.test(normalized)) {
    return "英文备注请用空格分隔";
  }

  const userMatch = normalized.match(/^([a-zA-Z0-9_]+)/);
  if (!userMatch) return "用户名只能包含字母、数字和下划线";
  const rest1 = normalized.slice(userMatch[0].length).trim();

  const amtMatch = rest1.match(/([1-9]\d*)\s*$/);
  if (!amtMatch) {
    if (/[-.]/.test(rest1)) return "金额只能为正整数";
    return "缺少金额";
  }
  const middle = rest1.slice(0, rest1.length - amtMatch[0].length).trim();

  if (!middle) return "缺少备注和金额";
  if (/[0-9]/.test(middle)) return "备注不能包含数字";
  if (!/^[a-zA-Z\u4e00-\u9fa5]+$/.test(middle)) return "备注含不支持的字符";

  return "格式异常";
}

function parseEntries(text) {
  if (!text || typeof text !== "string") return { valid: [], unrecognized: [] };
  const trimmed = text.trim();
  if (!trimmed) return { valid: [], unrecognized: [] };
  if (trimmed.length > CFG.MAX_MSG_LENGTH) {
    return { valid: [], unrecognized: [], _warning: `消息过长(${trimmed.length}字符), 已忽略` };
  }

  const valid = [], unrecognized = [];
  const matchedLineNums = new Set();
  const lines = trimmed.split(/\r?\n/);
  let count = 0;

  try {
    for (let i = 0; i < lines.length; i++) {
      const parsedLine = parseEntryLine(lines[i]);
      if (!parsedLine) continue;
      count++;
      if (count > CFG.MAX_ENTRIES) {
        log.warn("消息条目过多, 拒绝处理", { totalAtLeast: count, max: CFG.MAX_ENTRIES });
        return { valid: [], unrecognized: [], _warning: `一次最多处理${CFG.MAX_ENTRIES}笔，当前超过限制，请拆分发送` };
      }
      matchedLineNums.add(i);
      try {
        valid.push({ member: parsedLine.member, remark: parsedLine.remark, amount: parsedLine.amount });
      } catch (e) { log.warn("单条解析异常", { err: e?.message, index: count }); continue; }
    }
  } catch (e) { log.error("正则解析异常", { err: e?.message }); }

  try {
    for (let i = 0; i < lines.length; i++) {
      if (unrecognized.length >= 10) break;
      const line = lines[i].trim();
      if (!line) continue;
      if (matchedLineNums.has(i)) continue;
      if (looksLikeEntry(line)) {
        const hint = diagnoseLine(line);
        if (hint) unrecognized.push({ line, hint });
      }
    }
  } catch (e) { log.warn("未匹配行扫描异常", { err: e?.message }); }

  return { valid, unrecognized };
}

// ================================================================
//  9. CLASSIFIER
// ================================================================
function formatRiskFailure(name, fallback) {
  const raw = String(name || fallback || "风控").trim();
  return raw.split("/").filter(Boolean).map(part => {
    return part.endsWith("查询失败") ? part : `${part}查询失败`;
  }).join("/");
}

function classifyEntries(entries, todayRechargeMap, riskMaps) {
  const auto = [], confirm = [], overLimit = [];
  if (!Array.isArray(entries)) return { auto, confirm, overLimit };

  const keyCounts = new Map();
  for (const e of entries) {
    if (!e || !e.member || !e.remark) continue;
    const key = `${String(e.member).trim()}|${String(e.remark).trim()}`;
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }

  // 当天加款记录（来自后台 accountChangeList，替代本地 tx_log）
  // 结构: Map<member, items[]>，items 含 operatorRemark/amount 等字段
  const todayMap = (todayRechargeMap instanceof Map) ? todayRechargeMap : new Map();

  // 风控预检结果
  const giftRatioMap = (riskMaps && riskMaps.giftRatioMap) || new Map();
  const betConcentrationMap = (riskMaps && riskMaps.betConcentrationMap) || new Map();
  const weekRechargeMap = (riskMaps && riskMaps.weekRechargeMap) || new Map();
  const periodProfitMap = (riskMaps && riskMaps.periodProfitMap) || new Map();
  const associationMap = (riskMaps && riskMaps.associationMap) || new Map();

  for (const e of entries) {
    try {
      if (!e || !e.member || typeof e.amount !== "number" || !isFinite(e.amount)) continue;
      if (e.amount > CFG.AMOUNT_MAX) { overLimit.push(e); continue; }

      // 收集所有触发的原因（不再 continue 跳过后续检查）
      const reasons = [];

      const m = String(e.member).trim();
      const r = String(e.remark || "").trim();
      const key = `${m}|${r}`;

      // 当天同类型彩金重复：用用户输入的备注 r 去匹配后台记录的各个备注字段
      // （operatorRemark / remark），双向包含以应对规范化差异（"周" ↔ "周卡"）
      const todayItems = todayMap.get(m) || [];
      const matched = todayItems.find(item => {
        if (!r) return false;
        const op1 = String(item.operatorRemark || "").trim();
        const op2 = String(item.remark || "").trim();
        if (op1 && (op1.includes(r) || r.includes(op1))) return true;
        if (op2 && (op2.includes(r) || r.includes(op2))) return true;
        return false;
      });
      const inFlight = isProcessing(key);
      if ((keyCounts.get(key) || 0) > 1) {
        reasons.push("批内重复");
      }
      if (matched) {
        reasons.push("当天彩金重复");
      } else if (inFlight) {
        reasons.push("当天彩金重复(处理中)");
      }

      // 周卡标记（提前获取，用于后续豁免判断）
      const isZhouka = r.includes("周卡");

      // 需求 1：总赠送金额 / 总充值金额 占比 > 15%
      const giftRatio = giftRatioMap.get(m);
      const zhoukaHighLoss = isZhouka && giftRatio && Number.isFinite(giftRatio.profitAndLoss) && giftRatio.profitAndLoss >= CFG.HIGH_LOSS_EXEMPT;
      const greenPass = isGreenPassMember(m, giftRatioMap, periodProfitMap, associationMap);
      const softBypass = greenPass || zhoukaHighLoss;
      if (giftRatio && giftRatio.riskCheckFailed) {
        reasons.push(`${giftRatio.riskCheckName || "风控"}查询失败`);
      } else if (giftRatio && giftRatio.isNewMember && e.amount > CFG.NEW_MEMBER_AUTO_MAX) {
        const desc = (giftRatio.newMemberReasons || []).join("、") || "资料较新";
        reasons.push(`新会员(${desc})`);
      } else if (giftRatio && giftRatio.ratio !== undefined && !softBypass) {
        reasons.push(`赠送占比${Math.round((giftRatio.ratio || 0) * 100)}%`);
      }

      const period = periodProfitMap.get(m);
      if (period && period.riskCheckFailed) {
        reasons.push(`${period.riskCheckName || "周期输赢"}查询失败`);
      } else if (period && Number.isFinite(period.periodProfit) && period.periodProfit > CFG.PERIOD_PROFIT_BLOCK) {
        reasons.push(`近七日盈利${Math.round(period.periodProfit)}`);
      }

      const assoc = associationMap.get(m);
      if (assoc && assoc.riskCheckFailed) {
        reasons.push(formatRiskFailure(assoc.riskCheckName, "关联"));
      } else if (assoc && assoc.triggered) {
        reasons.push(...(assoc.reasons || ["关联异常"]));
      }

      // 需求 2：官彩投注占比 > 20%
      const betConc = betConcentrationMap.get(m);
      if (betConc && betConc.riskCheckFailed) {
        reasons.push(`${betConc.riskCheckName || "投注占比"}查询失败`);
      } else if (betConc && !softBypass) {
        reasons.push(`近七日官彩投注占比${Math.round((betConc.ratio || 0) * 100)}%`);
      }

      // 需求 3：近七日除"周卡"外加款次数 > WEEK_RECHARGE_LIMIT
      // 当前备注为"周卡"时，此规则不生效
      const weekRecharge = !isZhouka ? weekRechargeMap.get(m) : undefined;
      if (weekRecharge && weekRecharge.riskCheckFailed) {
        reasons.push(`${weekRecharge.riskCheckName || "加款记录"}查询失败`);
      } else if (weekRecharge && !softBypass) {
        reasons.push(`近七日彩金已加款${weekRecharge.count}次`);
      }

      // 原有规则：当天加款 >= WEEK_RECHARGE_LIMIT 次（数据来自后台 accountChangeList）
      const todayCount = todayItems.length;
      if (todayCount >= CFG.WEEK_RECHARGE_LIMIT && !softBypass) {
        reasons.push(`今日赠送${todayCount + 1}次`);
      }

      if (reasons.length > 0) {
        const entry = { ...e };
        // 整体输赢作为展示信息附加（不是触发条件，仅人工审核时展示）
        // profitAndLoss：机器人内部统一为正数=输钱，负数=赢钱。
        if (giftRatio && Number.isFinite(giftRatio.profitAndLoss)) {
          const pnl = giftRatio.profitAndLoss;
          const label = pnl >= 0 ? "输钱" : "赢钱";
          reasons.push(`${label}：${Math.round(Math.abs(pnl))}`);
        }
        entry._reasons = reasons;
        confirm.push(entry);
        continue;
      }

      const needConfirm = e.amount > CFG.AMOUNT_CONFIRM && !CFG.SAFE_REMARKS.includes(e.remark) && !greenPass;
      (needConfirm ? confirm : auto).push(e);
    } catch (err) { log.warn("分类条目异常", { member: e?.member, err: err?.message }); }
  }

  return { auto, confirm, overLimit };
}

// ================================================================
//  10. EXECUTOR
// ================================================================
async function executeBatch(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (!GLOBAL_TOKEN) {
    return items.map(item => ({ ...item, ok: false, err: "auth-service 未连接" }));
  }

  // 使用 pLimit worker pool 控制并发，避免手写 running Set + Promise.race 的微任务顺序陷阱
  const taskTimeout = CFG.API_TIMEOUT * (CFG.API_RETRY + 1) * 2 + 2000;

  return pLimit(items, CFG.CONCURRENCY, (item) => {
    if (!item || !item.member) {
      return Promise.resolve({ member: item?.member || "未知", remark: item?.remark || "", amount: item?.amount || 0, ok: false, err: "无效条目" });
    }
    let timer = null;
    return Promise.race([
      apiAddBalance(item.member, item.remark, item.amount, ensureRequestId(item)).then(r => ({ ...item, ok: r.ok, err: r.err || undefined })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("单任务超时")), taskTimeout); }),
    ]).catch(err => ({ ...item, ok: false, err: err?.message || "执行异常" }))
      .finally(() => { if (timer) { try { clearTimeout(timer); } catch {} timer = null; } });
  });
}

// ================================================================
//  11. REPORTER
// ================================================================
function trunc(t, max = 3800) {
  try {
    if (typeof t !== "string") return "";
    return t.length > max ? t.slice(0, max) + "\n...已截断" : t;
  } catch { return ""; }
}

function pushSuccessSummary(lines, label, items) {
  if (!Array.isArray(items) || !items.length) return;
  lines.push(`${label}：${items.length} 笔`);
}

function buildBReport(classified, results, notExist) {
  const s = [];
  if (classified.overLimit && classified.overLimit.length) {
    s.push(`⛔️ 拒绝加款：${classified.overLimit.length} 笔`);
    classified.overLimit.forEach((r) => s.push(`${r.member}  ${r.remark}  ${r.amount} - ${r._rejectReason || "金额超限"}`));
  }
  if (notExist && notExist.length) {
    s.push(`⚠️ 账号无效：${notExist.length} 笔`);
    notExist.forEach((r) => s.push(`${r.member}  ${r.remark}  ${r.amount}`));
  }
  if (results && results.length) {
    const ok = results.filter((r) => r && r.ok);
    const fail = results.filter((r) => r && !r.ok);
    pushSuccessSummary(s, "✅ 自动加款", ok);
    ok.forEach((r) => s.push(`${r.member}  ${r.remark}  ${r.amount}`));
    if (fail.length) {
      s.push(`❌ 加款失败：${fail.length} 笔`);
      fail.forEach((r) => s.push(`${r.member}  ${r.remark}  ${r.amount}${r.err ? " - " + r.err : ""}`));
    }
  }
  return s.length ? s.join("\n") : null;
}

function buildConfirmText(items) {
  try {
    if (!Array.isArray(items) || items.length === 0) return "⏳ 操作中...\n(无待处理条目)";
    const lines = ["⏳ 操作中..."];
    for (const i of items) lines.push(`  ${i.member || "?"}  ${i.remark || "?"}  ${i.amount}`);
    return trunc(lines.join("\n"));
  } catch { return "⏳ 操作中..."; }
}

function buildAGroupNotification(classified, results, notExist) {
  const p = [];
  if (classified.overLimit && classified.overLimit.length) {
    p.push(`⛔️ 拒绝加款：${classified.overLimit.length} 笔`);
    classified.overLimit.forEach((r) => p.push(`${r.member}  ${r.remark}  ${r.amount} - ${r._rejectReason || "金额超限"}`));
  }
  if (notExist && notExist.length) {
    p.push(`⚠️ 账号无效：${notExist.length} 笔`);
    notExist.forEach((r) => p.push(`${r.member}  ${r.remark}  ${r.amount}`));
  }
  if (classified.confirm && classified.confirm.length) {
    p.push(`📝 等待审核：${classified.confirm.length} 笔`);
    classified.confirm.forEach((r) => {
      let reason = "";
      if (r._reasons && r._reasons.length) reason = `  -  ${r._reasons.join("/ ")}`;
      p.push(`${r.member}  ${r.remark}  ${r.amount}${reason}`);
    });
  }
  const ok = (results || []).filter(r => r && r.ok);
  pushSuccessSummary(p, "✅ 自动加款", ok);
  const fail = (results || []).filter(r => r && !r.ok);
  if (fail.length) {
    p.push(`❌ 自动加款失败：${fail.length} 笔`);
    fail.forEach(r => p.push(`${r.member}  ${r.remark}  ${r.amount}${r.err ? " - " + r.err : ""}`));
  }
  return p.length ? p.join("\n") : null;
}

// ================================================================
//  12. SAFE TELEGRAM WRAPPERS
// ================================================================
const tg = {
  reply(ctx, text, opts) {
    if (!ctx || !ctx.reply) return Promise.resolve(null);
    try {
      return ctx.reply(typeof text === "string" ? text : String(text), opts || {}).catch((e) => {
        log.error("reply失败", { err: e?.message || String(e) }); return null;
      });
    } catch (e) { log.error("reply异常", { err: e?.message }); return Promise.resolve(null); }
  },
  edit(ctx, text, opts) {
    if (!ctx || !ctx.editMessageText) return Promise.resolve(null);
    try {
      return ctx.editMessageText(typeof text === "string" ? text : String(text), opts || {}).catch((e) => {
        log.debug("edit失败", { err: e?.message }); return null;
      });
    } catch (e) { log.error("edit异常", { err: e?.message }); return Promise.resolve(null); }
  },
  cb(ctx, text) {
    if (!ctx || !ctx.answerCbQuery) return Promise.resolve(null);
    try { return ctx.answerCbQuery(typeof text === "string" ? text : String(text)).catch(() => null); } catch { return Promise.resolve(null); }
  },
  typing(ctx) {
    if (!ctx || !ctx.sendChatAction) return Promise.resolve(null);
    try { return ctx.sendChatAction("typing").catch(() => null); } catch { return Promise.resolve(null); }
  },
};

function displayNameFromUser(user) {
  if (!user) return "未知";
  const full = `${user.first_name || ""}${user.last_name ? " " + user.last_name : ""}`.trim();
  if (full) return full;
  if (user.username) return user.username;
  return "未知";
}

function bjTimeShort() {
  const t = safeNow().slice(11, 16);
  return t ? t.replace(":", "-") : "";
}

function actionOperatorText(ctx) {
  const name = displayNameFromUser(ctx?.from);
  const t = bjTimeShort();
  return t ? `${name} ${t}` : name;
}

// ================================================================
//  13. BOT SETUP
// ================================================================
let GLOBAL_TOKEN = null;
let autoForward = true;
let autoForwardSchedule = false;
let scheduleIv = null;
const pending = new Map();
// 预占位锁：executeBatch 期间占用 member|remark，防止其他消息在异步间隙内重复归类为 auto
// 使用 Map 引用计数：多条消息可并发锁定同一 key，避免 Set 的 delete 误删其他消息的锁
const processingEntries = new Map();
function lockEntry(key) { processingEntries.set(key, (processingEntries.get(key) || 0) + 1); }
function unlockEntry(key) {
  const c = processingEntries.get(key);
  if (c > 1) processingEntries.set(key, c - 1);
  else processingEntries.delete(key);
}
function isProcessing(key) { return processingEntries.has(key); }
function ensureRequestId(item) {
  if (!item || typeof item !== "object") return null;
  if (!item._requestId) item._requestId = crypto.randomBytes(12).toString("hex");
  return item._requestId;
}

// ================================================================
//  auth-service 动态降级与恢复
//  网络失败时 GLOBAL_TOKEN=false 避免后续消息继续撞墙，
//  定时探测恢复后自动重新启用。
// ================================================================
let authRecheckIv = null;

async function checkAuthServiceHealth() {
  try {
    const res = await axios.get(`${AUTH_SERVICE_URL}/health`, {
      headers: authHeaders(), httpAgent: authApiAgent, httpsAgent: authApiAgentS, timeout: 5000,
    });
    if (res.data?.healthy === false) return false; // Token 未就绪，不算恢复
    if (!GLOBAL_TOKEN) {
      GLOBAL_TOKEN = true;
      log.info("auth-service 已恢复, 重新启用加款功能");
    }
    if (authRecheckIv) { clearInterval(authRecheckIv); authRecheckIv = null; }
    return true;
  } catch (e) {
    return false;
  }
}

function scheduleAuthRecheck() {
  if (authRecheckIv) return; // 已在探测中
  log.warn("auth-service 降级, 启动定时探测恢复");
  authRecheckIv = setInterval(() => {
    checkAuthServiceHealth().catch(e => log.debug("auth-service 探测异常", { err: e?.message }));
  }, CFG.AUTH_RECHECK_MS);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, {
  telegram: {
    apiRoot: process.env.TELEGRAM_API_ROOT || undefined,
    agent: tgHttpsAgent,
  },
});

bot.catch((err, ctx) => {
  log.error("Bot未捕获错误", { err: err?.message || String(err), chat: ctx?.chat?.id, updateType: ctx?.updateType });
});

// --- 管理员控制面板 ---
function applySchedule() {
  if (!autoForwardSchedule) return;
  const now = new Date();
  const bjHour = (now.getUTCHours() + 8) % 24;
  const shouldOn = bjHour >= CFG.SCHEDULE_START_HOUR;
  if (autoForward !== shouldOn) {
    autoForward = shouldOn;
    DB.saveAutoForward(autoForward);
    log.info(`定时调度: 自动转发${autoForward ? "开启" : "关闭"}`, { bjHour });
  }
}

function buildMenuText() {
  const fwdStatus = autoForward ? "✅ 已开启" : "❌ 已关闭";
  const schedStatus = autoForwardSchedule ? "✅ 已开启" : "❌ 已关闭";
  return `🎛️ 控制面板\n\n自动转发: ${fwdStatus}\n定时调度: ${schedStatus}`;
}

// 抽取菜单内联键盘，消除三处重复构建（DEAD-3）
function buildMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(autoForward ? "🔴 关闭自动转发" : "🟢 开启自动转发", `toggle_forward`)],
    [Markup.button.callback(autoForwardSchedule ? "🔴 关闭定时调度" : "🟢 开启定时调度", `toggle_schedule`)],
  ]);
}

// 管理员鉴权（SEC-2）：ADMIN_ID 未配置时拒绝所有管理接口，避免任意用户操控
function isAdmin(ctx) {
  return CFG.ADMIN_ID != null && ctx?.from?.id === CFG.ADMIN_ID;
}

// 非管理员访问的统一拒绝响应（使用 tg 包装器，错误内部处理）
function rejectNonAdmin(ctx, cb = true) {
  if (cb) return tg.cb(ctx, "⛔️ 无权限");
  return tg.reply(ctx, "⛔️ 无权限");
}

bot.command("menu", async (ctx) => {
  if (!isAdmin(ctx)) return rejectNonAdmin(ctx, false);
  try {
    await tg.reply(ctx, buildMenuText(), buildMenuKeyboard());
  } catch (e) { log.error("菜单异常", { err: e?.message }); }
});

bot.action(/^toggle_forward$/, async (ctx) => {
  if (!isAdmin(ctx)) return rejectNonAdmin(ctx, true);
  try {
    autoForward = !autoForward;
    DB.saveAutoForward(autoForward);
    // 手动切换自动转发时关闭定时调度，避免被定时器覆盖
    if (autoForwardSchedule) {
      autoForwardSchedule = false;
      DB.saveAutoForwardSchedule(false);
    }
    await tg.edit(ctx, buildMenuText(), buildMenuKeyboard());
    await tg.cb(ctx, autoForward ? "✅ 已开启" : "❌ 已关闭");
    log.info("自动转发状态切换", { autoForward });
  } catch (e) { log.error("切换异常", { err: e?.message }); }
});

bot.action(/^toggle_schedule$/, async (ctx) => {
  if (!isAdmin(ctx)) return rejectNonAdmin(ctx, true);
  try {
    autoForwardSchedule = !autoForwardSchedule;
    DB.saveAutoForwardSchedule(autoForwardSchedule);
    if (autoForwardSchedule) applySchedule();
    await tg.edit(ctx, buildMenuText(), buildMenuKeyboard());
    await tg.cb(ctx, autoForwardSchedule ? "✅ 定时调度已开启" : "❌ 定时调度已关闭");
    log.info("定时调度状态切换", { autoForwardSchedule });
  } catch (e) { log.error("定时调度切换异常", { err: e?.message }); }
});

// --- 按真实姓名查询老用户 ---
// 注：此命令无需鉴权，所有群成员均可使用（业务需求）
bot.command("checkoldusers", async (ctx) => {
  try {
    const rawText = ctx?.message?.text || "";
    const realname = rawText.replace(/^\/checkoldusers\s*/i, "").trim();
    if (!realname) {
      await tg.reply(ctx, "❌ 请输入真实姓名\n用法: /checkoldusers 张三");
      return;
    }

    if (!GLOBAL_TOKEN) {
      await tg.reply(ctx, "❌ auth-service 未连接, 系统未初始化。");
      return;
    }

    await tg.typing(ctx);

    const result = await apiCheckOldUsers(realname);

    // 401/403 可能是 auth-service 重启或 Token 临时失效,降级并调度探测恢复,避免系统永久瘫痪
    if (result.tokenExpired || result.authError) {
      GLOBAL_TOKEN = false;
      scheduleAuthRecheck();
      await tg.reply(ctx, `❌ ${result.err}, 系统已降级, 请稍后重试`);
      return;
    }

    if (!result.ok) {
      await tg.reply(ctx, `❌ 查询失败: ${result.err}`);
      return;
    }

    const items = result.items || [];
    if (items.length === 0) {
      await tg.reply(ctx, `🔍 未找到姓名为「${realname}」的会员`);
      return;
    }

    const lines = [`🔍 查询结果 (共${result.totalNum || items.length}人)`];
    for (const u of items) {
      const profitVal = Math.round(parseFloat(u.profitAndLoss) || 0);
      const profitText = profitVal < 0 ? `输钱：${Math.abs(profitVal)}` : (profitVal > 0 ? `赢钱：${profitVal}` : "赢钱：0");
      const statusText = Number(u.freezeStatus) === 0 ? "正常" : "禁用";
      const remarkText = u.remark || "无";

      lines.push("────────────────");
      lines.push(`会员帐号：${u.memberName || "未知"}`);
      lines.push(profitText);
      lines.push(`最后登录IP：${u.latestLoginIp || "未知"}`);
      lines.push(`最后登录地址：${u.latestLoginAddress || "未知"}`);
      lines.push(`账号状态：${statusText}`);
      lines.push(`备注内容：${remarkText}`);
    }

    await tg.reply(ctx, trunc(lines.join("\n")));
    log.info("checkoldusers查询完成", { realname, count: items.length });
  } catch (e) {
    log.error("checkoldusers异常", { err: e?.message || String(e), stack: e?.stack });
    await tg.reply(ctx, "⚠️ 查询出错, 请稍后重试。");
  }
});

// ================================================================
//  13a. 频率限制（SEC-1）：每用户每分钟最大消息数，防刷屏/防轰炸
// ================================================================
const userMsgTimestamps = new Map(); // userId → number[]（毫秒时间戳）

function checkRateLimit(ctx) {
  const userId = ctx?.from?.id;
  if (!userId) return false;
  if (CFG.ADMIN_ID != null && userId === CFG.ADMIN_ID) return false; // 管理员豁免
  const now = Date.now();
  const windowMs = 60000;
  let arr = userMsgTimestamps.get(userId);
  if (!arr) { arr = []; userMsgTimestamps.set(userId, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= CFG.RATE_LIMIT_PER_MIN) return true;
  arr.push(now);
  return false;
}

// --- 编辑消息处理 ---
bot.on("edited_message", async (ctx) => {
  try {
    const chatId = ctx?.chat?.id;
    if (CFG.GROUP_A_ID && chatId === CFG.GROUP_A_ID) {
      const editedText = ctx?.edited_message?.text || "";
      const replyText = editedText ? `⚠️ 编辑无效，请重新发送:\n${editedText}` : "⚠️ 编辑无效，请重新发送";
      await tg.reply(ctx, replyText, { reply_to_message_id: ctx?.edited_message?.message_id });
    }
  } catch (e) { log.error("编辑消息处理异常", { err: e?.message }); }
});

// --- 消息入口 ---
bot.on("text", async (ctx) => {
  try {
    const rawText = ctx?.message?.text;
    if (!rawText || typeof rawText !== "string") return;

    const chatId = ctx?.chat?.id;
    if (!chatId) return;

    // 频率限制：超阈值静默丢弃，避免刷屏消耗 API 配额
    if (checkRateLimit(ctx)) {
      log.warn("用户触发频率限制", { userId: ctx.from?.id, chatId });
      return;
    }

    const parsed = parseEntries(rawText);
    log.debug("消息接收", { chatId, valid: parsed.valid.length, unrecognized: parsed.unrecognized.length, textLen: rawText.length, preview: rawText.slice(0, 80) });
    if (parsed._warning) {
      await tg.reply(ctx, `⚠️ ${parsed._warning}`);
      return;
    }
    if (!parsed.valid.length && !parsed.unrecognized.length) return;

    // A群组 — 验证格式 + 查重 + 转发B群
    if (CFG.GROUP_A_ID && chatId === CFG.GROUP_A_ID) {
      log.debug("路由→A群", { valid: parsed.valid.length, autoForward, hasToken: !!GLOBAL_TOKEN });
      if (parsed.unrecognized && parsed.unrecognized.length) {
        let t = `⚠️ 格式有误，请重新发送:\n`;
        for (const u of parsed.unrecognized) t += `  ${u.line} — ${u.hint}\n`;
        await tg.reply(ctx, trunc(t), { reply_to_message_id: ctx.message.message_id });
      }

      if (!parsed.valid.length) return;

      if (!autoForward) return;

      let validEntries = parsed.valid;

      let notExistMembers = [];
      if (GLOBAL_TOKEN) {
        const { map: existMap, tokenExpired, authError, networkError } = await checkUserExists(parsed.valid.map(e => e.member));

        if (tokenExpired || authError || networkError) {
          const bGroupId = CFG.GROUP_B_ID || CFG.TARGET_CHAT_ID;
          const senderName = ctx?.from ? ((ctx.from.first_name || "") + (ctx.from.last_name || "") || ctx.from.username || "未知") : "A群";
          const preview = rawText.slice(0, 80);
          let errMsg = "";
          if (tokenExpired) {
            errMsg = "❌ API 认证失败, 请检查 auth-service 配置";
            GLOBAL_TOKEN = false;
            scheduleAuthRecheck(); // 硬约束：所有 401/403 降级路径必须调用，避免永久瘫痪
          } else if (authError) {
            errMsg = "❌ API 权限不足, 请检查 AUTH_API_KEY 配置";
            GLOBAL_TOKEN = false;
            scheduleAuthRecheck(); // 硬约束：所有 401/403 降级路径必须调用，避免永久瘫痪
          } else {
            errMsg = "⚠️ 网络异常, 无法验证用户, 请稍后重试";
            GLOBAL_TOKEN = false; // 网络问题，降级+定时探测恢复
            scheduleAuthRecheck();
          }
          if (bGroupId) {
            await bot.telegram.sendMessage(bGroupId, `${errMsg}\n来自: ${senderName}\n消息: ${preview}`).catch(() => {});
          }
          return;
        }

        validEntries = [];
        for (const e of parsed.valid) {
          const info = existMap.get(e.member);
          if (info?.exists === false) {
            notExistMembers.push(e);
          } else {
            validEntries.push({ ...e });
          }
        }
      }

      if (!validEntries.length && !notExistMembers.length) {
        await tg.reply(ctx, "⚠️ 无法验证用户状态，请稍后重试。");
        return;
      }

      await processForGroupB(validEntries, chatId, ctx.message.message_id, ctx?.from, notExistMembers);
      return;
    }

    // B群组判断
    const isTarget =
      (CFG.GROUP_B_ID && chatId === CFG.GROUP_B_ID) ||
      (!CFG.GROUP_B_ID && CFG.TARGET_CHAT_ID && chatId === CFG.TARGET_CHAT_ID);

    log.debug("路由→B群判断", { chatId, groupB: CFG.GROUP_B_ID, targetChatId: CFG.TARGET_CHAT_ID, isTarget, chatType: ctx.chat?.type, fromId: ctx?.from?.id });
    if (!isTarget) return;

    if (parsed.unrecognized && parsed.unrecognized.length) {
      let t = `⚠️ 未识别 (${parsed.unrecognized.length}笔):\n`;
      for (const u of parsed.unrecognized) t += `  ${u.line} — ${u.hint}\n`;
      await tg.reply(ctx, trunc(t), { reply_to_message_id: ctx.message.message_id });
    }

    if (!parsed.valid.length) return;
    if (!GLOBAL_TOKEN) return await tg.reply(ctx, "❌ auth-service 未连接, 系统未初始化。");

    log.debug("B群→进入handleB", { valid: parsed.valid.length });
    await handleB(ctx, parsed.valid);
  } catch (e) {
    log.error("消息处理失败", { err: e?.message || String(e), stack: e?.stack });
    try { await tg.reply(ctx, "⚠️ 内部错误, 请稍后重试。"); } catch {}
  }
});

// --- A群转发B群处理 ---
// ================================================================
// 公共逻辑：风控预检 + 分类 + 加锁 + 执行 auto + 释放 auto 锁
// processForGroupB 与 handleB 共享（约 90% 逻辑相同）
// 返回 { classified, results, confirmLockKeys }
// 注意：confirm 锁由本函数加锁但**不释放**，调用方负责：
//   - 成功路径：pending.set 后由 ok_/no_/expireEntry 释放
//   - 异常路径（executeBatch 抛错）：本函数自动释放 confirm 锁
//   - 异常路径（pending.set 前抛错）：调用方通过 unmanagedConfirmLocks 兜底释放
// ================================================================
async function classifyAndExecute(entries) {
  // 风控预检：失败即转人工，避免查不到数据时自动加款。
  let riskMaps = { giftRatioMap: new Map(), betConcentrationMap: new Map(), weekRechargeMap: new Map(), todayRechargeMap: new Map(), periodProfitMap: new Map(), associationMap: new Map() };
  try {
    riskMaps = await runRiskPreChecks(entries);
  } catch (e) {
    log.warn("风控预检失败, 全部转人工", { err: e?.message || String(e) });
    const failMap = new Map();
    for (const item of entries || []) {
      const m = String(item?.member || "").trim();
      if (m) failMap.set(m, { riskCheckFailed: true, riskCheckName: "风控" });
    }
    riskMaps = { giftRatioMap: failMap, betConcentrationMap: new Map(), weekRechargeMap: new Map(), todayRechargeMap: new Map(), periodProfitMap: new Map(), associationMap: new Map() };
  }
  const classified = classifyEntries(entries, riskMaps.todayRechargeMap, riskMaps);

  // 预占位：对 auto 和 confirm 都立即加锁，防止并发消息将相同 member|remark 归类为 auto 重复加款
  // auto 的锁在 executeBatch 完成后释放；confirm 的锁随 pending 生命周期，在 ok_/no_/expireEntry 释放
  const autoLockKeys = [];
  const confirmLockKeys = [];
  for (const item of classified.auto) {
    const lk = `${String(item.member).trim()}|${String(item.remark).trim()}`;
    lockEntry(lk);
    autoLockKeys.push(lk);
  }
  for (const item of classified.confirm) {
    const lk = `${String(item.member).trim()}|${String(item.remark).trim()}`;
    lockEntry(lk);
    confirmLockKeys.push(lk);
  }

  let results = null;
  let failed = false;
  try {
    if (classified.auto.length) {
      results = await executeBatch(classified.auto);
    }
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    // auto 锁总是释放（executeBatch 成功或失败）
    for (const lk of autoLockKeys) unlockEntry(lk);
    // executeBatch 失败：confirm 锁也释放（无 pending 生命周期能管理它们）
    if (failed) {
      for (const lk of confirmLockKeys) unlockEntry(lk);
    }
  }
  return { classified, results, confirmLockKeys };
}

// ================================================================
// A群 → B群：从 A群接收消息，转发到 B群处理
// ================================================================
async function processForGroupB(entries, sourceChatId, sourceMessageId, sourceFrom, notExistMembers) {
  let unmanagedConfirmLocks = null; // pending.set 前异常时的兜底释放
  try {
    const bGroupId = CFG.GROUP_B_ID || CFG.TARGET_CHAT_ID;
    log.info("A群→processForGroupB", { entries: entries.length, bGroupId, sourceChatId, hasToken: !!GLOBAL_TOKEN });
    if (!bGroupId) {
      log.error("processForGroupB: B群ID未配置");
      return;
    }

    const senderName = sourceFrom ? ((sourceFrom.first_name || "") + (sourceFrom.last_name || "") || sourceFrom.username || "未知") : "A群";
    const header = `📥 来自: ${senderName}`;

    if (!GLOBAL_TOKEN) {
      await bot.telegram.sendMessage(bGroupId, `${header}\n❌ auth-service 未连接, 无法处理加款, 请稍后重试`).catch(() => {});
      return;
    }

    const { classified, results, confirmLockKeys } = await classifyAndExecute(entries);
    unmanagedConfirmLocks = confirmLockKeys;

    const baseReport = buildBReport(classified, results, notExistMembers);

    let aGroupMsgId = null;
    const aMsg = buildAGroupNotification(classified, results, notExistMembers);
    if (aMsg) {
      try {
        const aSent = await bot.telegram.sendMessage(sourceChatId, trunc(aMsg), {
          reply_to_message_id: sourceMessageId
        });
        aGroupMsgId = aSent?.message_id || null;
      } catch (e) { log.error("A群通知失败", { err: e?.message }); }
    }

    if (classified.confirm.length) {
      let bText = `${header}\n📊 处理报告`;
      if (baseReport) bText += "\n" + baseReport;
      bText += `\n⏳ 等待操作：${classified.confirm.length} 笔`;
      for (const t of classified.confirm) {
        const reason = (t._reasons && t._reasons.length) ? `  -  ${t._reasons.join("/ ")}` : "";
        bText += `\n${t.member || "?"}  ${t.remark || "?"}  ${t.amount}${reason}`;
      }

      const id = crypto.randomBytes(6).toString("hex");
      if (pending.size >= CFG.MAX_PENDING) await cleanPending();

      // 先发送 B群消息以获取 message_id，用于超时后主动编辑
      const bSent = await bot.telegram.sendMessage(bGroupId, trunc(bText), Markup.inlineKeyboard([
        Markup.button.callback("✅ 确认", `ok_${id}`),
        Markup.button.callback("❌ 取消", `no_${id}`),
      ])).catch(e => { log.error("B群确认消息发送失败", { err: e?.message }); return null; });
      if (!bSent) {
        for (const lk of confirmLockKeys) unlockEntry(lk);
        unmanagedConfirmLocks = null;
        await bot.telegram.sendMessage(sourceChatId, "⚠️ B群确认消息发送失败，待审核加款未入队，请稍后重试。", {
          reply_to_message_id: sourceMessageId
        }).catch(e => log.error("A群发送确认失败通知失败", { err: e?.message }));
        return;
      }

      pending.set(id, {
        tasks: classified.confirm,
        expire: Date.now() + CFG.CONFIRM_EXPIRE_MS,
        autoResults: results || [],
        overLimit: classified.overLimit || [],
        notExist: notExistMembers || [],
        header,
        sourceChatId,
        sourceMessageId,
        aGroupMsgId,
        bGroupId,
        bMessageId: bSent?.message_id ?? null,
        confirmLockKeys,
      });
      scheduleExpiry(id, pending.get(id));
      unmanagedConfirmLocks = null; // confirm 锁已移交 pending 管理
    } else {
      let bText = `${header}\n📊 处理报告`;
      if (baseReport) bText += "\n" + baseReport;
      await bot.telegram.sendMessage(bGroupId, trunc(bText)).catch(e => log.error("B群报告发送失败", { err: e?.message }));
    }

    log.info("A群→B群: 处理完成", { auto: classified.auto.length, confirm: classified.confirm.length, overLimit: classified.overLimit.length });
  } catch (e) {
    // pending.set 前异常时释放 confirm 锁，避免泄漏
    if (unmanagedConfirmLocks) {
      for (const lk of unmanagedConfirmLocks) unlockEntry(lk);
    }
    log.error("processForGroupB失败", { err: e?.message || String(e), stack: e?.stack });
  }
}

// --- B群组处理 ---
async function handleB(ctx, entries) {
  let unmanagedConfirmLocks = null; // pending.set 前异常时的兜底释放
  try {
    await tg.typing(ctx);

    let validEntries = entries;

    let notExistMembers = [];
    if (GLOBAL_TOKEN) {
      const { map: existMap, tokenExpired, authError, networkError } = await checkUserExists(entries.map(e => e.member));

      if (tokenExpired) {
        GLOBAL_TOKEN = false;
        scheduleAuthRecheck(); // 硬约束：所有 401/403 降级路径必须调用，避免永久瘫痪
        await tg.reply(ctx, "❌ API 认证失败, 请检查 auth-service 配置。");
        return;
      }
      if (authError) {
        GLOBAL_TOKEN = false;
        scheduleAuthRecheck(); // 硬约束：所有 401/403 降级路径必须调用，避免永久瘫痪
        await tg.reply(ctx, "❌ API 权限不足, 请检查 AUTH_API_KEY 配置。");
        return;
      }
      if (networkError) {
        GLOBAL_TOKEN = false; // 网络问题，降级+定时探测恢复
        scheduleAuthRecheck();
        await tg.reply(ctx, "⚠️ 网络异常, 无法验证用户, 请稍后重试。");
        return;
      }

      validEntries = [];
      for (const e of entries) {
        const info = existMap.get(e.member);
        if (info?.exists === false) {
          notExistMembers.push(e);
        } else {
          validEntries.push({ ...e });
        }
      }

      if (!validEntries.length && !notExistMembers.length) {
        await tg.reply(ctx, "⚠️ 无法验证用户状态，请稍后重试。");
        return;
      }
    }

    // 风控预检 + 分类 + 加锁 + 执行 auto + 释放 auto 锁（公共逻辑）
    const { classified, results, confirmLockKeys } = await classifyAndExecute(validEntries);
    unmanagedConfirmLocks = confirmLockKeys;

    const baseReport = buildBReport(classified, results, notExistMembers);

    if (classified.confirm.length) {
      let confirmList = `⏳ 等待操作：${classified.confirm.length} 笔`;
      for (const t of classified.confirm) {
        const reason = (t._reasons && t._reasons.length) ? `  -  ${t._reasons.join("/ ")}` : "";
        confirmList += `\n${t.member || "?"}  ${t.remark || "?"}  ${t.amount}${reason}`;
      }

      const fullText = `📊 处理报告\n` + (baseReport ? baseReport + "\n" : "") + confirmList;

      const id = crypto.randomBytes(6).toString("hex");
      if (pending.size >= CFG.MAX_PENDING) await cleanPending();

      // 先发送 B群消息以获取 message_id，用于超时后主动编辑
      let replyMsg = null;
      try {
        replyMsg = await tg.reply(ctx, trunc(fullText), {
          reply_to_message_id: ctx?.message?.message_id,
          ...Markup.inlineKeyboard([
            Markup.button.callback("✅ 确认", `ok_${id}`),
            Markup.button.callback("❌ 取消", `no_${id}`),
          ]),
        });
      } catch (e) { log.error("确认消息发送失败", { err: e?.message }); }
      if (!replyMsg) {
        for (const lk of confirmLockKeys) unlockEntry(lk);
        unmanagedConfirmLocks = null;
        await tg.reply(ctx, "⚠️ 确认消息发送失败，待审核加款未入队，请稍后重试。").catch(() => {});
        return;
      }

      pending.set(id, {
        tasks: classified.confirm,
        expire: Date.now() + CFG.CONFIRM_EXPIRE_MS,
        overLimit: classified.overLimit || [],
        notExist: notExistMembers,
        autoResults: results || [],
        header: null,
        sourceChatId: null,
        sourceMessageId: null,
        bGroupId: ctx.chat?.id ?? null,
        bMessageId: replyMsg?.message_id ?? null,
        confirmLockKeys,
      });
      scheduleExpiry(id, pending.get(id));
      unmanagedConfirmLocks = null; // confirm 锁已移交 pending 管理
    } else if (baseReport) {
      await tg.reply(ctx, `📊 处理报告\n` + baseReport, { reply_to_message_id: ctx?.message?.message_id });
    }
  } catch (e) {
    // pending.set 前异常时释放 confirm 锁，避免泄漏
    if (unmanagedConfirmLocks) {
      for (const lk of unmanagedConfirmLocks) unlockEntry(lk);
    }
    log.error("B群处理失败", { err: e?.message || String(e), stack: e?.stack });
    try { await tg.reply(ctx, "⚠️ 处理过程中出错, 请查看日志。"); } catch {}
  }
}

// --- 确认回调 ---
bot.action(/^ok_(.+)$/, async (ctx) => {
  try {
    const id = ctx?.match?.[1];
    if (!id) return tg.cb(ctx, "参数无效");

    const cached = pending.get(id);
    if (cached && cached._timer) { try { clearTimeout(cached._timer); } catch {} }
    if (!cached) return tg.edit(ctx, "⏰ 已过期或不存在", { reply_markup: { inline_keyboard: [] } }).then(() => tg.cb(ctx, "已过期"));
    pending.delete(id); // 立即删除，防止双击重复执行
    cached.actionOperator = actionOperatorText(ctx);
    log.info("确认按钮点击", { id, operator: cached.actionOperator });

    // 所有路径统一在 finally 释放 confirm 锁，避免早返回导致泄漏
    let results = null;
    try {
      if (!cached.tasks || !Array.isArray(cached.tasks)) {
        await tg.edit(ctx, "⚠️ 数据异常", { reply_markup: { inline_keyboard: [] } });
        await tg.cb(ctx, "数据异常");
        return;
      }
      if (Date.now() > cached.expire) {
        await notifyAGroup(cached, 'expired');
        await tg.edit(ctx, "⏰ 操作超时", { reply_markup: { inline_keyboard: [] } });
        await tg.cb(ctx, "已超时");
        return;
      }
      if (!GLOBAL_TOKEN) {
        await tg.edit(ctx, "❌ auth-service 未连接, 无法执行操作", { reply_markup: { inline_keyboard: [] } });
        await tg.cb(ctx, "无Token");
        return;
      }

      const toRun = (cached.tasks || []).filter(t => t && t.member && t.remark);
      if (!toRun.length) {
        await tg.edit(ctx, "⏳ 无有效条目", { reply_markup: { inline_keyboard: [] } });
        await tg.cb(ctx, "空");
        return;
      }

      await tg.edit(ctx, buildConfirmText(toRun), { reply_markup: { inline_keyboard: [] } });
      try {
        results = await executeBatch(toRun);
      } catch (execErr) {
        // executeBatch 内部用 Promise.allSettled 正常不会抛错，此处兜底防止极端异常导致消息卡在"操作中"
        log.error("executeBatch 异常", { err: execErr?.message || String(execErr) });
        results = toRun.map(item => ({ ...item, ok: false, err: "执行异常: " + (execErr?.message || "未知") }));
      }

      if (cached.sourceChatId) {
        await notifyAGroup(cached, 'confirmed', results);
      }

      const header = cached.header || null;
      const baseReport = buildBReport({ overLimit: cached.overLimit || [] }, cached.autoResults, cached.notExist || []);

      let bEditText = header ? `${header}\n📊 处理报告` : "📊 处理报告";
      if (baseReport) bEditText += "\n" + baseReport;
      bEditText += `\n🔄 操作人员：${cached.actionOperator}`;
      const okConfirm = (results || []).filter(r => r && r.ok);
      if (okConfirm.length) {
        bEditText += `\n✅ 审核加款：${okConfirm.length} 笔`;
        okConfirm.forEach(r => { bEditText += `\n${r.member}  ${r.remark}  ${r.amount}`; });
      }
      const failConfirm = (results || []).filter(r => r && !r.ok);
      if (failConfirm.length) {
        bEditText += `\n❌ 审核失败：${failConfirm.length} 笔`;
        failConfirm.forEach(r => { bEditText += `\n${r.member}  ${r.remark}  ${r.amount} - ${r.err || ""}`; });
      }
      await tg.edit(ctx, trunc(bEditText), { reply_markup: { inline_keyboard: [] } });
      await tg.cb(ctx, "完成");
    } finally {
      // 无论正常返回、早返回还是异常，都释放 confirm 锁
      if (Array.isArray(cached.confirmLockKeys)) {
        for (const lk of cached.confirmLockKeys) unlockEntry(lk);
      }
    }
  } catch (e) {
    log.error("确认执行失败", { err: e?.message || String(e), stack: e?.stack });
    try { await tg.cb(ctx, "执行出错, 请查看日志"); } catch {}
  }
});

bot.action(/^no_(.+)$/, async (ctx) => {
  try {
    const id = ctx?.match?.[1];
    let cached = id ? pending.get(id) : null;
    if (cached && cached._timer) { try { clearTimeout(cached._timer); } catch {} }
    if (id) pending.delete(id);
    if (cached) {
      cached.actionOperator = actionOperatorText(ctx);
      log.info("取消按钮点击", { id, operator: cached.actionOperator });
    }
    // 释放 confirm 占位锁
    if (cached && Array.isArray(cached.confirmLockKeys)) {
      for (const lk of cached.confirmLockKeys) unlockEntry(lk);
    }
    if (!cached) {
      // 已被 ok_ 或 expireEntry 处理，不编辑消息避免覆盖结果
      await tg.cb(ctx, "已处理");
      return;
    }
    const isExpired = Date.now() > cached.expire;
    if (cached.sourceChatId) {
      await notifyAGroup(cached, isExpired ? 'expired' : 'cancelled');
    }
    const header = cached.header || null;
    const baseReport = buildBReport({ overLimit: cached.overLimit || [] }, cached.autoResults, cached.notExist || []);

    let bEditText = header ? `${header}\n📊 处理报告` : "📊 处理报告";
    if (baseReport) bEditText += "\n" + baseReport;
    bEditText += `\n🔄 操作人员：${cached.actionOperator}`;
    if (cached.tasks && cached.tasks.length) {
      bEditText += `\n❌ 取消加款：${cached.tasks.length} 笔`;
      cached.tasks.forEach(r => {
        const reason = (r._reasons && r._reasons.length) ? `  -  ${r._reasons.join("/ ")}` : "";
        bEditText += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}${reason}`;
      });
    }
    await tg.edit(ctx, trunc(bEditText), { reply_markup: { inline_keyboard: [] } });
    await tg.cb(ctx, isExpired ? "已超时" : "已取消");
  } catch (e) { log.error("取消操作异常", { err: e?.message }); }
});

// ================================================================
//  14. EXPRESS + HEALTH
// ================================================================
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: false }));

app.get("/health", (_req, res) => {
  try {
    res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
  } catch (e) { res.status(500).json({ status: "error", error: e?.message }); }
});

app.get("/", (_req, res) => { try { res.send("Bot Running"); } catch {} });
app.use((err, _req, res, _next) => {
  log.error("Express错误", { err: err?.message });
  try { res.status(500).json({ error: "Internal Server Error" }); } catch {}
});

// ================================================================
//  15. PROCESS GUARD
// ================================================================
process.on("uncaughtException", (e) => {
  log.fatal("uncaughtException, 进程即将退出", { err: e?.message, stack: e?.stack?.slice(0, 500) });
  // 1 秒退出：平衡日志刷新与避免在损坏状态下继续处理消息
  setTimeout(() => process.exit(1), 1000);
});
process.on("unhandledRejection", (r) => {
  log.error("unhandledRejection (已捕获)", { reason: r?.message ? String(r.message).slice(0, 200) : String(r) });
});

const memIv = setInterval(() => {
  try {
    const m = process.memoryUsage();
    if (Math.round(m.rss / 1024 / 1024) > 300) log.warn("内存使用过高", { rssMB: Math.round(m.rss / 1024 / 1024) });
  } catch {}
  // 清理频率限制 Map 中的过期用户条目，避免长期累积泄漏
  try {
    const now = Date.now();
    for (const [uid, arr] of userMsgTimestamps) {
      if (!arr || arr.length === 0 || now - arr[arr.length - 1] > 120000) userMsgTimestamps.delete(uid);
    }
  } catch {}
}, 60000);

// ================================================================
//  14a. A群通知助手 — 消除 cleanPending / ok_ / no_ 中的重复 ~130 行代码
// ================================================================
// --- 编辑消息带重试 ---
// 仅对可重试错误重试：429 限流、5xx 服务端错误、网络错误
// 不可重试错误立即抛出：400 Bad Request（消息未变/内容空）、403 Forbidden（bot 被屏蔽）
function isRetryableTgError(e) {
  if (!e) return false;
  const status = e.response?.error_code || e.code || e.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const desc = e.description || e.message || "";
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|timeout/i.test(desc)) return true;
  return false;
}

async function editWithRetry(chatId, msgId, text, maxRetries = 2, delayMs = 800) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await bot.telegram.editMessageText(chatId, msgId, undefined, text);
    } catch (e) {
      if (!isRetryableTgError(e) || i >= maxRetries) throw e;
      const retryAfter = e.response?.parameters?.retry_after;
      const wait = retryAfter ? retryAfter * 1000 : delayMs * (i + 1);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

async function notifyAGroup(c, action, newResults) {
  if (!c || !c.sourceChatId) return;
  let t = "";

  if (c.overLimit && c.overLimit.length) {
    t += (t ? "\n" : "") + `⛔️ 拒绝加款：${c.overLimit.length} 笔`;
    c.overLimit.forEach(r => { t += `\n${r.member}  ${r.remark}  ${r.amount} - ${r._rejectReason || "金额超限"}`; });
  }
  if (c.notExist && c.notExist.length) {
    t += (t ? "\n" : "") + `⚠️ 账号无效：${c.notExist.length} 笔`;
    c.notExist.forEach(r => { t += `\n${r.member}  ${r.remark}  ${r.amount}`; });
  }

  // 自动加款结果：成功项汇总，失败项逐笔展示。
  const autoOk = (c.autoResults || []).filter(r => r && r.ok);
  const autoFail = (c.autoResults || []).filter(r => r && !r.ok);
  if (autoOk.length) {
    t += (t ? "\n" : "") + `✅ 自动加款：${autoOk.length} 笔`;
  }
  if (autoFail.length) {
    t += (t ? "\n" : "") + `❌ 自动加款失败：${autoFail.length} 笔`;
    autoFail.forEach(r => { t += `\n${r.member}  ${r.remark}  ${r.amount} - ${r.err || ""}`; });
  }

  // 审核任务结果（confirm 队列）
  if (c.tasks && c.tasks.length) {
    if (action === 'expired') {
      t += (t ? "\n" : "") + `❌ 超时取消：${c.tasks.length} 笔`;
      c.tasks.forEach(r => {
        const reason = (r._reasons && r._reasons.length) ? `  -  ${r._reasons.join("/ ")}` : "";
        t += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}${reason}`;
      });
    } else if (action === 'purged') {
      // 容量超限主动清理：与超时取消区分，便于运维定位 pending 容量问题
      t += (t ? "\n" : "") + `❌ 系统取消：${c.tasks.length} 笔`;
      c.tasks.forEach(r => {
        const reason = (r._reasons && r._reasons.length) ? `  -  ${r._reasons.join("/ ")}` : "";
        t += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}${reason}`;
      });
    } else if (action === 'cancelled') {
      t += (t ? "\n" : "") + `❌ 取消加款：${c.tasks.length} 笔`;
      c.tasks.forEach(r => {
        const reason = (r._reasons && r._reasons.length) ? `  -  ${r._reasons.join("/ ")}` : "";
        t += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}${reason}`;
      });
    } else if (action === 'confirmed') {
      // 展示审核结果明细：成功 + 失败（失败项必须可见，避免资金风险静默）
      const confirmOk = (newResults || []).filter(r => r && r.ok);
      const confirmFail = (newResults || []).filter(r => r && !r.ok);
      if (confirmOk.length) {
        t += (t ? "\n" : "") + `✅ 审核加款：${confirmOk.length} 笔`;
      }
      if (confirmFail.length) {
        t += (t ? "\n" : "") + `❌ 审核失败：${confirmFail.length} 笔`;
        confirmFail.forEach(r => { t += `\n${r.member}  ${r.remark}  ${r.amount} - ${r.err || ""}`; });
      }
    }
  }

  if (!t) return;

  // 截断防止超长（Telegram 4096 限制）
  const text = trunc(t);

  if (c.aGroupMsgId) {
    await editWithRetry(c.sourceChatId, c.aGroupMsgId, text).catch(e => {
      log.warn("A群通知编辑失败（重试后仍失败）", { err: e?.message });
      bot.telegram.sendMessage(c.sourceChatId, text, {
        reply_to_message_id: c.sourceMessageId
      }).catch(e2 => log.error("A群通知发送失败", { err: e2?.message }));
    });
  } else if (c.sourceMessageId) {
    await bot.telegram.sendMessage(c.sourceChatId, text, {
      reply_to_message_id: c.sourceMessageId
    }).catch(e => log.error("A群通知发送失败", { err: e?.message }));
  }
}

// --- 单条过期处理（供定时器和安全网共用）---
// action: 'expired'（定时器/超时）| 'purged'（容量超限主动清理）
async function expireEntry(id, entry, action = 'expired') {
  // 幂等守卫：delete 返回 false 表示已被处理（定时器和安全网可能并发）
  if (!pending.delete(id)) return;
  if (!entry || !entry.tasks || !entry.tasks.length) return;
  // 清除定时器防止重复触发
  if (entry._timer) { try { clearTimeout(entry._timer); } catch {} }
  // 释放 confirm 占位锁
  if (Array.isArray(entry.confirmLockKeys)) {
    for (const lk of entry.confirmLockKeys) unlockEntry(lk);
  }

  if (entry.sourceChatId) {
    try { await notifyAGroup(entry, action); } catch (e) { log.warn("expireEntry A群通知失败", { err: e?.message }); }
  }
  if (entry.bGroupId && entry.bMessageId) {
    try {
      const header = entry.header || null;
      const baseReport = buildBReport({ overLimit: entry.overLimit || [] }, entry.autoResults, entry.notExist || []);
      let bText = header ? `${header}\n📊 处理报告` : "📊 处理报告";
      if (baseReport) bText += "\n" + baseReport;
      bText += "\n🔄 操作结果";
      const cancelLabel = action === 'purged' ? "系统取消" : "超时取消";
      bText += `\n❌ ${cancelLabel}：${entry.tasks.length} 笔`;
      entry.tasks.forEach(r => {
        const reason = (r._reasons && r._reasons.length) ? `  -  ${r._reasons.join("/ ")}` : "";
        bText += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}${reason}`;
      });
      await bot.telegram.editMessageText(entry.bGroupId, entry.bMessageId, undefined,
        trunc(bText), { reply_markup: { inline_keyboard: [] } }
      ).catch(() => {});
    } catch (e) { log.warn("expireEntry B群消息编辑失败", { err: e?.message }); }
  }
}

function scheduleExpiry(id, entry) {
  const delay = Math.max(0, entry.expire - Date.now());
  entry._timer = setTimeout(() => {
    expireEntry(id, entry).catch(e => log.error("定时过期处理失败", { err: e?.message }));
  }, delay);
}

async function cleanPending() {
  try {
    const now = Date.now();
    // 先收集待处理的 key，避免在 for...of 迭代 pending 时通过 expireEntry 修改 Map
    const expiredKeys = [];
    for (const [k, v] of pending) {
      if (!v || v.expire < now) expiredKeys.push(k);
    }
    for (const k of expiredKeys) {
      const v = pending.get(k);
      if (v) await expireEntry(k, v).catch(e => log.error("cleanPending过期处理失败", { err: e?.message }));
    }
    if (pending.size > CFG.MAX_PENDING) {
      const sorted = [...pending.entries()].sort((a, b) => (a[1]?.expire || 0) - (b[1]?.expire || 0));
      const purged = sorted.slice(0, sorted.length - CFG.MAX_PENDING);
      for (const [k, v] of purged) {
        // 容量超限主动清理：复用 expireEntry 释放 confirmLockKeys 并通知 A/B 群
        // 传 'purged' 使通知文案显示"系统取消"，与定时器超时取消区分，便于运维定位
        log.warn("pending 超容量, 主动清理最旧条目", { id: k, expire: v?.expire });
        await expireEntry(k, v, 'purged').catch(e => log.error("cleanPending 超容量清理失败", { err: e?.message }));
      }
    }
  } catch (e) { log.error("清理pending异常", { err: e?.message }); }
}

// ================================================================
//  16. STARTUP / SHUTDOWN
// ================================================================
let httpSrv = null;
let pendIv = null;

async function launchBot() {
  for (let i = 0; i <= CFG.BOT_LAUNCH_RETRIES; i++) {
    try {
      await bot.launch({ dropPendingUpdates: CFG.DROP_PENDING_UPDATES });
      log.info("Bot已启动", { attempt: i + 1, mode: CFG.GROUP_A_ID ? "A录入+B业务" : "单群模式" });
      return true;
    } catch (e) {
      log.error(`Bot启动失败 (${i + 1}/${CFG.BOT_LAUNCH_RETRIES + 1})`, { err: e?.message || String(e) });
      if (i < CFG.BOT_LAUNCH_RETRIES) {
        const delay = 3000 * (i + 1);
        log.info(`${delay}ms 后重试...`);
        await sleep(delay);
      }
    }
  }
  log.error("Bot启动最终失败, Telegram 功能不可用", { retries: CFG.BOT_LAUNCH_RETRIES + 1 });
  return false;
}

async function start() {
  log.info("正在启动...");

  if (!initDB()) { log.fatal("数据库初始化失败, 无法启动"); process.exit(1); }

  // 验证 auth-service 连通性
  let authHealthy = false;
  try {
    const healthRes = await axios.get(`${AUTH_SERVICE_URL}/health`, {
      headers: authHeaders(), httpAgent: authApiAgent, httpsAgent: authApiAgentS, timeout: 5000,
    });
    if (healthRes.data?.healthy === false) {
      // Token 未就绪：与 checkAuthServiceHealth 保持一致，置 false 并启动定时探测恢复
      log.warn("auth-service Token 未就绪, 查询功能受限, 启动定时探测恢复");
      authHealthy = false;
    } else {
      authHealthy = true;
      log.info("auth-service 连接正常");
    }
  } catch (e) {
    log.warn("auth-service 连接失败, 加款功能将不可用", { err: e?.message?.slice(0, 80) });
  }

  GLOBAL_TOKEN = authHealthy; // 根据健康检查结果设置
  log.info(authHealthy ? "auth-service 已接管 Token 管理" : "auth-service 未连接, 功能受限");
  // 启动时若 auth 不健康，立即调度定时探测恢复（与运行时网络异常降级路径一致）
  if (!authHealthy) scheduleAuthRecheck();

  autoForward = DB.getAutoForward();
  autoForwardSchedule = DB.getAutoForwardSchedule();
  if (autoForwardSchedule) applySchedule();
  scheduleIv = setInterval(() => { try { applySchedule(); } catch {} }, 60000);
  log.info(`自动转发: ${autoForward ? "已开启" : "已关闭"}, 定时调度: ${autoForwardSchedule ? "已开启" : "已关闭"}`);

  // tx_log 已移除，无需定时清理历史数据
  pendIv = setInterval(() => { cleanPending().catch(e => log.error("cleanPending定时执行失败", { err: e?.message })); }, 120000);

  await new Promise((resolve, reject) => {
    httpSrv = app.listen(CFG.PORT, () => {
      log.info(`HTTP :${CFG.PORT}`);
      resolve();
    });
    httpSrv.on("error", (e) => {
      log.error("HTTP服务错误", { err: e?.message });
      if (e.code === "EADDRINUSE") {
        log.fatal(`端口 ${CFG.PORT} 已被占用, 请检查是否有残留进程或更换端口`);
        process.exit(1);
      }
      reject(e);
    });
  });

  await launchBot();
}

async function shutdown(sig) {
  log.info(`收到关闭信号: ${sig}`);

  const force = setTimeout(() => { log.warn("关闭超时, 强制退出"); process.exit(1); }, CFG.SHUTDOWN_MS);
  try { clearInterval(pendIv); } catch {}
  try { clearInterval(memIv); } catch {}
  try { clearInterval(scheduleIv); } catch {}
  try { if (authRecheckIv) { clearInterval(authRecheckIv); authRecheckIv = null; } } catch {}
  // 清理 pending 中残留的定时器，避免 shutdown 后触发 expireEntry 产生噪声日志
  for (const [, v] of pending) {
    if (v?._timer) { try { clearTimeout(v._timer); } catch {} }
  }
  pending.clear();
  try { if (httpSrv) httpSrv.close(); } catch {}

  // 等待 bot 完全停止后再关闭 DB，避免消息处理中的 DB 操作崩溃
  try { await bot.stop(sig); } catch {}
  DB.close();

  try { tgHttpsAgent.destroy(); } catch {}
  try { authApiAgent.destroy(); } catch {} try { authApiAgentS.destroy(); } catch {}
  log.info("已清理完成");
  clearTimeout(force);
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("TERM"));

start().catch((e) => {
  log.fatal("启动过程异常", { err: e?.message || String(e) });
  process.exit(1);
});
