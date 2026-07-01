/**
 * 平台B - 娱乐城体系（X-AUTH-TOKEN + SM4）
 *
 * 认证方式：X-AUTH-TOKEN + Cookie
 * 响应加密：SM4-ECB（密钥从 Token MD5 派生）
 * 加款需要：谷歌验证码
 *
 * 使用此平台的机器人：
 *   - TG_Robot（加款机器人）
 *   - TG_Riskbot（风控机器人）
 *
 * 对外接口：
 *   POST /api/platform-b/checkUser
 *   POST /api/platform-b/recharge
 *   POST /api/platform-b/checkOldUsers
 *   POST /api/platform-b/setToken
 *   POST /api/platform-b/withdrawOrders
 *   POST /api/platform-b/memberInfo
 *   POST /api/platform-b/memberBets
 *   POST /api/platform-b/betsCount
 *   POST /api/platform-b/memberWithdrawals
 *   POST /api/platform-b/paymentOrders
 *   POST /api/platform-b/loginLogs
 *   POST /api/platform-b/rechargeSum
 *   POST /api/platform-b/thirdGameOrders
 *   POST /api/platform-b/wsDomain
 *   GET  /api/platform-b/ws-token
 *   GET  /api/platform-b/health
 */

import axios, { type AxiosRequestConfig } from 'axios';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { tokenManager, type TokenKey } from '../token-manager';
import { generateTOTP } from '../totp';
import { decryptResponse } from '../sm4-crypto';
import { env } from '../crypto-utils';
import { FIXED_DEVICE_ID } from '../auto-login-b';
import { TokenExpiredError, ConfigError, RateLimitError } from '../errors';
import { FIXED_UA, getTimezoneDateRange, createUserLock, parallelLimit } from '../utils';

const TOKEN_KEY: TokenKey = 'platform_b'; // 所有 Platform B bot 共享同一 Token

// ============================================================
// 加款相关常量（来自平台B后台定义）
// ============================================================
const TRANS_TYPE_MANUAL_RECHARGE = 174;    // 平台B后台「人工加款」交易类型编码（updateBalance 接口）
const TRANS_TYPE_ARTIFICIAL_RECHARGE = 254; // 平台B后台「人工充值汇总」交易类型编码（accountChange/sum/amount 接口）

// ============================================================
// 用户级并发锁：防止同一用户被并发加款
// ============================================================
const withUserLock = createUserLock();

// 两个机器人使用不同的后台地址
const BASE_URL_ROBOT = () => env('PLATFORM_B_ROBOT_BASE_URL').replace(/\/+$/, '');
const BASE_URL_RISK = () => env('PLATFORM_B_RISK_BASE_URL').replace(/\/+$/, '');

function getTotpSecret(): string {
  return env('PLATFORM_B_TOTP_SECRET');
}

function getTzOffset(): number {
  return parseInt(env('TZ_OFFSET') || '8', 10);
}

// ============================================================
// HTTP Agent 复用
// ============================================================

let apiHttpAgent: http.Agent;
let apiHttpsAgent: https.Agent;
let agentsInitialized = false;

function ensureAgents() {
  if (agentsInitialized) return;
  const ct = 5000;
  apiHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 60, keepAliveMsecs: 30000, timeout: ct, family: 4 });
  apiHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 60, keepAliveMsecs: 30000, timeout: ct, family: 4 });
  agentsInitialized = true;
}

function generateHeaders(token: string, baseUrl?: string): Record<string, string> {
  const timestamp = Date.now().toString();
  const origin = baseUrl || BASE_URL_ROBOT();
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cookie': `sidebarStatus=0; X-AUTH-TOKEN=${token}`,
    'Lang': 'zh-CN',
    'Origin': origin,
    'Referer': `${origin}/`,
    'Request-Encrypt': 'true',
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'X-Auth-Token': token,
    'X-Bg-Req-Id': crypto.randomBytes(8).toString('base64url').slice(0, 12),
    'X-Tenant-Code': env('PLATFORM_B_TENANT_CODE') || 'CSZH',
    'X-Device-Id': FIXED_DEVICE_ID,
    'X-Timestamp': timestamp,
    'User-Agent': FIXED_UA,
  };
}

