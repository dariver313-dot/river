/**
 * /pc_session — 获取登录前的预会话 token
 *
 * 浏览器抓包确认:
 *   POST https://120.24.20.128:10443/pc_session
 *   headers: {
 *     Content-Type: application/json,
 *     authToken: "0",   ← 首次为 "0"，后续为之前返回的 token
 *     Origin: app://.,
 *   }
 *   body: {
 *     flag: 1,
 *     device_name: "pc",
 *     userId: null,
 *     clientId: "<UUID>",
 *     platform: 5,
 *   }
 *   返回: {
 *     code: 0,
 *     result: {
 *       token: "1ec4322c-9c9e-4c96-9709-8e55c7113f29",  ← 预会话 token
 *       status: 0,
 *       expired: 300000,  ← 5 分钟有效期
 *       platform: 5,
 *       device_name: null,
 *       userId: null,
 *     }
 *   }
 *
 * 后续 /login_pwd 请求头需要带: authToken: <pc_session_token>
 *
 * @param {object} options
 * @param {string} options.appServerHost - 实际 appServer (如 "https://120.24.20.128:10443")
 * @param {string} options.clientId - 客户端 ID
 * @param {number} [options.platform=5] - 平台编号 (5=Web)
 * @param {string} [options.deviceName='pc'] - 设备名
 * @returns {Promise<{token: string, expired: number, status: number}>}
 */
import { insecureFetch, USER_AGENT } from '../utils/http.js';
import { assertNonEmpty, assertString, assertValidUrl, assertInt } from '../utils/validate.js';
import { logger } from '../utils/logger.js';

export async function getPcSession({ appServerHost, clientId, platform = 5, deviceName = 'pc' }) {
  // 输入校验
  assertValidUrl(appServerHost, 'appServerHost');
  assertNonEmpty(clientId, 'clientId');
  assertString(clientId, 'clientId');
  assertInt(platform, 'platform', 0, 255);
  assertString(deviceName, 'deviceName');

  const url = `${appServerHost}/pc_session`;
  const body = JSON.stringify({
    flag: 1,
    device_name: deviceName,
    userId: null,
    clientId,
    platform,
  });

  logger.debug(`[PcSession] POST ${url}`);
  logger.debug(`[PcSession] clientId: ${clientId}`);

  const response = await insecureFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN',
      'Origin': 'app://.',
      'authToken': '0',  // 首次为 "0"
      'User-Agent': USER_AGENT,
    },
    body,
    insecure: true,  // appServer 可能使用自签名证书
  });

  if (!response.ok) {
    throw new Error(`[PcSession] HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`[PcSession] code=${data.code}: ${data.message}`);
  }

  const result = data.result;
  // ★ 预会话 token 是敏感凭据，不输出任何前缀到日志
  logger.debug(`[PcSession] ✅ 预会话 token: <redacted> (有效期 ${result.expired}ms)`);

  // ★ 提取 Set-Cookie 中的 JSESSIONID，供 /session_login 使用
  const setCookie = response.headers.get('set-cookie');
  let cookie = null;
  if (setCookie) {
    const match = setCookie.match(/JSESSIONID=([^;]+)/);
    if (match) {
      cookie = `JSESSIONID=${match[1]}`;
      logger.debug(`[PcSession]   JSESSIONID: <redacted>`);
    }
  }

  return {
    token: result.token,
    expired: result.expired,
    status: result.status,
    cookie,  // ★ 传给 /session_login
  };
}

export default { getPcSession };
