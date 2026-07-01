require("dotenv").config();

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
//  1. LOGGING — 结构化日志, 永远不会因日志本身崩溃
// ================================================================
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };
const logLevel = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LEVELS.INFO;

function safeStringify(obj, depth = 2) {
  try { return JSON.stringify(obj, null, depth); } catch { return String(obj); }
}

const log = {
  _ts() { try { return new Date().toISOString(); } catch { return "---"; } },
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
    } catch { /* 日志本身也不能崩溃 */ }
  },
  debug(msg, meta) { if (logLevel <= 0) this._f("DEBUG", msg, meta); },
  info(msg, meta) { if (logLevel <= 1) this._f("INFO", msg, meta); },
  warn(msg, meta) { if (logLevel <= 2) this._f("WARN", msg, meta); },
  error(msg, meta) { if (logLevel <= 3) this._f("ERROR", msg, meta); },
  fatal(msg, meta) { this._f("FATAL", msg, meta); },
};

// ================================================================
//  2. CONFIG — 集中配置, 启动校验
// ================================================================
function safeParseInt(val, fallback) {
  try { const n = parseInt(val, 10); return isNaN(n) ? fallback : n; } catch { return fallback; }
}

const CFG = {
  ADMIN_ID: (() => { try { const v = process.env.ADMIN_ID; if (!v) return null; const n = parseInt(v, 10); return isNaN(n) ? null : n; } catch { return null; } })(),
  GROUP_A_ID: (() => { try { const v = process.env.GROUP_A_ID; return v ? parseInt(v, 10) : null; } catch { return null; } })(),
  GROUP_B_ID: (() => { try { const v = process.env.GROUP_B_ID; return v ? parseInt(v, 10) : null; } catch { return null; } })(),
  TARGET_CHAT_ID: (() => { try { const v = process.env.TARGET_CHAT_ID; return v ? parseInt(v, 10) : null; } catch { return null; } })(),
  BASE_URL: (() => { try { const v = process.env.API_BASE_URL; return v ? v.replace(/\/+$/, "") : null; } catch { return null; } })(),
  PORT: safeParseInt(process.env.PORT, 3022),
  API_TIMEOUT: safeParseInt(process.env.API_TIMEOUT, 10000),
  API_CONNECT_TIMEOUT: safeParseInt(process.env.API_CONNECT_TIMEOUT, 5000),

  // 业务规则
  AMOUNT_CONFIRM: 888,
  AMOUNT_MAX: 3000,
  SAFE_REMARKS: ["周卡"],
  CONCURRENCY: 3,
  CONFIRM_EXPIRE_MS: 5 * 60 * 1000,

  // 内部保护
  MAX_PENDING: 500,
  MAX_MSG_LENGTH: 10000,
  MAX_ENTRIES: 200,
  RETRY: 2,
  RETRY_DELAY_BASE: 1000,
  DB_BUSY_MS: 5000,
  SHUTDOWN_MS: 10000,
  BOT_LAUNCH_RETRIES: 3,

  // 熔断器配置
  CIRCUIT_FAILURES: 5,
  CIRCUIT_COOLDOWN: 30000,

  // ─── 固定 User-Agent ───
  FIXED_UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",

  // ─── 备注管理 (别名补全, 未识别备注保留原文) ───
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


if (!CFG.BASE_URL) { log.fatal("API_BASE_URL 未设置"); process.exit(1); }
if (!process.env.TELEGRAM_BOT_TOKEN) { log.fatal("TELEGRAM_BOT_TOKEN 未设置"); process.exit(1); }

log.info("配置加载完成", { admin: CFG.ADMIN_ID, gA: CFG.GROUP_A_ID, gB: CFG.GROUP_B_ID, port: CFG.PORT });

// ================================================================
//  3. HTTP AGENTS — 模块级复用 (修复: 避免每次请求新建 Agent)
// ================================================================
const apiHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10,
  timeout: CFG.API_CONNECT_TIMEOUT,
});
const apiHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  timeout: CFG.API_CONNECT_TIMEOUT,
});
const tgHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
  timeout: 30000,
});

// ================================================================
//  4. DATABASE — 带全面错误保护的数据层 (tx_log 唯一数据表)
// ================================================================

let db = null;

function initDB() {
  try {
    db = new Database(path.resolve(__dirname, "data.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = " + CFG.DB_BUSY_MS);
    db.pragma("synchronous = NORMAL");

    db.exec(`
      CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tx_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member TEXT NOT NULL, remark TEXT NOT NULL,
        amount REAL NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_tx ON tx_log(member, remark, created_at);
    `);

    // 清理旧表 (已合并到 tx_log)
    db.exec("DROP TABLE IF EXISTS success_log");

    log.info("数据库就绪", { mode: "WAL" });
    return true;
  } catch (e) {
    log.fatal("数据库初始化失败", { err: e?.message || String(e) });
    return false;
  }
}

// 修复 P1: 手动构建固定格式, 确保 100% 匹配 SQLite datetime('now','localtime')
function safeNow() {
  const d = new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${bj.getFullYear()}-${pad(bj.getMonth() + 1)}-${pad(bj.getDate())} ${pad(bj.getHours())}:${pad(bj.getMinutes())}:${pad(bj.getSeconds())}`;
}

const DB = {
  _safe(fn) {
    try { return fn(); } catch (e) { log.error("DB操作错误", { err: e?.message || String(e) }); return undefined; }
  },

  _isAlive() { try { return db && db.open; } catch { return false; } },

  getToken() {
    if (!this._isAlive()) return null;
    return this._safe(() => {
      const r = db.prepare("SELECT value FROM system_config WHERE key=?").get("global_token");
      return (r && typeof r.value === "string") ? r.value : null;
    });
  },

  saveToken(t) {
    if (!this._isAlive()) return;
    if (typeof t !== "string" || !t.trim()) return;
    this._safe(() => db.prepare("REPLACE INTO system_config VALUES(?,?)").run("global_token", t.trim()));
  },

  clearToken() {
    if (!this._isAlive()) return;
    this._safe(() => db.prepare("DELETE FROM system_config WHERE key=?").run("global_token"));
  },

  insertTxLog(items, todayMap) {
    if (!this._isAlive() || !Array.isArray(items) || items.length === 0) return false;
    return this._safe(() => {
      const now = safeNow();
      const uniquePairs = [];
      const seenKeys = new Set();
      for (const i of items) {
        if (i && i.member && i.remark) {
          const key = `${String(i.member).trim()}|${String(i.remark).trim()}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            uniquePairs.push({ member: String(i.member).trim(), remark: String(i.remark).trim() });
          }
        }
      }
      const existing = todayMap instanceof Map ? todayMap : (uniquePairs.length > 0 ? this.getTodayBatch(uniquePairs) : new Map());

      const ins = db.prepare("INSERT INTO tx_log(member,remark,amount,created_at) VALUES(?,?,?,?)");
      let inserted = 0;
      const batch = db.transaction((arr) => {
        for (const i of arr) {
          if (i && i.member && i.remark && typeof i.amount === "number" && isFinite(i.amount)) {
            const key = `${String(i.member).trim()}|${String(i.remark).trim()}`;
            if (!existing.has(key)) {
              ins.run(String(i.member), String(i.remark), i.amount, now);
              existing.set(key, { member: String(i.member).trim(), remark: String(i.remark).trim(), amount: i.amount, created_at: now });
              inserted++;
            }
          }
        }
      });
      batch(items);
      if (inserted < items.length) {
        log.info("insertTxLog: 跳过今日已存在记录", { total: items.length, inserted, skipped: items.length - inserted });
      }
      return true;
    }) === true;
  },

  /**
   * A群重复检测: 查询 tx_log 中 member+remark 已存在的记录
   * 返回匹配的记录数组: [{ member, remark, amount, created_at }]
   */
  checkDuplicates(entries) {
    if (!this._isAlive() || !Array.isArray(entries) || entries.length === 0) return [];
    return this._safe(() => {
      const seen = new Set();
      const pairs = [];
      for (const e of entries) {
        if (e && e.member && e.remark) {
          const key = `${String(e.member).trim()}|${String(e.remark).trim()}`;
          if (!seen.has(key)) {
            seen.add(key);
            pairs.push(e);
          }
        }
      }
      if (pairs.length === 0) return [];
      const placeholders = pairs.map(() => "(?,?)").join(",");
      const params = pairs.flatMap(p => [String(p.member).trim(), String(p.remark).trim()]);
      const sql = `SELECT member, remark, amount, created_at FROM tx_log WHERE (member, remark) IN (${placeholders}) AND date(created_at) = date('now','+8 hours') ORDER BY created_at DESC`;
      return db.prepare(sql).all(...params) || [];
    }) || [];
  },

  /**
   * 批量查询今日已加款记录 (查 tx_log 今日数据)
   * 返回 Map: "member|remark" -> { amount, created_at }
   */
  getTodayBatch(pairs) {
    if (!this._isAlive() || !Array.isArray(pairs) || pairs.length === 0) return new Map();
    return this._safe(() => {
      const placeholders = pairs.map(() => "(?,?)").join(",");
      const params = pairs.flatMap(p => [String(p.member).trim(), String(p.remark).trim()]);
      const sql = `SELECT member, remark, amount, created_at FROM tx_log WHERE (member, remark) IN (${placeholders}) AND date(created_at) = date('now','+8 hours')`;
      const rows = db.prepare(sql).all(...params);
      const map = new Map();
      for (const r of (rows || [])) {
        map.set(`${String(r.member).trim()}|${String(r.remark).trim()}`, r);
      }
      return map;
    }) || new Map();
  },

  /**
   * 清理旧数据
   * 修复: 只保留今天的数据, 删除今天零点之前的所有记录
   */
  cleanOld() {
    if (!this._isAlive()) return;
    this._safe(() => {
      const a = db.prepare("DELETE FROM tx_log WHERE created_at < datetime('now','+8 hours','start of day')").run().changes;
      if (a) log.info("数据清理完成", { txLog: a });
    });
  },

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

  close() {
    try { if (db && db.open) db.close(); } catch (e) { log.warn("DB关闭异常", { err: e?.message }); }
    db = null;
  },
};

