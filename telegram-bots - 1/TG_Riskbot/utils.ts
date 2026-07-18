import { type WithdrawOrder } from './ws-client';
import type { MemberInfo } from './types';
import { logger } from './logger';

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

/** 规范会员备注，用于通知展示和“无备注”规则，避免空白/符号备注造成噪声。 */
export function normalizeMemberRemark(value: unknown, maxLength = 80): string {
  const compact = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const meaningful = compact.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!meaningful) return '';
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

/** 合并会员与订单备注，去除重复内容后再用于展示和规则判断。 */
export function combineMemberRemarks(values: unknown[], maxLength = 80): string {
  const seen = new Set<string>();
  const remarks: string[] = [];
  for (const value of values) {
    const remark = normalizeMemberRemark(value, maxLength);
    const key = remark.toLocaleLowerCase();
    if (remark && !seen.has(key)) {
      seen.add(key);
      remarks.push(remark);
    }
  }
  return normalizeMemberRemark(remarks.join('；'), maxLength);
}

export function extractProxyCode(order?: WithdrawOrder | null, member?: MemberInfo | null): string {
  return order?.proxyCode || order?.proxy_code || order?.agencyMemberName ||
    member?.agencyMemberName || member?.proxyCode || member?.proxy_code ||
    member?.agentCode || member?.agent_code || member?.proxyName || member?.parentName || '';
}