// ============================================================
// 通用请求（带 SM4 解密 + Token 过期检测 + 429 重试 + POST安全）
// ============================================================

const MAX_RETRIES = 3;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function request<T = unknown>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  baseUrlOverride?: string,
  tokenKey: TokenKey = TOKEN_KEY,
): Promise<T> {
  const baseUrl = baseUrlOverride || BASE_URL_ROBOT();
  if (!baseUrl) throw new ConfigError('PLATFORM_B_BASE_URL 未配置');

  ensureAgents();

  const isSafeMethod = SAFE_METHODS.has(method.toUpperCase());

  // 外层循环：最多尝试 2 轮 token 刷新
  for (let tokenRound = 0; tokenRound < 2; tokenRound++) {
    let token = tokenManager.getToken(tokenKey);
    if (!token) {
      token = await tokenManager.invalidateToken(tokenKey);
    }
    if (!token) throw new TokenExpiredError('Token 未设置或已过期，请先设置 Token');

    const url = `${baseUrl}${path}`;
    const headers = generateHeaders(token, baseUrl);

    // 内层重试：仅对安全方法启用，POST/PUT 等立即失败
    const maxAttempts = isSafeMethod ? MAX_RETRIES : 0;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      const options: AxiosRequestConfig = {
        method, url, headers,
        httpAgent: apiHttpAgent,
        httpsAgent: apiHttpsAgent,
        timeout: parseInt(process.env.API_TIMEOUT || '10000', 10),
        validateStatus: (s) => (s >= 200 && s < 300) || s === 401 || s === 429,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
      };

      if (body) options.data = body;

      try {
        const res = await axios(options);

        // HTTP 401 → 刷新 token 后无感重试
        if (res.status === 401) {
          const newToken = await tokenManager.invalidateToken(tokenKey);
          if (newToken) break;
          throw new TokenExpiredError('Token 已过期且刷新失败');
        }

        // HTTP 429 → 限流等待后重试（安全方法）/ 立即抛出（非安全方法）
        if (res.status === 429) {
          const retryAfter = res.headers?.['retry-after'];
          const waitSec = retryAfter ? parseInt(retryAfter, 10) : 5;
          const waitMs = (isNaN(waitSec) ? 5 : Math.min(waitSec, 30)) * 1000;
          if (isSafeMethod && attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, waitMs));
            continue;
          }
          throw new RateLimitError(waitMs);
        }

        let data = res.data;

        // 返回 HTML = Token 过期
        if (typeof data === 'string' && data.trim().startsWith('<')) {
          const newToken = await tokenManager.invalidateToken(tokenKey);
          if (newToken) break;
          throw new TokenExpiredError('Token 已过期（返回 HTML）且刷新失败');
        }

        // 业务层 401 / 未登录 → 刷新 token 后无感重试
        if (data && (data.code === '401' || data.code === 401 || (data.success === false && data.msg?.includes('未登录')))) {
          const newToken = await tokenManager.invalidateToken(tokenKey);
          if (newToken) break;
          throw new TokenExpiredError('Token 已过期（业务层 401）且刷新失败');
        }

        // SM4 解密（带降级）— 使用发起请求时的同一 token 解密
        if (typeof data === 'string') {
          try {
            data = decryptResponse(data, token);
          } catch {
            try {
              data = JSON.parse(data);
              // 脱敏路径，避免日志泄露查询参数中的用户名等敏感信息
              const safePath = path.replace(/([?&])(memberName|account|nickname|memberId)=[^&]*/gi, '$1$2=***');
              const preview = typeof data === 'object' ? JSON.stringify(data).slice(0, 120) : String(data).slice(0, 120);
              console.warn(`[SM4降级] 解密失败但JSON.parse成功 | path=${safePath} | preview=${preview}`);
            } catch {
              throw new Error('响应解密和解析均失败');
            }
          }
        }

        return data as T;

      } catch (err: any) {
        // 类型化错误：Token/配置/限流 — 按类型处理
        if (err instanceof TokenExpiredError) break;
        if (err instanceof ConfigError) throw err;
        if (err instanceof RateLimitError) {
          if (isSafeMethod && attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, err.retryAfterMs));
            continue;
          }
          throw err;
        }

        // 非安全方法（POST/PUT）：不重试，避免重复执行
        if (!isSafeMethod) throw err;

        // 安全方法：指数退避重试
        if (attempt < maxAttempts) {
          const delay = 1000 * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw err;
        }
      }
    }
  }

  throw new TokenExpiredError('Token 刷新后请求仍然失败');
}