// ================================================================
//  5. CIRCUIT BREAKER — 熔断器
// ================================================================
const circuit = {
  failures: 0,
  state: "closed",
  _openAt: 0,

  recordSuccess() {
    if (this.state === "open" || this.state === "half-open") {
      this.state = "closed";
      log.info("熔断器恢复", { state: "closed" });
    }
    this.failures = 0;
  },

  recordFailure() {
    // 半开状态: 一次失败立即重新打开
    if (this.state === "half-open") {
      this.state = "open";
      this._openAt = Date.now();
      log.warn("熔断器半开探测失败, 重新打开", { cooldownMs: CFG.CIRCUIT_COOLDOWN });
      return;
    }
    this.failures++;
    if (this.failures >= CFG.CIRCUIT_FAILURES) {
      this.state = "open";
      this._openAt = Date.now();
      log.warn("熔断器触发", { failures: this.failures, cooldownMs: CFG.CIRCUIT_COOLDOWN });
    }
  },

  isAvailable() {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (Date.now() - this._openAt >= CFG.CIRCUIT_COOLDOWN) {
        this.state = "half-open";
        log.info("熔断器半开, 允许探测");
        return true;
      }
      return false;
    }
    return true;
  },

  getRemainingCooldown() {
    if (this.state !== "open") return 0;
    return Math.max(0, CFG.CIRCUIT_COOLDOWN - (Date.now() - this._openAt));
  },
};

// ================================================================
//  6. HTTP CLIENT
//    修复: 去掉 AbortController (与 axios timeout 冲突), Agent 全局复用
// ================================================================
const sleep = (ms) => new Promise((r) => { try { setTimeout(r, ms); } catch { r(); } });

async function httpRequest(method, url, options = {}, retries = CFG.RETRY) {
  if (!circuit.isAvailable()) {
    const remaining = circuit.getRemainingCooldown();
    const err = new Error(`熔断中, ${Math.ceil(remaining / 1000)}秒后恢复`);
    err.code = "CIRCUIT_OPEN";
    throw err;
  }

  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // P7 修复: options 先展开, 安全默认值后设, 防止被覆盖
      const merged = {
        ...options,
        httpAgent: apiHttpAgent,
        httpsAgent: apiHttpsAgent,
        timeout: CFG.API_TIMEOUT,
        validateStatus: (s) => (s >= 200 && s < 300) || s === 429,
        maxContentLength: 1024 * 1024,
        maxBodyLength: 1024 * 1024,
      };
      const res = await axios({
        method,
        url,
        ...merged,
      });

      // P16 修复: 429 限流响应特殊处理
      if (res.status === 429) {
        const retryAfter = res.headers?.["retry-after"];
        const waitSec = retryAfter ? parseInt(retryAfter, 10) : 5;
        const waitMs = (isNaN(waitSec) ? 5 : Math.min(waitSec, 30)) * 1000;
        log.warn(`HTTP 429 限流, 等待 ${waitMs}ms`, { url: String(url).slice(0, 80) });
        if (attempt === retries) {
          circuit.recordFailure();
          break;
        }
        await sleep(waitMs);
        continue;
      }

      circuit.recordSuccess();

      // 验证响应
      if (res.data === null || res.data === undefined) {
        throw new Error("API返回空响应");
      }
      if (typeof res.data === "string") {
        const trimmed = res.data.trim();
        if (trimmed.startsWith("<")) {
          // API 返回 HTML 而非 JSON → Token/Session 已过期, 不可重试
          const err = new Error(`API返回非JSON内容(HTTP ${res.status}), Token可能已过期`);
          err.code = "TOKEN_EXPIRED";
          throw err;
        }
        try { res.data = JSON.parse(res.data); } catch { throw new Error("API返回无效JSON"); }
      }

      return res;

    } catch (err) {
      last = err;

      let retryable = false;
      if (err.code === "CIRCUIT_OPEN") throw err;
      // Token 过期返回 HTML, 不重试
      if (err.code === "TOKEN_EXPIRED") throw err;
      if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") retryable = true;
      if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "ENOTFOUND") retryable = true;
      if (err.code === "ERR_NETWORK" || err.code === "EAI_AGAIN") retryable = true;
      if (!err.response) retryable = true;
      if (err.response && err.response.status >= 500) retryable = true;

      if (attempt === retries) {
        circuit.recordFailure();
        break;
      }

      if (!retryable) {
        throw err;
      }

      const delay = CFG.RETRY_DELAY_BASE * Math.pow(2, attempt);
      log.warn(`HTTP ${method} 失败, ${delay}ms后重试 (${attempt + 1}/${retries})`, {
        url: String(url).slice(0, 80),
        code: err.code || "UNKNOWN",
        msg: err.message?.slice(0, 100) || "",
      });
      await sleep(delay);
    }
  }
  throw last || new Error("请求失败");
}

// ================================================================
//  7. SESSION / API
//    修复: Token 第二行固定为 FIXED_UA, 兼容2行/3行格式
// ================================================================
function parseSession(raw) {
  if (!raw || typeof raw !== "string") throw new Error("Token为空");
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Token为空");

  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  if (lines.length < 2) {
    throw new Error("Token格式错误(需至少2行,当前" + lines.length + "行)");
  }

  const sid = lines[0];
  if (sid.length > 5000) throw new Error("SID过长");

  // 密码: 3行格式取第3行, 2行格式取第2行
  const pwd = lines.length >= 3 ? lines[2] : lines[1];
  if (pwd.length > 500) throw new Error("密码过长");

  // 第二行固定为 FIXED_UA, 无论 Token 中写什么都忽略
  return { sid, ua: CFG.FIXED_UA, pwd };
}

function validateToken(token) {
  if (!token || typeof token !== "string" || !token.trim()) {
    return { ok: false, err: "Token未设置或为空" };
  }
  try {
    parseSession(token);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: "Token格式无效: " + (e?.message || "未知错误") };
  }
}

