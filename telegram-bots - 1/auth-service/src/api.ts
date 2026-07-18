/**
 * API 路由 - Express 路由 + BOT_API_KEY 认证中间件 + 速率限制
 *
 * 按平台命名：
 *   /api/platform-a/*  → 平台A（澳博体系，TG_Aobo + AB_Riskbot）
 *   /api/platform-b/*  → 平台B（娱乐城体系，TG_Robot + TG_Riskbot）
 */

import crypto from 'crypto';
import path from 'path';
import express from 'express';
import { tokenManager } from './token-manager';
import * as platformA from './platforms/platform-a';
import * as platformB from './platforms/platform-b';
import { env } from './crypto-utils';
import { clearSm4Cache } from './sm4-crypto';
import { IdempotencyStore } from './idempotency-store';
import { UpstreamError, RateLimitError, TokenExpiredError, ConfigError } from './errors';
import { getDateRangeForTimezone, timestampToPlatformDateTime } from './utils';

const router = express.Router();

// ============================================================
// 认证中间件 — 三级 Key 体系
// ============================================================
// BOT_API_KEYS         — 只读权限（查询类操作）
// BOT_FINANCE_KEYS     — 金融权限（加款），必须显式配置，不再回退到 BOT_API_KEYS
// BOT_ADMIN_KEYS       — 管理员权限（setToken/status），必须显式配置
// BOT_WS_KEYS          — 平台 B WebSocket Token 权限，仅 TG_Riskbot 使用
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
let _wsKeys: Set<string> | null = null;
let _wsKeysRaw = '';

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
function getWsKeys(): Set<string> {
  const raw = env('BOT_WS_KEYS');
  if (raw !== _wsKeysRaw || !_wsKeys) {
    _wsKeys = buildKeySet('BOT_WS_KEYS');
    _wsKeysRaw = raw;
  }
  return _wsKeys;
}
function getAllValidKeys(): Set<string> {
  return new Set([...getReadKeys(), ...getFinanceKeys(), ...getAdminKeys(), ...getWsKeys()]);
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
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
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
    if (!/^\d{1,3}$/.test(p)) return null;
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

/** 普通查询权限；WS 专用 Key 单独配置时不能读取会员数据。 */
function readAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const key = (req as any)._apiKey || extractApiKey(req);
  const allowed = getReadKeys().has(key) || getFinanceKeys().has(key) || getAdminKeys().has(key);
  if (!allowed) {
    res.status(403).json({ success: false, error: '此操作需要查询权限' });
    return;
  }
  next();
}

/** WebSocket Token 专用权限中间件 */
function wsAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const key = (req as any)._apiKey || extractApiKey(req);
  if (!getWsKeys().has(key)) {
    res.status(403).json({ success: false, error: '此操作需要 WebSocket Token 权限' });
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

function rateLimit(scope: string, maxRequests: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const identity = (req as any)._apiKey || extractApiKey(req) || req.ip || 'unknown';
    const key = `${scope}:${identity}`;
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

function positiveIntEnv(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// 金融操作严格限制：每分钟最多30次
const financeRateLimit = rateLimit('finance', positiveIntEnv('FINANCE_RATE_LIMIT_PER_MIN', 30), 60 * 1000);
// 查询操作宽松限制：每分钟最多120次
const queryLimiter = rateLimit('query', positiveIntEnv('QUERY_RATE_LIMIT_PER_MIN', 120), 60 * 1000);
const wsLimiter = rateLimit('ws', positiveIntEnv('WS_RATE_LIMIT_PER_MIN', 60), 60 * 1000);
const queryRateLimit: express.RequestHandler = (req, res, next) => {
  readAuth(req, res, () => queryLimiter(req, res, next));
};
// Token设置限制：每分钟最多5次
const setTokenRateLimit = rateLimit('admin', positiveIntEnv('SET_TOKEN_RATE_LIMIT_PER_MIN', 5), 60 * 1000);

// ============================================================
// 充值幂等性保护（防重复加款）
// ============================================================

const IDEMPOTENCY_TTL = positiveIntEnv('IDEMPOTENCY_TTL_MINUTES', 1440) * 60 * 1000;
const MAX_IDEMPOTENCY_ENTRIES = positiveIntEnv('IDEMPOTENCY_MAX_ENTRIES', 50000);
const idempotencyPathConfig = process.env.IDEMPOTENCY_STORE_PATH || 'data/idempotency-store.json';
const IDEMPOTENCY_STORE_PATH = path.isAbsolute(idempotencyPathConfig)
  ? idempotencyPathConfig
  : path.resolve(__dirname, '..', idempotencyPathConfig);
const idempotencyStore = new IdempotencyStore(
  IDEMPOTENCY_STORE_PATH,
  IDEMPOTENCY_TTL,
  MAX_IDEMPOTENCY_ENTRIES,
);
console.log(`[幂等] 存储路径: ${IDEMPOTENCY_STORE_PATH}`);
const recoveredPending = idempotencyStore.recoverPending(
  { success: false, error: '服务曾在加款处理中断，操作状态未知，请人工核对后再处理' },
  503,
);
if (recoveredPending > 0) {
  console.warn(`[幂等] 已恢复 ${recoveredPending} 条中断记录，状态标记为未知`);
}

// 每5分钟清理过期的幂等键
setInterval(() => {
  idempotencyStore.cleanup();
}, 5 * 60 * 1000);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function requestDigest(req: express.Request): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ method: req.method, path: req.path, body: stableValue(req.body || {}) }))
    .digest('hex');
}

