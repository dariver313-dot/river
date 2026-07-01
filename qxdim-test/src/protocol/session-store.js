/**
 * Session 持久化存储
 *
 * 把 autoLogin 拿到的 token + clientId + 连接参数保存到本地文件，
 * 下次启动直接读文件，跳过 /login_pwd（避免旧 token 失效、避免触发多端互踢）。
 *
 * 文件位置: config/sessions/<mobile_normalized>.json
 *   mobile_normalized: 去掉 + 和空格，如 "+86 13800000000" → "8613800000000"
 *
 * ⚠️ session 文件含敏感信息（token、tokenKey），已加入 .gitignore，不会提交
 */

import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, '..', '..', 'config', 'sessions');

/**
 * 把手机号规范化为文件名安全的字符串
 * "+86 13800000000" → "8613800000000"
 */
export function normalizeMobile(mobile) {
  return String(mobile || '').replace(/[^\d]/g, '');
}

/**
 * 获取 session 文件路径
 * @param {string} mobile - 手机号（含或不含 +86 都可）
 */
export function getSessionPath(mobile) {
  const normalized = normalizeMobile(mobile);
  if (!normalized) throw new Error('[SessionStore] mobile 不能为空');
  return path.join(SESSIONS_DIR, `${normalized}.json`);
}

/**
 * 加载 session
 * @param {string} mobile
 * @returns {Promise<object|null>} session 数据，不存在返回 null
 */
export async function loadSession(mobile) {
  const file = getSessionPath(mobile);
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    logger.warn(`[SessionStore] 读取 ${file} 失败:`, e.message);
    return null;
  }
}

/**
 * 保存 session
 * @param {string} mobile
 * @param {object} data - session 数据
 * @returns {Promise<object>} 保存的完整数据
 */
export async function saveSession(mobile, data) {
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
  const file = getSessionPath(mobile);
  const now = Date.now();
  const fullData = {
    ...data,
    mobile,
    loginAt: data.loginAt || now,
    lastUsedAt: now,
  };
  await fsp.writeFile(file, JSON.stringify(fullData, null, 2), { mode: 0o600 });
  logger.debug(`[SessionStore] 已保存 session → ${path.relative(process.cwd(), file)}`);
  return fullData;
}

/**
 * 清除 session
 * @param {string} mobile
 * @returns {Promise<boolean>} 是否删除了文件
 */
export async function clearSession(mobile) {
  const file = getSessionPath(mobile);
  try {
    await fsp.unlink(file);
    logger.debug(`[SessionStore] 已删除 ${path.relative(process.cwd(), file)}`);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * 列出所有保存的 session
 * @returns {Promise<Array<{mobile, userId, userName, clientId, loginAt, lastUsedAt}>>}
 */
export async function listSessions() {
  let files;
  try {
    files = await fsp.readdir(SESSIONS_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  // ★ 并行读取所有 session 文件，替代串行 for 循环
  const results = await Promise.all(
    jsonFiles.map(async (f) => {
      try {
        const text = await fsp.readFile(path.join(SESSIONS_DIR, f), 'utf8');
        const data = JSON.parse(text);
        return {
          mobile: data.mobile,
          userId: data.userId,
          userName: data.userName,
          clientId: data.clientId,
          companyCode: data.companyCode || null,
          companyName: data.companyInfo?.companyName || null,
          appServer: data.appServer || null,
          loginAt: data.loginAt,
          lastUsedAt: data.lastUsedAt,
        };
      } catch (e) {
        return null;  // 损坏文件跳过
      }
    })
  );
  return results.filter(s => s !== null);
}

/** 默认 TTL: 24 小时 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 判断 session 是否仍然可用
 *
 * 策略:
 *   1. 检查必要字段是否存在
 *   2. 检查是否超过 TTL (默认 24 小时)
 *   3. TTL 基于 lastUsedAt (每次 autoLogin 命中缓存时更新)
 *
 * @param {object} session
 * @param {number} [ttlMs=86400000] - TTL 毫秒，默认 24 小时
 * @returns {boolean}
 */
export function isSessionValid(session, ttlMs = DEFAULT_TTL_MS) {
  if (!session) return false;
  if (!session.encryptedToken || !session.clientId || !session.userId) return false;

  // ★ TTL 检查: 基于 lastUsedAt 或 loginAt
  const refTime = session.lastUsedAt || session.loginAt || 0;
  if (refTime > 0) {
    const age = Date.now() - refTime;
    if (age > ttlMs) {
      const ageHours = Math.round(age / 3600000);
      const ttlHours = Math.round(ttlMs / 3600000);
      logger.debug(`[SessionStore] ⏰ session 已过期 (age=${ageHours}h > ttl=${ttlHours}h)`);
      return false;
    }
  }

  return true;
}

export default {
  normalizeMobile,
  getSessionPath,
  loadSession,
  saveSession,
  clearSession,
  listSessions,
  isSessionValid,
};
