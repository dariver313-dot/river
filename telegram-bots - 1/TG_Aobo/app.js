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
const AUTH_SERVICE_URL = (process.env.AUTH_SERVICE_URL || "http://localhost:3100/api/platform-a").replace(/\/+$/, "");
const AUTH_API_KEY = process.env.AUTH_API_KEY || "";
// 官彩游戏ID列表（逗号分隔字符串，直接作为 gameId 参数传给 lot/bet/queryPage）
const LOTTERY_GAME_IDS = (process.env.LOTTERY_GAME_IDS || "").split(",").map(s => s.trim()).filter(Boolean).join(",");
const authApiAgent = new http.Agent({ keepAlive: true, maxSockets: 20, timeout: 5000 });
const authApiAgentS = new https.Agent({ keepAlive: true, maxSockets: 20, timeout: 5000 });

function authHeaders() {
  return { Authorization: `Bearer ${AUTH_API_KEY}`, "Content-Type": "application/json" };
}

// ================================================================
//  0. TIMEZONE — 北京时间工具函数（统一实现，需在 LOGGING 之前定义）
// ================================================================
// 统一时区转换：将任意 Date 转为北京时间组件
// 原理：getTime() 是 UTC epoch，加 8h 后用 UTC 系列 getter 取值即为北京时间
function bjComponents(date) {
  try {
    const shifted = new Date(date.getTime() + 8 * 3600000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth(),
      date: shifted.getUTCDate(),
      hours: shifted.getUTCHours(),
      minutes: shifted.getUTCMinutes(),
      seconds: shifted.getUTCSeconds(),
    };
  } catch {
    return { year: 1970, month: 0, date: 1, hours: 0, minutes: 0, seconds: 0 };
  }
}

function safeNow() {
  try {
    const c = bjComponents(new Date());
    const pad = (n) => String(n).padStart(2, "0");
    return `${c.year}-${pad(c.month + 1)}-${pad(c.date)} ${pad(c.hours)}:${pad(c.minutes)}:${pad(c.seconds)}`;
  } catch {
    try { return new Date().toISOString().replace("T", " ").slice(0, 19); } catch { return "---"; }
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

const CFG = {
  ADMIN_ID: (() => { try { const v = process.env.ADMIN_ID; if (!v) return null; const n = parseInt(v, 10); return isNaN(n) ? null : n; } catch { return null; } })(),
  GROUP_A_ID: (() => { try { const v = process.env.GROUP_A_ID; return v ? parseInt(v, 10) : null; } catch { return null; } })(),
  GROUP_B_ID: (() => { try { const v = process.env.GROUP_B_ID; return v ? parseInt(v, 10) : null; } catch { return null; } })(),
  TARGET_CHAT_ID: (() => { try { const v = process.env.TARGET_CHAT_ID; return v ? parseInt(v, 10) : null; } catch { return null; } })(),
  PORT: safeParseInt(process.env.PORT, 3023),
  API_TIMEOUT: safeParseInt(process.env.API_TIMEOUT, 10000),

  AMOUNT_CONFIRM: safeParseInt(process.env.AMOUNT_CONFIRM, 200),
  AMOUNT_MAX: safeParseInt(process.env.AMOUNT_MAX, 201),
  SAFE_REMARKS: (process.env.SAFE_REMARKS || "").split(",").map(s => s.trim()).filter(Boolean),
  CONCURRENCY: safeParseInt(process.env.CONCURRENCY, 15),
  API_RETRY: safeParseInt(process.env.API_RETRY, 2),
  CONFIRM_EXPIRE_MS: 5 * 60 * 1000,

  // 风控阈值（可配置化）
  GIFT_RATIO_THRESHOLD: parseFloat(process.env.GIFT_RATIO_THRESHOLD || "0.15"),
  BET_CONCENTRATION_THRESHOLD: parseFloat(process.env.BET_CONCENTRATION_THRESHOLD || "0.20"),
  MIN_RECHARGE_FOR_RATIO: safeParseInt(process.env.MIN_RECHARGE_FOR_RATIO, 300),
  HIGH_LOSS_EXEMPT: safeParseInt(process.env.HIGH_LOSS_EXEMPT, 50000),
  WEEK_RECHARGE_LIMIT: safeParseInt(process.env.WEEK_RECHARGE_LIMIT, 3),
  SCHEDULE_START_HOUR: safeParseInt(process.env.SCHEDULE_START_HOUR, 12),

  MAX_PENDING: 500,
  MAX_MSG_LENGTH: 4096,
  MAX_ENTRIES: 200,
  DB_BUSY_MS: 5000,
  SHUTDOWN_MS: 10000,
  BOT_LAUNCH_RETRIES: 3,

  // 频率限制（每用户每分钟最大消息数）
  RATE_LIMIT_PER_MIN: safeParseInt(process.env.RATE_LIMIT_PER_MIN, 10),
  // 风控API并发数（每批最大并行请求数）
  RISK_API_CONCURRENCY: safeParseInt(process.env.RISK_API_CONCURRENCY, 10),
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
  },
};


if (!process.env.AUTH_SERVICE_URL) { log.fatal("AUTH_SERVICE_URL 未设置"); process.exit(1); }
if (!process.env.TELEGRAM_BOT_TOKEN) { log.fatal("TELEGRAM_BOT_TOKEN 未设置"); process.exit(1); }
if (!AUTH_API_KEY) { log.fatal("AUTH_API_KEY 未设置, 无法连接 auth-service"); process.exit(1); }

log.info("配置加载完成", { admin: CFG.ADMIN_ID, gA: CFG.GROUP_A_ID, gB: CFG.GROUP_B_ID, port: CFG.PORT, lotteryGameIds: LOTTERY_GAME_IDS });

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
async function apiAddBalance(member, remark, amount) {
  if (!member || typeof member !== "string") return { ok: false, err: "用户名为空" };
  if (!remark || typeof remark !== "string") return { ok: false, err: "备注为空" };
  if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) return { ok: false, err: "金额无效" };
  if (!GLOBAL_TOKEN) return { ok: false, err: "auth-service 未连接" };
  try {
    // 幂等键：member+remark+amount+日期+小时，同小时内重试用相同 key 防止网络超时重复加款
    // 加入小时粒度：允许同天不同小时的合法重复加款（如上午/下午各一次活动奖励）
    const now = new Date();
    const c = bjComponents(now);
    const idemKey = crypto.createHash('sha256')
      .update(`${member.trim()}|${remark.trim()}|${amount}|${c.year}-${c.month+1}-${c.date}-${c.hours}`)
      .digest('hex');
    const res = await axios.post(`${AUTH_SERVICE_URL}/recharge`, { member: member.trim(), remark: remark.trim(), amount }, {
      headers: { ...authHeaders(), 'X-Idempotency-Key': idemKey }, httpAgent: authApiAgent, httpsAgent: authApiAgentS, timeout: CFG.API_TIMEOUT + 5000,
    });
    const data = res.data;
    if (data && typeof data === "object" && typeof data.ok === "boolean") return data;
    if (data && typeof data === "object" && data.success === true) return { ok: true, data: data.data };
    if (data && typeof data === "object" && data.success === false) return { ok: false, err: data.error || "加款响应格式异常" };
    return { ok: false, err: data?.error || "加款响应格式异常" };
  } catch (e) {
    const status = e.response?.status;
    if (status === 401) return { ok: false, err: "API Key 无效或缺失, 请联系管理员" };
    if (status === 403) return { ok: false, err: e.response?.data?.error || "金融权限不足, 请检查 AUTH_API_KEY 权限" };
    return { ok: false, err: e.response?.data?.error || e.message || "加款失败" };
  }
}