// ============================================================
// 加款机器人接口（TG_Robot 使用）
// ============================================================

/** 查询用户是否存在（并发限制为3，Token错误快速失败） */
export async function checkUser(members: string[]): Promise<Record<string, { exists: boolean; nickname?: string; id?: string | number }>> {
  // 预检：确保 Token 有效，避免批量查询中大量任务同时触发刷新
  let token = tokenManager.getToken(TOKEN_KEY);
  if (!token) {
    token = await tokenManager.invalidateToken(TOKEN_KEY);
    if (!token) throw new TokenExpiredError('Token 未设置，无法查询用户');
  }

  const result: Record<string, { exists: boolean; nickname?: string; id?: string | number }> = {};

  const tasks = members.map((account) => async () => {
    try {
      const data = await request<any>('GET', `/livepro/memberAccount/list?currentPage=1&pageSize=50&memberName=${encodeURIComponent(account)}`);
      const items = Array.isArray(data?.items) ? data.items : [];
      const match = items.find((item: any) => item?.memberName === account);
      if (match) {
        result[account] = { exists: true, nickname: match.memberName || account, id: match.accountId || match.memberId };
      } else {
        result[account] = { exists: false };
      }
    } catch (e: any) {
      // 类型化 Token 错误 → 向上传播触发刷新；其他错误 → 标记为不存在
      if (e instanceof TokenExpiredError) throw e;
      result[account] = { exists: false };
    }
  });

  await parallelLimit(tasks, 3, { abortOnError: true });
  return result;
}

/** 加款（带用户级并发锁，防止同一用户被并发加款） */
export async function recharge(params: {
  member: string;
  remark: string;
  amount: number;
}): Promise<{ ok: boolean; err?: string; data?: any }> {
  const { member, remark, amount } = params;
  if (!member || !remark || !amount || amount <= 0) {
    return { ok: false, err: '参数无效' };
  }

  return withUserLock(member.trim(), async () => {
    // 1. 查询用户信息获取 memberId 和 nickname
    let userData: any;
    try {
      userData = await request<any>('GET', `/livepro/memberAccount/list?currentPage=1&pageSize=50&memberName=${encodeURIComponent(member.trim())}`);
    } catch (e: any) {
      return { ok: false, err: `查询用户失败: ${e.message}` };
    }

    const items = Array.isArray(userData?.items) ? userData.items : [];
    const match = items.find((item: any) => item?.memberName === member.trim());
    if (!match) return { ok: false, err: '用户不存在' };

    const nickname = match.memberName || member.trim();
    const accountId = match.accountId || match.memberId;
    if (!accountId) return { ok: false, err: '用户ID缺失，无法加款' };

    // 2. 生成谷歌验证码（检查 TOTP 窗口剩余时间）
    const totpSecret = getTotpSecret();
    if (!totpSecret) return { ok: false, err: 'TOTP_SECRET 未配置' };
    const WINDOW_SEC = 30;
    const MIN_REMAINING_SEC = 5;
    const remainingInWindow = WINDOW_SEC - (Math.floor(Date.now() / 1000) % WINDOW_SEC);
    if (remainingInWindow < MIN_REMAINING_SEC && remainingInWindow >= 0) {
      // 窗口剩余不足5秒：等待到下一个30秒窗口
      await new Promise(resolve => setTimeout(resolve, (remainingInWindow + 1) * 1000));
    } else if (remainingInWindow < 0) {
      // 时钟偏差检测（服务器时间与NTP不一致）
      console.warn(`[TOTP] 时钟偏差: remainingInWindow=${remainingInWindow}s，可能影响TOTP验证`);
    }
    const googleCode = generateTOTP(totpSecret);

    // 3. 调用加款接口（与原始 TG_Robot 格式一致：批量加款）
    try {
      const requestData = {
        totalNum: 1,
        transDetail: '礼金',
        transType: TRANS_TYPE_MANUAL_RECHARGE,
        effecRolling: 1,
        rollingRate: '1',
        remark: '礼金',
        operatorRemark: remark,
        googleCode: googleCode,
        list: [{ memberName: nickname, amount: amount }],
      };

      const result = await request<any>('POST', '/livepro/memberAccount/updateBalance', requestData);

      // 解析加款结果
      if (result) {
        const succNum = result.succNum !== undefined ? result.succNum : result.data?.succNum;
        const transResult = result.transResult !== undefined ? result.transResult : result.data?.transResult;
        if ((Number(succNum) > 0 && Number(transResult) === 0) || result.transResultDesc === '成功') {
          return { ok: true, data: result };
        }
        if (result.success === true || result.success === 'true' || result.code === '200') {
          return { ok: true, data: result };
        }
      }

      const apiMsg = result?.msg || result?.transResultDesc || result?.message || result?.error || '';
      return { ok: false, err: apiMsg ? String(apiMsg) : '加款接口返回失败', data: result };
    } catch (e: any) {
      return { ok: false, err: `加款失败: ${e.message}` };
    }
  });
}

