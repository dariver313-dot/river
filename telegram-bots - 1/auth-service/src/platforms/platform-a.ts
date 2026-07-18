/**
 * 平台A - 澳博体系（Bearer JWT）
 *
 * 认证方式：Bearer JWT + Cookie 双通道
 * 加款需要：谷歌验证码
 * 自动登录：两步认证（login → verify2fa）
 *
 * 使用此平台的机器人：
 *   - TG_Aobo（加款机器人）
 *   - AB_Riskbot（风控机器人）
 *
 * 对外接口：
 *   POST /api/platform-a/checkUser
 *   POST /api/platform-a/recharge
 *   POST /api/platform-a/checkOldUsers
 *   POST /api/platform-a/setToken
 *   POST /api/platform-a/withdrawOrders
 *   POST /api/platform-a/memberInfo
 *   POST /api/platform-a/betsCount
 *   POST /api/platform-a/rechReport
 *   POST /api/platform-a/rechargeHistory
 *   POST /api/platform-a/loginLogs
 *   POST /api/platform-a/paymentOrders
 *   GET  /api/platform-a/health
 */

import axios, { type AxiosRequestConfig } from 'axios';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { tokenManager, type TokenKey } from '../token-manager';
import { generateTOTP } from '../totp';
import { encryptPassword } from '../rsa-encrypt';
import { env } from '../crypto-utils';
import { TokenExpiredError, ConfigError, RateLimitError, UpstreamError } from '../errors';
import { FIXED_UA, getTimezoneDateRange, createUserLock, parallelLimit } from '../utils';

const TOKEN_KEY: TokenKey = 'platform_a';

// ============================================================
// 加款相关常量（来自平台A后台定义）
// ============================================================
const DISCOUNT_TYPE_NORMAL = '888';   // 平台A后台「标准折扣类型」编码

// ============================================================
// 用户级并发锁：防止同一用户被并发加款
// ============================================================
const withUserLock = createUserLock();

// 存储 logtoken（登录响应中的 accessLogToken），后续请求 Cookie 中需要携带
let _logtoken: string = '';

export function setLogtoken(val: string) { _logtoken = val; }

function getBaseUrl(): string {
  return env('PLATFORM_A_BASE_URL').replace(/\/+$/, '');
}

function getTotpSecret(): string {
  return env('PLATFORM_A_TOTP_SECRET');
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

function generateHeaders(token: string, logtoken?: string): Record<string, string> {
  const baseUrl = getBaseUrl();
  const cookies = [
    'language=zh-CN',
    'GooglekeY=1',
    logtoken ? `logtoken=${logtoken}` : '',
    'enable2fa=true',
    `token=${token}`,
    'sidebarStatus=0',
  ].filter(Boolean).join('; ');
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Authorization': `Bearer ${token}`,
    'Cookie': cookies,
    'Origin': baseUrl,
    'Referer': `${baseUrl}/`,
    'Langue': 'zh-CN',
    'X-Time-Zone': 'Asia/Shanghai',
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'User-Agent': FIXED_UA,
  };
}

// ============================================================
// 通用请求（带重试 + 429处理 + POST安全）
// ============================================================

const MAX_RETRIES = 3;
const BACKOFF_BASE = 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface MultipartFormBody {
  contentType: string;
  data: string;
}

type MultipartFieldValue = string | number | boolean | null | undefined;

