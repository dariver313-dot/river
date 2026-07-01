/**
 * 企业 ID → appServer 候选列表
 *
 * 流程:
 *   1. DNS TXT 查询 <companyCode>.qxdim.top
 *      使用 DoH (DNS over HTTPS): https://223.5.5.5/resolve
 *   2. 解析 TXT 记录，返回候选 appServer URL 列表
 *
 * 浏览器抓包确认:
 *   GET https://223.5.5.5/resolve?_t=<ts>&name=<companyCode>.qxdim.top&type=txt
 *   返回: { Answer: [{ data: "\"https://8.137.120.202:31019\"" }, ...] }
 *
 * @param {string} companyCode - 企业 ID (如 "your_company_code")
 * @param {string} [dohServer='https://223.5.5.5'] - DoH 服务器
 * @returns {Promise<string[]>} 候选 appServer URL 数组
 */
import { insecureFetch, USER_AGENT } from '../utils/http.js';
import { assertNonEmpty, assertString, assertValidUrl } from '../utils/validate.js';
import { logger } from '../utils/logger.js';

export async function resolveCompanyAppServers(companyCode, dohServer = 'https://223.5.5.5') {
  // 输入校验
  assertNonEmpty(companyCode, 'companyCode');
  assertString(companyCode, 'companyCode');
  assertValidUrl(dohServer, 'dohServer');

  const name = `${companyCode}.qxdim.top`;
  const url = `${dohServer}/resolve?_t=${Date.now()}&name=${encodeURIComponent(name)}&type=txt`;

  logger.debug(`[CompanyResolve] DNS TXT 查询: ${name}`);
  logger.debug(`[CompanyResolve] DoH URL: ${url}`);

  const response = await insecureFetch(url, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN',
      'User-Agent': USER_AGENT,
    },
    timeout: 20000,  // ★ DoH 查询超时保护，防止 DNS 服务器不可达时阻塞
  });

  if (!response.ok) {
    throw new Error(`[CompanyResolve] DoH 查询失败: HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.Status !== 0) {
    throw new Error(`[CompanyResolve] DoH 查询错误: Status=${data.Status}`);
  }

  // TXT 记录在 Answer 数组中，data 字段用双引号包裹
  const answers = data.Answer || [];
  const servers = [];
  for (const ans of answers) {
    if (ans.type === 16 && typeof ans.data === 'string') {
      // data 形如 "\"https://8.137.120.202:31019\""，需要剥掉外层引号
      const url = ans.data.replace(/^"(.*)"$/, '$1');
      if (url.startsWith('http://') || url.startsWith('https://')) {
        servers.push(url);
      }
    }
  }

  if (servers.length === 0) {
    throw new Error(`[CompanyResolve] DNS TXT 查询无有效 appServer 记录`);
  }

  logger.debug(`[CompanyResolve] 找到 ${servers.length} 个候选 appServer:`);
  for (const s of servers) {
    logger.debug(`  - ${s}`);
  }

  return servers;
}

export default { resolveCompanyAppServers };
