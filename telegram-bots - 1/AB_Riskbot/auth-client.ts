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
    // 检查 API 是否返回了错误结构
    const data = res.data;
    if (data && typeof data === 'object' && data.success === false && data.error) {
      throw new Error(`auth-service API 错误: ${data.error}`);
    }
    return (data?.data ?? data) as T;
  } catch (err: any) {
    // 对 5xx 错误和网络错误重试1次
    if (retries > 0 && (!err.response || err.response.status >= 500)) {
      await new Promise(r => setTimeout(r, 1000));
      return post<T>(path, body, retries - 1);
    }
    throw err;
  }
}

/** 提现订单（分页查询，支持多页自动翻页） */
export async function getWithdrawOrders(params: {
  current?: number; size?: number; cashStatusList?: number | number[];
  createTimeFrom?: string; createTimeTo?: string;
}): Promise<any> {
  return post('/withdrawOrders', params as any);
}

/** 按代理查下级会员 */
export async function getMembersByAgency(agencyUsername: string, page = 1, pageSize = 200): Promise<any> {
  return post('/membersByAgency', { agencyUsername, page, pageSize });
}

/** 按账号查会员信息 */
export async function getMemberInfo(account: string): Promise<any> {
  return post('/memberInfo', { account });
}

/** 投注记录 */
export async function getMemberBets(params: {
  account: string; page?: number; size?: number; startTime?: number; endTime?: number;
}): Promise<any> {
  return post('/memberBets', params as any);
}

/** 投注统计 */
export async function getBetsCount(account: string): Promise<any> {
  return post('/betsCount', { account });
}

/** 提现历史 */
export async function getMemberWithdrawals(params: {
  account: string; page?: number; startTime?: number; endTime?: number;
}): Promise<any> {
  return post('/memberWithdrawals', params as any);
}

/** 充值订单 */
export async function getPaymentOrders(account: string, page?: number, timeRange?: { start: number; end: number }): Promise<any> {
  return post('/paymentOrders', { account, page, startTime: timeRange?.start, endTime: timeRange?.end });
}

/** 充值汇总 */
export async function getRechReport(account: string, startTime?: number, endTime?: number): Promise<any> {
  return post('/rechReport', { account, startTime, endTime });
}

/** 充值历史 */
export async function getRechargeHistory(account: string, beginDatetime?: string, endDatetime?: string): Promise<any> {
  return post('/rechargeHistory', { account, beginDatetime, endDatetime });
}

/** 登录日志（可按 account / loginIp / device 查询） */
export async function getLoginLogs(params: {
  account?: string; loginIp?: string; deviceClientId?: string;
  current?: number; size?: number;
}): Promise<any> {
  return post('/loginLogs', params as any);
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