/** 平台 A 会员管理页面真实使用 multipart/form-data，而不是将筛选条件放进 URL。 */
export function createMultipartForm(fields: Record<string, MultipartFieldValue>): MultipartFormBody {
  const boundary = `----AuthService${crypto.randomBytes(12).toString('hex')}`;
  const lines: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const safeName = name.replace(/[\r\n"]/g, '');
    const safeValue = String(value).replace(/[\r\n]/g, '');
    lines.push(`--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"\r\n\r\n${safeValue}\r\n`);
  }
  lines.push(`--${boundary}--\r\n`);
  return { contentType: `multipart/form-data; boundary=${boundary}`, data: lines.join('') };
}

function isMultipartFormBody(value: unknown): value is MultipartFormBody {
  return !!value
    && typeof value === 'object'
    && typeof (value as MultipartFormBody).contentType === 'string'
    && typeof (value as MultipartFormBody).data === 'string';
}

function transportError(error: unknown): Error {
  if (!axios.isAxiosError(error)) return error instanceof Error ? error : new Error(String(error));
  const status = error.response?.status;
  return new UpstreamError(
    502,
    status ? `平台 A HTTP ${status}` : '平台 A 网络请求失败',
    status ?? error.code ?? null,
    status === undefined || status >= 500,
  );
}

async function request<T = unknown>(
  method: string,
  path: string,
  body?: Record<string, unknown> | URLSearchParams | MultipartFormBody,
): Promise<T> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) throw new ConfigError('PLATFORM_A_BASE_URL 未配置');

  ensureAgents();

  const isSafeMethod = SAFE_METHODS.has(method.toUpperCase());

  // 外层循环：最多尝试 2 轮 token 刷新（仅安全方法重试整个外层）
  for (let tokenRound = 0; tokenRound < 2; tokenRound++) {
    let token = tokenManager.getToken(TOKEN_KEY);
    if (!token) {
      token = await tokenManager.invalidateToken(TOKEN_KEY);
    }
    if (!token) throw new TokenExpiredError('Token 未设置或已过期，请先设置 Token');

    const url = `${baseUrl}${path}`;
    const headers = generateHeaders(token, _logtoken);

    // 内层重试：仅对安全方法启用，POST/PUT 等立即失败
    const maxAttempts = isSafeMethod ? MAX_RETRIES : 0;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      try {
        const options: AxiosRequestConfig = {
          method, url, headers,
          httpAgent: apiHttpAgent,
          httpsAgent: apiHttpsAgent,
          timeout: parseInt(process.env.API_TIMEOUT || '10000', 10),
          validateStatus: (s) => (s >= 200 && s < 300) || s === 401 || s === 429,
          maxContentLength: 2 * 1024 * 1024,
          maxBodyLength: 2 * 1024 * 1024,
        };

        if (body) {
          if (isMultipartFormBody(body)) {
            options.data = body.data;
            options.headers = { ...headers, 'Content-Type': body.contentType };
          } else if (body instanceof URLSearchParams) {
            options.data = body.toString();
            options.headers = { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' };
          } else {
            options.data = body;
          }
        }

        const res = await axios(options);
        const data = res.data;

        // HTTP 401 / 业务层 401 → 刷新 token 后重试（无感）
        if (res.status === 401 || (data && (data.code === 401 || data.code === '401' || data.status === 401))) {
          const newToken = await tokenManager.invalidateToken(TOKEN_KEY);
          if (newToken) break; // 跳出内层，用新 token 重试
          throw new TokenExpiredError('Token 已过期且刷新失败');
        }

        // HTTP 429 → 限流，等待后重试（安全方法）/ 立即抛出（非安全方法）
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

        // 平台 A 的业务失败也可能使用 HTTP 200，必须检查响应信封。
        if (data && typeof data === 'object') {
          const upstreamCode = data.code ?? data.status ?? null;
          const hasEnvelope = 'succeed' in data || 'code' in data || 'message' in data;
          const codeOk = upstreamCode === null || upstreamCode === 0 || upstreamCode === '0';
          const succeedOk = !('succeed' in data) || data.succeed === true;
          if (hasEnvelope && (!succeedOk || !codeOk)) {
            throw new UpstreamError(
              502,
              String(data.message || data.msg || '平台 A 返回业务失败'),
              upstreamCode,
              Boolean(data.retry),
            );
          }
        }

        return data as T;

      } catch (err: any) {
        // 类型化错误：Token/配置/限流 — 按类型处理
        if (err instanceof TokenExpiredError) break;
        if (err instanceof ConfigError || err instanceof UpstreamError) throw err;
        if (err instanceof RateLimitError) {
          if (isSafeMethod && attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, err.retryAfterMs));
            continue;
          }
          throw err;
        }

        // 非安全方法（POST/PUT）：不重试，避免重复执行
        if (!isSafeMethod) throw transportError(err);

        // 安全方法：仅网络错误或 5xx 才重试；4xx 参数/权限错误立即返回。
        const retryableTransport = !axios.isAxiosError(err) || !err.response || err.response.status >= 500;
        if (retryableTransport && attempt < maxAttempts) {
          const delay = BACKOFF_BASE * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw transportError(err);
        }
      }
    }
    // 内层 break 出来 → 已尝试刷新 token → 继续外层下一轮
  }

  throw new TokenExpiredError('Token 刷新后请求仍然失败');
}

