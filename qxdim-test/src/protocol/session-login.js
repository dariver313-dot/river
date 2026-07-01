/**
 * /session_login/<token> — 用预会话 token 完成会话登录
 *
 * 浏览器抓包确认:
 *   POST https://120.24.20.128:10443/session_login/176a062c-33e1-4ed1-b187-90b5dd9fec09
 *   headers: {
 *     Content-Type: application/x-www-form-urlencoded,
 *     authToken: "0",
 *     Cookie: JSESSIONID=<来自 /pc_session 的 Set-Cookie>,
 *   }
 *   body: (空，Content-Length: 0)
 *   返回: { code: 0, message: "success", result: null }
 *
 * 在 /pc_session 之后、/login_pwd 之前调用
 * 作用: 把 pc_session 返回的 token "激活"为正式会话，让后续 /login_pwd 能用这个 token 作为 authToken
 *
 * 注意: 实测服务器当前不强制校验（跳过也能 /login_pwd 成功），但按客户端行为完整还原
 *
 * @param {object} options
 * @param {string} options.appServerHost - app-server 地址
 * @param {string} options.pcSessionToken - /pc_session 返回的 token
 * @param {string} [options.cookie] - 来自 /pc_session 响应的 Set-Cookie (JSESSIONID=...)
 * @returns {Promise<boolean>} 是否成功
 */
import { insecureFetch, USER_AGENT } from '../utils/http.js';
import { assertValidUrl, assertNonEmpty, assertString } from '../utils/validate.js';
import { logger } from '../utils/logger.js';

export async function sessionLogin({ appServerHost, pcSessionToken, cookie }) {
  // 输入校验
  assertValidUrl(appServerHost, 'appServerHost');
  if (cookie != null) {
    assertString(cookie, 'cookie');
  }

  if (!pcSessionToken) {
    logger.warn('[SessionLogin] pcSessionToken 为空，跳过 /session_login');
    return false;
  }
  assertString(pcSessionToken, 'pcSessionToken');

  const url = `${appServerHost}/session_login/${pcSessionToken}`;
  logger.debug(`[SessionLogin] POST ${url}`);

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN',
    'Origin': 'app://.',
    'authToken': '0',
    'User-Agent': USER_AGENT,
  };
  if (cookie) {
    headers['Cookie'] = cookie;
  }

  try {
    const response = await insecureFetch(url, {
      method: 'POST',
      headers,
      body: '',  // 空 body，Content-Length: 0
      insecure: true,  // appServer 可能使用自签名证书
    });

    if (!response.ok) {
      logger.warn(`[SessionLogin] HTTP ${response.status}: ${await response.text()}`);
      return false;
    }

    const data = await response.json();
    if (data.code !== 0) {
      logger.warn(`[SessionLogin] code=${data.code}: ${data.message}`);
      return false;
    }

    logger.debug('[SessionLogin] ✅ 会话登录成功');
    return true;
  } catch (e) {
    logger.warn(`[SessionLogin] 失败: ${e.message}`);
    return false;
  }
}

/**
 * 从 fetch Response 的 Set-Cookie 头提取 JSESSIONID
 * 用于把 /pc_session 的 cookie 传给 /session_login
 *
 * @param {Response} response
 * @returns {string|null}
 */
export function extractCookie(response) {
  // fetch API 把多个 Set-Cookie 合并到一起，用逗号分隔（但 cookie 内部也可能有逗号，需要小心）
  // 简单做法: 取 set-cookie 头，找 JSESSIONID=
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/JSESSIONID=([^;]+)/);
  return match ? `JSESSIONID=${match[1]}` : null;
}

export default { sessionLogin, extractCookie };
