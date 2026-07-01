/**
 * 轻量日志模块 — 支持 LOG_LEVEL 环境变量分级
 *
 * 级别: error(0) < warn(1) < info(2) < debug(3)
 * 默认 info，生产环境只显示 warn/error，调试时设 LOG_LEVEL=debug 看全部。
 *
 * 用法:
 *   import { logger } from '../utils/logger.js';
 *   logger.debug('调试信息');   // LOG_LEVEL=debug 时才输出
 *   logger.info('关键信息');
 *   logger.warn('警告');
 *   logger.error('错误');
 *
 * 环境变量:
 *   LOG_LEVEL=debug|info|warn|error  (默认 info)
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function log(level, args) {
  if (LEVELS[level] > currentLevel) return;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(...args);
}

export const logger = {
  error: (...args) => log('error', args),
  warn: (...args) => log('warn', args),
  info: (...args) => log('info', args),
  debug: (...args) => log('debug', args),
  /** 当前日志级别是否允许 debug 输出（用于热路径避免昂贵参数求值） */
  isDebugEnabled: () => LEVELS.debug <= currentLevel,
  /** 当前日志级别是否允许 info 输出 */
  isInfoEnabled: () => LEVELS.info <= currentLevel,
  /** 当前日志级别是否允许 warn 输出 */
  isWarnEnabled: () => LEVELS.warn <= currentLevel,
};

export default logger;
