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

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getAuthApiKey()}`,
    'Content-Type': 'application/json',
  };
}

async function post<T = unknown>(path: string, body: Record<string, unknown>, retries = 1): Promise<T> {
  const options: AxiosRequestConfig = {
    method: 'POST',
    url: `${getAuthServiceUrl()}${path}`,
    headers: authHeaders(),
    httpAgent: apiHttpAgent,
    httpsAgent: apiHttpsAgent,
    timeout: getAuthTimeout(),
    validateStatus: (s) => s >= 200 && s < 300,
  };
  if (body) options.data = body;
  try {
    const res = await axios(options);
    const data = res.data;
    if (data && typeof data === 'object' && data.success === false && data.error) {
      throw new Error(`auth-service API 错误: ${data.error}`);
    }
    return (data?.data ?? data) as T;
  } catch (err: any) {
    if (retries > 0 && (!err.response || err.response.status >= 500)) {
      await new Promise(r => setTimeout(r, 1000));
      return post<T>(path, body, retries - 1);
    }
    throw err;
  }
}

export async function getWithdrawOrders(params: Record<string, unknown>): Promise<any> {
  return post('/withdrawOrders', params);
}

export async function getMembersByAgency(agencyUsername: string, page = 1, pageSize = 200): Promise<any> {
  return post('/membersByAgency', { agencyUsername, page, pageSize });
}

export async function getMemberInfo(memberName: string): Promise<any> {
  return post('/memberInfo', { memberName });
}

export async function getMemberBets(params: Record<string, unknown>): Promise<any> {
  return post('/memberBets', params);
}

export async function getBetsCount(memberName: string, dateRange?: { start: number; end: number }): Promise<any> {
  return post('/betsCount', { memberName, startTime: dateRange?.start, endTime: dateRange?.end });
}

export async function getMemberWithdrawals(params: Record<string, unknown>): Promise<any> {
  return post('/memberWithdrawals', params);
}

export async function getPaymentOrders(memberName: string, page?: number, timeRange?: { start: number; end: number }): Promise<any> {
  return post('/paymentOrders', {
    memberName, page,
    startTime: timeRange?.start, endTime: timeRange?.end,
  });
}

export async function getRechargeSum(params: { memberName: string; startTime: number; endTime: number }): Promise<any> {
  return post('/rechargeSum', params as any);
}

export async function getThirdGameOrders(memberName: string, page?: number, dateRange?: { start: number; end: number }): Promise<any> {
  return post('/thirdGameOrders', { memberName, page, startTime: dateRange?.start, endTime: dateRange?.end });
}

/** 会员进出报表（近7天各游戏类型投注汇总，startTime/endTime 为 "YYYY-MM-DD" 字符串） */
export async function getMemberInOutReport(memberName: string, startDate: string, endDate: string): Promise<any> {
  return post('/memberInOutReport', { memberName, startTime: startDate, endTime: endDate });
}

export async function getLoginLogs(params: Record<string, unknown>): Promise<any> {
  return post('/loginLogs', params);
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
    return res.data?.healthy === true;
  } catch {
    return false;
  }
}