// ============================================================
// 加款机器人接口（TG_Aobo 使用）
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
      const data = await request<any>('GET', `/api/admin/member/getAccountDetail?account=${encodeURIComponent(account)}&popularizeId=&currency=CNY`);
      if (data?.data == null) {
        result[account] = { exists: false };
      } else {
        result[account] = {
          exists: true,
          nickname: data.data.nickname || account,
          id: data.data.id,
        };
      }
    } catch (e: any) {
      // 查询失败不能伪装成“会员不存在”，交给调用方进入人工处理。
      throw e;
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
    // 1. 查询用户信息
    let userData: any;
    try {
      userData = await request<any>('GET', `/api/admin/member/getAccountDetail?account=${encodeURIComponent(member.trim())}&popularizeId=&currency=CNY`);
    } catch (e: any) {
      return { ok: false, err: `查询用户失败: ${e.message}` };
    }

    if (userData?.data == null) return { ok: false, err: '用户不存在' };

    const memberId = userData.data.id;
    const nickname = userData.data.nickname || member.trim();
    if (!memberId) return { ok: false, err: '用户ID缺失，无法加款' };

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

    // 3. 调用加款接口（参数放在 URL query string 中，与原始 TG_Aobo 一致）
    try {
      const formData = new URLSearchParams({
        nickname,
        memberId: String(memberId),
        remarks: remark,
        discountDmlMultiple: '1',
        discount: '0',
        discountAmount: String(amount),
        dmlFlag: '1',
        discountType: DISCOUNT_TYPE_NORMAL,
        discountDml: String(amount),
        skipAuditing: 'true',
        amount: '0',
        normalDm: '0',
        pointFlag: '1',
        currency: 'CNY',
        gs: googleCode,
      });

      const result = await request<any>('POST', `/api/admin/finance/rechargeOrder/manual?${formData.toString()}`);
      return { ok: true, data: result };
    } catch (e: any) {
      return { ok: false, err: `加款失败: ${e.message}` };
    }
  });
}