// ================================================================
//  7b. API — 加款接口
// ================================================================
async function apiAddBalance(member, remark, amount, token, cachedInfo) {
  if (!member || typeof member !== "string") return { ok: false, err: "用户名为空" };
  if (!remark || typeof remark !== "string") return { ok: false, err: "备注为空" };
  if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) return { ok: false, err: "金额无效" };
  if (!token || typeof token !== "string") return { ok: false, err: "Token为空" };

  // P12: 只解析一次 session
  let session;
  try { session = parseSession(token); } catch { return { ok: false, err: "Token解析失败" }; }

  // 查询用户
  const account = member.trim();
  if (!account) return { ok: false, err: "用户名为空" };

  let user;
  // 如果有缓存的用户信息, 跳过查询步骤
  if (cachedInfo && cachedInfo.nickname && cachedInfo.id) {
    user = { account: cachedInfo.nickname, accountId: cachedInfo.id };
  } else {
    try {
      const url = `${CFG.BASE_URL}/agent/finance/memmnyope/memmny.do?account=${encodeURIComponent(account)}&_=${Date.now()}`;
      const res = await httpRequest("GET", url, {
        headers: { "user-agent": session.ua, Cookie: session.sid },
      });

      if (!res.data || typeof res.data !== "object") return { ok: false, err: "API返回格式异常" };
      if (res.data.accountId === undefined || res.data.accountId === null || res.data.accountId === "") return { ok: false, err: "用户不存在" };
      user = res.data;
    } catch (e) {
      if (e?.code === "TOKEN_EXPIRED") return { ok: false, err: "Token已过期, 请重新设置Token" };
      return { ok: false, err: e?.message || "查询用户时出错" };
    }
  }

  const userAccount = String(user.account || "").trim();
  const accountId = user.accountId;
  if (!userAccount) return { ok: false, err: "用户数据不完整" };

  // 执行加款
  const params = new URLSearchParams({
    searchText: userAccount,
    id: String(accountId),
    type: "81",
    money: String(amount),
    checkBetNum: "2",
    betNumMultiple: "1",
    minusBetNumMultiple: "0",
    remark: remark,
    extra: "",
    rePassword: session.pwd,
  });

  try {
    const res = await httpRequest("POST", `${CFG.BASE_URL}/agent/finance/memmnyope/save.do`, {
      headers: { "user-agent": session.ua, Cookie: session.sid },
      data: params,
    });

    if (!res.data || typeof res.data !== "object") return { ok: false, err: "API返回格式异常" };
    if (res.data.success === true || res.data.success === "true") return { ok: true };

    const apiMsg = res.data.msg || res.data.message || res.data.error || "";
    return { ok: false, err: apiMsg ? String(apiMsg) : "接口返回失败" };
  } catch (e) {
    if (e?.code === "TOKEN_EXPIRED") return { ok: false, err: "Token已过期, 请重新设置Token" };
    const msg = e?.message || String(e);
    if (msg.includes("熔断")) return { ok: false, err: msg };
    return { ok: false, err: "加款失败: " + msg };
  }
}

async function checkUserExists(members, token) {
  if (!Array.isArray(members) || members.length === 0) return { map: new Map(), tokenExpired: false, networkError: false };
  if (!token || typeof token !== "string") return { map: new Map(), tokenExpired: false, networkError: false };

  let session;
  try { session = parseSession(token); } catch { return { map: new Map(), tokenExpired: false, networkError: false }; }

  const uniqueMembers = [...new Set(members.map(m => String(m).trim()).filter(Boolean))];
  const resultMap = new Map();
  let tokenExpired = false;
  let networkError = false;

  const tasks = uniqueMembers.map((account) => (async () => {
    try {
      const url = `${CFG.BASE_URL}/agent/finance/memmnyope/memmny.do?account=${encodeURIComponent(account)}&_=${Date.now()}`;
      const res = await httpRequest("GET", url, {
        headers: { "user-agent": session.ua, Cookie: session.sid },
      });
      if (!res.data || typeof res.data !== "object" || res.data.accountId === undefined || res.data.accountId === null || res.data.accountId === "") {
        resultMap.set(account, { exists: false });
      } else {
        resultMap.set(account, { exists: true, nickname: res.data.account || "", id: res.data.accountId });
      }
    } catch (e) {
      if (e?.code === "TOKEN_EXPIRED") {
        tokenExpired = true;
        resultMap.set(account, { exists: false });
      } else {
        networkError = true;
        resultMap.set(account, { exists: false });
      }
    }
  }));

  const running = new Set();
  const promises = [];
  for (const fn of tasks) {
    const p = fn();
    running.add(p);
    promises.push(p);
    p.then(() => { try { running.delete(p); } catch {} }, () => { try { running.delete(p); } catch {} });
    if (running.size >= CFG.CONCURRENCY) {
      await Promise.race(running);
    }
  }
  await Promise.all(promises);

  return { map: resultMap, tokenExpired, networkError };
}

// ================================================================
//  7c. API — 按真实姓名查询用户 (list.do)
// ================================================================
async function apiCheckOldUsers(realname, token) {
  if (!realname || typeof realname !== "string" || !realname.trim()) return { ok: false, err: "姓名为空" };
  if (!token || typeof token !== "string") return { ok: false, err: "Token为空" };

  let session;
  try { session = parseSession(token); } catch { return { ok: false, err: "Token解析失败" }; }

  try {
    const params = new URLSearchParams({
      sortOrder: "asc",
      pageSize: "20",
      pageNumber: "1",
      userName: realname.trim(),
      startDate: "",
      account: "",
      account2: "",
      levelGroupList: "",
      keyName: "userName",
      keyword: realname.trim(),
      recommendName: "",
      promoInfo: "",
      endDate: "",
      agentName: "",
      account3: "",
      depositStatus: "",
      status: "",
      moneyMin: "",
      moneyMax: "",
      hisMoneyMin: "",
      hisMoneyMax: "",
      unDepositDay: "",
      unloginDay: "",
      depositStartDate: "",
      depositEndDate: "",
      drawStartDate: "",
      drawEndDate: "",
      hadloginDay: "",
      overUnloginDay: "",
      remark: "",
      remarkStatus: "",
      betAlarmStatus: "0",
    });

    const res = await httpRequest("POST", `${CFG.BASE_URL}/agent/member/manager/list.do`, {
      headers: { "user-agent": session.ua, Cookie: session.sid },
      data: params,
    });

    if (!res.data || typeof res.data !== "object") return { ok: false, err: "API返回格式异常" };

    const data = res.data;

    if (data.success === false && (data.msg || "").includes("未登录")) {
      return { ok: false, err: "Token已过期, 请重新设置Token" };
    }

    const rows = Array.isArray(data.rows) ? data.rows : [];
    const total = data.total || rows.length;
    return { ok: true, rows, total };

  } catch (e) {
    if (e?.code === "TOKEN_EXPIRED") return { ok: false, err: "Token已过期, 请重新设置Token" };
    const msg = e?.message || String(e);
    if (msg.includes("熔断") || msg.includes("超时") || msg.includes("网络") || msg.includes("ECONN") || msg.includes("ERR_")) {
      return { ok: false, err: "网络异常, 请稍后重试" };
    }
    return { ok: false, err: "查询失败: " + msg };
  }
}


// ================================================================
//  8. PARSER — 消息解析器
// ================================================================
const TOKEN_RE = /^SESSION=[a-fA-F0-9-]+$/;

// 逐行匹配版本 (修复 P0: 消除 \r\n 导致的行号偏移问题)
const LINE_RE = /^\s*([a-zA-Z0-9]+)\s*([a-zA-Z\u4e00-\u9fa5]+)\s*([1-9]\d*)\s*$/;

function looksLikeEntry(line) {
  if (!line || typeof line !== "string") return false;
  const t = line.trim();
  if (!t || t.length < 3) return false;
  if (!/^[a-zA-Z0-9]/.test(t)) return false;
  if (!/\d\s*$/.test(t)) return false;
  if (/^[a-zA-Z0-9]+$/.test(t)) return false;
  return true;
}