function completeIdempotency(req: express.Request, result: any, statusCode = 200): void {
  const idKey = (req as any)._idempotencyKey;
  const hash = (req as any)._idempotencyRequestHash;
  if (idKey && hash) idempotencyStore.set(idKey, { result, timestamp: Date.now(), requestHash: hash, statusCode });
}

function clearIdempotency(req: express.Request): void {
  const idKey = (req as any)._idempotencyKey;
  if (!idKey) return;
  try {
    idempotencyStore.delete(idKey);
  } catch (error) {
    console.error(`[幂等] 清理无效请求记录失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const UNKNOWN_FINANCE_RESULT = {
  success: false,
  error: '加款操作状态未知，请人工核对后再处理',
};

function markFinanceResultUnknown(req: express.Request): void {
  try {
    completeIdempotency(req, UNKNOWN_FINANCE_RESULT, 503);
  } catch (error) {
    console.error(`[幂等] 保存未知状态失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
    const storeKey = crypto.createHash('sha256').update(`${apiKey}:${key}`).digest('hex');
    const hash = requestDigest(req);

    const existing = idempotencyStore.get(storeKey);
    if (existing) {
      if (existing.requestHash !== hash) {
        res.status(409).json({ success: false, error: '同一幂等键不能用于不同的金融请求' });
        return;
      }
      if (existing.pending) {
        res.status(409).json({ success: false, error: '相同金融操作正在处理中，请稍后查看结果' });
        return;
      }
      console.log(`[幂等] 命中缓存 ${key.slice(0, 8)}... | 原始时间: ${new Date(existing.timestamp).toISOString()}`);
      res.status(existing.statusCode ?? 200).json(existing.result);
      return;
    }

    // 容量保护
    if (idempotencyStore.size >= MAX_IDEMPOTENCY_ENTRIES) {
      idempotencyStore.cleanup();
      if (idempotencyStore.size >= MAX_IDEMPOTENCY_ENTRIES) {
        res.status(503).json({ success: false, error: '服务繁忙，请稍后重试' });
        return;
      }
    }

    (req as any)._idempotencyKey = storeKey;
    (req as any)._idempotencyRequestHash = hash;
    try {
      // 必须在调用上游前落盘，进程重启后仍能阻止重复加款。
      idempotencyStore.set(storeKey, { timestamp: Date.now(), pending: true, requestHash: hash });
      next();
    } catch (error) {
      console.error(`[幂等] 持久化失败: ${error instanceof Error ? error.message : String(error)}`);
      res.status(503).json({ success: false, error: '幂等保护暂不可用，已拒绝金融操作' });
    }
  };
}

const PAGE_SIZE_100_ROUTES = new Set([
  '/platform-a/withdrawOrders',
  '/platform-a/loginLogs',
  '/platform-b/withdrawOrders',
  '/platform-b/loginLogs',
  '/platform-b/report/rechargeOrders',
  '/platform-b/report/withdrawOrders',
]);

/** Optional pagination fields are validated when present instead of silently defaulting. */
function paginationValidation(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    next();
    return;
  }

  for (const field of ['page', 'current', 'currentPage']) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = Number(body[field]);
    if (!Number.isInteger(value) || value < 1 || value > 1000000) {
      res.status(400).json({ error: `${field} 必须为正整数` });
      return;
    }
  }

  const maxPageSize = PAGE_SIZE_100_ROUTES.has(req.path) ? 100 : 500;
  for (const field of ['size', 'pageSize']) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = Number(body[field]);
    if (!Number.isInteger(value) || value < 1 || value > maxPageSize) {
      res.status(400).json({ error: `${field} 必须为 1-${maxPageSize} 的整数` });
      return;
    }
  }
  next();
}

// 全局认证中间件：所有 /api/* 路由必须通过 API Key 认证
router.use(authMiddleware);
router.use(paginationValidation);

// ============================================================
// 输入校验工具
// ============================================================