/** 按姓名查询用户 */
export async function checkOldUsers(realname: string): Promise<{ ok: boolean; err?: string; data?: any }> {
  if (!realname?.trim()) return { ok: false, err: '姓名为空' };

  try {
    const formData = new URLSearchParams({
      flag: '0', baseSearchType: '8', baseSearchFuzzy: '0',
      otherSearchType: '0', accountSearchType: '2',
      current: '1', size: '50', account: realname.trim(),
    });
    const data = await request<any>('POST', `/api/admin/member/list?${formData.toString()}`);
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
// 风控机器人接口（AB_Riskbot 使用）
// ============================================================

/** 获取提现订单 */
export async function getWithdrawOrders(params: {
  status?: number | number[];
  page?: number;
  pageSize?: number;
  startTime?: string;
  endTime?: string;
}): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const tzMs = getTzOffset() * 3600000;
  const startStr = params.startTime ?? new Date(start + tzMs).toISOString().replace('T', ' ').slice(0, 19);
  const endStr = params.endTime ?? new Date(end + tzMs).toISOString().replace('T', ' ').slice(0, 19);

  const searchParams = new URLSearchParams({
    order: 'DESC', flag: '0',
    current: String(params.page ?? 1), size: String(params.pageSize ?? 50),
    cashStatusList: String(params.status ?? 1),
    createTimeFrom: startStr, createTimeTo: endStr,
  });
  return request('POST', `/api/admin/finance/memberWithdraw/page?${searchParams.toString()}`);
}

const RECHARGE_ORDER_FIELDS = [
  'id', 'brandId', 'account', 'nickname', 'balance', 'superAccount', 'orderNo',
  'payTypeName', 'tpInterfaceName', 'tpMerchantName', 'tpPayChannelName',
  'amount', 'payAmount', 'discountAmount', 'discountType', 'totalAmount',
  'discountDml', 'rechargePerson', 'rechargeTime', 'status', 'remarks',
  'auditorAccount', 'auditTime', 'auditRemarks', 'ipAddress', 'createTime',
  'memberType', 'mode', 'payType', 'memberId', 'memberLevel', 'vipLevel',
  'pointFlag', 'currency', 'currencyRate', 'currencyCount', 'rechargeTimes',
  'popularizeId', 'parentPopularizeId', 'userRemark',
] as const;

const MEMBER_LIST_FIELDS = [
  'id', 'brandId', 'popularizeId', 'account', 'nickname', 'vipLevel', 'remark',
  'parentId', 'parentPopularizeId', 'parentName', 'userType', 'superPath', 'userLevel', 'lowerNum',
  'withdrawFlag', 'currency', 'balance', 'freeze', 'gameFreeze',
  'totalRechAmount', 'totalRechTimes', 'totalWithdrawAmount', 'totalWithdrawTimes',
  'registerIp', 'registerIpCount', 'createTime', 'invitationCode', 'registerHost', 'registerSource',
  'status', 'online', 'lastLoginIp', 'lastLoginIpCount', 'lastLoginTime', 'lastLoginDeviceClientId',
  'agentLevel', 'registerBrowser', 'registerDeviceClientId', 'registerDeviceCount', 'registerOs',
  'growth', 'goldCoin', 'salaryFlag', 'balanceDifference', 'winAmount', 'waterAmount', 'betAmount',
  'validAmount', 'iconId', 'adSource', 'adInfo', 'registerMode',
  'validAmountToday', 'validAmountHistory', 'winAmountToday', 'winAmountHistory',
  'waterAmountToday', 'waterAmountHistory', 'bonusAmountToday', 'bonusAmountHistory',
  'exceptionRechargeTotalAmount', 'exceptionWithdrawTotalAmount',
  'commissionAmountToday', 'commissionAmountHistory', 'inviter', 'interestAmount',
  'firstRechTime', 'firstRechAmount', 'firstWithdrawTime', 'firstWithdrawAmount',
  'lastRechTime', 'lastRechAmount', 'thirdSource', 'appVersion',
] as const;

function pickFields(source: any, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!source || typeof source !== 'object') return result;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = source[field];
  }
  return result;
}

function sanitizePlatformARecords(response: any, fields: readonly string[]): any {
  const records = response?.data?.records;
  if (!Array.isArray(records)) return response;
  return {
    ...response,
    data: { ...response.data, records: records.map((item: any) => pickFields(item, fields)) },
  };
}

export function sanitizePlatformAMemberRecords(response: any): any {
  return sanitizePlatformARecords(response, MEMBER_LIST_FIELDS);
}

/** 查询会员信息 */
export async function getMemberInfo(params: { account: string }): Promise<any> {
  const formData = createMultipartForm({
    flag: '0', baseSearchType: '8', baseSearchFuzzy: '0',
    otherSearchType: '0', accountSearchType: '2',
    current: '1', size: '10', account: params.account,
  });
  const response = await request('POST', '/api/admin/member/list', formData);
  return sanitizePlatformAMemberRecords(response);
}

/** 会员所有游戏有效投注分析（支持自定义日期范围，用于风控近7天占比计算）
 *  调用 /api/admin/member/dayReport/findMemberbetAnalysis，返回 7 个 *ValidAmount 字段：
 *  lotteryValidAmount / sportValidAmount / realValidAmount / hunterValidAmount /
 *  chessValidAmount / egameValidAmount / esportValidAmount
 *  默认日期范围：最近7天（含今天），按北京时间计算 */
export async function getMemberBetAnalysis(params: { account: string; startTime?: string; endTime?: string }): Promise<any> {
  const { end } = getTimezoneDateRange(getTzOffset());
  const tzMs = getTzOffset() * 3600000;
  // end 是北京今天24点的 UTC 时间戳；end + tzMs 转为北京时间日期对象后取 YYYY-MM-DD
  // startTime = endTime 往前推 6 天，共 7 天（今天-6, ..., 今天-1, 今天）
  const endTime = params.endTime ?? new Date(end + tzMs).toISOString().slice(0, 10);
  const startTime = params.startTime ?? new Date(end + tzMs - 6 * 86400000).toISOString().slice(0, 10);

  const searchParams = new URLSearchParams({
    account: params.account, isTrue: '0', startTime, endTime,
  });
  return request('GET', `/api/admin/member/dayReport/findMemberbetAnalysis?${searchParams.toString()}`);
}