function diagnoseLine(line) {
  if (!line || typeof line !== "string") return null;
  const t = line.trim().replace(/，/g, " ");
  if (!t) return null;

  if (LINE_RE.test(t)) return null;

  const userMatch = t.match(/^([a-zA-Z0-9]+)/);
  if (!userMatch) return "用户名只能包含字母和数字";
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

  // 修复 P0: 逐行正则匹配, 彻底消除 \r\n 偏移问题
  try {
    for (let i = 0; i < lines.length; i++) {
      const m = LINE_RE.exec(lines[i]);
      if (!m) continue;

      count++;
      if (count > CFG.MAX_ENTRIES) {
        log.warn("消息条目过多, 截断处理", { total: count, max: CFG.MAX_ENTRIES });
        break;
      }

      matchedLineNums.add(i);

      try {
        const member = String(m[1] || "").trim();
        const rawRemark = String(m[2] || "").trim();
        const amountStr = String(m[3] || "").trim();

        if (!member || !rawRemark || !amountStr) continue;

        const amount = parseInt(amountStr, 10);

        // 别名查找 (大小写不敏感)
        const remarkLower = rawRemark.toLowerCase();
        const aliased = CFG.REMARK_ALIASES[remarkLower] || CFG.REMARK_ALIASES[rawRemark];
        const remark = aliased || rawRemark;

        valid.push({ member, remark, amount });
      } catch (e) {
        log.warn("单条解析异常", { err: e?.message, index: count });
        continue;
      }
    }
  } catch (e) {
    log.error("正则解析异常", { err: e?.message });
  }

  // 扫描未匹配的行, 检测疑似条目
      try {
        for (let i = 0; i < lines.length; i++) {
          if (unrecognized.length >= 10) break;
        const line = lines[i].trim();
        if (!line) continue;
        if (matchedLineNums.has(i)) continue;
        if (looksLikeEntry(line)) {
          const hint = diagnoseLine(line);
          if (hint) {
            unrecognized.push({ line, hint });
          }
        }
      }
    } catch (e) {
      log.warn("未匹配行扫描异常", { err: e?.message });
    }

  return { valid, unrecognized };
}

// ================================================================
//  9. CLASSIFIER — 条目分类器
// ================================================================
function classifyEntries(entries) {
  const auto = [], confirm = [], overLimit = [];
  if (!Array.isArray(entries)) return { auto, confirm, overLimit, successMap: new Map() };

  // P13: 批量查询今日已加款 (替代逐条 DB.getSuccess N+1)
  const seen = new Map();
  const deduped = entries.filter(e => {
    if (!e || !e.member || !e.remark) return false;
    const key = `${String(e.member).trim()}|${String(e.remark).trim()}`;
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });

  const pairs = deduped.map(e => ({ member: e.member, remark: e.remark }));
  const successMap = pairs.length > 0 ? DB.getTodayBatch(pairs) : new Map();

  for (const e of deduped) {
    try {
      if (!e || !e.member || typeof e.amount !== "number" || !isFinite(e.amount)) continue;
      if (e.amount > CFG.AMOUNT_MAX) { overLimit.push(e); continue; }

      const key = `${String(e.member).trim()}|${String(e.remark).trim()}`;
      const prev = successMap.get(key);
      if (prev) {
        // 今日已加款的条目也走人工确认, 带历史信息
        confirm.push({ ...e, _dup: true, prevAmount: prev.amount || 0, prevTime: prev.created_at || "未知" });
        continue;
      }

      const needConfirm = e.amount > CFG.AMOUNT_CONFIRM && !CFG.SAFE_REMARKS.includes(e.remark);
      (needConfirm ? confirm : auto).push(e);
    } catch (err) {
      log.warn("分类条目异常", { member: e?.member, err: err?.message });
    }
  }

  return { auto, confirm, overLimit, successMap };
}

// ================================================================
//  10. EXECUTOR — 并发执行器
// ================================================================
async function executeBatch(items, token, existMap) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const promises = [];
  const running = new Set();

  for (const item of items) {
    if (!item || !item.member) {
      promises.push(Promise.resolve({ member: item?.member || "未知", remark: item?.remark || "", amount: item?.amount || 0, ok: false, err: "无效条目" }));
      continue;
    }

    const p = (async () => {
      // P11 修复: 正确清理 setTimeout, 防止定时器泄漏
      let timer = null;
      try {
        const cachedInfo = existMap?.get(item.member);
        const r = await Promise.race([
          apiAddBalance(item.member, item.remark, item.amount, token, cachedInfo),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("单任务超时")), CFG.API_TIMEOUT * (CFG.RETRY + 1) * 2 + 2000); }),
        ]);
        return { ...item, ok: r.ok, err: r.err || undefined };
      } catch (err) {
        return { ...item, ok: false, err: err?.message || "执行异常" };
      } finally {
        if (timer) { try { clearTimeout(timer); } catch {} timer = null; }
      }
    })();

    promises.push(p);
    running.add(p);
    p.then(() => { try { running.delete(p); } catch {} }, () => { try { running.delete(p); } catch {} });

    if (running.size >= CFG.CONCURRENCY) {
      try { await Promise.race(running); } catch {}
    }
  }

  const settled = await Promise.allSettled(promises);
  return settled.map((r) => {
    if (r.status === "fulfilled" && r.value && typeof r.value === "object") return r.value;
    return { ok: false, err: "未知错误" };
  });
}

// ================================================================
//  11. REPORTER — 报告生成器
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
    classified.confirm.forEach((r) => p.push(`${r.member}  ${r.remark}  ${r.amount}`));
  }
  const ok = (results || []).filter(r => r && r.ok);
  if (ok.length) p.push(`✅ 成功加款：${ok.length} 笔`);
  return p.length ? p.join("\n") : null;
}

