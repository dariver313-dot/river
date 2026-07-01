import crypto from 'crypto';
import { type WithdrawOrder } from './ws-client';
import type { MemberInfo } from './types';
import { logger, warnOnce } from './logger';

export function parseTimeStr(t: string | number | undefined | null): number {
  if (!t) return 0;
  if (typeof t === 'number') {
    if (t < 100000000000) return t * 1000;
    return t;
  }

  const str = String(t).trim();

  // 纯数字字符串 → 当作时间戳（秒级自动转毫秒）
  if (/^\d+$/.test(str)) {
    const n = parseInt(str, 10);
    if (n < 100000000000) return n * 1000;
    return n;
  }

  // "YYYY-MM-DD HH:MM:SS" / "YYYY-MM-DDTHH:MM:SS" / "YYYY/M/D H:M:S" 等
  // 平台 API 返回的全部是北京时间，统一用 Date.UTC + 减去 TZ_OFFSET 换算
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s](\d{1,2}):(\d{2}):(\d{2})/.exec(str);
  if (m) {
    const tzOffsetMs = (parseInt(process.env.TZ_OFFSET || '8', 10) || 8) * 3600000;
    const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return utc - tzOffsetMs;
  }

  const ms = new Date(t).getTime();
  if (isNaN(ms)) {
    logger.warn({ input: String(t).substring(0, 50) }, '[工具] parseTimeStr 收到非法日期字符串，返回0');
    return 0;
  }
  return ms;
}

/** 将 Date / 时间戳 / 日期字符串格式化为北京时间字符串 */
export function formatBeijingTime(date?: Date | number | string | null, fmt: 'datetime' | 'date' | 'time' = 'datetime'): string {
  const tzOffsetMs = (parseInt(process.env.TZ_OFFSET || '8', 10) || 8) * 3600000;
  let ts: number;
  if (date === undefined || date === null) {
    ts = Date.now();
  } else if (typeof date === 'string') {
    ts = parseTimeStr(date);
  } else if (typeof date === 'number') {
    ts = date;
  } else {
    ts = date.getTime();
  }
  if (!ts || isNaN(ts)) return '无效日期';
  const local = new Date(ts + tzOffsetMs);
  const y = local.getUTCFullYear();
  const mo = (local.getUTCMonth() + 1).toString();
  const d = local.getUTCDate().toString();
  const h = local.getUTCHours().toString().padStart(2, '0');
  const mi = local.getUTCMinutes().toString().padStart(2, '0');
  const s = local.getUTCSeconds().toString().padStart(2, '0');
  if (fmt === 'date') return `${y}/${mo}/${d}`;
  if (fmt === 'time') return `${h}:${mi}:${s}`;
  return `${y}/${mo}/${d} ${h}:${mi}:${s}`;
}

export function absFloat(v: string | number | undefined | null): number {
  return Math.abs(parseFloat(String(v)) || 0);
}

export function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

export function fmtNum(n: number | string | undefined | null): string {
  if (n === null || n === undefined) return '0';
  const num = typeof n === 'number' ? n : parseFloat(String(n));
  if (isNaN(num)) return '0';
  return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function extractProxyCode(order?: WithdrawOrder | null, member?: MemberInfo | null): string {
  return order?.proxyCode || order?.proxy_code || order?.agencyMemberName ||
    member?.agencyMemberName || member?.proxyCode || member?.proxy_code ||
    member?.agentCode || member?.agent_code || member?.proxyName || member?.parentName || '';
}

/* ===== 敏感数据加密/解密（用于 Token 等安全存储） ===== */

const ENC_ALGO = 'aes-256-gcm';
const ENC_PREFIX = 'enc:';

function getEncryptionKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY || '';
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

/**
 * 加密明文。无 ENCRYPTION_KEY 时降级为明文存储（向后兼容）。
 * 加密格式: enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) {
    warnOnce('[加密] 未配置 ENCRYPTION_KEY，敏感数据将以明文存储，建议在 .env 中设置 64 位 hex 密钥');
    return plaintext;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${ENC_PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * 解密密文。自动识别加密格式，非加密格式直接返回（向后兼容旧数据）。
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext.startsWith(ENC_PREFIX)) return ciphertext;
  const key = getEncryptionKey();
  if (!key) {
    warnOnce('[加密] 数据已加密但未配置 ENCRYPTION_KEY，无法解密');
    return ciphertext;
  }
  try {
    const parts = ciphertext.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) return ciphertext;
    const [ivHex, tagHex, data] = parts;
    const decipher = crypto.createDecipheriv(ENC_ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[加密] 解密失败，返回原始值');
    return ciphertext;
  }
}

/** 生成新的 ENCRYPTION_KEY（运行一次，将输出写入 .env） */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}


