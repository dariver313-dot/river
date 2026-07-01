/**
 * API 路由 - Express 路由 + BOT_API_KEY 认证中间件 + 速率限制
 *
 * 按平台命名：
 *   /api/platform-a/*  → 平台A（澳博体系，TG_Aobo + AB_Riskbot）
 *   /api/platform-b/*  → 平台B（娱乐城体系，TG_Robot + TG_Riskbot）
 */

import crypto from 'crypto';
import express from 'express';
import { tokenManager } from './token-manager';
import * as platformA from './platforms/platform-a';
import * as platformB from './platforms/platform-b';
import { env } from './crypto-utils';
import { clearSm4Cache } from './sm4-crypto';

const router = express.Router();

// ============================================================
// 认证中间件 — 三级 Key 体系
// ============================================================
// BOT_API_KEYS         — 只读权限（查询类操作）
// BOT_FINANCE_KEYS     — 金融权限（加款），必须显式配置，不再回退到 BOT_API_KEYS
// BOT_ADMIN_KEYS       — 管理员权限（setToken/status），必须显式配置
//
// 每个环境变量都支持 _ENC 加密格式（通过 env()），优先级：XXX_ENC > XXX

function buildKeySet(envKey: string): Set<string> {
  // env() 自动处理 _ENC 解密 → 明文 fallback
  const raw = env(envKey);
  return new Set(raw.split(',').map(k => k.trim()).filter(Boolean));
}

// 缓存 + 变更检测
let _readKeys: Set<string> | null = null;
let _readKeysRaw = '';
let _financeKeys: Set<string> | null = null;
let _financeKeysRaw = '';
let _adminKeys: Set<string> | null = null;
let _adminKeysRaw = '';

function getReadKeys(): Set<string> {
  const raw = env('BOT_API_KEYS');
  if (raw !== _readKeysRaw || !_readKeys) { _readKeys = buildKeySet('BOT_API_KEYS'); _readKeysRaw = raw; }
  return _readKeys;
}
function getFinanceKeys(): Set<string> {
  const raw = env('BOT_FINANCE_KEYS');
  if (raw !== _financeKeysRaw || !_financeKeys) {
    _financeKeys = buildKeySet('BOT_FINANCE_KEYS');
    _financeKeysRaw = raw;
    if (_financeKeys.size === 0) {
      console.warn('[安全] BOT_FINANCE_KEYS 未配置，金融操作（加款）将被拒绝！请设置 BOT_FINANCE_KEYS 或 BOT_FINANCE_KEYS_ENC 环境变量。');
    }
  }
  // 安全加固：不再回退到只读 Key，金融操作必须显式授权
  return _financeKeys;
}
function getAdminKeys(): Set<string> {
  const raw = env('BOT_ADMIN_KEYS');
  if (raw !== _adminKeysRaw || !_adminKeys) {
    _adminKeys = buildKeySet('BOT_ADMIN_KEYS');
    _adminKeysRaw = raw;
    if (_adminKeys.size === 0) {
      console.warn('[安全] BOT_ADMIN_KEYS 未配置，管理员操作将被拒绝！请设置 BOT_ADMIN_KEYS 或 BOT_ADMIN_KEYS_ENC 环境变量。');
    }
  }
  // 安全加固：不再回退到只读 Key，管理员操作必须显式授权
  return _adminKeys;
}
function getAllValidKeys(): Set<string> {
  return new Set([...getReadKeys(), ...getFinanceKeys(), ...getAdminKeys()]);
}

/** 提取 API Key（从 Authorization header 中） */
function extractApiKey(req: express.Request): string {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return '';
  return authHeader.slice('Bearer '.length).trim();
}

// ============================================================
// IP 白名单（可选，未设置时不限制）
// ============================================================
// BOT_IP_WHITELIST=10.0.0.1,192.168.1.0/24,127.0.0.1

let _ipWhitelist: { exact: Set<string>; cidr: { net: number; mask: number }[] } | null = null;
let _ipWhitelistRaw = '';