// ================================================================
//  7e. API — 通用查询封装（调用 auth-service 新增端点）
// ================================================================
// 并发限制器：限制同时执行的 Promise 数量，避免 4N 峰值并发打垮 auth-service
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
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// 带重试的 apiQuery（CFG.API_RETRY 次重试，仅对网络错误和 429 重试）
async function apiQuery(endpoint, body = {}) {
  if (!GLOBAL_TOKEN) return { ok: false, err: "auth-service 未连接" };
  let lastErr = null;
  for (let attempt = 0; attempt <= CFG.API_RETRY; attempt++) {
    try {
      const res = await axios.post(`${AUTH_SERVICE_URL}${endpoint}`, body, {
        headers: authHeaders(), httpAgent: authApiAgent, httpsAgent: authApiAgentS, timeout: CFG.API_TIMEOUT,
      });
      if (!res.data?.success) return { ok: false, err: res.data?.error || "查询失败" };
      return { ok: true, data: res.data.data };
    } catch (e) {
      const status = e.response?.status;
      lastErr = e;
      // 401/403：不可重试的权限错误，降级并调度探测恢复
      if (status === 401) { GLOBAL_TOKEN = false; scheduleAuthRecheck(); return { ok: false, err: "API Key 无效" }; }
      if (status === 403) return { ok: false, err: "权限不足" };
      // 429：限流，可重试（最后一次返回 rateLimited 标记，风控函数据此强制人工审核）
      if (status === 429) {
        if (attempt < CFG.API_RETRY) { await sleep(500 * (attempt + 1)); continue; }
        return { ok: false, err: "请求过于频繁, 请稍后", rateLimited: true };
      }
      // 网络错误：可重试
      if (!e.response && attempt < CFG.API_RETRY) { await sleep(500 * (attempt + 1)); continue; }
      return { ok: false, err: e.response?.data?.error || e.message || "查询失败" };
    }
  }
  return { ok: false, err: lastErr?.message || "查询失败" };
}

// ================================================================
//  7f. 风控预检函数
// ================================================================