/** 按姓名查询用户（与原始 TG_Robot 格式一致：key=2 搜索模式） */
export async function checkOldUsers(realname: string): Promise<{ ok: boolean; err?: string; data?: any }> {
  if (!realname?.trim()) return { ok: false, err: '姓名为空' };

  try {
    const data = await request<any>('POST', '/livepro/userCenter/getAllUsersByCondition', {
      currentPage: 1,
      key: 2,
      pageSize: 50,
      value: realname.trim(),
    });
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, err: `查询失败: ${e.message}` };
  }
}

/** 设置 Token */
export function setToken(token: string): void {
  tokenManager.setToken(TOKEN_KEY, token);
}

// ============================================================
// 风控机器人接口（TG_Riskbot 使用）
// ============================================================

/** 获取提现订单 */
export async function getWithdrawOrders(params: {
  status?: number;
  page?: number;
  pageSize?: number;
  startTime?: number;
  endTime?: number;
}): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const status = params.status ?? 1;
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 50;
  const startTime = params.startTime ?? start;
  const endTime = params.endTime ?? end;

  return request('GET', `/livepro/withdraw/list?currentPage=${page}&pageSize=${pageSize}&status=${status}&timeType=0&startTime=${startTime}&endTime=${endTime}`, undefined, BASE_URL_RISK(), TOKEN_KEY);
}

/** 查询会员信息（两步：先搜 memberName → memberId, 再调 getUserDetails 拿完整数据。
 *  getUserDetails 失败时降级返回搜索结果。 */
export async function getMemberInfo(params: { memberName: string; page?: number; pageSize?: number }): Promise<any> {
  // 1. 通过 memberName 搜索获取 memberId
  const searchResult: any = await request('POST', '/livepro/userCenter/getAllUsersByCondition', {
    currentPage: params.page ?? 1,
    memberName: params.memberName,
    pageSize: params.pageSize ?? 50,
  }, BASE_URL_RISK(), TOKEN_KEY);

  const items = Array.isArray(searchResult?.items) ? searchResult.items : [];
  const match = items.find((item: any) => item?.memberName === params.memberName);
  if (!match?.memberId) {
    return searchResult;
  }

  // 2. 用 memberId 获取完整详情（含 sumRecharge/sumWithdraw/sumRechargeTimes 等财务数据）
  try {
    const details: any = await request('GET', `/livepro/userCenter/getUserDetails?memberId=${encodeURIComponent(match.memberId)}`, undefined, BASE_URL_RISK(), TOKEN_KEY);
    const detailData = details?.data || {};
    return {
      ...searchResult,
      items: items.map((item: any) => {
        if (item.memberName === params.memberName || item.memberId === detailData.memberId || item.memberId === match.memberId) {
          return { ...item, ...detailData };
        }
        return item;
      }),
    };
  } catch (e: any) {
    // 降级：getUserDetails 失败时返回不含财务数据的搜索结果
    if (e instanceof TokenExpiredError) throw e;
    console.warn(`[getMemberInfo] getUserDetails 失败，返回降级数据 | ${e.message?.slice(0, 80)}`);
    return searchResult;
  }
}