function getIpWhitelist(): { exact: Set<string>; cidr: { net: number; mask: number }[] } | null {
  const raw = process.env.BOT_IP_WHITELIST || '';
  if (raw !== _ipWhitelistRaw) {
    _ipWhitelistRaw = raw;
    const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (entries.length === 0) { _ipWhitelist = null; return null; }
    const exact = new Set<string>();
    const cidr: { net: number; mask: number }[] = [];
    for (const entry of entries) {
      const slash = entry.indexOf('/');
      if (slash >= 0) {
        const ip = entry.slice(0, slash);
        const bits = parseInt(entry.slice(slash + 1), 10);
        if (isNaN(bits) || bits < 0 || bits > 32) continue;
        const net = ipToInt(ip);
        if (net === null) continue;
        const mask = ~((1 << (32 - bits)) - 1) >>> 0;
        cidr.push({ net: net & mask, mask });
      } else {
        exact.add(entry);
      }
    }
    _ipWhitelist = { exact, cidr };
  }
  return _ipWhitelist;
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = parseInt(p, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/** 规范化 IP 地址：IPv4-mapped IPv6 → IPv4，::1 → 127.0.0.1 */
function normalizeIp(ip: string): string {
  // ::ffff:x.x.x.x → x.x.x.x
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return v4mapped[1];
  // ::1 → 127.0.0.1
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function ipAllowed(rawIp: string): boolean {
  const ip = normalizeIp(rawIp);
  const wl = getIpWhitelist();
  if (!wl) return true; // 未设置白名单，全部放行
  if (wl.exact.has(ip)) return true;
  const ipNum = ipToInt(ip);
  if (ipNum === null) return false; // IPv6 非映射地址，不在白名单则拒绝
  for (const { net, mask } of wl.cidr) {
    if ((ipNum & mask) === net) return true;
  }
  return false;
}

/** 基础认证：Key 必须存在于任一集合中 + IP 白名单 */
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  // IP 白名单检查（可选）
  const clientIp = req.ip || req.socket.remoteAddress || '';
  if (!ipAllowed(clientIp)) {
    res.status(403).json({ error: 'IP 不在白名单中' });
    return;
  }

  const key = extractApiKey(req);
  if (!key) {
    res.status(401).json({ error: '缺少 Authorization: Bearer <key>' });
    return;
  }
  if (!getAllValidKeys().has(key)) {
    res.status(403).json({ error: '无效的 API Key' });
    return;
  }
  // 将解析后的 key 挂到 req 上，供后续中间件使用
  (req as any)._apiKey = key;
  next();
}

/** 金融权限中间件 */
function financeAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const key = (req as any)._apiKey || extractApiKey(req);
  if (!getFinanceKeys().has(key)) {
    res.status(403).json({ error: '此操作需要金融权限' });
    return;
  }
  next();
}

/** 管理员权限中间件 */
function adminAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const key = (req as any)._apiKey || extractApiKey(req);
  if (!getAdminKeys().has(key)) {
    res.status(403).json({ error: '此操作需要管理员权限' });
    return;
  }
  next();
}

// ============================================================
// 操作审计日志
// ============================================================

function auditLog(op: string, target: string, result: string, req: express.Request, extra?: Record<string, unknown>): void {
  const key = (req as any)._apiKey || extractApiKey(req);
  // 使用 SHA256 前8位作为稳定的脱敏标识符
  const masked = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    type: 'audit',
    op,
    target,
    result,
    keyHash: masked,
    ...(extra || {}),
  }));
}

// ============================================================
// 速率限制（以提取的 API Key 为限流键，同一 Key 独立计数）
// ============================================================

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const MAX_RATE_LIMIT_ENTRIES = 10000;

// 每5分钟清理过期的速率限制条目，防止内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [k, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(k);
  }
}, 5 * 60 * 1000);

function rateLimit(maxRequests: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const key = (req as any)._apiKey || extractApiKey(req) || req.ip || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now > entry.resetAt) {
      // 容量保护：超出上限时先清理过期条目，仍超出则拒绝
      if (!entry && rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
        for (const [k, e] of rateLimitMap) {
          if (now > e.resetAt) rateLimitMap.delete(k);
        }
        if (rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
          res.status(503).json({ error: '服务繁忙，请稍后重试' });
          return;
        }
      }
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (entry.count >= maxRequests) {
      res.status(429).json({ error: '请求过于频繁，请稍后再试' });
      return;
    }

    entry.count++;
    next();
  };
}

// 金融操作严格限制：每分钟最多30次
const financeRateLimit = rateLimit(30, 60 * 1000);
// 查询操作宽松限制：每分钟最多120次
const queryRateLimit = rateLimit(120, 60 * 1000);
// Token设置限制：每分钟最多5次
const setTokenRateLimit = rateLimit(5, 60 * 1000);

// ============================================================
// 充值幂等性保护（防重复加款）
// ============================================================

const idempotencyStore = new Map<string, { result: any; timestamp: number }>();
const IDEMPOTENCY_TTL = 10 * 60 * 1000; // 10分钟 TTL
const MAX_IDEMPOTENCY_ENTRIES = 5000;

// 每5分钟清理过期的幂等键
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of idempotencyStore) {
    if (now - v.timestamp > IDEMPOTENCY_TTL) idempotencyStore.delete(k);
  }
}, 5 * 60 * 1000);

/** 充值幂等性中间件：检查 X-Idempotency-Key 头，已处理过的请求直接返回缓存结果
 *  @param required 是否强制要求幂等键（金融操作必须为 true） */