// 需求 1：总赠送金额 / 总充值金额 占比 > 15%
//   平台A字段：
//     分子 = commissionAmountHistory + bonusAmountHistory + waterAmountHistory + 本次加款金额
//     分母 = totalRechAmount
//     totalRechAmount < 300 跳过（避免新会员噪音）
//     整体输赢 = balanceDifference（正数=输钱，负数=赢钱）
async function riskCheckGiftRatio(entries) {
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
    const info = await apiQuery("/memberInfo", { account: m });
    // 429 限流：标记 riskCheckFailed，风控规则失效时强制进入人工审核
    if (!info.ok) {
      if (info.rateLimited) result.set(m, { riskCheckFailed: true, reason: "查询限流" });
      return;
    }
    // 平台A memberInfo 返回结构: { code:0, data:{ records:[{ totalRechAmount, ... }], total }, succeed:true }
    const records = Array.isArray(info.data?.data?.records) ? info.data.data.records : [];
    const d = records.find(it => String(it?.account || "").trim() === m);
    if (!d) return;
    const totalRechAmount = parseFloat(d.totalRechAmount || 0);
    const profitAndLoss = parseFloat(d.balanceDifference || 0);
    if (!Number.isFinite(totalRechAmount) || totalRechAmount < CFG.MIN_RECHARGE_FOR_RATIO) {
      if (Number.isFinite(profitAndLoss)) result.set(m, { profitAndLoss });
      return;
    }
    const gift = parseFloat(d.commissionAmountHistory || 0) + parseFloat(d.bonusAmountHistory || 0)
               + parseFloat(d.waterAmountHistory || 0);
    const entryForMember = dedupedEntries.filter(e => String(e.member).trim() === m);
    const currentAmount = entryForMember.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const ratio = (gift + currentAmount) / totalRechAmount;
    if (ratio > CFG.GIFT_RATIO_THRESHOLD) {
      result.set(m, { ratio, gift, sumRecharge: totalRechAmount, currentAmount, profitAndLoss });
    } else {
      if (Number.isFinite(profitAndLoss)) result.set(m, { profitAndLoss });
    }
  });
  return result;
}

// 需求 2：官彩投注占比 > 20%
//   公式：（21个指定官彩游戏投注金额 + 三方游戏投注金额）/（彩票游戏总投注金额 + 三方游戏总投注金额）
//   平台A实现：
//     officialBet = lotteryBetReport.otherData.validAmount（lot/bet/queryPage 按 gameId 过滤）
//     allBetTotal = 7个 *ValidAmount 字段之和（findMemberbetAnalysis）
//     lotteryValidAmount = memberBetAnalysis.lotteryValidAmount（彩票类总投注，含官彩+非官彩）
//     三方游戏投注金额 = allBetTotal - lotteryValidAmount
//     numerator = officialBet + (allBetTotal - lotteryValidAmount)
//     denominator = allBetTotal
// 统一日期格式化工具
function fmtBjDate(ms) {
  const c = bjComponents(new Date(ms));
  const pad = (n) => String(n).padStart(2, "0");
  return `${c.year}-${pad(c.month + 1)}-${pad(c.date)}`;
}
function fmtBjDatetime(ms) {
  const c = bjComponents(new Date(ms));
  const pad = (n) => String(n).padStart(2, "0");
  return `${c.year}-${pad(c.month + 1)}-${pad(c.date)} ${pad(c.hours)}:${pad(c.minutes)}:${pad(c.seconds)}`;
}

// 北京今天 00:00 的 UTC 时间戳（毫秒）
function bjTodayMidnightMs() {
  const c = bjComponents(new Date());
  return Date.UTC(c.year, c.month, c.date) - 8 * 3600000;
}

// 近7天日期范围（YYYY-MM-DD），含今天共7天
function get7DayDateRange() {
  const todayMid = bjTodayMidnightMs();
  const startMid = todayMid - 6 * 24 * 3600000; // 6天前
  return { startTime: fmtBjDate(startMid), endTime: fmtBjDate(todayMid) };
}

// 近7天时间戳范围（毫秒），用于 lotteryBetReport
function get7DayTimestampRange() {
  const todayMid = bjTodayMidnightMs();
  return { startTime: todayMid - 6 * 24 * 3600000, endTime: Date.now() };
}

// 近7天日期时间范围（YYYY-MM-DD HH:MM:SS），用于 rechargeDiscountHistory
function get7DayDatetimeRange() {
  const { startTime, endTime } = get7DayTimestampRange();
  return { beginDatetime: fmtBjDatetime(startTime), endDatetime: fmtBjDatetime(endTime) };
}

