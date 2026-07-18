/**
 * Auth Service 客户端（平台A 风控）— 替代直接调用下游平台 API
 *
 * 使用方式：
 *   1. .env 中设置 AUTH_SERVICE_URL 和 AUTH_API_KEY
 *   2. 原有 ApiClient 中的方法改为调用此模块
 */

import axios, { type AxiosRequestConfig } from 'axios';
import http from 'http';
import https from 'https';

// 延迟读取环境变量，避免在 dotenv.config() 之前加载模块导致值为空
function getAuthServiceUrl(): string {
  return (process.env.AUTH_SERVICE_URL || 'http://localhost:3100/api/platform-a').replace(/\/+$/, '');
}
function getAuthApiKey(): string {
  return process.env.AUTH_API_KEY || '';
}
function getAuthTimeout(): number {
  return parseInt(process.env.API_TIMEOUT || '10000', 10);
}

const apiHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 10, timeout: 5000 });
const apiHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 5000 });

export interface AuthRequestOptions {
  signal?: AbortSignal;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    if (active >= max) return;
    const next = queue.shift();
    if (next) next();
  };

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>(resolve => queue.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      active--;
      runNext();
    }
  };
}

type RequestLimiter = <T>(task: () => Promise<T>) => Promise<T>;

let limitGeneralRequest: RequestLimiter | null = null;
let limitLoginLogRequest: RequestLimiter | null = null;

function getRequestLimiter(path: string): RequestLimiter {
  if (!limitGeneralRequest) {
    limitGeneralRequest = createLimiter(parsePositiveInt(process.env.AUTH_CLIENT_CONCURRENCY, 8));
  }
  if (!limitLoginLogRequest) {
    limitLoginLogRequest = createLimiter(parsePositiveInt(process.env.AUTH_CLIENT_LOGIN_LOG_CONCURRENCY, 2));
  }
  return path === '/loginLogs' ? limitLoginLogRequest : limitGeneralRequest;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getAuthApiKey()}`,
    'Content-Type': 'application/json',
  };
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function payloadErrorMessage(payload: unknown): string | null {
  if (!isObject(payload)) return null;
  const success = payload.success;
  const code = payload.code;
  const retry = payload.retry;
  const msg = payload.error || payload.msg || payload.message || payload.transResultDesc;

  if (success === false) {
    return String(msg || `接口返回失败${code ? ` code=${code}` : ''}`);
  }

  if ((code === 401 || code === '401' || code === 403 || code === '403') && success !== true) {
    return String(msg || `接口授权失败 code=${code}`);
  }

  if (retry === true && success === false) {
    return String(msg || '接口要求重试');
  }

  return null;
}

async function post<T = unknown>(path: string, body: Record<string, unknown>, retries = 1, requestOptions: AuthRequestOptions = {}): Promise<T> {
  const options: AxiosRequestConfig = {
    method: 'POST',
    url: `${getAuthServiceUrl()}${path}`,
    headers: authHeaders(),
    httpAgent: apiHttpAgent,
    httpsAgent: apiHttpsAgent,
    timeout: getAuthTimeout(),
    signal: requestOptions.signal,
    validateStatus: (s) => s >= 200 && s < 300,
  };
  if (body) options.data = body;
  const limit = getRequestLimiter(path);
  try {
    const res = await limit(() => axios(options));
    const data = res.data;
    const outerError = payloadErrorMessage(data);
    if (outerError) throw new Error(`auth-service API 错误: ${outerError}`);

    const payload = isObject(data) && 'data' in data ? data.data : data;
    const innerError = payloadErrorMessage(payload);
    if (innerError) throw new Error(`平台 API 错误: ${innerError}`);

    return payload as T;
  } catch (err: any) {
    // 对 5xx 错误和网络错误重试1次
    const cancelled = requestOptions.signal?.aborted || err?.code === 'ERR_CANCELED' || axios.isCancel?.(err);
    if (!cancelled && retries > 0 && (!err.response || err.response.status >= 500)) {
      await new Promise(r => setTimeout(r, 1000));
      return post<T>(path, body, retries - 1, requestOptions);
    }
    throw err;
  }
}

/** 提现订单（分页查询，支持多页自动翻页） */
export async function getWithdrawOrders(params: {
  current?: number; size?: number; cashStatusList?: number | number[];
  createTimeFrom?: string; createTimeTo?: string;
}, options?: AuthRequestOptions): Promise<any> {
  return post('/withdrawOrders', params as any, 1, options);
}

/** 按代理查下级会员 */
export async function getMembersByAgency(agencyUsername: string, page = 1, pageSize = 200, options?: AuthRequestOptions): Promise<any> {
  return post('/membersByAgency', { agencyUsername, page, pageSize }, 1, options);
}

/** 按账号查会员信息 */
export async function getMemberInfo(account: string, options?: AuthRequestOptions): Promise<any> {
  return post('/memberInfo', { account }, 1, options);
}

/** 投注记录 */
export async function getMemberBets(params: {
  account: string; page?: number; size?: number; startTime?: number; endTime?: number;
}, options?: AuthRequestOptions): Promise<any> {
  return post('/memberBets', params as any, 1, options);
}

/** 投注统计 */
export async function getBetsCount(account: string, dateRange?: { startDate?: string; endDate?: string }, options?: AuthRequestOptions): Promise<any> {
  return post('/betsCount', { account, startTime: dateRange?.startDate, endTime: dateRange?.endDate }, 1, options);
}

/** 提现历史 */
export async function getMemberWithdrawals(params: {
  account: string; page?: number; startTime?: number; endTime?: number;
}, options?: AuthRequestOptions): Promise<any> {
  return post('/memberWithdrawals', params as any, 1, options);
}

/** 充值订单 */
export async function getPaymentOrders(account: string, page?: number, timeRange?: { start: number; end: number }, options?: AuthRequestOptions): Promise<any> {
  return post('/paymentOrders', { account, page, startTime: timeRange?.start, endTime: timeRange?.end }, 1, options);
}

/** 充值汇总 */
export async function getRechReport(account: string, startTime?: number, endTime?: number, options?: AuthRequestOptions): Promise<any> {
  return post('/rechReport', { account, startTime, endTime }, 1, options);
}

/** 充值历史 */
export async function getRechargeHistory(account: string, beginDatetime?: string, endDatetime?: string, options?: AuthRequestOptions): Promise<any> {
  return post('/rechargeHistory', { account, beginDatetime, endDatetime }, 1, options);
}

/** 登录日志（可按 account / loginIp / device 查询） */
export async function getLoginLogs(params: {
  account?: string; loginIp?: string; deviceClientId?: string;
  current?: number; size?: number; beginTime?: string; endTime?: string;
}, options?: AuthRequestOptions): Promise<any> {
  return post('/loginLogs', params as any, 1, options);
}

/** 健康检查 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await axios.get(`${getAuthServiceUrl()}/health`, {
      headers: { Authorization: `Bearer ${getAuthApiKey()}` },
      httpAgent: apiHttpAgent,
      httpsAgent: apiHttpsAgent,
      timeout: 5000,
    });
    return res.data?.healthy === true;
  } catch {
    return false;
  }
}