function buildConfirmAGroupNotification(results) {
  if (!results || !results.length) return null;
  const ok = results.filter((r) => r && r.ok);
  const fail = results.filter((r) => r && !r.ok);
  if (!ok.length && !fail.length) return null;
  if (ok.length && !fail.length) return "✅ 成功加款";
  const p = [];
  if (ok.length) { p.push(`✅ 成功加款: ${ok.length} 笔`); ok.forEach((r) => p.push(`  ${r.member} ${r.remark} ${r.amount}`)); }
  if (fail.length) p.push(`❌ 失败: ${fail.length} 笔`);
  return p.join("\n");
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
  del(ctx, id) {
    if (!ctx || !ctx.deleteMessage) return Promise.resolve(null);
    try { return ctx.deleteMessage(id).catch(() => null); } catch { return Promise.resolve(null); }
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
//  13. BOT SETUP — 消息路由与处理
//    修复: Bot 启动添加重试机制 + 状态标记
// ================================================================
let GLOBAL_TOKEN = null;
let botRunning = false;
let autoForward = true;
const pending = new Map();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, {
  telegram: {
    apiRoot: process.env.TELEGRAM_API_ROOT || undefined,
    // 修复: 使用模块级 Agent
    agent: tgHttpsAgent,
  },
});

bot.catch((err, ctx) => {
  log.error("Bot未捕获错误", { err: err?.message || String(err), chat: ctx?.chat?.id, updateType: ctx?.updateType });
});

// --- 管理员控制面板 ---
bot.command("menu", async (ctx) => {
  try {
    const status = autoForward ? "✅ 已开启" : "❌ 已关闭";
    await tg.reply(ctx, `🎛️ 控制面板\n\n自动转发: ${status}`, Markup.inlineKeyboard([
      [Markup.button.callback(autoForward ? "🔴 关闭自动转发" : "🟢 开启自动转发", `toggle_forward`)],
      [Markup.button.callback("📊 查看状态", `show_status`)],
    ]));
  } catch (e) { log.error("菜单异常", { err: e?.message }); }
});

bot.action(/^toggle_forward$/, async (ctx) => {
  try {
    autoForward = !autoForward;
    DB.saveAutoForward(autoForward);
    const status = autoForward ? "✅ 已开启" : "❌ 已关闭";
    const btnText = autoForward ? "🔴 关闭自动转发" : "🟢 开启自动转发";
    await tg.edit(ctx, `🎛️ 控制面板\n\n自动转发: ${status}`, Markup.inlineKeyboard([
      [Markup.button.callback(btnText, `toggle_forward`)],
      [Markup.button.callback("📊 查看状态", `show_status`)],
    ]));
    await tg.cb(ctx, status);
    log.info("自动转发状态切换", { autoForward });
  } catch (e) { log.error("切换异常", { err: e?.message }); }
});

bot.action(/^show_status$/, async (ctx) => {
  try {
    const fwdStatus = autoForward ? "✅ 已开启(自动转发)" : "❌ 已关闭(需手动转发)";
    const tokenStatus = GLOBAL_TOKEN ? "✅ 已设置" : "❌ 未设置";
    const circuitStatus = circuit.isAvailable() ? "✅ 正常" : `❌ ${circuit.state}(${Math.ceil(circuit.getRemainingCooldown() / 1000)}s)`;
    const pendingCount = pending.size;
    let statusText = `📊 系统状态\n\n`;
    statusText += `自动转发: ${fwdStatus}\n`;
    statusText += `Token: ${tokenStatus}\n`;
    statusText += `API: ${circuitStatus}\n`;
    statusText += `待确认: ${pendingCount}笔\n`;
    statusText += `\n发送 /menu 打开控制面板`;
    await tg.edit(ctx, trunc(statusText));
    await tg.cb(ctx, "");
  } catch (e) { log.error("查看状态异常", { err: e?.message }); }
});

// --- 按真实姓名查询老用户 ---
bot.command("checkoldusers", async (ctx) => {
  try {
    const rawText = ctx?.message?.text || "";
    const realname = rawText.replace(/^\/checkoldusers\s*/i, "").trim();
    if (!realname) {
      await tg.reply(ctx, "❌ 请输入真实姓名\n用法: /checkoldusers 张三");
      return;
    }

    if (!GLOBAL_TOKEN) {
      await tg.reply(ctx, "❌ 系统未初始化, 请先设置 Token。");
      return;
    }

    if (!circuit.isAvailable()) {
      const remaining = Math.ceil(circuit.getRemainingCooldown() / 1000);
      await tg.reply(ctx, `🔌 API暂时不可用, ${remaining}秒后自动恢复, 请稍后再试。`);
      return;
    }

    await tg.typing(ctx);

    const result = await apiCheckOldUsers(realname, GLOBAL_TOKEN);

    if (!result.ok) {
      await tg.reply(ctx, `❌ 查询失败: ${result.err}`);
      return;
    }

    const rows = result.rows || [];
    if (rows.length === 0) {
      await tg.reply(ctx, `🔍 未找到姓名为「${realname}」的会员`);
      return;
    }

    const lines = [`🔍 查询结果 (共${result.total || rows.length}人)`];
    for (const u of rows) {
      const diffVal = parseFloat(u.depositAndDrawDiff) || 0;
      let profitText;
      if (diffVal > 0) {
        profitText = `输钱：${diffVal}`;
      } else if (diffVal < 0) {
        profitText = `赢钱：${Math.abs(diffVal)}`;
      } else {
        profitText = "赢钱：0";
      }
      const statusText = u.accountStatus === 2 ? "启用" : "禁用";
      const remarkText = u.remark || "无";

      lines.push("────────────────");
      lines.push(`会员帐号：${u.account || "未知"}`);
      lines.push(profitText);
      lines.push(`最后登录IP：${u.lastLoginIp || "未知"}`);
      lines.push(`最后登录地址：${u.lastLoginIpAddress || "未知"}`);
      lines.push(`账号状态：${statusText}`);
      lines.push(`备注内容：${remarkText}`);
    }

    await tg.reply(ctx, trunc(lines.join("\n")));
    log.info("checkoldusers查询完成", { realname, count: rows.length });
  } catch (e) {
    log.error("checkoldusers异常", { err: e?.message || String(e), stack: e?.stack });
    await tg.reply(ctx, "⚠️ 查询出错, 请稍后重试。");
  }
});

// --- 编辑消息处理 (A群编辑无效) ---
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

    if (TOKEN_RE.test(rawText)) {
      const sessionCheck = validateToken(rawText);
      if (sessionCheck.ok) {
        GLOBAL_TOKEN = rawText.trim();
        DB.saveToken(GLOBAL_TOKEN);
        const msgId = ctx?.message?.message_id;
    if (msgId) {
      const delOk = await tg.del(ctx, msgId);
      if (!delOk) await tg.reply(ctx, "⚠️ 无法删除Token消息, 请手动删除以防泄露！");
    }
        await tg.reply(ctx, `✅ 密钥已更新 - ${ctx?.from?.first_name || "管理员"}`);
        log.info("Token已更新", { from: ctx?.from?.id });
      } else {
        await tg.reply(ctx, `❌ ${sessionCheck.err}`);
      }
      return;
    }

    const chatId = ctx?.chat?.id;
    if (!chatId) return;

    const parsed = parseEntries(rawText);
    log.info("消息接收", { chatId, valid: parsed.valid.length, unrecognized: parsed.unrecognized.length, textLen: rawText.length, preview: rawText.slice(0, 80) });
    if (!parsed.valid.length && !parsed.unrecognized.length) return;

    if (parsed._warning) {
      await tg.reply(ctx, `⚠️ ${parsed._warning}`);
      return;
    }

    // A群组 — 验证格式 + 查重 + 转发B群
    if (CFG.GROUP_A_ID && chatId === CFG.GROUP_A_ID) {
      log.info("路由→A群", { valid: parsed.valid.length, autoForward, hasToken: !!GLOBAL_TOKEN, circuitState: circuit.state });
      if (parsed.unrecognized && parsed.unrecognized.length) {
        let t = `⚠️ 格式有误，请重新发送:\n`;
        for (const u of parsed.unrecognized) t += `  ${u.line} — ${u.hint}\n`;
        await tg.reply(ctx, trunc(t), { reply_to_message_id: ctx.message.message_id });
      }

      if (!parsed.valid.length) return;

      if (!autoForward) return;

      const duplicates = DB.checkDuplicates(parsed.valid);
      if (duplicates && duplicates.length > 0) {
        const groups = new Map();
        for (const r of duplicates) {
          const key = `${r.member}|${r.remark}`;
          if (!groups.has(key)) groups.set(key, { member: r.member, remark: r.remark, count: 0, records: [] });
          const g = groups.get(key);
          g.count++;
          g.records.push(r);
        }
        let dupText = `⚠️ 检测到重复数据！\n`;
        for (const info of groups.values()) {
          dupText += `--------------------------\n重复 ${info.count} 次\n`;
          for (const record of info.records) {
            const time = String(record.created_at || "").substring(5);
            dupText += `[ ${record.member} | ${record.remark} | ${record.amount} ] * ${time}\n`;
          }
        }
        await tg.reply(ctx, trunc(dupText), { reply_to_message_id: ctx.message.message_id });
      }

      let validEntries = parsed.valid;

      let notExistMembers = [];
      if (GLOBAL_TOKEN && circuit.isAvailable()) {
        const { map: existMap, tokenExpired, networkError } = await checkUserExists(parsed.valid.map(e => e.member), GLOBAL_TOKEN);

        if (tokenExpired) return;
        if (networkError) return;

        validEntries = [];
        for (const e of parsed.valid) {
          const info = existMap.get(e.member);
          if (info?.exists === false) {
            notExistMembers.push(e);
          } else {
            validEntries.push({ ...e, _nickname: info?.nickname, _memberId: info?.id });
          }
        }
      }

      if (!validEntries.length && !notExistMembers.length) return;

      await processForGroupB(validEntries, chatId, ctx.message.message_id, ctx?.from, notExistMembers);
      return;
    }

    // B群组判断
    const isTarget =
      (CFG.GROUP_B_ID && chatId === CFG.GROUP_B_ID) ||
      (!CFG.GROUP_B_ID && CFG.TARGET_CHAT_ID && chatId === CFG.TARGET_CHAT_ID);

    log.info("路由→B群判断", { chatId, groupB: CFG.GROUP_B_ID, targetChatId: CFG.TARGET_CHAT_ID, isTarget, chatType: ctx.chat?.type, fromId: ctx?.from?.id });
    if (!isTarget) return;

    // 仅在目标群组显示未识别提示
    if (parsed.unrecognized && parsed.unrecognized.length) {
      let t = `⚠️ 未识别 (${parsed.unrecognized.length}笔):\n`;
      for (const u of parsed.unrecognized) t += `  ${u.line} — ${u.hint}\n`;
      await tg.reply(ctx, trunc(t), { reply_to_message_id: ctx.message.message_id });
    }

    if (!parsed.valid.length) return;
    if (!GLOBAL_TOKEN) return tg.reply(ctx, "❌ 系统未初始化, 请先设置 Token。");
    if (!circuit.isAvailable()) {
      const remaining = Math.ceil(circuit.getRemainingCooldown() / 1000);
      return tg.reply(ctx, `🔌 API暂时不可用, ${remaining}秒后自动恢复, 请稍后再试。`);
    }

    log.info("B群→进入handleB", { valid: parsed.valid.length });
    await handleB(ctx, parsed.valid);
  } catch (e) {
    log.error("消息处理失败", { err: e?.message || String(e), stack: e?.stack });
    try { await tg.reply(ctx, "⚠️ 内部错误, 请稍后重试。"); } catch {}
  }
});