/** 查询投注记录 */
export async function getMemberBets(params: { memberName: string; page?: number; startTime?: number; endTime?: number }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  return request('POST', '/livepro/bets/list', {
    currentPage: params.page ?? 1,
    pageSize: 200,
    startTime: params.startTime ?? start,
    endTime: params.endTime ?? end,
    timeType: 0,
    memberName: params.memberName,
    issue: '',
    memberType: '',
    paymentType: '',
    seriesTag: '',
  }, BASE_URL_RISK(), TOKEN_KEY);
}

/** 投注统计 */
export async function getBetsCount(params: { memberName: string; startTime?: number; endTime?: number }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  return request('POST', '/livepro/bets/count', {
    memberName: params.memberName,
    timeType: 0,
    startTime: params.startTime ?? start,
    endTime: params.endTime ?? end,
    issue: '',
    memberType: '',
    paymentType: '',
    seriesTag: '',
  }, BASE_URL_RISK(), TOKEN_KEY);
}

/** 提现历史 */
export async function getMemberWithdrawals(params: { memberName: string; page?: number; startTime?: number; endTime?: number }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const page = params.page ?? 1;
  return request('GET', `/livepro/withdraw/list?currentPage=${page}&pageSize=200&timeType=0&startTime=${params.startTime ?? start}&endTime=${params.endTime ?? end}&memberName=${encodeURIComponent(params.memberName)}`, undefined, BASE_URL_RISK(), TOKEN_KEY);
}

/** 充值订单 */
export async function getPaymentOrders(params: { memberName: string; page?: number; startTime?: number; endTime?: number }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const page = params.page ?? 1;
  return request('GET', `/livepro/paymentOrder/list?currentPage=${page}&pageSize=200&startTime=${params.startTime ?? start}&endTime=${params.endTime ?? end}&orderType=0&timeType=0&status=0000&memberName=${encodeURIComponent(params.memberName)}`, undefined, BASE_URL_RISK(), TOKEN_KEY);
}

/** 登录日志 */
export async function getLoginLogs(params: { memberName?: string; loginIp?: string; device?: string; page?: number }): Promise<any> {
  const now = Date.now();
  const start = now - 30 * 24 * 3600 * 1000;
  const reqBody: Record<string, unknown> = {
    currentPage: params.page ?? 1,
    pageSize: 50,
    startTime: start,
    endTime: now,
  };
  if (params.memberName) reqBody.memberName = params.memberName;
  if (params.loginIp) reqBody.loginIp = params.loginIp;
  if (params.device) reqBody.device = params.device;

  return request('POST', '/livepro/authorization/getAppLog', reqBody, BASE_URL_RISK(), TOKEN_KEY);
}

/** 充值汇总 - 人工充值 (transType 254) */
export async function getRechargeSum(params: { memberName: string; startTime: number; endTime: number }): Promise<any> {
  return request('POST', '/livepro/accountChange/sum/amount', {
    startTime: params.startTime,
    endTime: params.endTime,
    memberName: params.memberName,
    transTypeList: [TRANS_TYPE_ARTIFICIAL_RECHARGE],
  }, BASE_URL_RISK(), TOKEN_KEY);
}

/** 第三方游戏订单 */
export async function getThirdGameOrders(params: { memberName: string; page?: number; startTime?: number; endTime?: number }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  return request('POST', '/livepro/thirdgame/queryOrder', {
    currentPage: params.page ?? 1,
    pageSize: 200,
    memberName: params.memberName,
    timeType: 0,
    startTime: params.startTime ?? start,
    endTime: params.endTime ?? end,
    type: 18,
  }, BASE_URL_RISK(), TOKEN_KEY);
}