const MAX_MEMBERS_LENGTH = 50;
const MAX_STRING_LENGTH = 200;

function validateMembers(members: unknown): string[] | null {
  if (!Array.isArray(members)) return null;
  if (members.length === 0 || members.length > MAX_MEMBERS_LENGTH) return null;
  if (!members.every(m => typeof m === 'string' && m.trim().length > 0 && m.length <= MAX_STRING_LENGTH)) return null;
  return [...new Set((members as string[]).map(member => member.trim()))];
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

function platformDateTime(timestamp: number): string {
  const configuredOffset = Number.parseInt(process.env.TZ_OFFSET || '8', 10);
  return timestampToPlatformDateTime(timestamp, configuredOffset);
}

/** 分页参数：≥1 */
function validatePage(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/** 分页大小参数：1 ~ max */
function validatePageSize(v: unknown, fallback: number, max: number): number {
  const n = Number(v);
  const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  return Math.min(Math.max(1, safe), max);
}

/** 两个平台使用不同的提款状态表，不能共用一个白名单。 */
const PLATFORM_A_WITHDRAW_STATUSES = new Set([0, 1, 2, 3, 4, 5]);
const PLATFORM_B_WITHDRAW_STATUSES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function validateStatusValue(v: unknown, allowed: Set<number>): number | null {
  const n = Number(v);
  if (!Number.isInteger(n) || !allowed.has(n)) return null;
  return n;
}

function validateStatusSelection(value: unknown, allowed: Set<number>): number | number[] | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const values = value.map(item => validateStatusValue(item, allowed));
    if (values.some(item => item === null)) return null;
    return values as number[];
  }
  return validateStatusValue(value, allowed);
}

function validateDateTimeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (!validCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  return text;
}

function validateDateString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  return validCalendarDate(year, month, day) ? text : null;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// 澳门娱乐城日报接口校验与聚合
// ---------------------------------------------------------------------------
// 这组接口仅供 Balance Sheet 日报工具读取成功的充值/提款订单。它们不复用
// 风控按会员查询的接口，避免改变既有机器人行为或把支付敏感字段透传到新工具。
const REPORT_MEMBER_TYPES = [2, 3] as const;
const REPORT_MAX_PAGES_PER_MEMBER_TYPE = 200;
const REPORT_MAX_ORDERS_PER_MEMBER_TYPE = 20_000;

type ReportMemberType = typeof REPORT_MEMBER_TYPES[number];
type ReportPageFetcher = (params: {
  memberType: ReportMemberType;
  page: number;
  pageSize: number;
  startTime: number;
  endTime: number;
}) => Promise<unknown>;

type ParsedReportPage = {
  totalNum: number;
  totalPage: number;
  items: unknown[];
};

function validateReportMemberTypes(value: unknown): readonly ReportMemberType[] | null {
  if (value === undefined) return REPORT_MEMBER_TYPES;
  if (!Array.isArray(value) || value.length !== REPORT_MEMBER_TYPES.length) return null;
  const unique = new Set(value.map(Number));
  return unique.size === REPORT_MEMBER_TYPES.length && REPORT_MEMBER_TYPES.every(type => unique.has(type))
    ? REPORT_MEMBER_TYPES
    : null;
}

function validateReportDateRange(date: unknown): { date: string; startTime: number; endTime: number } | null {
  const validDate = validateDateString(date);
  if (!validDate) return null;
  const tzOffset = Number.parseInt(process.env.TZ_OFFSET || '8', 10);
  const { startTime, endTime } = (() => {
    const range = getDateRangeForTimezone(validDate, tzOffset);
    return { startTime: range.start, endTime: range.end };
  })();
  return { date: validDate, startTime, endTime };
}

function toReportCounter(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > REPORT_MAX_ORDERS_PER_MEMBER_TYPE) {
    throw new UpstreamError(502, `平台 B 日报分页字段异常: ${field}`, null, true);
  }
  return parsed;
}

function parseReportPage(response: unknown, memberType: ReportMemberType, page: number): ParsedReportPage {
  if (!response || typeof response !== 'object') {
    throw new UpstreamError(502, `平台 B 日报返回为空（会员类型 ${memberType}，第 ${page} 页）`, null, true);
  }
  const source = response as Record<string, unknown>;
  if (source.success !== true) {
    throw new UpstreamError(502, `平台 B 日报查询失败（会员类型 ${memberType}，第 ${page} 页）`, source.code as string | number | null ?? null, true);
  }
  if (!Array.isArray(source.items)) {
    throw new UpstreamError(502, `平台 B 日报缺少订单列表（会员类型 ${memberType}，第 ${page} 页）`, null, true);
  }
  return {
    totalNum: toReportCounter(source.totalNum, 'totalNum'),
    totalPage: toReportCounter(source.totalPage ?? 0, 'totalPage'),
    items: source.items,
  };
}