// --- A群转发B群处理 ---
async function processForGroupB(entries, sourceChatId, sourceMessageId, sourceFrom, notExistMembers) {
  try {
    const bGroupId = CFG.GROUP_B_ID || CFG.TARGET_CHAT_ID;
    log.info("A群→processForGroupB", { entries: entries.length, bGroupId, sourceChatId, hasToken: !!GLOBAL_TOKEN, circuitState: circuit.state });
    if (!bGroupId) {
      log.error("processForGroupB: B群ID未配置");
      return;
    }

    const senderName = sourceFrom ? ((sourceFrom.first_name || "") + (sourceFrom.last_name || "") || sourceFrom.username || "未知") : "A群";
    const header = `📥 来自: ${senderName}`;

    if (!GLOBAL_TOKEN) {
      await bot.telegram.sendMessage(bGroupId, `${header}\n❌ Token未设置, 请先设置Token`).catch(() => {});
      return;
    }
    if (!circuit.isAvailable()) {
      const remaining = Math.ceil(circuit.getRemainingCooldown() / 1000);
      await bot.telegram.sendMessage(bGroupId, `${header}\n🔌 API暂时不可用, ${remaining}秒后自动恢复`).catch(() => {});
      return;
    }

    const classified = classifyEntries(entries);

    const existMap = new Map();
    for (const e of entries) {
      if (e._nickname && e._memberId) existMap.set(e.member, { nickname: e._nickname, id: e._memberId });
    }

    let results = null;
    if (classified.auto.length) {
      results = await executeBatch(classified.auto, GLOBAL_TOKEN, existMap);
      const okList = (results || []).filter(r => r && r.ok);
      if (okList.length) DB.insertTxLog(okList, classified.successMap);
    }

    const baseReport = buildBReport(classified, results, notExistMembers);

    let aGroupMsgId = null;
    const aMsg = buildAGroupNotification(classified, results, notExistMembers);
    if (aMsg) {
      try {
        const aSent = await bot.telegram.sendMessage(sourceChatId, aMsg, {
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
        bText += `\n${t.member || "?"}  ${t.remark || "?"}  ${t.amount}`;
      }

      const id = crypto.randomBytes(6).toString("hex");
      if (pending.size >= CFG.MAX_PENDING) cleanPending();
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
        existMap,
        successMap: classified.successMap,
      });

      await bot.telegram.sendMessage(bGroupId, trunc(bText), Markup.inlineKeyboard([
        Markup.button.callback("✅ 确认", `ok_${id}`),
        Markup.button.callback("❌ 取消", `no_${id}`),
      ])).catch(e => log.error("B群确认消息发送失败", { err: e?.message }));
    } else {
      let bText = `${header}\n📊 处理报告`;
      if (baseReport) bText += "\n" + baseReport;
      await bot.telegram.sendMessage(bGroupId, trunc(bText)).catch(e => log.error("B群报告发送失败", { err: e?.message }));
    }

    log.info("A群→B群: 处理完成", { auto: classified.auto.length, confirm: classified.confirm.length, overLimit: classified.overLimit.length });
  } catch (e) {
    log.error("processForGroupB失败", { err: e?.message || String(e), stack: e?.stack });
  }
}