/** 人工加款明细列表（用于风控计数，按 operatorRemark 过滤） */
export async function getAccountChangeList(params: {
  memberName: string; startTime: number; endTime: number; page?: number; pageSize?: number;
}): Promise<any> {
  return request('POST', '/livepro/accountChange/List', {
    currentPage: params.page ?? 1,
    pageSize: params.pageSize ?? 200,
    startTime: params.startTime,
    endTime: params.endTime,
    memberName: params.memberName,
    transTypeList: [TRANS_TYPE_MANUAL_RECHARGE], // 174 = 人工加款
    memberTypeList: [],
  }, BASE_URL_RISK(), TOKEN_KEY);
}

/** 彩票游戏投注报表（startTime/endTime 为日期字符串 "YYYY-MM-DD"） */
export async function getCpReport(params: {
  memberName: string; startTime: string; endTime: string; page?: number; pageSize?: number;
}): Promise<any> {
  return request('POST', '/livepro/tenantMemberCpReport', {
    currentPage: params.page ?? 1,
    pageSize: params.pageSize ?? 500,
    startTime: params.startTime,
    endTime: params.endTime,
    memberName: params.memberName,
  }, BASE_URL_RISK(), TOKEN_KEY);
}

/** 三方游戏投注报表（startTime/endTime 为日期字符串 "YYYY-MM-DD"） */
export async function getThirdReport(params: {
  memberName: string; startTime: string; endTime: string; page?: number; pageSize?: number;
}): Promise<any> {
  return request('POST', '/livepro/tenantMemberThirdReport', {
    currentPage: params.page ?? 1,
    pageSize: params.pageSize ?? 500,
    startTime: params.startTime,
    endTime: params.endTime,
    memberName: params.memberName,
  }, BASE_URL_RISK(), TOKEN_KEY);
}

/** 会员进出报表统计（近7天各游戏类型投注金额汇总，用于风控主投游戏判断）
 *  startTime/endTime 为日期字符串 "YYYY-MM-DD" */
export async function getMemberInOutReport(params: {
  memberName: string; startTime: string; endTime: string;
}): Promise<any> {
  return request('POST', '/livepro/tenantMemberInOutReportCount', {
    startTime: params.startTime,
    endTime: params.endTime,
    memberType: '',
    memberName: params.memberName,
    profitSort: null,
  }, BASE_URL_RISK(), TOKEN_KEY);
}

/** 获取 WS 域名 */
export async function getWsDomain(): Promise<any> {
  return request('GET', '/livepro/platform/domain/list?currentPage=1&pageSize=100&status=1&domainType=2', undefined, BASE_URL_RISK(), TOKEN_KEY);
}

/** 获取 WS 连接 Token（给风控机器人直连后台用） */
export function getWsToken(): { token: string | null; wsUrl: string } {
  const token = tokenManager.getToken(TOKEN_KEY);
  const wsUrl = env('PLATFORM_B_WS_URL');
  return { token, wsUrl };
}

/** 健康检查 */
export async function checkHealth(): Promise<boolean> {
  try {
    const token = tokenManager.getToken(TOKEN_KEY);
    if (!token) return false;
    await request('POST', '/livepro/userCenter/getAllUsersByCondition', {
      currentPage: 1,
      memberName: '__health_check__',
      pageSize: 1,
    }, BASE_URL_RISK(), TOKEN_KEY);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 风控专用（TG_Riskbot）
// ============================================================

/** 按代理账号查下级会员列表 */
export async function getMembersByAgency(params: { agencyUsername: string; page?: number; pageSize?: number }): Promise<any> {
  return request('POST', '/livepro/userCenter/getAllUsersByCondition', {
    currentPage: params.page ?? 1,
    pageSize: params.pageSize ?? 200,
    memberName: params.agencyUsername,
  }, BASE_URL_RISK(), TOKEN_KEY);
}