function normaliseAmount(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    throw new UpstreamError(502, '平台 B 日报订单金额异常', null, true);
  }
  return text;
}

/** 精确累加十进制金额，避免 JavaScript 浮点误差污染日报核对数。 */
function sumDecimalAmounts(values: unknown[]): string {
  const numbers = values.map(normaliseAmount);
  const decimals = Math.max(0, ...numbers.map(value => (value.split('.')[1] || '').length));
  const factor = 10n ** BigInt(decimals);
  const total = numbers.reduce((sum, value) => {
    const [integer, fraction = ''] = value.split('.');
    const scaled = BigInt(integer) * factor + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
    return sum + scaled;
  }, 0n);
  const integer = total / factor;
  const fraction = (total % factor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer.toString();
}

async function collectReportOrders(
  memberType: ReportMemberType,
  pageSize: number,
  startTime: number,
  endTime: number,
  fetchPage: ReportPageFetcher,
  sanitize: (item: unknown) => Record<string, unknown>,
): Promise<{ memberType: ReportMemberType; sourceTotal: number; fetched: number; sumAmount: string; items: Record<string, unknown>[] }> {
  const firstPage = parseReportPage(
    await fetchPage({ memberType, page: 1, pageSize, startTime, endTime }),
    memberType,
    1,
  );
  const minimumPages = Math.ceil(firstPage.totalNum / pageSize);
  const pageCount = Math.max(minimumPages, firstPage.totalPage);
  if (pageCount > REPORT_MAX_PAGES_PER_MEMBER_TYPE) {
    throw new UpstreamError(502, `平台 B 日报订单超过单个会员类型 ${REPORT_MAX_PAGES_PER_MEMBER_TYPE} 页上限`, null, false);
  }

  const sourceItems = [...firstPage.items];
  for (let page = 2; page <= pageCount; page++) {
    const result = parseReportPage(
      await fetchPage({ memberType, page, pageSize, startTime, endTime }),
      memberType,
      page,
    );
    // 分页过程中订单集合变化会产生无法可靠核对的半截日报，宁可明确失败后重试。
    if (result.totalNum !== firstPage.totalNum || result.totalPage !== firstPage.totalPage) {
      throw new UpstreamError(502, `平台 B 日报分页数据发生变化（会员类型 ${memberType}）`, null, true);
    }
    sourceItems.push(...result.items);
  }
  if (sourceItems.length !== firstPage.totalNum) {
    throw new UpstreamError(502, `平台 B 日报订单数量不完整（会员类型 ${memberType}）`, null, true);
  }

  const items = sourceItems.map(item => {
    const safe = sanitize(item);
    const orderNo = typeof safe.orderNo === 'string' ? safe.orderNo.trim() : '';
    if (!orderNo) throw new UpstreamError(502, '平台 B 日报订单缺少 orderNo', null, true);
    return { ...safe, orderNo, amount: normaliseAmount(safe.amount), memberType };
  });
  return {
    memberType,
    sourceTotal: firstPage.totalNum,
    fetched: items.length,
    sumAmount: sumDecimalAmounts(items.map(item => item.amount)),
    items,
  };
}

function dedupeReportOrders(items: Record<string, unknown>[]): { items: Record<string, unknown>[]; duplicateCount: number } {
  const unique = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const orderNo = String(item.orderNo);
    if (!unique.has(orderNo)) unique.set(orderNo, item);
  }
  return { items: [...unique.values()], duplicateCount: items.length - unique.size };
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function validateTimestampRange(
  startValue: unknown,
  endValue: unknown,
  options: { required?: boolean; maxSpanMs?: number } = {},
): { start?: number; end?: number; error?: string } {
  const hasStart = hasValue(startValue);
  const hasEnd = hasValue(endValue);
  if (!hasStart && !hasEnd) {
    return options.required ? { error: '开始时间和结束时间均为必填' } : {};
  }
  if (!hasStart || !hasEnd) return { error: '开始时间和结束时间必须同时提供' };
  const start = validateTimestamp(startValue);
  const end = validateTimestamp(endValue);
  if (start === null || end === null) return { error: '时间必须为有效毫秒时间戳' };
  if (start > end) return { error: '开始时间不能晚于结束时间' };
  if (options.maxSpanMs && end - start > options.maxSpanMs) return { error: '查询时间范围超过上游允许的最大值' };
  return { start, end };
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
  if (internalError instanceof UpstreamError) {
    res.status(502).json({
      success: false,
      error: userMessage,
      upstreamCode: internalError.upstreamCode,
      retryable: internalError.retryable,
    });
    return;
  }
  if (internalError instanceof RateLimitError) {
    res.status(429).json({ success: false, error: userMessage, retryable: true });
    return;
  }
  if (internalError instanceof TokenExpiredError || internalError instanceof ConfigError) {
    res.status(503).json({ success: false, error: userMessage, retryable: true });
    return;
  }
  res.status(statusCode).json({ success: false, error: userMessage, retryable: false });
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
      clearIdempotency(req);
      res.status(400).json({ error: '缺少参数: member, remark, amount（amount必须为正数）' });
      return;
    }
    const result = await platformA.recharge({ member, remark, amount });
    auditLog('platform-a.recharge', member, result.ok ? 'success' : 'fail', req, { amount, remark: remark.slice(0, 50) });
    completeIdempotency(req, result);
    res.json(result);
  } catch (e: any) {
    markFinanceResultUnknown(req);
    auditLog('platform-a.recharge', req.body?.member || 'unknown', 'error', req, { amount: req.body?.amount });
    console.error(`[金融] 平台A加款结果无法安全确认: ${e instanceof Error ? e.name : 'UnknownError'}`);
    res.status(503).json(UNKNOWN_FINANCE_RESULT);
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
    if (body.size) params.pageSize = validatePageSize(body.size, 10, 100);
    if (hasValue(body.cashStatusList)) {
      const validated = validateStatusSelection(body.cashStatusList, PLATFORM_A_WITHDRAW_STATUSES);
      if (validated === null) { res.status(400).json({ error: 'cashStatusList 包含无效的澳博提款状态' }); return; }
      params.status = validated;
    }
    const hasStart = hasValue(body.createTimeFrom);
    const hasEnd = hasValue(body.createTimeTo);
    if (hasStart !== hasEnd) { res.status(400).json({ error: 'createTimeFrom/createTimeTo 必须同时提供' }); return; }
    if (hasStart) {
      const start = validateDateTimeString(body.createTimeFrom);
      const end = validateDateTimeString(body.createTimeTo);
      if (!start || !end || Date.parse(`${start.replace(' ', 'T')}+08:00`) > Date.parse(`${end.replace(' ', 'T')}+08:00`)) {
        res.status(400).json({ error: '提款时间必须为有效的 YYYY-MM-DD HH:mm:ss，且开始时间不能晚于结束时间' });
        return;
      }
      params.startTime = start;
      params.endTime = end;
    }
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
    if (hasValue(req.body?.startTime ?? req.body?.startDate) !== hasValue(req.body?.endTime ?? req.body?.endDate)
      || (hasValue(req.body?.startTime ?? req.body?.startDate) && (!startTime || !endTime || startTime > endTime))) {
      res.status(400).json({ error: 'startTime/endTime 必须同时为有效的 YYYY-MM-DD，且开始日期不能晚于结束日期' }); return;
    }
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
    if (hasValue(req.body?.startTime ?? req.body?.startDate) !== hasValue(req.body?.endTime ?? req.body?.endDate)
      || (hasValue(req.body?.startTime ?? req.body?.startDate) && (!startTime || !endTime || startTime > endTime))) {
      res.status(400).json({ error: 'startTime/endTime 必须同时为有效的 YYYY-MM-DD，且开始日期不能晚于结束日期' }); return;
    }
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
    const toDateStr = (v: any): string | null | undefined => {
      if (!hasValue(v)) return undefined;
      const n = Number(v);
      if (Number.isFinite(n) && n > 1e12) {
        const valid = validateTimestamp(n);
        if (valid === null) return null;
        const tz = parseInt(process.env.TZ_OFFSET || '8', 10) * 3600000;
        return new Date(valid + tz).toISOString().slice(0, 10);
      }
      return validateDateString(String(v));
    };
    const startDate = toDateStr(req.body?.startDate ?? req.body?.startTime);
    const endDate = toDateStr(req.body?.endDate ?? req.body?.endTime);
    if ((startDate === undefined) !== (endDate === undefined) || startDate === null || endDate === null || (startDate && endDate && startDate > endDate)) {
      res.status(400).json({ error: '充值报表开始和结束日期必须同时有效，且开始日期不能晚于结束日期' }); return;
    }
    const result = await platformA.getRechReport({
      account,
      startDate,
      endDate,
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
    const beginRaw = req.body?.beginDatetime ?? req.body?.startTime;
    const endRaw = req.body?.endDatetime ?? req.body?.endTime;
    const beginDatetime = hasValue(beginRaw) ? validateDateTimeString(beginRaw) : undefined;
    const endDatetime = hasValue(endRaw) ? validateDateTimeString(endRaw) : undefined;
    if (hasValue(beginRaw) !== hasValue(endRaw) || (hasValue(beginRaw) && (!beginDatetime || !endDatetime || beginDatetime > endDatetime))) {
      res.status(400).json({ error: 'beginDatetime/endDatetime 必须同时为有效的 YYYY-MM-DD HH:mm:ss' }); return;
    }
    const result = await platformA.getRechargeHistory({
      account,
      beginDatetime: beginDatetime ?? undefined,
      endDatetime: endDatetime ?? undefined,
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
    const beginRaw = req.body?.beginDatetime ?? req.body?.startTime;
    const endRaw = req.body?.endDatetime ?? req.body?.endTime;
    const beginDatetime = hasValue(beginRaw) ? validateDateTimeString(beginRaw) : undefined;
    const endDatetime = hasValue(endRaw) ? validateDateTimeString(endRaw) : undefined;
    if (hasValue(beginRaw) !== hasValue(endRaw) || (hasValue(beginRaw) && (!beginDatetime || !endDatetime || beginDatetime > endDatetime))) {
      res.status(400).json({ error: 'beginDatetime/endDatetime 必须同时为有效的 YYYY-MM-DD HH:mm:ss' }); return;
    }
    const result = await platformA.getRechargeDiscountHistory({
      account,
      beginDatetime: beginDatetime ?? undefined,
      endDatetime: endDatetime ?? undefined,
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
    const range = validateTimestampRange(req.body?.startTime ?? req.body?.start, req.body?.endTime ?? req.body?.end);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    const result = await platformA.getLotteryBetReport({
      account,
      gameId,
      startTime: range.start,
      endTime: range.end,
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
    if (body.size) params.size = validatePageSize(body.size, 10, 100);
    if (body.account) params.account = String(body.account).substring(0, MAX_STRING_LENGTH);
    if (body.loginIp) params.loginIp = String(body.loginIp).substring(0, MAX_STRING_LENGTH);
    if (body.deviceClientId) params.deviceClientId = String(body.deviceClientId).substring(0, MAX_STRING_LENGTH);
    if (!params.account && !params.loginIp && !params.deviceClientId) { res.status(400).json({ error: 'account/loginIp/deviceClientId 至少提供一个' }); return; }
    const hasStart = hasValue(body.beginTime);
    const hasEnd = hasValue(body.endTime);
    if (hasStart !== hasEnd) { res.status(400).json({ error: 'beginTime/endTime 必须同时提供' }); return; }
    if (hasStart) {
      const beginTime = validateDateTimeString(body.beginTime);
      const endTime = validateDateTimeString(body.endTime);
      if (!beginTime || !endTime || beginTime > endTime) { res.status(400).json({ error: 'beginTime/endTime 格式或顺序无效' }); return; }
      params.beginTime = beginTime;
      params.endTime = endTime;
    }
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
    const range = validateTimestampRange(req.body?.startTime, req.body?.endTime);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    const result = await platformA.getPaymentOrders({
      account,
      page: req.body?.page ? validatePage(req.body.page) : undefined,
      startTime: range.start !== undefined ? platformDateTime(range.start) : undefined,
      endTime: range.end !== undefined ? platformDateTime(range.end) : undefined,
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
      page: validatePage(req.body?.page),
      pageSize: validatePageSize(req.body?.pageSize, 200, 500),
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
    const range = validateTimestampRange(req.body?.startTime, req.body?.endTime);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    const result = await platformA.getMemberBets({
      account,
      page: validatePage(req.body?.page),
      startTime: range.start,
      endTime: range.end,
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
    const range = validateTimestampRange(req.body?.startTime, req.body?.endTime);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    const result = await platformA.getMemberWithdrawals({
      account,
      page: validatePage(req.body?.page),
      startTime: range.start,
      endTime: range.end,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询提现历史失败', e);
  }
});

router.get('/platform-a/health', queryRateLimit, async (_req, res) => {
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
      clearIdempotency(req);
      res.status(400).json({ error: '缺少参数: member, remark, amount（amount必须为正数）' });
      return;
    }
    const result = await platformB.recharge({ member, remark, amount });
    auditLog('platform-b.recharge', member, result.ok ? 'success' : 'fail', req, { amount, remark: remark.slice(0, 50) });
    completeIdempotency(req, result);
    res.json(result);
  } catch (e: any) {
    markFinanceResultUnknown(req);
    auditLog('platform-b.recharge', req.body?.member || 'unknown', 'error', req, { amount: req.body?.amount });
    console.error(`[金融] 平台B加款结果无法安全确认: ${e instanceof Error ? e.name : 'UnknownError'}`);
    res.status(503).json(UNKNOWN_FINANCE_RESULT);
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
    // 对外参数沿用 currentPage；平台适配层内部使用 page。
    // 若错误保留为 currentPage，平台层会始终回退第 1 页，分页时会重复请求第一页。
    if (body.currentPage) params.page = validatePage(body.currentPage);
    if (body.pageSize) params.pageSize = validatePageSize(body.pageSize, 10, 100);
    if (hasValue(body.status)) {
      const validated = validateStatusValue(body.status, PLATFORM_B_WITHDRAW_STATUSES);
      if (validated === null) { res.status(400).json({ error: 'status 不是有效的澳门娱乐城提款状态' }); return; }
      params.status = validated;
    }
    const range = validateTimestampRange(body.startTime ?? body.start, body.endTime ?? body.end);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    params.startTime = range.start;
    params.endTime = range.end;
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
    const range = validateTimestampRange(req.body?.startTime ?? req.body?.start, req.body?.endTime ?? req.body?.end);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    const result = await platformB.getMemberBets({
      memberName,
      page: req.body?.page ? validatePage(req.body.page) : undefined,
      startTime: range.start,
      endTime: range.end,
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
    const range = validateTimestampRange(req.body?.startTime ?? req.body?.start, req.body?.endTime ?? req.body?.end);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    const result = await platformB.getBetsCount({
      memberName,
      startTime: range.start,
      endTime: range.end,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询投注统计失败', e);
  }
});

router.post('/platform-b/memberWithdrawals', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    if (!memberName) { res.status(400).json({ error: '缺少参数: memberName' }); return; }
    const range = validateTimestampRange(req.body?.startTime ?? req.body?.start, req.body?.endTime ?? req.body?.end);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    const result = await platformB.getMemberWithdrawals({
      memberName,
      page: req.body?.page ? validatePage(req.body.page) : undefined,
      startTime: range.start,
      endTime: range.end,
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
    const range = validateTimestampRange(req.body?.startTime ?? req.body?.start, req.body?.endTime ?? req.body?.end);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    const result = await platformB.getPaymentOrders({
      memberName,
      page: req.body?.page ? validatePage(req.body.page) : undefined,
      startTime: range.start,
      endTime: range.end,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询充值订单失败', e);
  }
});

// --- Balance Sheet 日报读取接口（只读、全量分页、字段脱敏） ---

router.post('/platform-b/report/rechargeOrders', queryRateLimit, async (req, res) => {
  try {
    const range = validateReportDateRange(req.body?.date);
    const memberTypes = validateReportMemberTypes(req.body?.memberTypes);
    if (!range || !memberTypes) {
      res.status(400).json({ error: 'date 必须是有效 YYYY-MM-DD，memberTypes 必须同时为 [2, 3]' });
      return;
    }
    const pageSize = validatePageSize(req.body?.pageSize, 100, 100);
    const sources = await Promise.all(memberTypes.map(memberType => collectReportOrders(
      memberType,
      pageSize,
      range.startTime,
      range.endTime,
      platformB.getReportRechargeOrderPage,
      platformB.sanitizeReportRechargeOrder,
    )));
    const deduped = dedupeReportOrders(sources.flatMap(source => source.items));
    res.json({
      success: true,
      data: {
        date: range.date,
        startTime: range.startTime,
        endTime: range.endTime,
        pageSize,
        sources: sources.map(({ items, ...source }) => source),
        totalNum: deduped.items.length,
        duplicateCount: deduped.duplicateCount,
        sumAmount: sumDecimalAmounts(deduped.items.map(item => item.amount)),
        complete: true,
        items: deduped.items,
      },
    });
  } catch (e: any) {
    safeError(res, 500, '查询日报充值订单失败', e);
  }
});

router.post('/platform-b/report/withdrawOrders', queryRateLimit, async (req, res) => {
  try {
    const range = validateReportDateRange(req.body?.date);
    const memberTypes = validateReportMemberTypes(req.body?.memberTypes);
    if (!range || !memberTypes) {
      res.status(400).json({ error: 'date 必须是有效 YYYY-MM-DD，memberTypes 必须同时为 [2, 3]' });
      return;
    }
    const pageSize = validatePageSize(req.body?.pageSize, 100, 100);
    const sources = await Promise.all(memberTypes.map(memberType => collectReportOrders(
      memberType,
      pageSize,
      range.startTime,
      range.endTime,
      platformB.getReportWithdrawOrderPage,
      platformB.sanitizeReportWithdrawOrder,
    )));
    const deduped = dedupeReportOrders(sources.flatMap(source => source.items));
    res.json({
      success: true,
      data: {
        date: range.date,
        startTime: range.startTime,
        endTime: range.endTime,
        pageSize,
        sources: sources.map(({ items, ...source }) => source),
        totalNum: deduped.items.length,
        duplicateCount: deduped.duplicateCount,
        sumAmount: sumDecimalAmounts(deduped.items.map(item => item.amount)),
        complete: true,
        items: deduped.items,
      },
    });
  } catch (e: any) {
    safeError(res, 500, '查询日报提款订单失败', e);
  }
});

router.post('/platform-b/loginLogs', queryRateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    // 只提取允许的字段
    const params: Record<string, any> = {};
    if (body.currentPage) params.currentPage = validatePage(body.currentPage);
    if (body.pageSize) params.pageSize = validatePageSize(body.pageSize, 10, 100);
    if (body.memberName) params.memberName = String(body.memberName).substring(0, MAX_STRING_LENGTH);
    if (body.loginIp) params.loginIp = String(body.loginIp).substring(0, MAX_STRING_LENGTH);
    if (body.device) params.device = String(body.device).substring(0, MAX_STRING_LENGTH);
    if (!params.memberName && !params.loginIp && !params.device) { res.status(400).json({ error: 'memberName/loginIp/device 至少提供一个' }); return; }
    const range = validateTimestampRange(body.startTime, body.endTime);
    if (range.error) { res.status(400).json({ error: range.error }); return; }
    params.startTime = range.start;
    params.endTime = range.end;
    const result = await platformB.getLoginLogs(params);
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询登录日志失败', e);
  }
});

router.post('/platform-b/rechargeSum', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    const range = validateTimestampRange(req.body?.startTime, req.body?.endTime, { required: true });
    if (!memberName || range.error || range.start === undefined || range.end === undefined) { res.status(400).json({ error: range.error || '缺少参数: memberName' }); return; }
    const result = await platformB.getRechargeSum({ memberName, startTime: range.start, endTime: range.end });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询充值汇总失败', e);
  }
});

router.post('/platform-b/thirdGameOrders', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    if (!memberName) { res.status(400).json({ error: '缺少参数: memberName' }); return; }
    const range = validateTimestampRange(
      req.body?.startTime ?? req.body?.start,
      req.body?.endTime ?? req.body?.end,
      { maxSpanMs: 31 * 24 * 60 * 60 * 1000 },
    );
    if (range.error) { res.status(400).json({ error: `${range.error}（三方订单最多查询31天）` }); return; }
    const result = await platformB.getThirdGameOrders({
      memberName,
      page: req.body?.page ? validatePage(req.body.page) : undefined,
      startTime: range.start,
      endTime: range.end,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询第三方游戏订单失败', e);
  }
});

/** 后台礼金/人工加款账变明细（可能含彩金，由调用方按明细字段过滤） */
router.post('/platform-b/accountChangeList', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    const range = validateTimestampRange(req.body?.startTime, req.body?.endTime, { required: true });
    if (!memberName || range.error || range.start === undefined || range.end === undefined) {
      res.status(400).json({ error: range.error || '缺少参数: memberName' });
      return;
    }
    const result = await platformB.getAccountChangeList({
      memberName,
      startTime: range.start,
      endTime: range.end,
      page: validatePage(req.body?.page),
      pageSize: req.body?.pageSize ? validatePageSize(req.body.pageSize, 200, 500) : undefined,
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询加款明细失败', e);
  }
});

/** 彩票游戏投注报表 */
router.post('/platform-b/cpReport', queryRateLimit, async (req, res) => {
  try {
    const memberName = validateString(req.body?.memberName, 'memberName');
    const startTime = validateDateString(req.body?.startTime);
    const endTime = validateDateString(req.body?.endTime);
    if (!memberName || !startTime || !endTime || startTime > endTime) {
      res.status(400).json({ error: '缺少参数: memberName, startTime, endTime（时间必须为 YYYY-MM-DD 格式）' });
      return;
    }
    const result = await platformB.getCpReport({
      memberName,
      startTime,
      endTime,
      page: validatePage(req.body?.page),
      pageSize: req.body?.pageSize ? validatePageSize(req.body.pageSize, 500, 500) : undefined,
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
    if (!memberName || !startTime || !endTime || startTime > endTime) {
      res.status(400).json({ error: '缺少参数: memberName, startTime, endTime（时间必须为 YYYY-MM-DD 格式）' });
      return;
    }
    const result = await platformB.getThirdReport({
      memberName,
      startTime,
      endTime,
      page: validatePage(req.body?.page),
      pageSize: req.body?.pageSize ? validatePageSize(req.body.pageSize, 500, 500) : undefined,
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
    if (!memberName || !startTime || !endTime || startTime > endTime) {
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

router.get('/platform-b/ws-token', wsAuth, wsLimiter, async (_req, res) => {
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
      page: validatePage(req.body?.page),
      pageSize: validatePageSize(req.body?.pageSize, 200, 500),
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    safeError(res, 500, '查询代理会员失败', e);
  }
});

router.get('/platform-b/health', queryRateLimit, async (_req, res) => {
  const health = await platformB.checkHealth();
  res.json({ success: true, ...health });
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
