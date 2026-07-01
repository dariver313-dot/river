/**
 * /query_company_server — 用企业 ID 查询实际服务地址
 *
 * 流程:
 *   1. 从 resolveCompanyAppServers 拿到候选 appServer 列表
 *   2. 依次尝试 POST /query_company_server 直到成功
 *   3. 返回 { appServerHost, imServerHost, proxyServerHost, ... }
 *
 * 浏览器抓包确认:
 *   POST https://8.137.120.202:31019/query_company_server
 *   body: { companyCode: "<your_company_code>" }
 *   返回: {
 *     companyCode, companyName, unifiedSocialCreditCode,
 *     appServerHost: "https://120.24.20.128:10443",  ← 实际登录用的 appServer
 *     imServerHost: "https://qim1.qixunda.tech",     ← /route 用的 serviceHost
 *     proxyServerHost: "120.24.20.228:30019",
 *     pcProxyHost: "120.24.20.128:18433",
 *     proxyServerAccount: "<your_oss_access_key>",
 *     proxyServerPass: "<your_oss_secret_key>",
 *     forceProxy: "1",
 *   }
 *
 * @param {string} companyCode - 企业 ID
 * @param {string[]} candidateServers - 候选 appServer URL 列表
 * @returns {Promise<object>} companyInfo
 */
import { insecureFetch, USER_AGENT } from '../utils/http.js';
import { assertNonEmpty, assertString } from '../utils/validate.js';
import { logger } from '../utils/logger.js';

export async function queryCompanyServer(companyCode, candidateServers) {
  // 输入校验
  assertNonEmpty(companyCode, 'companyCode');
  assertString(companyCode, 'companyCode');
  if (!Array.isArray(candidateServers) || candidateServers.length === 0) {
    throw new Error('[Validate] candidateServers 必须是非空数组');
  }
  for (let i = 0; i < candidateServers.length; i++) {
    const s = candidateServers[i];
    if (typeof s !== 'string' || !s.startsWith('http://') && !s.startsWith('https://')) {
      throw new Error(`[Validate] candidateServers[${i}] 必须是 http/https URL: ${s}`);
    }
  }

  const body = JSON.stringify({ companyCode });
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN',
    'Origin': 'app://.',
    'User-Agent': USER_AGENT,
  };

  let lastErr = null;
  for (const server of candidateServers) {
    const url = `${server}/query_company_server`;
    logger.debug(`[CompanyServer] 尝试: ${url}`);
    try {
      // 使用 insecureFetch 实现 per-request TLS 配置（无需全局 NODE_TLS_REJECT_UNAUTHORIZED=0）
      const response = await insecureFetch(url, {
        method: 'POST',
        headers,
        body,
        insecure: true,  // 候选 appServer 可能使用自签名证书
        timeout: 15000,  // ★ 单候选超时保护，防止慢 server 拖累全部候选
      });

      if (!response.ok) {
        logger.warn(`[CompanyServer] HTTP ${response.status}, 试下一个`);
        lastErr = new Error(`HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      if (data.code !== 0) {
        logger.warn(`[CompanyServer] code=${data.code}, msg=${data.message}, 试下一个`);
        lastErr = new Error(`code=${data.code}: ${data.message}`);
        continue;
      }

      const info = data.result;
      logger.debug(`[CompanyServer] ✅ 查询成功`);
      logger.debug(`  companyCode      : ${info.companyCode}`);
      logger.debug(`  companyName      : ${info.companyName}`);
      logger.debug(`  appServerHost    : ${info.appServerHost}`);
      logger.debug(`  imServerHost     : ${info.imServerHost}`);
      logger.debug(`  proxyServerHost  : ${info.proxyServerHost}`);
      logger.debug(`  pcProxyHost      : ${info.pcProxyHost}`);
      logger.debug(`  forceProxy       : ${info.forceProxy}`);

      return info;
    } catch (e) {
      logger.warn(`[CompanyServer] ${server} 失败: ${e.message}, 试下一个`);
      lastErr = e;
    }
  }

  throw new Error(`[CompanyServer] 所有候选服务器都失败: ${lastErr?.message}`);
}

export default { queryCompanyServer };
