/**
 * Auth Service 客户端（平台B 风控）— 替代直接调用下游平台 API
 */

import axios, { type AxiosRequestConfig } from 'axios';
import http from 'http';
import https from 'https';

// 延迟读取环境变量，避免在 dotenv.config() 之前加载模块导致值为空
function getAuthServiceUrl(): string {
  return (process.env.AUTH_SERVICE_URL || 'http://localhost:3100/api/platform-b').replace(/\/+$/, '');
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

/**
 * auth-service 会把上游明确不可重试的错误标记为 retryable: false。
 * 即使外层 HTTP 状态是 5xx，也不应再等待一秒后重复同一请求。
 */
export function shouldRetryAuthRequestError(error: unknown): boolean {
  const err = error as {
    response?: { status?: number; data?: { retryable?: unknown } };
    retryable?: unknown;
  };
  if (err?.retryable === false || err?.response?.data?.retryable === false) return false;

  const status = err?.response?.status;
  return !status || status >= 500;
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
    if (data && typeof data === 'object' && data.success === false && data.error) {
      throw Object.assign(new Error(`auth-service API 错误: ${data.error}`), { retryable: data.retryable });
    }
    return (data?.data ?? data) as T;
  } catch (err: any) {
    const cancelled = requestOptions.signal?.aborted || err?.code === 'ERR_CANCELED' || axios.isCancel?.(err);
    if (!cancelled && retries > 0 && shouldRetryAuthRequestError(err)) {
      await new Promise(r => setTimeout(r, 1000));
      return post<T>(path, body, retries - 1, requestOptions);
    }
    throw err;
  }
}

export async function getWithdrawOrders(params: Record<string, unknown>, options?: AuthRequestOptions): Promise<any> {
  return post('/withdrawOrders', params, 1, options);
}

export async function getMembersByAgency(agencyUsername: string, page = 1, pageSize = 200, options?: AuthRequestOptions): Promise<any> {
  return post('/membersByAgency', { agencyUsername, page, pageSize }, 1, options);
}

export async function getMemberInfo(memberName: string, options?: AuthRequestOptions): Promise<any> {
  return post('/memberInfo', { memberName }, 1, options);
}

export async function getMemberBets(params: Record<string, unknown>, options?: AuthRequestOptions): Promise<any> {
  return post('/memberBets', params, 1, options);
}

export async function getBetsCount(memberName: string, dateRange?: { start: number; end: number }, options?: AuthRequestOptions): Promise<any> {
  return post('/betsCount', { memberName, startTime: dateRange?.start, endTime: dateRange?.end }, 1, options);
}

export async function getMemberWithdrawals(params: Record<string, unknown>, options?: AuthRequestOptions): Promise<any> {
  return post('/memberWithdrawals', params, 1, options);
}

export async function getPaymentOrders(memberName: string, page?: number, timeRange?: { start: number; end: number }, options?: AuthRequestOptions): Promise<any> {
  return post('/paymentOrders', {
    memberName, page,
    startTime: timeRange?.start, endTime: timeRange?.end,
  }, 1, options);
}

export async function getRechargeSum(params: { memberName: string; startTime: number; endTime: number }, options?: AuthRequestOptions): Promise<any> {
  return post('/rechargeSum', params as any, 1, options);
}

export async function getAccountChangeList(params: { memberName: string; startTime: number; endTime: number; page?: number; pageSize?: number }, options?: AuthRequestOptions): Promise<any> {
  return post('/accountChangeList', params as any, 1, options);
}

export async function getThirdGameOrders(memberName: string, page?: number, dateRange?: { start: number; end: number }, options?: AuthRequestOptions): Promise<any> {
  return post('/thirdGameOrders', { memberName, page, startTime: dateRange?.start, endTime: dateRange?.end }, 1, options);
}

/** 会员进出报表（近7天各游戏类型投注汇总，startTime/endTime 为 "YYYY-MM-DD" 字符串） */
export async function getMemberInOutReport(memberName: string, startDate: string, endDate: string, options?: AuthRequestOptions): Promise<any> {
  return post('/memberInOutReport', { memberName, startTime: startDate, endTime: endDate }, 1, options);
}

export async function getLoginLogs(params: Record<string, unknown>, options?: AuthRequestOptions): Promise<any> {
  return post('/loginLogs', params, 1, options);
}

/** 获取 WebSocket Token */
export async function getWsToken(): Promise<{ token: string; wsUrl: string } | null> {
  try {
    const res = await axios.get(`${getAuthServiceUrl()}/ws-token`, {
      headers: { Authorization: `Bearer ${getAuthApiKey()}` },
      httpAgent: apiHttpAgent,
      httpsAgent: apiHttpsAgent,
      timeout: 5000,
    });
    if (res.data?.success && res.data.token) {
      return { token: res.data.token, wsUrl: res.data.wsUrl };
    }
    return null;
  } catch {
    return null;
  }
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await axios.get(`${getAuthServiceUrl()}/health`, {
      headers: { Authorization: `Bearer ${getAuthApiKey()}` },
      httpAgent: apiHttpAgent,
      httpsAgent: apiHttpsAgent,
      timeout: 5000,
    });
    // TG_Riskbot 只依赖风控后台。加款后台不可用不应把风控链路误判为不可用。
    return res.data?.riskApi === true || res.data?.healthy === true;
  } catch {
    return false;
  }
}