/** 充值汇总 */
export async function getRechReport(params: { account: string; startDate?: string; endDate?: string }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const tzMs = getTzOffset() * 3600000;
  const startDate = params.startDate ?? new Date(start + tzMs).toISOString().slice(0, 10);
  const endDate = params.endDate ?? new Date(end + tzMs).toISOString().slice(0, 10);

  const searchParams = new URLSearchParams({
    flag: '0', currency: 'CNY', startTime: startDate, endTime: endDate, account: params.account,
  });
  return request('GET', `/api/admin/report/data/findRechReport?${searchParams.toString()}`);
}

/** 充值历史（会员所有充值数据，modeList=2） */
export async function getRechargeHistory(params: { account: string; beginDatetime?: string; endDatetime?: string }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const tzMs = getTzOffset() * 3600000;
  const beginDatetime = params.beginDatetime ?? new Date(start + tzMs).toISOString().replace('T', ' ').slice(0, 19);
  const endDatetime = params.endDatetime ?? new Date(end + tzMs).toISOString().replace('T', ' ').slice(0, 19);

  const searchParams = new URLSearchParams({
    orderBy: 'auditTime', order: 'DESC', adSource: '0', rechargeTimes: '-1',
    flag: '0', superPathLike: 'false', current: '1', size: '500',
    status: '3', currency: 'CNY', userAccount: params.account, account: params.account,
    beginDatetime, endDatetime, modeList: '2', pointFlag: '1', memberType: 'M',
  });
  const response = await request('POST', `/api/admin/finance/rechargeOrderHistory/page?${searchParams.toString()}`);
  return sanitizePlatformARecords(response, RECHARGE_ORDER_FIELDS);
}

/** 彩金加款明细（会员彩金加款详细数据，modeList=2,3 + discountTypes=888）
 *  与 getRechargeHistory 独立：后者查所有充值，本函数专查彩金加款 */
export async function getRechargeDiscountHistory(params: { account: string; beginDatetime?: string; endDatetime?: string }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const tzMs = getTzOffset() * 3600000;
  const beginDatetime = params.beginDatetime ?? new Date(start + tzMs).toISOString().replace('T', ' ').slice(0, 19);
  const endDatetime = params.endDatetime ?? new Date(end + tzMs).toISOString().replace('T', ' ').slice(0, 19);

  const searchParams = new URLSearchParams({
    orderBy: 'auditTime', order: 'DESC', adSource: '0', rechargeTimes: '-1',
    flag: '0', superPathLike: 'false', current: '1', size: '500',
    modeList: '2,3', discountTypes: DISCOUNT_TYPE_NORMAL,
    account: params.account,
    beginDatetime, endDatetime,
  });
  const response = await request('POST', `/api/admin/finance/rechargeOrderHistory/page?${searchParams.toString()}`);
  return sanitizePlatformARecords(response, RECHARGE_ORDER_FIELDS);
}

/** 官彩游戏有效投注查询（按 gameId 过滤，用于风控占比计算）
 *  gameId 为逗号分隔的游戏ID字符串，如 "79,149,179" */
export async function getLotteryBetReport(params: { account: string; gameId: string; startTime?: number; endTime?: number }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const sp = new URLSearchParams({
    account: params.account, status: '1', currency: 'CNY',
    betStartTime: String(params.startTime ?? start),
    betEndTime: String(params.endTime ?? end),
    gameId: params.gameId,
    summary: 'true', current: '1', size: '500',
  });
  return request('GET', `/api/admin/lot/bet/queryPage?${sp.toString()}`);
}

