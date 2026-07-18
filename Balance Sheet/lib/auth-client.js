'use strict';

const crypto = require('node:crypto');

async function requestReport(settings, path, body) {
  if (!settings.authApiKey) throw new Error('AUTH_API_KEY 未配置，无法查询订单');
  const response = await fetch(`${settings.authServiceUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.authApiKey}`,
      'Content-Type': 'application/json',
      'X-Request-Id': `balance-${crypto.randomUUID()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`auth-service 返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  if (!response.ok || payload?.success !== true || !payload?.data?.complete) {
    throw new Error(payload?.error || `auth-service 查询失败（HTTP ${response.status}）`);
  }
  return payload.data;
}

async function loadDailyOrders(settings, date, pageSize) {
  const body = { date, pageSize, memberTypes: [2, 3] };
  const [recharge, withdraw] = await Promise.all([
    requestReport(settings, '/report/rechargeOrders', body),
    requestReport(settings, '/report/withdrawOrders', body),
  ]);
  return { recharge, withdraw };
}

module.exports = { loadDailyOrders };