async function riskCheckBetConcentration(entries) {
  const result = new Map();
  if (!Array.isArray(entries) || entries.length === 0) return result;
  if (!LOTTERY_GAME_IDS) {
    log.warn("LOTTERY_GAME_IDS 未配置, 跳过官彩投注占比检查");
    return result;
  }
  const dateRange = get7DayDateRange();
  const { startTime: betStartMs, endTime: betEndMs } = get7DayTimestampRange();
  const members = [...new Set(entries.map(e => String(e.member || "").trim()).filter(Boolean))];
  await pLimit(members, CFG.RISK_API_CONCURRENCY, async (m) => {
    const [lotteryRes, betsRes] = await Promise.all([
      apiQuery("/lotteryBetReport", { account: m, gameId: LOTTERY_GAME_IDS, startTime: betStartMs, endTime: betEndMs }),
      apiQuery("/betsCount", { account: m, startTime: dateRange.startTime, endTime: dateRange.endTime }),
    ]);
    // 429 限流：任一查询被限流则标记 riskCheckFailed 强制人工审核
    if (lotteryRes.rateLimited || betsRes.rateLimited) {
      result.set(m, { riskCheckFailed: true, reason: "查询限流" });
      return;
    }
    // lotteryBetReport 返回: { code:0, data:{ otherData:{ validAmount } }, succeed:true }
    const officialBet = parseFloat(lotteryRes.data?.data?.otherData?.validAmount || 0);
    const b = (betsRes.ok && betsRes.data) ? betsRes.data : {};
    const allBetTotal = parseFloat(b.lotteryValidAmount || 0) + parseFloat(b.sportValidAmount || 0)
                      + parseFloat(b.realValidAmount || 0) + parseFloat(b.hunterValidAmount || 0)
                      + parseFloat(b.chessValidAmount || 0) + parseFloat(b.egameValidAmount || 0)
                      + parseFloat(b.esportValidAmount || 0);
    const lotteryValidAmount = parseFloat(b.lotteryValidAmount || 0);
    const thirdTotal = allBetTotal - lotteryValidAmount;
    const numerator = officialBet + thirdTotal;
    const denominator = allBetTotal;
    if (denominator > 0 && numerator / denominator > CFG.BET_CONCENTRATION_THRESHOLD) {
      result.set(m, { matchedBet: officialBet, thirdTotal, cpTotal: lotteryValidAmount, denominator, ratio: numerator / denominator });
    }
  });
  return result;
}

// 当天时间范围（北京 00:00 ~ 现在），用于查询当天加款记录做查重和当天次数
function getTodayTimestampRange() {
  return { startTime: bjTodayMidnightMs(), endTime: Date.now() };
}

// 一次查询近七日彩金加款记录，客户端过滤出今天的（避免 rechargeDiscountHistory 重复查询）
// 返回 { weekRechargeMap: Map<member, {count}>, todayRechargeMap: Map<member, items[]> }
// 平台A数据来源：auth-service /rechargeDiscountHistory（rechargeOrderHistory/page, modeList=2,3 + discountTypes=888）
async function fetchRechargeRecords(entries) {
  const weekRechargeMap = new Map();
  const todayRechargeMap = new Map();
  if (!Array.isArray(entries) || entries.length === 0) return { weekRechargeMap, todayRechargeMap };

  const { beginDatetime, endDatetime } = get7DayDatetimeRange();
  const todayStart = getTodayTimestampRange().startTime;
  const members = [...new Set(entries.map(e => String(e.member || "").trim()).filter(Boolean))];

  await pLimit(members, CFG.RISK_API_CONCURRENCY, async (m) => {
    const res = await apiQuery("/rechargeDiscountHistory", { account: m, beginDatetime, endDatetime });
    if (!res.ok) {
      log.warn("彩金加款记录查询失败，查重和频率检查将失效", { member: m, err: res.err });
      // 429 限流：标记 todayRechargeMap 为空数组（不误报也不漏报），weekRechargeMap 不设置
      if (res.rateLimited) todayRechargeMap.set(m, []);
      return;
    }
    const items = Array.isArray(res.data?.data?.records) ? res.data.data.records : [];

    // 近七日次数（排除备注包含"周卡"的记录）
    const weekCount = items.filter(i => !String(i.remarks || "").includes("周卡")).length;
    if (weekCount >= CFG.WEEK_RECHARGE_LIMIT) weekRechargeMap.set(m, { count: weekCount });

    // 从近七日记录中过滤出今天的：每条记录独立判断是否有时间字段
    // 修复 EDGE-2：不再用全局 hasTimeField 标记，避免部分有部分无时计数偏差
    const todayItems = items.filter(i => {
      const t = i.auditTime ?? i.createTime;
      if (t === undefined || t === null) return false;
      if (typeof t === "number") return t >= todayStart;
      if (typeof t === "string") { const ms = Date.parse(t); return !isNaN(ms) && ms >= todayStart; }
      return false;
    });
    todayRechargeMap.set(m, todayItems);
  });

  return { weekRechargeMap, todayRechargeMap };
}