// --- B群组处理 ---
async function handleB(ctx, entries) {
  try {
    await tg.typing(ctx);

    let validEntries = entries;
    let existMap = null;

    let notExistMembers = [];
    if (GLOBAL_TOKEN && circuit.isAvailable()) {
      const { map: existMapResult, tokenExpired, networkError } = await checkUserExists(entries.map(e => e.member), GLOBAL_TOKEN);
      existMap = existMapResult;

      if (tokenExpired) {
        await tg.reply(ctx, "❌ Token已过期, 请重新设置Token。");
        return;
      }
      if (networkError) {
        await tg.reply(ctx, "⚠️ 网络异常, 无法验证用户, 请稍后重试。");
        return;
      }

      validEntries = [];
      for (const e of entries) {
        const info = existMap.get(e.member);
        if (info?.exists === false) {
          notExistMembers.push(e);
        } else {
          validEntries.push({ ...e, _nickname: info?.nickname, _memberId: info?.id });
        }
      }
    }

    const classified = classifyEntries(validEntries);

    let results = null;
    if (classified.auto.length) {
      results = await executeBatch(classified.auto, GLOBAL_TOKEN, existMap);
      const okList = (results || []).filter((r) => r && r.ok);
      if (okList.length) {
        const writeOk = DB.insertTxLog(okList, classified.successMap);
        log.info(writeOk ? "成功记录写入tx_log" : "成功记录写入tx_log失败", { count: okList.length });
      }
    }

    const baseReport = buildBReport(classified, results, notExistMembers);

    if (classified.confirm.length) {
      let confirmList = `⏳ 等待操作：${classified.confirm.length} 笔`;
      for (const t of classified.confirm) {
        confirmList += `\n${t.member || "?"}  ${t.remark || "?"}  ${t.amount}`;
      }

      const fullText = `📊 处理报告\n` + (baseReport ? baseReport + "\n" : "") + confirmList;

      const id = crypto.randomBytes(6).toString("hex");
      if (pending.size >= CFG.MAX_PENDING) cleanPending();
      pending.set(id, {
        tasks: classified.confirm,
        expire: Date.now() + CFG.CONFIRM_EXPIRE_MS,
        autoResults: results || [],
        overLimit: classified.overLimit || [],
        notExist: notExistMembers,
        header: null,
        sourceChatId: null,
        sourceMessageId: null,
        existMap,
        successMap: classified.successMap,
      });

      try {
        await tg.reply(ctx, trunc(fullText), {
          reply_to_message_id: ctx?.message?.message_id,
          ...Markup.inlineKeyboard([
            Markup.button.callback("✅ 确认", `ok_${id}`),
            Markup.button.callback("❌ 取消", `no_${id}`),
          ]),
        });
      } catch (e) { log.error("确认消息发送失败", { err: e?.message }); }
    } else if (baseReport) {
    await tg.reply(ctx, `📊 处理报告\n` + baseReport, { reply_to_message_id: ctx?.message?.message_id });
    }
  } catch (e) {
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
    if (!cached) return tg.edit(ctx, "⏰ 已过期或不存在", { reply_markup: { inline_keyboard: [] } }).then(() => tg.cb(ctx, "已过期"));
    if (!cached.tasks || !Array.isArray(cached.tasks)) { pending.delete(id); return tg.edit(ctx, "⚠️ 数据异常", { reply_markup: { inline_keyboard: [] } }).then(() => tg.cb(ctx, "数据异常")); }
    if (Date.now() > cached.expire) {
      if (cached.sourceChatId) {
        let aText = "";
        if (cached.overLimit && cached.overLimit.length) {
          aText += `⛔️ 拒绝加款：${cached.overLimit.length} 笔`;
          cached.overLimit.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount} - 金额超限`; });
        }
        if (cached.notExist && cached.notExist.length) {
          aText += (aText ? "\n" : "") + `⚠️ 账号无效：${cached.notExist.length} 笔`;
          cached.notExist.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount}`; });
        }
        aText += (aText ? "\n" : "") + `❌ 超时取消：${cached.tasks.length} 笔`;
        cached.tasks.forEach(r => { aText += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}`; });
        const autoOk = (cached.autoResults || []).filter(r => r && r.ok);
        if (autoOk.length) aText += `\n✅ 成功加款：${autoOk.length} 笔`;
        if (aText) {
          if (cached.aGroupMsgId) {
            await bot.telegram.editMessageText(cached.sourceChatId, cached.aGroupMsgId, undefined, aText).catch(e => {
              log.warn("A群超时通知编辑失败", { err: e?.message });
              bot.telegram.sendMessage(cached.sourceChatId, aText, {
                reply_to_message_id: cached.sourceMessageId
              }).catch(e2 => log.error("A群超时通知失败", { err: e2?.message }));
            });
          } else if (cached.sourceMessageId) {
            await bot.telegram.sendMessage(cached.sourceChatId, aText, {
              reply_to_message_id: cached.sourceMessageId
            }).catch(e => log.error("A群超时通知失败", { err: e?.message }));
          }
        }
      }
      pending.delete(id);
      return tg.edit(ctx, "⏰ 操作超时", { reply_markup: { inline_keyboard: [] } }).then(() => tg.cb(ctx, "已超时"));
    }
    if (!GLOBAL_TOKEN) { pending.delete(id); return tg.edit(ctx, "❌ Token未设置, 请重新设置Token后操作", { reply_markup: { inline_keyboard: [] } }).then(() => tg.cb(ctx, "无Token")); }
    if (!circuit.isAvailable()) {
      const remaining = Math.ceil(circuit.getRemainingCooldown() / 1000);
      return tg.edit(ctx, `🔌 API暂时不可用, ${remaining}秒后自动恢复`, { reply_markup: { inline_keyboard: [] } }).then(() => tg.cb(ctx, "熔断中"));
    }

    // 用户已确认, 不再二次去重, 直接执行
    const toRun = (cached.tasks || []).filter(t => t && t.member && t.remark);
    pending.delete(id);

    if (!toRun.length) {
      await tg.edit(ctx, "⏳ 无有效条目", { reply_markup: { inline_keyboard: [] } });
      return tg.cb(ctx, "空");
    }

    await tg.edit(ctx, buildConfirmText(toRun), { reply_markup: { inline_keyboard: [] } });
    const results = await executeBatch(toRun, GLOBAL_TOKEN, cached.existMap);
    const okList = (results || []).filter((r) => r && r.ok);
    if (okList.length) {
      const writeOk = DB.insertTxLog(okList, cached.successMap);
      if (!writeOk) log.warn("确认执行: 成功记录写入tx_log失败", { count: okList.length });
    }
    const header = cached.header || null;
    const baseReport = buildBReport({ overLimit: cached.overLimit || [] }, cached.autoResults, cached.notExist || []);
    if (cached.sourceChatId && cached.aGroupMsgId) {
      let aText = "";
      if (cached.overLimit && cached.overLimit.length) {
        aText += `⛔️ 拒绝加款：${cached.overLimit.length} 笔`;
        cached.overLimit.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount} - 金额超限`; });
      }
      if (cached.notExist && cached.notExist.length) {
        aText += (aText ? "\n" : "") + `⚠️ 账号无效：${cached.notExist.length} 笔`;
        cached.notExist.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount}`; });
      }
      const okConfirm = (results || []).filter(r => r && r.ok);
      const autoOk = (cached.autoResults || []).filter(r => r && r.ok);
      const totalOk = okConfirm.length + autoOk.length;
      if (totalOk) aText += (aText ? "\n" : "") + `✅ 成功加款：${totalOk} 笔`;
      if (aText) {
        await bot.telegram.editMessageText(cached.sourceChatId, cached.aGroupMsgId, undefined, aText).catch(e => {
          log.warn("A群通知编辑失败", { err: e?.message });
          bot.telegram.sendMessage(cached.sourceChatId, aText, {
            reply_to_message_id: cached.sourceMessageId
          }).catch(e2 => log.error("A群确认通知失败", { err: e2?.message }));
        });
      }
    } else if (cached.sourceChatId && cached.sourceMessageId) {
      let aText = "";
      if (cached.overLimit && cached.overLimit.length) {
        aText += `⛔️ 拒绝加款：${cached.overLimit.length} 笔`;
        cached.overLimit.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount} - 金额超限`; });
      }
      if (cached.notExist && cached.notExist.length) {
        aText += (aText ? "\n" : "") + `⚠️ 账号无效：${cached.notExist.length} 笔`;
        cached.notExist.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount}`; });
      }
      const okConfirm = (results || []).filter(r => r && r.ok);
      const autoOk = (cached.autoResults || []).filter(r => r && r.ok);
      const totalOk = okConfirm.length + autoOk.length;
      if (totalOk) aText += (aText ? "\n" : "") + `✅ 成功加款：${totalOk} 笔`;
      if (aText) {
        await bot.telegram.sendMessage(cached.sourceChatId, aText, {
          reply_to_message_id: cached.sourceMessageId
        }).catch(e => log.error("A群确认通知失败", { err: e?.message }));
      }
    }

    // 将确认结果合并到基础报告中, 编辑同一条消息 (不发新消息)
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
  } catch (e) {
    log.error("确认执行失败", { err: e?.message || String(e), stack: e?.stack });
    try { await tg.cb(ctx, "执行出错, 请查看日志"); } catch {}
  }
});

bot.action(/^no_(.+)$/, async (ctx) => {
  try {
    const id = ctx?.match?.[1];
    let cached = id ? pending.get(id) : null;
    if (!cached) return tg.edit(ctx, "⏰ 已过期或不存在", { reply_markup: { inline_keyboard: [] } }).then(() => tg.cb(ctx, "已过期"));
    if (Date.now() > cached.expire) {
      if (cached.sourceChatId) {
        let aText = "";
        if (cached.overLimit && cached.overLimit.length) {
          aText += `⛔️ 拒绝加款：${cached.overLimit.length} 笔`;
          cached.overLimit.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount} - 金额超限`; });
        }
        if (cached.notExist && cached.notExist.length) {
          aText += (aText ? "\n" : "") + `⚠️ 账号无效：${cached.notExist.length} 笔`;
          cached.notExist.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount}`; });
        }
        aText += (aText ? "\n" : "") + `❌ 超时取消：${cached.tasks.length} 笔`;
        cached.tasks.forEach(r => { aText += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}`; });
        const autoOk = (cached.autoResults || []).filter(r => r && r.ok);
        if (autoOk.length) aText += `\n✅ 成功加款：${autoOk.length} 笔`;
        if (aText) {
          if (cached.aGroupMsgId) {
            await bot.telegram.editMessageText(cached.sourceChatId, cached.aGroupMsgId, undefined, aText).catch(e => {
              log.warn("A群超时通知编辑失败", { err: e?.message });
              bot.telegram.sendMessage(cached.sourceChatId, aText, {
                reply_to_message_id: cached.sourceMessageId
              }).catch(e2 => log.error("A群超时通知失败", { err: e2?.message }));
            });
          } else if (cached.sourceMessageId) {
            await bot.telegram.sendMessage(cached.sourceChatId, aText, {
              reply_to_message_id: cached.sourceMessageId
            }).catch(e => log.error("A群超时通知失败", { err: e?.message }));
          }
        }
      }
      pending.delete(id);
      return tg.edit(ctx, "⏰ 操作超时", { reply_markup: { inline_keyboard: [] } }).then(() => tg.cb(ctx, "已超时"));
    }
    if (id) pending.delete(id);
    const header = cached.header || null;
    const baseReport = buildBReport({ overLimit: cached.overLimit || [] }, cached.autoResults, cached.notExist || []);
    if (cached && !isExpired && cached.sourceChatId && cached.aGroupMsgId) {
      let aText = "";
      if (cached.overLimit && cached.overLimit.length) {
        aText += `⛔️ 拒绝加款：${cached.overLimit.length} 笔`;
        cached.overLimit.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount} - 金额超限`; });
      }
      if (cached.notExist && cached.notExist.length) {
        aText += (aText ? "\n" : "") + `⚠️ 账号无效：${cached.notExist.length} 笔`;
        cached.notExist.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount}`; });
      }
      aText += (aText ? "\n" : "") + `❌ 取消加款：${cached.tasks.length} 笔`;
      cached.tasks.forEach(r => { aText += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}`; });
      const autoOk = (cached.autoResults || []).filter(r => r && r.ok);
      if (autoOk.length) aText += `\n✅ 成功加款：${autoOk.length} 笔`;
      await bot.telegram.editMessageText(cached.sourceChatId, cached.aGroupMsgId, undefined, aText).catch(e => {
        log.warn("A群取消通知编辑失败", { err: e?.message });
        bot.telegram.sendMessage(cached.sourceChatId, aText, {
          reply_to_message_id: cached.sourceMessageId
        }).catch(e2 => log.error("A群取消通知失败", { err: e2?.message }));
      });
    } else if (cached && !isExpired && cached.sourceChatId && cached.sourceMessageId) {
      let aText = "";
      if (cached.overLimit && cached.overLimit.length) {
        aText += `⛔️ 拒绝加款：${cached.overLimit.length} 笔`;
        cached.overLimit.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount} - 金额超限`; });
      }
      if (cached.notExist && cached.notExist.length) {
        aText += (aText ? "\n" : "") + `⚠️ 账号无效：${cached.notExist.length} 笔`;
        cached.notExist.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount}`; });
      }
      aText += (aText ? "\n" : "") + `❌ 取消加款：${cached.tasks.length} 笔`;
      cached.tasks.forEach(r => { aText += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}`; });
      const autoOk = (cached.autoResults || []).filter(r => r && r.ok);
      if (autoOk.length) aText += `\n✅ 成功加款：${autoOk.length} 笔`;
      if (aText) {
        await bot.telegram.sendMessage(cached.sourceChatId, aText, {
          reply_to_message_id: cached.sourceMessageId
        }).catch(e => log.error("A群取消通知失败", { err: e?.message }));
      }
    }
        let bEditText = header ? `${header}\n📊 处理报告` : "📊 处理报告";
        if (baseReport) bEditText += "\n" + baseReport;
        bEditText += "\n🔄 操作结果";
        bEditText += `\n❌ 取消加款：${cached.tasks.length} 笔`;
        cached.tasks.forEach(r => { bEditText += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}`; });
    await tg.edit(ctx, trunc(bEditText), { reply_markup: { inline_keyboard: [] } });
    await tg.cb(ctx, "已取消");
  } catch (e) { log.error("取消操作异常", { err: e?.message }); }
});

// ================================================================
//  14. EXPRESS + HEALTH
// ================================================================
const app = express();
// P15 修复: 正确使用 express.json(), 不再每请求创建新实例
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
  setTimeout(() => process.exit(1), 3000);
});
process.on("unhandledRejection", (r) => {
  log.error("unhandledRejection (已捕获)", { reason: r?.message ? String(r.message).slice(0, 200) : String(r) });
});

// 内存监控
const memIv = setInterval(() => {
  try {
    const m = process.memoryUsage();
    if (Math.round(m.rss / 1024 / 1024) > 300) log.warn("内存使用过高", { rssMB: Math.round(m.rss / 1024 / 1024) });
  } catch {}
}, 60000);

async function cleanPending() {
  try {
    const now = Date.now();
    for (const [k, v] of pending) {
      if (!v || v.expire < now) {
        if (v && v.sourceChatId && v.tasks && v.tasks.length) {
          try {
            let aText = "";
            if (v.overLimit && v.overLimit.length) {
              aText += `⛔️ 拒绝加款：${v.overLimit.length} 笔`;
              v.overLimit.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount} - 金额超限`; });
            }
            if (v.notExist && v.notExist.length) {
              aText += (aText ? "\n" : "") + `⚠️ 账号无效：${v.notExist.length} 笔`;
              v.notExist.forEach(r => { aText += `\n${r.member}  ${r.remark}  ${r.amount}`; });
            }
            aText += (aText ? "\n" : "") + `❌ 超时取消：${v.tasks.length} 笔`;
            v.tasks.forEach(r => { aText += `\n${r.member || "?"}  ${r.remark || "?"}  ${r.amount}`; });
            const autoOk = (v.autoResults || []).filter(r => r && r.ok);
            if (autoOk.length) aText += `\n✅ 成功加款：${autoOk.length} 笔`;
            if (aText) {
              if (v.aGroupMsgId) {
                await bot.telegram.editMessageText(v.sourceChatId, v.aGroupMsgId, undefined, aText).catch(() => {});
              } else if (v.sourceMessageId) {
                await bot.telegram.sendMessage(v.sourceChatId, aText, {
                  reply_to_message_id: v.sourceMessageId
                }).catch(() => {});
              }
            }
          } catch (e) { log.warn("cleanPending A群通知失败", { err: e?.message }); }
        }
        pending.delete(k);
      }
    }
    if (pending.size > CFG.MAX_PENDING) {
      const sorted = [...pending.entries()].sort((a, b) => (a[1]?.expire || 0) - (b[1]?.expire || 0));
      for (const [k] of sorted.slice(0, sorted.length - CFG.MAX_PENDING)) pending.delete(k);
    }
  } catch (e) { log.error("清理pending异常", { err: e?.message }); }
}