function idempotencyCheck(required: boolean = false): express.RequestHandler {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const key = req.headers['x-idempotency-key'] as string;
    if (!key || key.length > 200) {
      if (required) {
        res.status(400).json({ success: false, error: '金融操作必须提供 X-Idempotency-Key 请求头' });
        return;
      }
      // 非金融操作：未提供幂等键时仍允许请求（向后兼容），但记录警告
      console.warn(`[幂等] 请求缺少 X-Idempotency-Key | from: ${(req as any)._apiKey?.slice(0, 4) || '?'}*** | target: ${req.body?.member || '?'}`);
      next();
      return;
    }

    // 使用 API Key + 幂等键组合作为存储键，防止跨 Key 碰撞
    const apiKey = (req as any)._apiKey || 'unknown';
    const storeKey = `${apiKey}:${key}`;

    const existing = idempotencyStore.get(storeKey);
    if (existing) {
      console.log(`[幂等] 命中缓存 ${key.slice(0, 8)}... | 原始时间: ${new Date(existing.timestamp).toISOString()}`);
      res.json(existing.result);
      return;
    }

    // 容量保护
    if (idempotencyStore.size >= MAX_IDEMPOTENCY_ENTRIES) {
      const now = Date.now();
      for (const [k, v] of idempotencyStore) {
        if (now - v.timestamp > IDEMPOTENCY_TTL) idempotencyStore.delete(k);
      }
      if (idempotencyStore.size >= MAX_IDEMPOTENCY_ENTRIES) {
        res.status(503).json({ success: false, error: '服务繁忙，请稍后重试' });
        return;
      }
    }

    (req as any)._idempotencyKey = storeKey;
    next();
  };
}

// 全局认证中间件：所有 /api/* 路由必须通过 API Key 认证
router.use(authMiddleware);

// ============================================================
// 输入校验工具
// ============================================================

const MAX_MEMBERS_LENGTH = 50;
const MAX_STRING_LENGTH = 200;

function validateMembers(members: unknown): string[] | null {
  if (!Array.isArray(members)) return null;
  if (members.length === 0 || members.length > MAX_MEMBERS_LENGTH) return null;
  const filtered = members.filter(m => typeof m === 'string' && m.trim().length > 0 && m.length <= MAX_STRING_LENGTH);
  return filtered.length > 0 ? filtered : null;
}

const MAX_AMOUNT = 1000000; // 单笔金额上限

function validateAmount(amount: unknown): number | null {
  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0 || num > MAX_AMOUNT) return null;
  return num;
}

function validateString(value: unknown, fieldName: string): string | null {
  if (!value || typeof value !== 'string') return null;
  if (value.length > MAX_STRING_LENGTH) return null;
  return value.trim() || null;
}

/** 时间戳校验：必须在 2000-01-01 ~ 2100-01-01 范围内 */
const MIN_TIMESTAMP = 946684800000;  // 2000-01-01T00:00:00.000Z
const MAX_TIMESTAMP = 4102444800000; // 2100-01-01T00:00:00.000Z

function validateTimestamp(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < MIN_TIMESTAMP || n > MAX_TIMESTAMP) return null;
  return n;
}

/** 分页参数：≥1 */
function validatePage(v: unknown): number {
  return Math.max(1, Number(v) || 1);
}

/** 状态值白名单验证：只允许已知的状态码数字，防止注入非法值 */
const VALID_CASH_STATUS_LIST = new Set([0, 1, 2, 3, 4, 5, 6]);

function validateStatusList(values: unknown): number[] | null {
  if (!Array.isArray(values)) return null;
  const filtered = values.filter(v => typeof v === 'number' && VALID_CASH_STATUS_LIST.has(v));
  return filtered.length > 0 ? filtered : null;
}

function validateStatusValue(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || !VALID_CASH_STATUS_LIST.has(n)) return null;
  return n;
}

/** 安全错误处理：脱敏内部错误信息，不泄露 token/key 等敏感数据 */
function safeError(res: express.Response, statusCode: number, userMessage: string, internalError?: any): void {
  if (internalError) {
    const full = internalError.message ? String(internalError.message) : String(internalError);
    // 脱敏：移除 Bearer token、URL 中的 token 参数、base64 长串
    const sanitized = full
      .replace(/Bearer\s+\S+/gi, 'Bearer ***')
      .replace(/token=\S+/gi, 'token=***')
      .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '***[base64]');
    console.error(`[API错误] ${userMessage} | ${sanitized.slice(0, 200)}`);
  }
  res.status(statusCode).json({ success: false, error: userMessage });
}

// ============================================================
// 平台A - 澳博体系（TG_Aobo + AB_Riskbot）
// ============================================================

// --- 加款机器人接口（TG_Aobo 使用） ---

