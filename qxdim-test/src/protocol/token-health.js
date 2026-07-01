/**
 * Token 健康检查 — 用 /route 作为探针检测 token 是否在 app-server 生效
 *
 * 用途: 自动重登后，新 token 在 app-server 和 im-server 之间同步有延迟。
 *      直接 MQTT 连接可能因为 im-server 还没拿到新 token 而认证失败。
 *      用 /route 探针轮询，status=0 说明 app-server 已接受新 token。
 *
 * 注意: /route 成功 ≠ im-server 已同步，但 /route 失败一定不能试 MQTT。
 *      所以这个探针的语义是 "necessary but not sufficient"。
 */

import { requestRoute } from './route.js';
import { logger } from '../utils/logger.js';

/**
 * 轮询 /route 检测新 token 是否生效
 *
 * @param {object} options
 * @param {string} options.userId
 * @param {string} options.token - 加密后的 token
 * @param {string} options.clientId
 * @param {string} options.proxyServer
 * @param {string} options.serviceHost
 * @param {object} [checkOptions]
 * @param {number} [checkOptions.maxAttempts=5] - 最大尝试次数
 * @param {number} [checkOptions.intervalMs=1000] - 每次间隔毫秒
 * @param {number} [checkOptions.timeoutMs=15000] - 总超时毫秒
 * @param {string} [checkOptions.logPrefix='[TokenHealth]']
 * @returns {Promise<{ready: boolean, attempts: number, durationMs: number, lastError?: string, routeResult?: object}>}
 */
export async function checkTokenReady(options, checkOptions = {}) {
  const {
    maxAttempts = 5,
    intervalMs = 1000,
    timeoutMs = 15000,
    logPrefix = '[TokenHealth]',
  } = checkOptions;

  const start = Date.now();
  let lastError;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // ★ 计算剩余时间，用于单次探针超时保护
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) {
      logger.debug(`${logPrefix} ⏰ 总超时 ${timeoutMs}ms，停止轮询`);
      break;
    }

    attemptsMade = attempt;
    try {
      logger.debug(`${logPrefix} 第 ${attempt}/${maxAttempts} 次探针: POST /route...`);
      // ★ 用 Promise.race 给单次探针加剩余时间超时，防止慢探针耗尽总超时
      //   requestRoute 自身有 20s 超时，但若 timeoutMs < 20s，单次探针会超过总超时
      const routeResult = await Promise.race([
        requestRoute(options),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`探针超时 (剩余 ${remaining}ms)`)),
          remaining
        )),
      ]);
      logger.debug(`${logPrefix} ✅ 第 ${attempt} 次探针成功，token 已在 app-server 生效`);
      return {
        ready: true,
        attempts: attempt,
        durationMs: Date.now() - start,
        routeResult,
      };
    } catch (e) {
      lastError = e.message;
      logger.debug(`${logPrefix} 第 ${attempt} 次探针失败: ${lastError}`);

      // 如果是 status=2 (token无效)，说明 token 还没生效，继续等
      // 如果是其他错误（网络等），也继续重试
      if (attempt < maxAttempts) {
        logger.debug(`${logPrefix} 等 ${intervalMs}ms 后重试...`);
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }
  }

  return {
    ready: false,
    attempts: attemptsMade,
    durationMs: Date.now() - start,
    lastError,
  };
}

export default { checkTokenReady };