// 并行执行 3 项风控预检（加款记录合并为一次查询）
async function runRiskPreChecks(entries) {
  const [giftRatioMap, betConcentrationMap, rechargeRecords] = await Promise.all([
    riskCheckGiftRatio(entries),
    riskCheckBetConcentration(entries),
    fetchRechargeRecords(entries),
  ]);
  return {
    giftRatioMap,
    betConcentrationMap,
    weekRechargeMap: rechargeRecords.weekRechargeMap,
    todayRechargeMap: rechargeRecords.todayRechargeMap,
  };
}

// ================================================================
//  8. PARSER
// ================================================================
const LINE_RE = /^\s*([a-zA-Z0-9_]+)\s*([a-zA-Z\u4e00-\u9fa5]+)\s*([1-9]\d*)\s*$/;

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
  // 统一中文分隔符：全角逗号，枚举逗号、全角分号；都替换为空格
  const t = line.trim().replace(/[，、；]/g, " ");
  if (!t) return null;

  if (LINE_RE.test(t)) return null;

  const userMatch = t.match(/^([a-zA-Z0-9_]+)/);
  if (!userMatch) return "用户名只能包含字母、数字和下划线";
  const rest1 = t.slice(userMatch[0].length).trim();

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
      // 统一中文分隔符为空格，与 diagnoseLine 保持一致
      const normalized = lines[i].replace(/[，、；]/g, " ");
      const m = LINE_RE.exec(normalized);
      if (!m) continue;
      count++;
      if (count > CFG.MAX_ENTRIES) { log.warn("消息条目过多, 截断处理", { total: count, max: CFG.MAX_ENTRIES }); break; }
      matchedLineNums.add(i);
      try {
        const member = String(m[1] || "").trim();
        const rawRemark = String(m[2] || "").trim();
        const amountStr = String(m[3] || "").trim();
        if (!member || !rawRemark || !amountStr) continue;
        const amount = parseInt(amountStr, 10);
        const remarkLower = rawRemark.toLowerCase();
        const aliased = CFG.REMARK_ALIASES[remarkLower] || CFG.REMARK_ALIASES[rawRemark];
        const remark = aliased || rawRemark;
        valid.push({ member, remark, amount });
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
function classifyEntries(entries, todayRechargeMap, riskMaps, inflightKeys) {
  const auto = [], confirm = [], overLimit = [];
  if (!Array.isArray(entries)) return { auto, confirm, overLimit };

  const seen = new Map();
  const deduped = entries.filter(e => {
    if (!e || !e.member || !e.remark) return false;
    const key = `${String(e.member).trim()}|${String(e.remark).trim()}`;
    if (seen.has(key)) {
      log.warn("同 member+remark 重复条目已去重，仅保留第一条", { member: e.member, remark: e.remark, amount: e.amount });
      return false;
    }
    seen.set(key, true);
    return true;
  });

  // 当天加款记录（来自后台 rechargeDiscountHistory，替代本地 tx_log）
  // 结构: Map<member, items[]>，items 含 remarks/discountAmount/auditTime 等字段
  const todayMap = (todayRechargeMap instanceof Map) ? todayRechargeMap : new Map();

  // 风控预检结果（3 项新增规则）
  const giftRatioMap = (riskMaps && riskMaps.giftRatioMap) || new Map();
  const betConcentrationMap = (riskMaps && riskMaps.betConcentrationMap) || new Map();
  const weekRechargeMap = (riskMaps && riskMaps.weekRechargeMap) || new Map();

  // inflightKeys: 由 classifyAndExecute 传入，记录本批次预锁前已被其他消息锁定的 key
  const inflightSet = (inflightKeys instanceof Set) ? inflightKeys : new Set();

  for (const e of deduped) {
    try {
      if (!e || !e.member || typeof e.amount !== "number" || !isFinite(e.amount)) continue;
      if (e.amount > CFG.AMOUNT_MAX) { overLimit.push(e); continue; }

      // 收集所有触发的原因（不再 continue 跳过后续检查）
      const reasons = [];

      const m = String(e.member).trim();
      const r = String(e.remark || "").trim();
      const key = `${m}|${r}`;

      // 当天同类型彩金重复：用用户输入的备注 r 去匹配后台记录的 remarks 字段
      // 双向包含以应对规范化差异（"周" ↔ "周卡"）
      const todayItems = todayMap.get(m) || [];
      const matched = todayItems.find(item => {
        if (!r) return false;
        const op = String(item.remarks || "").trim();
        if (op && (op.includes(r) || r.includes(op))) return true;
        return false;
      });
      const inFlight = inflightSet.has(key);
      if (matched) {
        reasons.push("当天彩金重复");
      } else if (inFlight) {
        reasons.push("当天彩金重复(处理中)");
      }

      // 周卡标记（提前获取，用于后续豁免判断）
      const isZhouka = r.includes("周卡");

      // 需求 1：总赠送金额 / 总充值金额 占比 > 阈值
      // 周卡 + 输钱 >= 豁免值：无视赠送占比规则，可直接赠送
      const giftRatio = giftRatioMap.get(m);
      const zhoukaHighLoss = isZhouka && giftRatio && Number.isFinite(giftRatio.profitAndLoss) && giftRatio.profitAndLoss >= CFG.HIGH_LOSS_EXEMPT;
      if (giftRatio && giftRatio.riskCheckFailed) {
        reasons.push("风控查询失败(限流)");
      } else if (giftRatio && giftRatio.ratio !== undefined && !zhoukaHighLoss) {
        reasons.push(`赠送占比${Math.round((giftRatio.ratio || 0) * 100)}%`);
      }

      // 需求 2：官彩投注占比 > 阈值
      // 周卡 + 输钱 >= 豁免值：无视官彩投注占比规则，可直接赠送
      const betConc = betConcentrationMap.get(m);
      if (betConc && betConc.riskCheckFailed) {
        reasons.push("风控查询失败(限流)");
      } else if (betConc && !zhoukaHighLoss) {
        reasons.push(`近七日官彩投注占比${Math.round((betConc.ratio || 0) * 100)}%`);
      }

      // 需求 3：近七日除"周卡"外加款次数 > 限制
      // 当前备注为"周卡"时，此规则不生效
      const weekRecharge = !isZhouka ? weekRechargeMap.get(m) : undefined;
      if (weekRecharge) {
        reasons.push(`近七日彩金已加款${weekRecharge.count}次`);
      }

      // 原有规则：当天加款 >= 限制次数（数据来自后台 rechargeDiscountHistory）
      const todayCount = todayItems.length;
      if (todayCount >= CFG.WEEK_RECHARGE_LIMIT) {
        reasons.push(`今日赠送${todayCount + 1}次`);
      }

      if (reasons.length > 0) {
        const entry = { ...e };
        // 整体输赢作为展示信息附加（不是触发条件，仅人工审核时展示）
        // 平台A：profitAndLoss = balanceDifference，正数=输钱，负数=赢钱
        if (giftRatio && Number.isFinite(giftRatio.profitAndLoss)) {
          const pnl = giftRatio.profitAndLoss;
          const label = pnl >= 0 ? "输钱" : "赢钱";
          reasons.push(`${label}：${Math.round(Math.abs(pnl))}`);
        }
        entry._reasons = reasons;
        confirm.push(entry);
        continue;
      }

      const needConfirm = e.amount > CFG.AMOUNT_CONFIRM && !CFG.SAFE_REMARKS.includes(e.remark);
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
  // 复检 GLOBAL_TOKEN：runRiskPreChecks 期间可能被其他消息置 false，避免无意义的 401 请求
  if (!GLOBAL_TOKEN) {
    return items.map(item => ({ ...item, ok: false, err: "auth-service 未连接" }));
  }

  // 使用 pLimit worker pool 控制并发，避免手写 running Set + Promise.race 的微任务顺序陷阱
  // 单任务超时 = API超时 × (重试次数+1) × 2 + 2000ms 缓冲，覆盖 apiQuery 内部重试的总时长
  const taskTimeout = CFG.API_TIMEOUT * (CFG.API_RETRY + 1) * 2 + 2000;

  return pLimit(items, CFG.CONCURRENCY, (item) => {
    if (!item || !item.member) {
      return Promise.resolve({ member: item?.member || "未知", remark: item?.remark || "", amount: item?.amount || 0, ok: false, err: "无效条目" });
    }
    let timer = null;
    return Promise.race([
      apiAddBalance(item.member, item.remark, item.amount).then(r => ({ ...item, ok: r.ok, err: r.err || undefined })),
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

function buildBReport(classified, results, notExist) {
  const s = [];
  if (classified.overLimit && classified.overLimit.length) {
    s.push(`⛔️ 拒绝加款：${classified.overLimit.length} 笔`);
    classified.overLimit.forEach((r) => s.push(`${r.member}  ${r.remark}  ${r.amount} - 金额超限`));
  }
  if (notExist && notExist.length) {
    s.push(`⚠️ 账号无效：${notExist.length} 笔`);
    notExist.forEach((r) => s.push(`${r.member}  ${r.remark}  ${r.amount}`));
  }
  if (results && results.length) {
    const ok = results.filter((r) => r && r.ok);
    const fail = results.filter((r) => r && !r.ok);
    if (ok.length) { s.push(`✅ 自动加款：${ok.length} 笔`); ok.forEach((r) => s.push(`${r.member}  ${r.remark}  ${r.amount}`)); }
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
    classified.overLimit.forEach((r) => p.push(`${r.member}  ${r.remark}  ${r.amount} - 金额超限`));
  }
  if (notExist && notExist.length) {
    p.push(`⚠️ 账号无效：${notExist.length} 笔`);
    notExist.forEach((r) => p.push(`${r.member}  ${r.remark}  ${r.amount}`));
  }
  if (classified.confirm && classified.confirm.length) {
    p.push(`📝 等待审核：${classified.confirm.length} 笔`);
    classified.confirm.forEach((r) => {
      let reason = "";
      if (r._reasons && r._reasons.length) reason = `  -  ${r._reasons.join(" / ")}`;
      p.push(`${r.member}  ${r.remark}  ${r.amount}${reason}`);
    });
  }
  const ok = (results || []).filter(r => r && r.ok);
  if (ok.length) {
    p.push(`✅ 自动加款：${ok.length} 笔`);
    ok.forEach(r => p.push(`${r.member}  ${r.remark}  ${r.amount}`));
  }
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

// ================================================================
//  13. BOT SETUP
// ================================================================
let GLOBAL_TOKEN = null;
let autoForward = true;
let autoForwardSchedule = false;
let scheduleIv = null;
const pending = new Map();
// 预占位锁：引用计数 Map，支持多消息并发锁定同一 member|remark
// key → lockCount，unlock 时 count-1，减到 0 才删除
const processingEntries = new Map();
function lockEntry(key) { processingEntries.set(key, (processingEntries.get(key) || 0) + 1); }
function unlockEntry(key) {
  const c = processingEntries.get(key);
  if (c > 1) processingEntries.set(key, c - 1);
  else processingEntries.delete(key);
}
function isProcessing(key) { return processingEntries.has(key); }

// ================================================================
//  auth-service 动态降级与恢复
//  网络失败时 GLOBAL_TOKEN=false 避免后续消息继续撞墙，
//  定时探测恢复后自动重新启用。
// ================================================================
let authRecheckIv = null;
const AUTH_RECHECK_MS = 30000; // 30秒探测一次

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
  }, AUTH_RECHECK_MS);
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
  const c = bjComponents(new Date());
  const shouldOn = c.hours >= CFG.SCHEDULE_START_HOUR;
  if (autoForward !== shouldOn) {
    autoForward = shouldOn;
    DB.saveAutoForward(autoForward);
    log.info(`定时调度: 自动转发${autoForward ? "开启" : "关闭"}`, { bjHour: c.hours });
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

// 非管理员访问的统一拒绝响应（使用 tg 包装器，错误内部处理，避免 bot.catch 误报）
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

// ================================================================
//  13a. 频率限制（SEC-1）：每用户每分钟最大消息数，防刷屏/防轰炸
// ================================================================
const userMsgTimestamps = new Map(); // userId → number[]（毫秒时间戳）

function checkRateLimit(ctx) {
  const userId = ctx?.from?.id;
  if (!userId) return false; // 无 from 信息，放行（不阻塞系统消息）
  // 管理员豁免
  if (CFG.ADMIN_ID != null && userId === CFG.ADMIN_ID) return false;
  const now = Date.now();
  const windowMs = 60000;
  let arr = userMsgTimestamps.get(userId);
  if (!arr) { arr = []; userMsgTimestamps.set(userId, arr); }
  // 清理过期时间戳
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= CFG.RATE_LIMIT_PER_MIN) return true; // 触发限流
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
  // 预占位锁：在风控预检之前就对所有 entries 加锁，消除竞态窗口
  // 引用计数：lockEntry 递增、unlockEntry 递减，支持多消息并发锁定同一 key
  // inflightKeys：记录在加锁前已被其他消息持有的 key（classifyEntries 会将其标记为"处理中"）
  const allLockKeys = [];
  const inflightKeys = new Set();
  for (const e of entries) {
    if (!e || !e.member || !e.remark) continue;
    const lk = `${String(e.member).trim()}|${String(e.remark).trim()}`;
    if (isProcessing(lk)) inflightKeys.add(lk);
    lockEntry(lk);
    allLockKeys.push(lk);
  }

  // 风控预检（3 项并行查询，失败不阻塞主流程）
  let riskMaps = { giftRatioMap: new Map(), betConcentrationMap: new Map(), weekRechargeMap: new Map(), todayRechargeMap: new Map() };
  try {
    riskMaps = await runRiskPreChecks(entries);
  } catch (e) {
    log.warn("风控预检失败, 跳过风控规则", { err: e?.message || String(e) });
  }
  const classified = classifyEntries(entries, riskMaps.todayRechargeMap, riskMaps, inflightKeys);

  // 分类后，auto 和 confirm 各自持有引用计数锁
  // overLimit 的锁需要立即释放（不会进入执行流程）
  const autoLockKeys = [];
  const confirmLockKeys = [];
  const classifiedKeys = new Set();
  for (const item of classified.auto) {
    const lk = `${String(item.member).trim()}|${String(item.remark).trim()}`;
    autoLockKeys.push(lk);
    classifiedKeys.add(lk);
  }
  for (const item of classified.confirm) {
    const lk = `${String(item.member).trim()}|${String(item.remark).trim()}`;
    confirmLockKeys.push(lk);
    classifiedKeys.add(lk);
  }
  // 释放 overLimit 条目的预锁
  for (const lk of allLockKeys) {
    if (!classifiedKeys.has(lk)) unlockEntry(lk);
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
        const reason = (t._reasons && t._reasons.length) ? `  -  ${t._reasons.join(" / ")}` : "";
        bText += `\n${t.member || "?"}  ${t.remark || "?"}  ${t.amount}${reason}`;
      }

      const id = crypto.randomBytes(6).toString("hex");
      if (pending.size >= CFG.MAX_PENDING) await cleanPending();

      // 先发送 B群消息以获取 message_id，用于超时后主动编辑
      const bSent = await bot.telegram.sendMessage(bGroupId, trunc(bText), Markup.inlineKeyboard([
        Markup.button.callback("✅ 确认", `ok_${id}`),
        Markup.button.callback("❌ 取消", `no_${id}`),
      ])).catch(e => { log.error("B群确认消息发送失败", { err: e?.message }); return null; });

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
        const reason = (t._reasons && t._reasons.length) ? `  -  ${t._reasons.join(" / ")}` : "";
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
      bEditText += "\n🔄 操作结果";
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
    bEditText += "\n🔄 操作结果";
    if (cached.tasks && cached.tasks.length) {
      bEditText += `\n❌ 取消加款：${cached.tasks.length} 笔`;
      cached.tasks.forEach(r => {
        const reason = (r._reasons && r._reasons.length) ? `  -  ${r._reasons.join(" / ")}` : "";
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
//  14a. A群通知助手 — 消除 cleanPending / ok_ / no_ 中的重复代码
// ================================================================
// --- 编辑消息带重试 ---
// 仅对可重试错误重试：429 限流、5xx 服务端错误、网络错误（ETIMEDOUT/ECONNRESET 等）
// 不可重试错误立即抛出：400 Bad Request（消息未变/内容空/无权限）、403 Forbidden（bot 被屏蔽）
function isRetryableTgError(e) {
  if (!e) return false;
  const status = e.response?.error_code || e.code || (e.response?.status);
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
      // 不可重试错误立即抛出，避免无意义重试消耗配额
      if (!isRetryableTgError(e) || i >= maxRetries) throw e;
      // 429 限流：优先尊重 retry_after，否则退避加倍
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
    t += `⛔️ 拒绝加款：${c.overLimit.length} 笔`;
    c.overLimit.forEach(r => { t += `\n${r.member}  ${r.remark}  ${r.amount} - 金额超限`; });
  }
  if (c.notExist && c.notExist.length) {
    t += (t ? "\n" : "") + `⚠️ 账号无效：${c.notExist.length} 笔`;
    c.notExist.forEach(r => { t += `\n${r.member}  ${r.remark}  ${r.amount}`; });
  }

  // 自动加款结果（已执行，始终展示明细，含失败项）
  const autoOk = (c.autoResults || []).filter(r => r && r.ok);
  const autoFail = (c.autoResults || []).filter(r => r && !r.ok);
  if (autoOk.length) {
    t += (t ? "\n" : "") + `✅ 自动加款：${autoOk.length} 笔`;
    autoOk.forEach(r => { t += `\n${r.member}  ${r.remark}  ${r.amount}`; });
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
        const reason = (r._reasons && r._reasons.length) ? `  -  ${r._reasons.join(" / ")}` : "";
        t += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}${reason}`;
      });
    } else if (action === 'purged') {
      // 容量超限主动清理：与超时取消区分，便于运维定位 pending 容量问题
      t += (t ? "\n" : "") + `❌ 系统取消：${c.tasks.length} 笔`;
      c.tasks.forEach(r => {
        const reason = (r._reasons && r._reasons.length) ? `  -  ${r._reasons.join(" / ")}` : "";
        t += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}${reason}`;
      });
    } else if (action === 'cancelled') {
      t += (t ? "\n" : "") + `❌ 取消加款：${c.tasks.length} 笔`;
      c.tasks.forEach(r => {
        const reason = (r._reasons && r._reasons.length) ? `  -  ${r._reasons.join(" / ")}` : "";
        t += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}${reason}`;
      });
    } else if (action === 'confirmed') {
      // 展示审核结果明细：成功 + 失败（失败项必须可见，避免资金风险静默）
      const confirmOk = (newResults || []).filter(r => r && r.ok);
      const confirmFail = (newResults || []).filter(r => r && !r.ok);
      if (confirmOk.length) {
        t += (t ? "\n" : "") + `✅ 审核加款：${confirmOk.length} 笔`;
        confirmOk.forEach(r => { t += `\n${r.member}  ${r.remark}  ${r.amount}`; });
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
        const reason = (r._reasons && r._reasons.length) ? `  -  ${r._reasons.join(" / ")}` : "";
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
    // （expireEntry 内部会 pending.delete，直接迭代会触发 "Map modified during iteration" 风险）
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