// ================================================================
//  16. STARTUP / SHUTDOWN
// ================================================================
let httpSrv = null;
let cleanIv = null;
let pendIv = null;

/**
 * 修复: Bot 启动添加重试机制, 失败后继续重试而非静默放弃
 */
async function launchBot() {
  for (let i = 0; i <= CFG.BOT_LAUNCH_RETRIES; i++) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      botRunning = true;
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
  botRunning = false;
  log.error("Bot启动最终失败, Telegram 功能不可用", { retries: CFG.BOT_LAUNCH_RETRIES + 1 });
  return false;
}

async function start() {
  log.info("正在启动...");

  if (!initDB()) { log.fatal("数据库初始化失败, 无法启动"); process.exit(1); }

  GLOBAL_TOKEN = DB.getToken();
  if (GLOBAL_TOKEN) {
    const check = validateToken(GLOBAL_TOKEN);
    if (!check.ok) { log.warn("已保存的Token格式无效, 已清除", { err: check.err }); DB.clearToken(); GLOBAL_TOKEN = null; }
  }
  log.info(GLOBAL_TOKEN ? "Token已加载" : "等待设置Token...");

  autoForward = DB.getAutoForward();
  log.info(`自动转发: ${autoForward ? "已开启" : "已关闭"}`);

  DB.cleanOld();
  cleanIv = setInterval(() => { try { DB.cleanOld(); } catch {} }, 6 * 3600000);
  pendIv = setInterval(() => { cleanPending().catch(e => log.error("cleanPending定时执行失败", { err: e?.message })); }, 300000);

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

function shutdown(sig) {
  log.info(`收到关闭信号: ${sig}`);
  botRunning = false;

  const force = setTimeout(() => { log.warn("关闭超时, 强制退出"); process.exit(1); }, CFG.SHUTDOWN_MS);
  try { clearInterval(cleanIv); } catch {}
  try { clearInterval(pendIv); } catch {}
  try { clearInterval(memIv); } catch {}
  try { if (httpSrv) httpSrv.close(); } catch {}
  try { bot.stop(sig).catch(() => {}); } catch {}
  DB.close();
  try { apiHttpAgent.destroy(); } catch {} try { apiHttpsAgent.destroy(); } catch {} try { tgHttpsAgent.destroy(); } catch {}
  log.info("已清理完成");
  clearTimeout(force);
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

start().catch((e) => {
  log.fatal("启动过程异常", { err: e?.message || String(e) });
  process.exit(1);
});
