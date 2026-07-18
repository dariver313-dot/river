import pino from 'pino';
import { LRUCache } from 'lru-cache';
import { formatBeijingTime } from './utils';

// 延迟获取日志级别，避免在 dotenv.config() 之前读取环境变量
function getLogLevel(): string {
  return (process.env.LOG_LEVEL || 'info').toLowerCase();
}

const levelNames: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

const levelColors: Record<string, string> = {
  TRACE: '\x1b[90m',
  DEBUG: '\x1b[36m',
  INFO: '\x1b[32m',
  WARN: '\x1b[33m',
  ERROR: '\x1b[31m',
  FATAL: '\x1b[41m\x1b[37m',
};

function shouldUseColor(): boolean {
  return process.env.LOG_COLOR === 'true' && !process.env.NO_COLOR && process.stdout.isTTY === true;
}

function formatLog(o: any): string {
  const lv = levelNames[o.level] || 'INFO';
  const color = shouldUseColor() ? (levelColors[lv] || '') : '';
  const reset = color ? '\x1b[0m' : '';
  const time = formatBeijingTime(o.time);
  const msg = o.msg || '';
  const extras = Object.entries(o)
    .filter(([k]) => !['level', 'time', 'msg', 'pid', 'hostname'].includes(k))
    .map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
  return `${color}[${time}] ${lv}${reset}: ${msg}${extras ? '\n' + extras : ''}\n`;
}

export const logger = pino(
  { level: getLogLevel() },
  {
    write(data: string) {
      try {
        const o = JSON.parse(data);
        process.stdout.write(formatLog(o));
      } catch {
        process.stdout.write(data + '\n');
      }
    },
  },
);

/** 仅输出一次的警告（避免日志刷屏），LRU 限制内存 */
const _warnedOnce = new LRUCache<string, boolean>({ max: 500, ttl: 24 * 60 * 60 * 1000 });
const warnOnce = (msg: string) => {
  if (!_warnedOnce.has(msg)) {
    _warnedOnce.set(msg, true);
    logger.warn(msg);
  }
};

export { warnOnce };
