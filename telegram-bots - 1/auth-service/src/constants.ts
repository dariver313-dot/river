/**
 * 共享常量与工具函数
 */

/** 重试退避基数（毫秒） */
export const RETRY_BACKOFF_BASE = 1000;

/** 最大重试次数 */
export const RETRY_MAX_ATTEMPTS = 3;

/** 计算第 N 次重试的延迟（指数退避：1s, 2s, 4s, 8s...） */
export function retryBackoff(attempt: number, base: number = RETRY_BACKOFF_BASE): number {
  return base * Math.pow(2, attempt);
}

/** 异步 sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