router.post('/platform-a/checkUser', queryRateLimit, async (req, res) => {
  try {
    const members = validateMembers(req.body?.members);
    if (!members) {
      res.status(400).json({ error: 'members 必须是非空数组（最多50项）' });
      return;
    }
    const result = await platformA.checkUser(members);
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询用户失败', e);
  }
});

router.post('/platform-a/recharge', financeRateLimit, financeAuth, idempotencyCheck(true), async (req, res) => {
  try {
    const member = validateString(req.body?.member, 'member');
    const remark = validateString(req.body?.remark, 'remark');
    const amount = validateAmount(req.body?.amount);
    if (!member || !remark || amount === null) {
      res.status(400).json({ error: '缺少参数: member, remark, amount（amount必须为正数）' });
      return;
    }
    const result = await platformA.recharge({ member, remark, amount });
    auditLog('platform-a.recharge', member, result.ok ? 'success' : 'fail', req, { amount, remark: remark.slice(0, 50) });
    // 缓存幂等结果
    const idKey = (req as any)._idempotencyKey;
    if (idKey) {
      idempotencyStore.set(idKey, { result, timestamp: Date.now() });
    }
    res.json(result);
  } catch (e: any) {
    auditLog('platform-a.recharge', req.body?.member || 'unknown', 'error', req, { amount: req.body?.amount });
    safeError(res, 500, '加款操作失败', e);
  }
});

router.post('/platform-a/checkOldUsers', queryRateLimit, async (req, res) => {
  try {
    const realname = validateString(req.body?.realname, 'realname');
    if (!realname) {
      res.status(400).json({ error: '缺少参数: realname' });
      return;
    }
    const result = await platformA.checkOldUsers(realname);
    res.json(result);
  } catch (e: any) {
    safeError(res, 500, '查询用户失败', e);
  }
});

router.post('/platform-a/setToken', setTokenRateLimit, adminAuth, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string' || token.trim().length < 10) {
      res.status(400).json({ error: 'Token 格式无效' });
      return;
    }
    platformA.setToken(token);
    auditLog('platform-a.setToken', 'token_update', 'success', req);
    res.json({ success: true });
  } catch (e: any) {
    auditLog('platform-a.setToken', 'token_update', 'error', req);
    safeError(res, 500, '设置Token失败', e);
  }
});

// --- 风控机器人接口（AB_Riskbot 使用） ---

router.post('/platform-a/withdrawOrders', queryRateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    // 只提取允许的字段，映射到 platform-a.ts 期望的参数名
    const params: Record<string, any> = {};
    if (body.current) params.page = validatePage(body.current);
    if (body.size) params.pageSize = Math.min(Math.max(1, Number(body.size) || 10), 100);
    if (body.cashStatusList) {
      const validated = validateStatusList(body.cashStatusList);
      if (validated) params.status = validated;
    }
    if (body.createTimeFrom) { const t = validateTimestamp(body.createTimeFrom); if (t) params.startTime = t; }
    if (body.createTimeTo) { const t = validateTimestamp(body.createTimeTo); if (t) params.endTime = t; }
    const result = await platformA.getWithdrawOrders(params);
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询提现订单失败', e);
  }
});

router.post('/platform-a/memberInfo', queryRateLimit, async (req, res) => {
  try {
    const account = validateString(req.body?.account, 'account');
    if (!account) { res.status(400).json({ error: '缺少参数: account' }); return; }
    const result = await platformA.getMemberInfo({ account });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询会员信息失败', e);
  }
});

/** 投注统计（默认最近7天含今天，支持自定义日期范围，北京时间）
 *  返回 7 个 *ValidAmount 字段：lottery/sport/real/hunter/chess/egame/esport */
