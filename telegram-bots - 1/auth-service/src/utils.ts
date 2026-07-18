/**
 * 共享工具函数（platform-a / platform-b 复用）
 *
 * 提取自两个平台模块中完全相同的实现，避免代码重复。
 */

/** 固定 User-Agent（与浏览器一致，避免被上游 WAF 拦截） */
export const FIXED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/**
 * 获取指定时区偏移的今日日期范围（UTC 毫秒时间戳）
 *
 * @param tzOffsetHours 时区偏移小时数（如东八区 = 8）
 * @returns { start: 当日0点UTC毫秒, end: 当日23:59:59.999 UTC毫秒 }
 */
export function getTimezoneDateRange(tzOffsetHours: number): { start: number; end: number } {
  const now = new Date();
  const offset = tzOffsetHours * 3600000;
  const localNow = new Date(now.getTime() + offset);
  const startOfDay = new Date(localNow);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(localNow);
  endOfDay.setUTCHours(23, 59, 59, 999);
  return { start: startOfDay.getTime() - offset, end: endOfDay.getTime() - offset };
}

/**
 * 将明确的 YYYY-MM-DD 解析为指定固定时区的自然日范围。
 *
 * 平台 B 的查询参数使用 UTC 毫秒时间戳；这里按配置时区计算当天 00:00:00.000
 * 至 23:59:59.999，避免服务器时区影响日报边界。
 */
export function getDateRangeForTimezone(date: string, tzOffsetHours: number): { start: number; end: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError('日期必须为 YYYY-MM-DD');

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw new RangeError('日期无效');
  }

  const safeOffset = Number.isFinite(tzOffsetHours) && tzOffsetHours >= -12 && tzOffsetHours <= 14
    ? tzOffsetHours
    : 8;
  const offset = safeOffset * 3600000;
  const start = Date.UTC(year, month - 1, day) - offset;
  return { start, end: start + 24 * 60 * 60 * 1000 - 1 };
}

/** 将 UTC 毫秒时间戳转换为平台 A 接受的无时区日期字符串。 */
export function timestampToPlatformDateTime(timestamp: number, tzOffsetHours: number): string {
  const safeOffset = Number.isFinite(tzOffsetHours) && tzOffsetHours >= -12 && tzOffsetHours <= 14
    ? tzOffsetHours
    : 8;
  return new Date(timestamp + safeOffset * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 创建用户级并发锁工厂
 *
 * 每个平台模块调用 createUserLock() 获得独立的锁 Map 和 withUserLock 函数，
 * 确保同一用户不会被并发加款。
 *
 * @returns withUserLock 函数（绑定独立的锁 Map）
 */
export function createUserLock() {
  const locks = new Map<string, Promise<any>>();

  async function withUserLock<T>(member: string, fn: () => Promise<T>): Promise<T> {
    const existing = locks.get(member);
    if (existing) {
      try { await existing; } catch { /* 上一个操作失败不影响当前 */ }
    }
    const promise = fn();
    locks.set(member, promise);
    try {
      return await promise;
    } finally {
      if (locks.get(member) === promise) {
        locks.delete(member);
      }
    }
  }

  return withUserLock;
}

/**
 * 并发控制执行
 *
 * 按指定并发度执行异步任务数组，支持 abortOnError 模式（首个错误时中止剩余任务）。
 *
 * @param tasks 异步任务数组
 * @param concurrency 最大并发数
 * @param options.abortOnError 首个错误时中止剩余任务（默认 false）
 */
export async function parallelLimit<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  options?: { abortOnError?: boolean },
): Promise<T[]> {
  const results: T[] = [];
  const running = new Set<Promise<void>>();
  let firstError: Error | null = null;

  for (let i = 0; i < tasks.length; i++) {
    if (options?.abortOnError && firstError) break;

    const task = tasks[i];
    const p = task().then(result => {
      results[i] = result;
      running.delete(p);
    }).catch((err) => {
      if (options?.abortOnError) {
        firstError = err;
      } else {
        console.warn(`[parallelLimit] 任务 ${i} 失败: ${err?.message?.slice(0, 80) || err}`);
      }
      results[i] = undefined as T;
      running.delete(p);
    });
    running.add(p);
    if (running.size >= concurrency) {
      await Promise.race(running);
    }
  }

  await Promise.all(running);
  if (options?.abortOnError && firstError) throw firstError;
  return results;
}