/** 登录日志 */
export async function getLoginLogs(params: { account?: string; loginIp?: string; deviceClientId?: string; type?: string; current?: number; size?: number; beginTime?: string; endTime?: string }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const tzMs = getTzOffset() * 3600000;
  const startStr = params.beginTime ?? new Date(start + tzMs).toISOString().replace('T', ' ').slice(0, 19);
  const endStr = params.endTime ?? new Date(end + tzMs).toISOString().replace('T', ' ').slice(0, 19);

  const searchParams: Record<string, string> = {
    type: params.type ?? '2',
    current: String(params.current ?? 1),
    size: String(params.size ?? 50),
    beginTime: startStr,
    endTime: endStr,
  };
  if (params.account) searchParams.account = params.account;
  if (params.loginIp) searchParams.loginIp = params.loginIp;
  if (params.deviceClientId) searchParams.deviceClientId = params.deviceClientId;

  const sp = new URLSearchParams(searchParams);
  return request('GET', `/api/admin/report/ip/page?${sp.toString()}`);
}

/** 充值订单 */
export async function getPaymentOrders(params: { account: string; startTime?: string; endTime?: string; page?: number }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const tzMs = getTzOffset() * 3600000;
  const startStr = params.startTime ?? new Date(start + tzMs).toISOString().replace('T', ' ').slice(0, 19);
  const endStr = params.endTime ?? new Date(end + tzMs).toISOString().replace('T', ' ').slice(0, 19);

  const searchParams = new URLSearchParams({
    statusList: '3', order: 'DESC', memberType: 'M',
    fullNameFuzzy: 'false', flag: '0',
    current: String(params.page ?? 1), size: '200',
    account: params.account,
    createTimeFrom: startStr, createTimeTo: endStr,
  });
  const response = await request('POST', `/api/admin/finance/rechargeOrder/page?${searchParams.toString()}`);
  return sanitizePlatformARecords(response, RECHARGE_ORDER_FIELDS);
}

/** 健康检查 */
export async function checkHealth(): Promise<boolean> {
  try {
    const token = tokenManager.getToken(TOKEN_KEY);
    if (!token) return false;
    const searchParams = new URLSearchParams({ account: '__health__', popularizeId: '', currency: 'CNY' });
    const result = await request<any>('GET', `/api/admin/member/getAccountDetail?${searchParams.toString()}`);
    return !!(result && (result.code === 0 || result.succeed === true || result.code === '0'));
  } catch {
    return false;
  }
}

// ============================================================
// 风控专用（AB_Riskbot）
// ============================================================

/** 按代理账号查下级会员列表 */
export async function getMembersByAgency(params: { agencyUsername: string; page?: number; pageSize?: number }): Promise<any> {
  const formData = createMultipartForm({
    flag: '0', baseSearchType: '8', baseSearchFuzzy: '0',
    otherSearchType: '0', accountSearchType: '2',
    current: String(params.page ?? 1), size: String(params.pageSize ?? 200),
    account: '', superAccount: params.agencyUsername,
  });
  const response = await request('POST', '/api/admin/member/list', formData);
  return sanitizePlatformAMemberRecords(response);
}

/** 投注记录查询（分页） */
export async function getMemberBets(params: { account: string; page?: number; startTime?: number; endTime?: number }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const sp = new URLSearchParams({
    account: params.account, status: '1', currency: 'CNY',
    betStartTime: String(params.startTime ?? start), betEndTime: String(params.endTime ?? end),
    summary: 'true', current: String(params.page ?? 1), size: '500',
  });
  return request('GET', `/api/admin/lot/bet/queryPage?${sp.toString()}`);
}

/** 提现历史 */
export async function getMemberWithdrawals(params: { account: string; page?: number; startTime?: number; endTime?: number }): Promise<any> {
  const { start, end } = getTimezoneDateRange(getTzOffset());
  const tzMs = getTzOffset() * 3600000;
  const startStr = new Date((params.startTime ?? start) + tzMs).toISOString().replace('T', ' ').slice(0, 19);
  const endStr = new Date((params.endTime ?? end) + tzMs).toISOString().replace('T', ' ').slice(0, 19);
  const sp = new URLSearchParams({
    order: 'DESC', flag: '0',
    current: String(params.page ?? 1), size: '200',
    account: params.account,
    createTimeFrom: startStr, createTimeTo: endStr,
  });
  return request('POST', `/api/admin/finance/memberWithdraw/page?${sp.toString()}`);
}