router.post('/platform-a/betsCount', queryRateLimit, async (req, res) => {
  try {
    const account = validateString(req.body?.account, 'account');
    if (!account) { res.status(400).json({ error: '缺少参数: account' }); return; }
    const startTime = validateDateString(req.body?.startTime ?? req.body?.startDate);
    const endTime = validateDateString(req.body?.endTime ?? req.body?.endDate);
    const result = await platformA.getMemberBetAnalysis({
      account,
      startTime: startTime ?? undefined,
      endTime: endTime ?? undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询投注统计失败', e);
  }
});

/** 会员所有游戏有效投注分析（支持自定义日期范围，用于风控近7天占比计算）
 *  返回 7 个 *ValidAmount 字段：lottery/sport/real/hunter/chess/egame/esport */
router.post('/platform-a/memberBetAnalysis', queryRateLimit, async (req, res) => {
  try {
    const account = validateString(req.body?.account, 'account');
    if (!account) { res.status(400).json({ error: '缺少参数: account' }); return; }
    const startTime = validateDateString(req.body?.startTime ?? req.body?.startDate);
    const endTime = validateDateString(req.body?.endTime ?? req.body?.endDate);
    const result = await platformA.getMemberBetAnalysis({
      account,
      startTime: startTime ?? undefined,
      endTime: endTime ?? undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询会员投注分析失败', e);
  }
});

router.post('/platform-a/rechReport', queryRateLimit, async (req, res) => {
  try {
    const account = validateString(req.body?.account, 'account');
    if (!account) { res.status(400).json({ error: '缺少参数: account' }); return; }
    const toDateStr = (v: any) => {
      if (!v) return undefined;
      const n = Number(v);
      if (!isNaN(n) && n > 1e12) { const tz = parseInt(process.env.TZ_OFFSET || '8', 10) * 3600000; return new Date(n + tz).toISOString().slice(0, 10); }
      return String(v).slice(0, 10);
    };
    const result = await platformA.getRechReport({
      account,
      startDate: toDateStr(req.body?.startDate || req.body?.startTime),
      endDate: toDateStr(req.body?.endDate || req.body?.endTime),
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询充值报表失败', e);
  }
});

router.post('/platform-a/rechargeHistory', queryRateLimit, async (req, res) => {
  try {
    const account = validateString(req.body?.account, 'account');
    if (!account) { res.status(400).json({ error: '缺少参数: account' }); return; }
    const result = await platformA.getRechargeHistory({
      account,
      beginDatetime: req.body?.beginDatetime || req.body?.startTime ? String(req.body?.beginDatetime || req.body?.startTime) : undefined,
      endDatetime: req.body?.endDatetime || req.body?.endTime ? String(req.body?.endDatetime || req.body?.endTime) : undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询充值历史失败', e);
  }
});

/** 彩金加款明细（modeList=2,3 + discountTypes=888，用于风控7天加款次数和查重） */
router.post('/platform-a/rechargeDiscountHistory', queryRateLimit, async (req, res) => {
  try {
    const account = validateString(req.body?.account, 'account');
    if (!account) { res.status(400).json({ error: '缺少参数: account' }); return; }
    const result = await platformA.getRechargeDiscountHistory({
      account,
      beginDatetime: req.body?.beginDatetime || req.body?.startTime ? String(req.body?.beginDatetime || req.body?.startTime) : undefined,
      endDatetime: req.body?.endDatetime || req.body?.endTime ? String(req.body?.endDatetime || req.body?.endTime) : undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询彩金加款明细失败', e);
  }
});

/** 官彩游戏有效投注查询（按 gameId 过滤，用于风控占比计算） */
router.post('/platform-a/lotteryBetReport', queryRateLimit, async (req, res) => {
  try {
    const account = validateString(req.body?.account, 'account');
    const gameId = validateString(req.body?.gameId, 'gameId');
    if (!account || !gameId) { res.status(400).json({ error: '缺少参数: account, gameId' }); return; }
    const startTime = validateTimestamp(req.body?.startTime ?? req.body?.start);
    const endTime = validateTimestamp(req.body?.endTime ?? req.body?.end);
    const result = await platformA.getLotteryBetReport({
      account,
      gameId,
      startTime: startTime ?? undefined,
      endTime: endTime ?? undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询官彩投注失败', e);
  }
});

router.post('/platform-a/loginLogs', queryRateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    // 只提取允许的字段
    const params: Record<string, any> = {};
    if (body.type) params.type = String(body.type);
    if (body.current) params.current = validatePage(body.current);
    if (body.size) params.size = Math.min(Math.max(1, Number(body.size) || 10), 100);
    if (body.account) params.account = String(body.account).substring(0, MAX_STRING_LENGTH);
    if (body.loginIp) params.loginIp = String(body.loginIp).substring(0, MAX_STRING_LENGTH);
    if (body.deviceClientId) params.deviceClientId = String(body.deviceClientId).substring(0, MAX_STRING_LENGTH);
    if (body.beginTime) params.beginTime = body.beginTime;
    if (body.endTime) params.endTime = body.endTime;
    const result = await platformA.getLoginLogs(params);
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询登录日志失败', e);
  }
});

router.post('/platform-a/paymentOrders', queryRateLimit, async (req, res) => {
  try {
    const account = validateString(req.body?.account, 'account');
    if (!account) { res.status(400).json({ error: '缺少参数: account' }); return; }
    const result = await platformA.getPaymentOrders({
      account,
      page: Number(req.body?.page) || undefined,
      startTime: req.body?.startTime || undefined,
      endTime: req.body?.endTime || undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询充值订单失败', e);
  }
});

router.post('/platform-a/membersByAgency', queryRateLimit, async (req, res) => {
  try {
    const agencyUsername = validateString(req.body?.agencyUsername, 'agencyUsername');
    if (!agencyUsername) { res.status(400).json({ error: '缺少参数: agencyUsername' }); return; }
    const result = await platformA.getMembersByAgency({
      agencyUsername,
      page: Math.max(1, Number(req.body?.page) || 1),
      pageSize: Math.min(Number(req.body?.pageSize) || 200, 500),
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询代理会员失败', e);
  }
});

router.post('/platform-a/memberBets', queryRateLimit, async (req, res) => {
  try {
    const account = validateString(req.body?.account, 'account');
    if (!account) { res.status(400).json({ error: '缺少参数: account' }); return; }
    const result = await platformA.getMemberBets({
      account,
      page: Math.max(1, Number(req.body?.page) || 1),
      startTime: req.body?.startTime,
      endTime: req.body?.endTime,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询投注记录失败', e);
  }
});

router.post('/platform-a/memberWithdrawals', queryRateLimit, async (req, res) => {
  try {
    const account = validateString(req.body?.account, 'account');
    if (!account) { res.status(400).json({ error: '缺少参数: account' }); return; }
    const result = await platformA.getMemberWithdrawals({
      account,
      page: Math.max(1, Number(req.body?.page) || 1),
      startTime: req.body?.startTime,
      endTime: req.body?.endTime,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询提现历史失败', e);
  }
});

router.get('/platform-a/health', async (_req, res) => {
  const healthy = await platformA.checkHealth();
  res.json({ success: true, healthy });
});

// ============================================================
// 平台B - 娱乐城体系（TG_Robot + TG_Riskbot）
// ============================================================

// --- 加款机器人接口（TG_Robot 使用） ---

router.post('/platform-b/checkUser', queryRateLimit, async (req, res) => {
  try {
    const members = validateMembers(req.body?.members);
    if (!members) {
      res.status(400).json({ error: 'members 必须是非空数组（最多50项）' });
      return;
    }
    const result = await platformB.checkUser(members);
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询用户失败', e);
  }
});

router.post('/platform-b/recharge', financeRateLimit, financeAuth, idempotencyCheck(true), async (req, res) => {
  try {
    const member = validateString(req.body?.member, 'member');
    const remark = validateString(req.body?.remark, 'remark');
    const amount = validateAmount(req.body?.amount);
    if (!member || !remark || amount === null) {
      res.status(400).json({ error: '缺少参数: member, remark, amount（amount必须为正数）' });
      return;
    }
    const result = await platformB.recharge({ member, remark, amount });
    auditLog('platform-b.recharge', member, result.ok ? 'success' : 'fail', req, { amount, remark: remark.slice(0, 50) });
    // 缓存幂等结果
    const idKey = (req as any)._idempotencyKey;
    if (idKey) {
      idempotencyStore.set(idKey, { result, timestamp: Date.now() });
    }
    res.json(result);
  } catch (e: any) {
    auditLog('platform-b.recharge', req.body?.member || 'unknown', 'error', req, { amount: req.body?.amount });
    safeError(res, 500, '加款操作失败', e);
  }
});

router.post('/platform-b/checkOldUsers', queryRateLimit, async (req, res) => {
  try {
    const realname = validateString(req.body?.realname, 'realname');
    if (!realname) {
      res.status(400).json({ error: '缺少参数: realname' });
      return;
    }
    const result = await platformB.checkOldUsers(realname);
    res.json(result);
  } catch (e: any) {
    safeError(res, 500, '查询用户失败', e);
  }
});

router.post('/platform-b/setToken', setTokenRateLimit, adminAuth, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string' || token.trim().length < 10) {
      res.status(400).json({ error: 'Token 格式无效' });
      return;
    }
    platformB.setToken(token);
    auditLog('platform-b.setToken', 'token_update', 'success', req);
    res.json({ success: true });
  } catch (e: any) {
    auditLog('platform-b.setToken', 'token_update', 'error', req);
    safeError(res, 500, '设置Token失败', e);
  }
});

// --- 风控机器人接口（TG_Riskbot 使用） ---

router.post('/platform-b/withdrawOrders', queryRateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    // 只提取允许的字段
    const params: Record<string, any> = {};
    if (body.currentPage) params.currentPage = Math.max(1, Number(body.currentPage) || 1);
    if (body.pageSize) params.pageSize = Math.min(Number(body.pageSize) || 10, 100);
    if (body.status) {
      const validated = validateStatusValue(body.status);
      if (validated !== null) params.status = validated;
    }
    if (body.startTime || body.start) { const t = validateTimestamp(body.startTime || body.start); if (t) params.startTime = t; }
    if (body.endTime || body.end) { const t = validateTimestamp(body.endTime || body.end); if (t) params.endTime = t; }
    if (body.timeType) params.timeType = body.timeType;
    const result = await platformB.getWithdrawOrders(params);
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询提现订单失败', e);
  }
});

router.post('/platform-b/memberInfo', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    if (!memberName) { res.status(400).json({ error: '缺少参数: memberName' }); return; }
    const result = await platformB.getMemberInfo({ memberName });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询会员信息失败', e);
  }
});

router.post('/platform-b/memberBets', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    if (!memberName) { res.status(400).json({ error: '缺少参数: memberName' }); return; }
    const startTime = validateTimestamp(req.body?.startTime ?? req.body?.start);
    const endTime = validateTimestamp(req.body?.endTime ?? req.body?.end);
    const result = await platformB.getMemberBets({
      memberName,
      page: Number(req.body?.page) || undefined,
      startTime: startTime ?? undefined,
      endTime: endTime ?? undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询投注记录失败', e);
  }
});

router.post('/platform-b/betsCount', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    if (!memberName) { res.status(400).json({ error: '缺少参数: memberName' }); return; }
    const result = await platformB.getBetsCount({ memberName });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询投注统计失败', e);
  }
});

router.post('/platform-b/memberWithdrawals', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    if (!memberName) { res.status(400).json({ error: '缺少参数: memberName' }); return; }
    const startTime = validateTimestamp(req.body?.startTime ?? req.body?.start);
    const endTime = validateTimestamp(req.body?.endTime ?? req.body?.end);
    const result = await platformB.getMemberWithdrawals({
      memberName,
      page: Number(req.body?.page) || undefined,
      startTime: startTime ?? undefined,
      endTime: endTime ?? undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询提现历史失败', e);
  }
});

router.post('/platform-b/paymentOrders', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    if (!memberName) { res.status(400).json({ error: '缺少参数: memberName' }); return; }
    const startTime = validateTimestamp(req.body?.startTime ?? req.body?.start);
    const endTime = validateTimestamp(req.body?.endTime ?? req.body?.end);
    const result = await platformB.getPaymentOrders({
      memberName,
      page: Number(req.body?.page) || undefined,
      startTime: startTime ?? undefined,
      endTime: endTime ?? undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询充值订单失败', e);
  }
});

router.post('/platform-b/loginLogs', queryRateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    // 只提取允许的字段
    const params: Record<string, any> = {};
    if (body.currentPage) params.currentPage = Math.max(1, Number(body.currentPage) || 1);
    if (body.pageSize) params.pageSize = Math.min(Number(body.pageSize) || 10, 100);
    if (body.memberName) params.memberName = String(body.memberName).substring(0, MAX_STRING_LENGTH);
    if (body.loginIp) params.loginIp = String(body.loginIp).substring(0, MAX_STRING_LENGTH);
    if (body.device) params.device = String(body.device).substring(0, MAX_STRING_LENGTH);
    if (body.startTime) { const t = validateTimestamp(body.startTime); if (t) params.startTime = t; }
    if (body.endTime) { const t = validateTimestamp(body.endTime); if (t) params.endTime = t; }
    const result = await platformB.getLoginLogs(params);
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询登录日志失败', e);
  }
});

router.post('/platform-b/rechargeSum', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    const startTime = validateTimestamp(req.body?.startTime);
    const endTime = validateTimestamp(req.body?.endTime);
    if (!memberName || startTime === null || endTime === null) { res.status(400).json({ error: '缺少参数: memberName, startTime, endTime（时间必须为有效毫秒时间戳）' }); return; }
    const result = await platformB.getRechargeSum({ memberName, startTime, endTime });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询充值汇总失败', e);
  }
});

router.post('/platform-b/thirdGameOrders', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    if (!memberName) { res.status(400).json({ error: '缺少参数: memberName' }); return; }
    const startTime = validateTimestamp(req.body?.startTime ?? req.body?.start);
    const endTime = validateTimestamp(req.body?.endTime ?? req.body?.end);
    const result = await platformB.getThirdGameOrders({
      memberName,
      page: Number(req.body?.page) || undefined,
      startTime: startTime ?? undefined,
      endTime: endTime ?? undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询第三方游戏订单失败', e);
  }
});

/** 人工加款明细列表（用于风控计数） */
router.post('/platform-b/accountChangeList', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    const startTime = validateTimestamp(req.body?.startTime);
    const endTime = validateTimestamp(req.body?.endTime);
    if (!memberName || startTime === null || endTime === null) {
      res.status(400).json({ error: '缺少参数: memberName, startTime, endTime（时间必须为有效毫秒时间戳）' });
      return;
    }
    const result = await platformB.getAccountChangeList({
      memberName,
      startTime,
      endTime,
      page: validatePage(req.body?.page),
      pageSize: Number(req.body?.pageSize) || undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询加款明细失败', e);
  }
});

/** 日期字符串校验（YYYY-MM-DD） */
function validateDateString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return s;
}

/** 彩票游戏投注报表 */
router.post('/platform-b/cpReport', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    const startTime = validateDateString(req.body?.startTime);
    const endTime = validateDateString(req.body?.endTime);
    if (!memberName || !startTime || !endTime) {
      res.status(400).json({ error: '缺少参数: memberName, startTime, endTime（时间必须为 YYYY-MM-DD 格式）' });
      return;
    }
    const result = await platformB.getCpReport({
      memberName,
      startTime,
      endTime,
      page: validatePage(req.body?.page),
      pageSize: Number(req.body?.pageSize) || undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询彩票报表失败', e);
  }
});

/** 三方游戏投注报表 */
router.post('/platform-b/thirdReport', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    const startTime = validateDateString(req.body?.startTime);
    const endTime = validateDateString(req.body?.endTime);
    if (!memberName || !startTime || !endTime) {
      res.status(400).json({ error: '缺少参数: memberName, startTime, endTime（时间必须为 YYYY-MM-DD 格式）' });
      return;
    }
    const result = await platformB.getThirdReport({
      memberName,
      startTime,
      endTime,
      page: validatePage(req.body?.page),
      pageSize: Number(req.body?.pageSize) || undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询三方报表失败', e);
  }
});

/** 会员进出报表统计（近7天各游戏类型投注金额汇总，用于风控主投游戏判断） */
router.post('/platform-b/memberInOutReport', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    const startTime = validateDateString(req.body?.startTime);
    const endTime = validateDateString(req.body?.endTime);
    if (!memberName || !startTime || !endTime) {
      res.status(400).json({ error: '缺少参数: memberName, startTime, endTime（时间必须为 YYYY-MM-DD 格式）' });
      return;
    }
    const result = await platformB.getMemberInOutReport({
      memberName,
      startTime,
      endTime,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询会员进出报表失败', e);
  }
});

router.post('/platform-b/wsDomain', queryRateLimit, async (req, res) => {
  try {
    const result = await platformB.getWsDomain();
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '获取WS域名失败', e);
  }
});

router.get('/platform-b/ws-token', queryRateLimit, async (_req, res) => {
  const result = platformB.getWsToken();
  if (!result.token) {
    res.status(503).json({ success: false, error: 'Token 不可用' });
    return;
  }
  res.json({ success: true, token: result.token, wsUrl: result.wsUrl });
});

router.post('/platform-b/membersByAgency', queryRateLimit, async (req, res) => {
  try {
    const agencyUsername = validateString(req.body?.agencyUsername, 'agencyUsername');
    if (!agencyUsername) { res.status(400).json({ error: '缺少参数: agencyUsername' }); return; }
    const result = await platformB.getMembersByAgency({
      agencyUsername,
      page: Math.max(1, Number(req.body?.page) || 1),
      pageSize: Math.min(Number(req.body?.pageSize) || 200, 500),
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询代理会员失败', e);
  }
});

router.get('/platform-b/health', async (_req, res) => {
  const healthy = await platformB.checkHealth();
  res.json({ success: true, healthy });
});

// ============================================================
// Token 撤销接口（仅管理员可访问，用于 Token 泄露等紧急场景）
// ============================================================

router.post('/revokeToken', setTokenRateLimit, adminAuth, async (req, res) => {
  try {
    const { platform } = req.body || {};
    if (!platform || (platform !== 'platform_a' && platform !== 'platform_b')) {
      res.status(400).json({ success: false, error: '无效的 platform 参数，必须为 platform_a 或 platform_b' });
      return;
    }
    const oldToken = tokenManager.revokeToken(platform);
    // 平台B 撤销时同步清除 SM4 密钥缓存
    if (platform === 'platform_b') {
      clearSm4Cache();
    }
    auditLog('revokeToken', platform, 'success', req, { hadToken: !!oldToken });
    res.json({ success: true, revoked: !!oldToken });
  } catch (e: any) {
    auditLog('revokeToken', req.body?.platform || 'unknown', 'error', req);
    safeError(res, 500, '撤销Token失败', e);
  }
});

// ============================================================
// 全局状态接口（仅管理员可访问，不暴露过期时间）
// ============================================================

router.get('/status', adminAuth, (_req, res) => {
  const raw = tokenManager.getStatus();
  // 脱敏：只暴露 hasToken，不暴露 expiresAt
  const safe: Record<string, { hasToken: boolean }> = {};
  for (const [k, v] of Object.entries(raw)) {
    safe[k] = { hasToken: v.hasToken };
  }
  res.json({ success: true, tokens: safe });
});

// ============================================================
// 全局异步错误兜底
// ============================================================

router.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const full = err.message ? String(err.message) : String(err);
  const sanitized = full
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/token=\S+/gi, 'token=***')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '***[base64]');
  console.error(`[未捕获错误] ${sanitized.slice(0, 200)}`);
  res.status(500).json({ success: false, error: '服务内部错误' });
});

export default router;
