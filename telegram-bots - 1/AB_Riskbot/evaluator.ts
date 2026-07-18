import crypto from 'crypto';
import { apiClient } from './api-client';
import type { RuleContext, EvaluationResult, LoginAssociationSummary } from './rule-types';
import { evaluateRules, getActiveRuleIds } from './rule-engine';
import { dbHolder } from './db';
import { logger } from './logger';
import { isAgentWhitelisted } from './constants';
import { parseTimeStr, absFloat, fmtNum, extractProxyCode, formatBeijingTime, getTzOffsetMinutes } from './utils';
import type { WithdrawOrder } from './types';
import type { MemberInfo, BetRecord, WithdrawalRecord, PaymentOrder, BetsCount, MemberCacheData, UserDetailsResponse, ApiResponse, PagedResponse, LoginLogItem, NewRechReport, NewRechargeOrderHistory } from './types';
import { LRUCache } from 'lru-cache';

const MAX_MEMBER_CACHE = 500;

const CACHE_TTL = 5 * 60 * 1000;
const BET_CACHE_TTL = 180 * 1000; // 3分钟投注缓存：平衡 API 调用量与时效性

const memberCache = new LRUCache<string, { data: MemberCacheData; betExpire: number; queryEnd?: number }>({
  max: MAX_MEMBER_CACHE,
  ttl: CACHE_TTL,
});

const AGENT_CACHE_TTL = 30 * 60 * 1000;

const agentWithdrawCache = new LRUCache<string, { count: number; memberIds: Set<string>; lastUpdate: number }>({
  max: MAX_MEMBER_CACHE,
  ttl: AGENT_CACHE_TTL,
});


// 代理风险评分短期缓存，避免同一代理在并发评估中被重复查询
const agentScoreCache = new LRUCache<string, number>({
  max: 500,
  ttl: 5 * 60 * 1000,
});

const IP_DEVICE_CACHE_TTL = 60 * 60 * 1000;
const DAILY_LOGIN_ASSOC_CACHE_TTL = 2 * 60 * 1000;

interface LoginAssociationCacheEntry {
  members: Set<string>;
  latestLoginAtByMember?: Map<string, number>;
  fetchedCount?: number;
  totalCount?: number;
  truncated?: boolean;
}

export const ipMemberCache = new LRUCache<string, LoginAssociationCacheEntry>({
  max: 2000,
  ttl: IP_DEVICE_CACHE_TTL,
});

export const deviceMemberCache = new LRUCache<string, LoginAssociationCacheEntry>({
  max: 2000,
  ttl: IP_DEVICE_CACHE_TTL,
});

interface DailyLoginAssociations {
  relatedByLoginIp: LoginLogItem[];
  relatedByLoginDevice: LoginLogItem[];
  relatedByLoginIpCount: number;
  relatedByLoginDeviceCount: number;
  dailyLoginIpAssociations: LoginAssociationSummary[];
  dailyLoginDeviceAssociations: LoginAssociationSummary[];
}

const dailyLoginAssociationCache = new LRUCache<string, DailyLoginAssociations>({
  max: 2000,
  ttl: DAILY_LOGIN_ASSOC_CACHE_TTL,
});

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getDailyLoginFetchOptions(signal?: AbortSignal): { maxPages: number; pageSize: number; signal?: AbortSignal } {
  return {
    maxPages: parsePositiveInt(process.env.DAILY_LOGIN_MAX_PAGES, 3),
    pageSize: parsePositiveInt(process.env.DAILY_LOGIN_PAGE_SIZE, 50),
    signal,
  };
}

function getPagedTotalCount<T>(res: PagedResponse<T> | ApiResponse<T> | null | undefined, fallback: number): number {
  const n = parseInt(String(res?.totalNum || ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function latestLoginTimesFromLogs(logs: LoginLogItem[]): Map<string, number> {
  const times = new Map<string, number>();
  for (const log of logs) {
    const name = String(log.memberName || '').trim();
    if (!name) continue;
    const ts = parseTimeStr(log.loginTime as string | number | undefined);
    const prev = times.get(name) || 0;
    if (ts > prev) times.set(name, ts);
    if (!times.has(name)) times.set(name, 0);
  }
  return times;
}

function sortedNamesByLatestTime(members: Set<string>, latestLoginAtByMember?: Map<string, number>): string[] {
  return [...members].sort((a, b) => {
    const tb = latestLoginAtByMember?.get(b) || 0;
    const ta = latestLoginAtByMember?.get(a) || 0;
    return tb - ta || a.localeCompare(b);
  });
}

function toLatestLoginRecord(latestLoginAtByMember?: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...(latestLoginAtByMember || new Map<string, number>()).entries()]);
}

function associationCacheKey(kind: 'ip' | 'device', value: string, dayStart: number): string {
  return `today:${dayStart}:${kind}:${value}`;
}

function getCachedMember(memberId: string, queryEnd?: number): { data: MemberCacheData; betStale: boolean } | null {
  const entry = memberCache.get(memberId);
  if (!entry) return null;
  // 查询结果严格绑定提款时刻，避免后一笔订单复用前一笔的投注/资金快照。
  const betStale = Date.now() > entry.betExpire || (queryEnd !== undefined && entry.queryEnd !== queryEnd);
  return { data: entry.data, betStale };
}

function setCachedMember(memberId: string, data: MemberCacheData, queryEnd?: number): void {
  memberCache.set(memberId, { data, betExpire: Date.now() + BET_CACHE_TTL, queryEnd });
}

export function clearMemberCache(): void {
  memberCache.clear();
}

function extractList<T>(res: PagedResponse<T> | ApiResponse<T> | null | undefined): T[] {
  const list = res?.items || (res?.data && typeof res.data === 'object' && !Array.isArray(res.data) ? (res.data as { list?: T[] }).list : null) || res?.list || (Array.isArray(res?.data) ? res.data : null);
  if (!list && res) {
    logger.warn({ resKeys: Object.keys(res || {}) }, '[评估器] extractList: 无法从响应中提取列表数据');
  }
  return Array.isArray(list) ? list : [];
}

async function getDailyLoginAssociations(
  member: MemberInfo,
  memberName: string,
  orderTime: number,
  abortSignal?: AbortSignal,
): Promise<DailyLoginAssociations> {
  const empty: DailyLoginAssociations = {
    relatedByLoginIp: [],
    relatedByLoginDevice: [],
    relatedByLoginIpCount: 0,
    relatedByLoginDeviceCount: 0,
    dailyLoginIpAssociations: [],
    dailyLoginDeviceAssociations: [],
  };
  if (!memberName || isAgentWhitelisted(memberName)) return empty;

  const activeRuleIds = getActiveRuleIds();
  const needIpAssociations = activeRuleIds.has('R02D') || activeRuleIds.has('R02');
  const needDeviceAssociations = activeRuleIds.has('R03D') || activeRuleIds.has('R03');
  if (!needIpAssociations && !needDeviceAssociations) return empty;

  // 自动规则必须以提款发生当日（北京时间）为准，不能误用服务器当前日期。
  const todayRange = apiClient.getTimezoneDateRange(orderTime, true);
  const memberKey = `today:${todayRange.start}:${memberName}:${needIpAssociations ? 'ip' : 'noip'}:${needDeviceAssociations ? 'dev' : 'nodev'}`;
  const cachedDaily = dailyLoginAssociationCache.get(memberKey);
  if (cachedDaily) return cachedDaily;

  try {
    if (abortSignal?.aborted) return empty;
    const fetchOptions = getDailyLoginFetchOptions(abortSignal);
    const ownLogsRes = await apiClient.getLoginLogsByMember(memberName, todayRange, fetchOptions);
    if (abortSignal?.aborted) return empty;
    const ownLogs = extractList<LoginLogItem>(ownLogsRes);
    const ownIps = new Set(ownLogs.map(l => String(l.loginIp || '').trim()).filter(Boolean));
    const ownDevices = new Set(ownLogs.map(l => String(l.device || '').trim()).filter(Boolean));

    if (member.lastLoginIp) ownIps.add(member.lastLoginIp);
    if (member.lastLoginDeviceClientId) ownDevices.add(member.lastLoginDeviceClientId);

    const ipValues = needIpAssociations ? [...ownIps].slice(0, 5) : [];
    const deviceValues = needDeviceAssociations ? [...ownDevices].slice(0, 5) : [];

    const ipResults = await Promise.all(ipValues.map(async (ip): Promise<LoginAssociationSummary | null> => {
      if (abortSignal?.aborted) return null;
      const cacheKey = associationCacheKey('ip', ip, todayRange.start);
      let cached = ipMemberCache.get(cacheKey);
      let members = cached?.members;
      let latestLoginAtByMember = cached?.latestLoginAtByMember;
      let fetchedCount = cached?.fetchedCount ?? 0;
      let totalCount = cached?.totalCount ?? 0;
      let truncated = cached?.truncated ?? false;
      if (!members) {
        const logsRes = await apiClient.getLoginLogsByIp(ip, todayRange, fetchOptions);
        if (abortSignal?.aborted) return null;
        const logs = extractList<LoginLogItem>(logsRes);
        latestLoginAtByMember = latestLoginTimesFromLogs(logs);
        members = new Set(latestLoginAtByMember.keys());
        fetchedCount = logs.length;
        totalCount = getPagedTotalCount(logsRes, fetchedCount);
        truncated = totalCount > fetchedCount;
        ipMemberCache.set(cacheKey, { members, latestLoginAtByMember, fetchedCount, totalCount, truncated });
      }
      if (!members.has(memberName)) return null;
      const memberNames = sortedNamesByLatestTime(members, latestLoginAtByMember)
        .filter(n => n === memberName || !isAgentWhitelisted(n));
      const otherMemberNames = memberNames.filter(n => n !== memberName);
      return { value: ip, memberNames, otherMemberNames, latestLoginAtByMember: toLatestLoginRecord(latestLoginAtByMember), accountCount: memberNames.length, fetchedCount, totalCount, truncated };
    }));

    const deviceResults = await Promise.all(deviceValues.map(async (device): Promise<LoginAssociationSummary | null> => {
      if (abortSignal?.aborted) return null;
      const cacheKey = associationCacheKey('device', device, todayRange.start);
      let cached = deviceMemberCache.get(cacheKey);
      let members = cached?.members;
      let latestLoginAtByMember = cached?.latestLoginAtByMember;
      let fetchedCount = cached?.fetchedCount ?? 0;
      let totalCount = cached?.totalCount ?? 0;
      let truncated = cached?.truncated ?? false;
      if (!members) {
        const logsRes = await apiClient.getLoginLogsByDevice(device, todayRange, fetchOptions);
        if (abortSignal?.aborted) return null;
        const logs = extractList<LoginLogItem>(logsRes);
        latestLoginAtByMember = latestLoginTimesFromLogs(logs);
        members = new Set(latestLoginAtByMember.keys());
        fetchedCount = logs.length;
        totalCount = getPagedTotalCount(logsRes, fetchedCount);
        truncated = totalCount > fetchedCount;
        deviceMemberCache.set(cacheKey, { members, latestLoginAtByMember, fetchedCount, totalCount, truncated });
      }
      if (!members.has(memberName)) return null;
      const memberNames = sortedNamesByLatestTime(members, latestLoginAtByMember)
        .filter(n => n === memberName || !isAgentWhitelisted(n));
      const otherMemberNames = memberNames.filter(n => n !== memberName);
      return { value: device, memberNames, otherMemberNames, latestLoginAtByMember: toLatestLoginRecord(latestLoginAtByMember), accountCount: memberNames.length, fetchedCount, totalCount, truncated };
    }));

    const ipSummaries = ipResults.filter((s): s is LoginAssociationSummary => !!s);
    const deviceSummaries = deviceResults.filter((s): s is LoginAssociationSummary => !!s);
    const relatedByLoginIp = ipSummaries.flatMap(s => s.otherMemberNames.map(memberName => ({ memberName, loginIp: s.value })));
    const relatedByLoginDevice = deviceSummaries.flatMap(s => s.otherMemberNames.map(memberName => ({ memberName, device: s.value })));

    const result = {
      relatedByLoginIp,
      relatedByLoginDevice,
      relatedByLoginIpCount: Math.max(0, ...ipSummaries.map(s => s.accountCount)),
      relatedByLoginDeviceCount: Math.max(0, ...deviceSummaries.map(s => s.accountCount)),
      dailyLoginIpAssociations: ipSummaries,
      dailyLoginDeviceAssociations: deviceSummaries,
    };
    dailyLoginAssociationCache.set(memberKey, result);
    return result;
  } catch (err) {
    logger.debug({ memberName, err: (err as Error).message }, '[评估器] 查询当天登录关联会员失败');
    // 登录关联是辅助证据；临时失败不能让整笔提款评估降级为失败通知。
    return empty;
  }
}

function fingerprintValue(value: string, purpose: string): string {
  const normalized = value.trim().replace(/[\s-]+/g, '').toLowerCase();
  const secret = process.env.RISK_FINGERPRINT_SECRET || '';
  if (!normalized || !secret) return '';
  return crypto.createHmac('sha256', secret).update(`${purpose}:${normalized}`).digest('hex');
}

function receivingFingerprint(order: WithdrawOrder): string {
  const name = fingerprintValue(String(order.receivingName || ''), 'receiving-name');
  const card = fingerprintValue(String(order.receivingCardNo || ''), 'receiving-card');
  return name && card ? crypto.createHash('sha256').update(`${name}|${card}`).digest('hex') : '';
}

function getWithdrawalMethod(order: WithdrawOrder): { bank: string; card: string; name: string; version: number } | null {
  const bank = String(order.receivingBank || '').trim();
  const name = fingerprintValue(String(order.receivingName || ''), 'receiving-name');
  const card = fingerprintValue(String(order.receivingCardNo || ''), 'receiving-card');
  if (!bank || (!name && !card)) return null;
  return { bank, name, card, version: 2 };
}

async function getSuccessfulWithdrawalContext(order: WithdrawOrder): Promise<{
  receivingAssociations: string[];
  lastWithdrawMethod: { bank: string; card: string; name: string; version?: number } | null;
}> {
  const memberName = String(order.memberName || order.member_name || '').trim();
  const orderTime = parseTimeStr(order.createTime || (order as Record<string, unknown>).createdAt as string | number | undefined) || Date.now();
  if (!memberName || isAgentWhitelisted(memberName)) {
    return { receivingAssociations: [], lastWithdrawMethod: null };
  }

  const fingerprint = receivingFingerprint(order);
  const days = Math.min(parsePositiveInt(process.env.RECEIVING_ASSOCIATION_DAYS, 180), 365);
  const historyStart = new Date(orderTime - days * 86400000);
  const historyEnd = new Date(orderTime);

  let previous: { receivingBank: string; receivingName: string; receivingCardNo: string } | null = null;
  let related: Array<{ memberName: string }> = [];
  try {
    [previous, related] = await Promise.all([
      dbHolder.db.successfulWithdrawal.findFirst({
        where: { memberName, createTime: { lt: historyEnd } },
        orderBy: { createTime: 'desc' },
        select: { receivingBank: true, receivingName: true, receivingCardNo: true },
      }),
      fingerprint
        ? dbHolder.db.successfulWithdrawal.findMany({
          where: { receivingFingerprint: fingerprint, createTime: { gte: historyStart, lt: historyEnd } },
          select: { memberName: true },
          distinct: ['memberName'],
        })
        : Promise.resolve([]),
    ]);
  } catch (err) {
    logger.warn({ memberName, err: (err as Error).message }, '[评估器] 查询成功提款历史失败，跳过历史关联规则');
    return { receivingAssociations: [], lastWithdrawMethod: null };
  }

  const receivingAssociations = [...new Set(related
    .map(item => String(item.memberName || '').trim())
    .filter(name => name && name !== memberName && !isAgentWhitelisted(name)))]
    .sort((a, b) => a.localeCompare(b));

  const lastWithdrawMethod = previous
    ? { bank: previous.receivingBank, name: previous.receivingName, card: previous.receivingCardNo, version: 2 }
    : null;
  return { receivingAssociations, lastWithdrawMethod };
}

// 防止同一订单重复计入代理缓存
const agentCacheOrderDedup = new LRUCache<string, boolean>({ max: 2000, ttl: 30 * 60 * 1000 });

function updateAgentCache(order: WithdrawOrder): void {
  const proxyCode = extractProxyCode(order);
  const memberName = String(order?.memberName || order?.member_name || '');
  const orderNo = String(order?.orderNo || order?.id || '');
  if (!proxyCode || !memberName) return;
  if (isAgentWhitelisted(proxyCode)) return;

  // 防止同一订单重复计入（如缓存失效后重新评估）
  const dedupKey = `${proxyCode}:${orderNo}`;
  if (agentCacheOrderDedup.has(dedupKey)) return;
  agentCacheOrderDedup.set(dedupKey, true);

  const entry = agentWithdrawCache.get(proxyCode) || { count: 0, memberIds: new Set<string>(), lastUpdate: 0 };
  entry.memberIds.add(memberName);
  entry.count++;
  entry.lastUpdate = Date.now();
  agentWithdrawCache.set(proxyCode, entry);
}

export function getAgentWithdrawCache(): LRUCache<string, { count: number; memberIds: Set<string>; lastUpdate: number }> {
  return agentWithdrawCache;
}

async function fetchRechargeStats(
  account: string,
  effectiveStart: number,
  effectiveEnd: number,
  threeDayStart: number,
  sevenDayStart: number,
  abortSignal?: AbortSignal,
): Promise<{
  manualRechargeToday: number;
  manualRecharge3Day: number;
  manualRecharge7Day: number;
  thirdPartyRechargeToday: number;
  thirdPartyRecharge3Day: number;
  thirdPartyRecharge7Day: number;
}> {
  if (!account) {
    return { manualRechargeToday: 0, manualRecharge3Day: 0, manualRecharge7Day: 0, thirdPartyRechargeToday: 0, thirdPartyRecharge3Day: 0, thirdPartyRecharge7Day: 0 };
  }
  try {
    const [report7, report3, report1] = await Promise.all([
      apiClient.getRechReport(account, sevenDayStart, effectiveEnd, { signal: abortSignal }),
      apiClient.getRechReport(account, threeDayStart, effectiveEnd, { signal: abortSignal }),
      apiClient.getRechReport(account, effectiveStart, effectiveEnd, { signal: abortSignal }),
    ]);
    return {
      manualRechargeToday: report1?.handMoney || 0,
      manualRecharge3Day: report3?.handMoney || 0,
      manualRecharge7Day: report7?.handMoney || 0,
      thirdPartyRechargeToday: report1?.onlineMoney || 0,
      thirdPartyRecharge3Day: report3?.onlineMoney || 0,
      thirdPartyRecharge7Day: report7?.onlineMoney || 0,
    };
  } catch (err) {
    logger.warn({ account, err: (err as Error).message }, '[评估器] 获取充值统计失败');
    throw err;
  }
}

/** 提取会员近7天充值渠道（payTypeName 去重），用于检测充值/提款渠道不一致 */
async function fetchRechargePayTypes(account: string, sevenDayStart: number, effectiveEnd: number, abortSignal?: AbortSignal): Promise<Set<string>> {
  if (!account) return new Set();
  try {
    const records = await apiClient.getRechargeOrderHistory(account, sevenDayStart, effectiveEnd, { signal: abortSignal });
    const payTypes = new Set<string>();
    for (const r of records) {
      const pt = (r.payTypeName || '').trim();
      if (pt) payTypes.add(pt);
    }
    return payTypes;
  } catch (err) {
    logger.warn({ account, err: (err as Error).message }, '[评估器] 获取充值渠道失败');
    throw err;
  }
}

/** 获取所有缓存的容量统计（用于监控和调试） */
export function getCacheStats(): Record<string, { size: number; max: number; utilization: string }> {
  const stats: Record<string, { size: number; max: number; utilization: string }> = {};
  for (const [name, cache] of [
    ['memberCache', memberCache],
    ['agentWithdrawCache', agentWithdrawCache],
    ['ipMemberCache', ipMemberCache],
    ['deviceMemberCache', deviceMemberCache],
  ] as const) {
    stats[name] = {
      size: cache.size,
      max: (cache as any).max || 0,
      utilization: (cache as any).max ? `${((cache.size / (cache as any).max) * 100).toFixed(1)}%` : 'N/A',
    };
  }
  return stats;
}

const EVAL_TIMEOUT = 30 * 1000;

const evaluatingMembers = new Map<string, Promise<EvaluationResult | null>>();

export async function evaluateOrder(order: WithdrawOrder): Promise<EvaluationResult | null> {
  const memberId = order.memberId || order.member_id;
  const traceId = crypto.randomUUID();
  if (!memberId) {
    logger.warn({ orderNo: order.orderNo || order.id, traceId }, '[评估器] 订单缺少 memberId');
    return null;
  }

  const existing = evaluatingMembers.get(memberId);
  if (existing) {
    // 同一会员存在多笔待处理提款时，必须串行但各自按自己的提款时间重新取数。
    // 复用前一笔评估快照会把投注、登录日和收款方式错误套到后一笔订单。
    await existing;
    await new Promise<void>(resolve => setImmediate(resolve));
    return evaluateOrder(order);
  }

  let resolveEval!: (value: EvaluationResult | null) => void;
  const evalPromise = new Promise<EvaluationResult | null>((resolve) => { resolveEval = resolve; });
  evaluatingMembers.set(memberId, evalPromise);

  (async () => {
    const startTime = Date.now();
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([
        evaluateOrderInner(order, memberId, startTime, () => abortController.signal.aborted, abortController.signal, traceId),
        new Promise<null>((resolve) => {
          timeoutId = setTimeout(() => {
            abortController.abort();
            resolve(null);
          }, EVAL_TIMEOUT);
        }),
      ]);
      clearTimeout(timeoutId!);
      resolveEval(result);
    } catch (err) {
      clearTimeout(timeoutId!);
      logger.error({ orderNo: order.orderNo || order.id, err: (err as Error).message }, `[评估器] 评估订单 ${order.orderNo || order.id} 失败`);
      resolveEval(null);
    } finally {
      // H2: 仅当 map 中仍是本轮的 promise 时才清理，防止误删后一轮的条目
      if (evaluatingMembers.get(memberId) === evalPromise) {
        evaluatingMembers.delete(memberId);
      }
    }
  })();

  return evalPromise;
}

async function evaluateOrderInner(order: WithdrawOrder, memberId: string, startTime: number, isCancelled?: () => boolean, abortSignal?: AbortSignal, traceId?: string): Promise<EvaluationResult | null> {
  const tid = traceId || crypto.randomUUID();
  try {
    // 创建浅拷贝，避免修改原始 order 对象
    const orderCtx = { ...order };
    updateAgentCache(order);

    const orderCreateTime = parseTimeStr(order.createTime || (order as Record<string, unknown>).createdAt as string | number | undefined) || Date.now();
    const effectiveDateRange = apiClient.getEffectiveDateRange(orderCreateTime);
    const { start: effectiveStart, end: effectiveEnd, isEarlyMorning } = effectiveDateRange;
    const sevenDayStart = effectiveStart - 6 * 24 * 3600 * 1000;
    const lotteryDateRange = apiClient.getRollingDateRange(orderCreateTime, Math.min(parsePositiveInt(process.env.LOTTERY_LOOKBACK_DAYS, 7), 14));
    const withdrawalHistoryDateRange = apiClient.getRollingDateRange(orderCreateTime, Math.min(parsePositiveInt(process.env.WITHDRAWAL_HISTORY_DAYS, 30), 90));
    const betsMaxPages = isEarlyMorning === true ? 5 : 3;
    const withdrawalsMaxPages = Math.min(parsePositiveInt(process.env.WITHDRAWAL_HISTORY_MAX_PAGES, isEarlyMorning ? 5 : 3), 20);

    const cached = getCachedMember(memberId, orderCreateTime);
    const memberName = order.memberName || order.member_name || '';
    const queryName = memberName || order.memberName || memberId;
    let member: MemberInfo = { memberId, memberName: queryName };
    let betsData: BetRecord[];
    let withdrawalsData: WithdrawalRecord[];
    let paymentOrdersData: PaymentOrder[];
    let betsCountData: BetsCount | null;
    let manualRechargeToday: number;
    let manualRecharge3Day: number;
    let manualRecharge7Day: number;
    let thirdPartyRechargeToday: number;
    let thirdPartyRecharge3Day: number;
    let thirdPartyRecharge7Day: number;
    let rechargePayTypes = new Set<string>();

    if (!memberName && memberId) {
      logger.warn({ orderNo: order.orderNo || order.id, memberId }, '[评估器] 订单缺少 memberName，使用 memberId 作为查询参数，部分 API 可能返回空数据');
    }

    let agentRiskScore: number | null = null;
    let lastWithdrawMethod: { bank: string; card: string; name: string; version?: number } | null = null;

    if (cached) {
      member = cached.data.member;

      if (!cached.betStale) {
        betsData = cached.data.bets;
        withdrawalsData = cached.data.withdrawals;
        paymentOrdersData = cached.data.paymentOrders || [];
        betsCountData = cached.data.betsCount || null;
        manualRechargeToday = cached.data.manualRechargeToday || 0;
        manualRecharge3Day = cached.data.manualRecharge3Day || 0;
        manualRecharge7Day = cached.data.manualRecharge7Day || 0;
        thirdPartyRechargeToday = cached.data.thirdPartyRechargeToday || 0;
        thirdPartyRecharge3Day = cached.data.thirdPartyRecharge3Day || 0;
        thirdPartyRecharge7Day = cached.data.thirdPartyRecharge7Day || 0;
        agentRiskScore = cached.data.agentRiskScore ?? null;
        // 充值渠道仍需刷新；登录关联在公共区按当天登录日志统一查询。
        const payTypes = await fetchRechargePayTypes(queryName, sevenDayStart, effectiveEnd, abortSignal);
        rechargePayTypes = payTypes;

        if (isCancelled?.()) return null;
      } else {
        const threeDayStart = effectiveStart - 2 * 24 * 3600 * 1000;

        const proxyCode = extractProxyCode(orderCtx, member);
        const agentProfilePromise = proxyCode
          ? dbHolder.db.agentProfile.findUnique({ where: { proxyCode } }).then(ap => ({ proxyCode, agentRiskScore: ap?.riskScore || 0 })).catch(() => ({ proxyCode, agentRiskScore: 0 }))
          : Promise.resolve({ proxyCode: '', agentRiskScore: 0 });

        const memberRefreshPromise = apiClient.getUserDetails(queryName, { signal: abortSignal });

        // 所有独立 API 调用合并为一个并行批次（member 在缓存中，login logs 也可并行）
        const [
          betsResult, betsCountResult,
          withdrawalsResult, paymentOrders7DayResult,
          agentProfileRes, memberRefreshRes,
          rechargeStats, payTypes,
        ] = await Promise.all([
          memberName ? apiClient.getMemberBets(queryName, 1, lotteryDateRange, betsMaxPages, { signal: abortSignal }).then(res => extractList<BetRecord>(res)) : Promise.resolve([] as BetRecord[]),
          memberName ? apiClient.getBetsCountToday(queryName, effectiveDateRange, { signal: abortSignal }) : Promise.resolve(null as ApiResponse<BetsCount> | null),
          memberName ? apiClient.getMemberWithdrawals(queryName, 1, withdrawalHistoryDateRange, withdrawalsMaxPages, { signal: abortSignal }).then(res => extractList<WithdrawalRecord>(res)) : Promise.resolve([] as WithdrawalRecord[]),
          memberName ? apiClient.getPaymentOrders(queryName, 1, { start: sevenDayStart, end: effectiveEnd }, 3, { signal: abortSignal }).then(res => extractList<PaymentOrder>(res)) : Promise.resolve([] as PaymentOrder[]),
          agentProfilePromise,
          memberRefreshPromise,
          fetchRechargeStats(queryName, effectiveStart, effectiveEnd, threeDayStart, sevenDayStart, abortSignal),
          fetchRechargePayTypes(queryName, sevenDayStart, effectiveEnd, abortSignal),
        ]);
        betsData = betsResult;
        betsCountData = (betsCountResult as ApiResponse<BetsCount> | null)?.data || null;
        withdrawalsData = withdrawalsResult;
        paymentOrdersData = paymentOrders7DayResult;
        rechargePayTypes = payTypes;

        if (memberRefreshRes) {
          const arr = memberRefreshRes?.items || memberRefreshRes?.data;
          const refreshed = Array.isArray(arr) ? arr[0] : (arr && !(arr as unknown as Record<string, unknown>).code ? arr : null);
          if (refreshed && (refreshed.memberName || refreshed.userName)) {
            member = refreshed;
          }
        }
        manualRechargeToday = rechargeStats.manualRechargeToday;
        manualRecharge3Day = rechargeStats.manualRecharge3Day;
        manualRecharge7Day = rechargeStats.manualRecharge7Day;
        thirdPartyRechargeToday = rechargeStats.thirdPartyRechargeToday;
        thirdPartyRecharge3Day = rechargeStats.thirdPartyRecharge3Day;
        thirdPartyRecharge7Day = rechargeStats.thirdPartyRecharge7Day;

        agentRiskScore = agentProfileRes?.agentRiskScore ?? null;

        if (isCancelled?.()) return null;
        setCachedMember(memberId, { member, bets: betsData, withdrawals: withdrawalsData, paymentOrders: paymentOrdersData, betsCount: betsCountData, manualRechargeToday, manualRecharge3Day, manualRecharge7Day, thirdPartyRechargeToday, thirdPartyRecharge3Day, thirdPartyRecharge7Day, agentRiskScore }, orderCreateTime);
      }
    } else {
      const threeDayStart = effectiveStart - 2 * 24 * 3600 * 1000;

      const t0 = Date.now();

      const userDetailsPromise = apiClient.getUserDetails(queryName, { signal: abortSignal });
      const betsPromise = memberName
        ? apiClient.getMemberBets(queryName, 1, lotteryDateRange, betsMaxPages, { signal: abortSignal }).then(res => extractList<BetRecord>(res))
        : Promise.resolve([] as BetRecord[]);
      const betsCountPromise = memberName
        ? apiClient.getBetsCountToday(queryName, effectiveDateRange, { signal: abortSignal })
        : Promise.resolve(null as ApiResponse<BetsCount> | null);
      const withdrawalsPromise = memberName
        ? apiClient.getMemberWithdrawals(queryName, 1, withdrawalHistoryDateRange, withdrawalsMaxPages, { signal: abortSignal }).then(res => extractList<WithdrawalRecord>(res))
        : Promise.resolve([] as WithdrawalRecord[]);
      const paymentOrdersPromise = memberName
        ? apiClient.getPaymentOrders(queryName, 1, { start: sevenDayStart, end: effectiveEnd }, 3, { signal: abortSignal }).then(res => extractList<PaymentOrder>(res))
        : Promise.resolve([] as PaymentOrder[]);

      const earlyProxyCode = extractProxyCode(orderCtx);
      const earlyAgentProfilePromise = earlyProxyCode
        ? dbHolder.db.agentProfile.findUnique({ where: { proxyCode: earlyProxyCode } }).then(ap => ({ proxyCode: earlyProxyCode, agentRiskScore: ap?.riskScore || 0 })).catch(() => ({ proxyCode: earlyProxyCode, agentRiskScore: 0 }))
        : Promise.resolve({ proxyCode: '', agentRiskScore: 0 });

      const userDetailsSideEffect = userDetailsPromise.then(details => {
        const detail = details?.data || null;
        if (detail) member = detail;
        return details;
      });

      // Stage1: 所有不依赖 member 的调用全部并行（rechargeStats + payTypes 并入主批次）
      const [
        userDetails, betsResult, betsCountResult,
        withdrawalsResult, paymentOrders7DayResult,
        agentProfileRes, rechargeStats, payTypes,
      ] = await Promise.all([
        userDetailsSideEffect, betsPromise, betsCountPromise,
        withdrawalsPromise, paymentOrdersPromise,
        earlyAgentProfilePromise,
        fetchRechargeStats(queryName, effectiveStart, effectiveEnd, threeDayStart, sevenDayStart, abortSignal),
        fetchRechargePayTypes(queryName, sevenDayStart, effectiveEnd, abortSignal),
      ]);

      const t1 = Date.now();

      betsData = betsResult;
      betsCountData = (betsCountResult as ApiResponse<BetsCount> | null)?.data || null;
      withdrawalsData = withdrawalsResult;
      paymentOrdersData = paymentOrders7DayResult;
      rechargePayTypes = payTypes;

      manualRechargeToday = rechargeStats.manualRechargeToday;
      manualRecharge3Day = rechargeStats.manualRecharge3Day;
      manualRecharge7Day = rechargeStats.manualRecharge7Day;
      thirdPartyRechargeToday = rechargeStats.thirdPartyRechargeToday;
      thirdPartyRecharge3Day = rechargeStats.thirdPartyRecharge3Day;
      thirdPartyRecharge7Day = rechargeStats.thirdPartyRecharge7Day;

      if (!member) member = userDetails?.data || { memberId, memberName: queryName };

      agentRiskScore = agentProfileRes?.agentRiskScore ?? null;

      // Stage2: lateProxyCode 需要 member 数据；登录关联统一在公共区按当天日志查询。
      const lateProxyCode = (!agentProfileRes?.proxyCode && member)
        ? extractProxyCode(orderCtx, member)
        : '';
      const lateAgentPromise = lateProxyCode
        ? dbHolder.db.agentProfile.findUnique({ where: { proxyCode: lateProxyCode } }).then(ap => ap?.riskScore || 0).catch(() => -1)
        : Promise.resolve(-1);

      const lateAgentScore = await lateAgentPromise;
      if (lateAgentScore >= 0) agentRiskScore = lateAgentScore;

      if (t1 - t0 > 3000) {
        logger.warn({
          traceId: tid,
          orderNo: order.orderNo || order.id,
          memberName: queryName,
          pipelineMs: t1 - t0,
          betsCount: betsData.length,
          withdrawalsCount: withdrawalsData.length,
          paymentOrdersCount: paymentOrdersData.length,
        }, `[评估器] 流水线耗时 ${t1 - t0}ms`);
      }

      if (isCancelled?.()) return null;
      setCachedMember(memberId, { member, bets: betsData, withdrawals: withdrawalsData, paymentOrders: paymentOrdersData, betsCount: betsCountData, manualRechargeToday, manualRecharge3Day, manualRecharge7Day,
        thirdPartyRechargeToday, thirdPartyRecharge3Day, thirdPartyRecharge7Day, agentRiskScore }, orderCreateTime);
    }

    // 公共区：agentRiskScore 回退。
    // 各路径内已尽力查询（early/late），此处仅在确实未获取到且 proxyCode 可用时做最终查询。
    // 使用模块级 LRU 缓存避免同一 proxyCode 在短时间内重复查询。
    if (agentRiskScore === null) {
      const proxyCode = extractProxyCode(orderCtx, member);
      if (proxyCode) {
        try {
          // 使用本地缓存避免短时间内对同一代理的重复 DB 查询
          const cachedAgentScore = agentScoreCache.get(proxyCode);
          if (cachedAgentScore !== undefined) {
            agentRiskScore = cachedAgentScore;
          } else {
            const agentProfile = await dbHolder.db.agentProfile.findUnique({ where: { proxyCode } });
            agentRiskScore = agentProfile?.riskScore || 0;
            agentScoreCache.set(proxyCode, agentRiskScore);
          }
        } catch (err) {
          logger.debug({ proxyCode, err: (err as Error).message }, '[评估器] 查询代理风险评分失败');
        }
      }
    }

    const [loginAssociations, successfulWithdrawalContext] = await Promise.all([
      getDailyLoginAssociations(member, queryName, orderCreateTime, abortSignal),
      getSuccessfulWithdrawalContext(orderCtx),
    ]);
    lastWithdrawMethod = successfulWithdrawalContext.lastWithdrawMethod;

    const ctx: RuleContext = {
      order: orderCtx,
      member,
      bets: betsData,
      withdrawals: withdrawalsData,
      relatedByLoginIp: loginAssociations.relatedByLoginIp,
      relatedByLoginDevice: loginAssociations.relatedByLoginDevice,
      relatedByLoginIpCount: loginAssociations.relatedByLoginIpCount,
      relatedByLoginDeviceCount: loginAssociations.relatedByLoginDeviceCount,
      dailyLoginIpAssociations: loginAssociations.dailyLoginIpAssociations,
      dailyLoginDeviceAssociations: loginAssociations.dailyLoginDeviceAssociations,
      receivingAssociations: successfulWithdrawalContext.receivingAssociations,
      agentWithdrawCache,
      paymentOrders: paymentOrdersData,
      betsCount: betsCountData,
      manualRechargeToday,
      manualRecharge3Day,
      manualRecharge7Day,
      thirdPartyRechargeToday,
      thirdPartyRecharge3Day,
      thirdPartyRecharge7Day,
      agentRiskScore: agentRiskScore ?? 0,
      tzOffset: getTzOffsetMinutes() / 60,
      associatedMemberBets: new Map(),
      isEarlyMorning,
      rechargePayTypes,
      traceId: tid,
      lastWithdrawMethod,
      currentWithdrawMethod: getWithdrawalMethod(orderCtx),
    };

    const result = await evaluateRules(ctx);
    result.isEarlyMorning = isEarlyMorning;

    const elapsed = Date.now() - startTime;
    if (elapsed > 3000) {
      logger.warn({ traceId: tid, orderNo: order.orderNo || order.id, elapsedMs: elapsed, memberName: order.memberName }, `[评估器] 订单评估耗时 ${elapsed}ms`);
    }

    return result;
  } catch (err) {
    logger.error({ orderNo: order.orderNo || order.id, err: (err as Error).message }, `[评估器] 评估订单 ${order.orderNo || order.id} 失败`);
    return null;
  }
}

/**
 * 将一笔订单的风险评估计入会员/代理画像。
 * ProfileContribution 与画像更新处于同一事务，重启或重试不会重复累计。
 */
export async function recordEvaluationProfile(order: WithdrawOrder, result: EvaluationResult): Promise<void> {
  const orderId = String(result.orderId || order.orderNo || order.id || '');
  const memberName = String(order.memberName || order.member_name || result.memberName || '').trim();
  const memberId = String(result.memberId || order.memberId || order.member_id || '');
  const proxyCode = extractProxyCode(order) || result.proxyCode || '';
  if (!orderId || !memberName || isAgentWhitelisted(memberName)) return;

  try {
    const isHighRisk = ['HIGH', 'CRITICAL'].includes(result.riskLevel);

    await dbHolder.db.$transaction(async (tx) => {
      try {
        await tx.profileContribution.create({
          data: { orderId, memberName, proxyCode },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') return;
        throw err;
      }

      const existing = await tx.memberProfile.findUnique({ where: { memberName } });

      let topRules: Record<string, number> = {};
      try { topRules = existing ? JSON.parse(existing.topRules || '{}') : {}; } catch { topRules = {}; }
      for (const r of result.triggeredRules) {
        topRules[r.id] = (topRules[r.id] || 0) + 1;
      }

      const maxRiskLevel = existing
        ? (riskLevelPriority(result.riskLevel) > riskLevelPriority(existing.maxRiskLevel || '') ? result.riskLevel : existing.maxRiskLevel || result.riskLevel)
        : result.riskLevel;

      const lastEvalScore = result.totalScore;

      await tx.memberProfile.upsert({
        where: { memberName },
        update: {
          memberId: memberId || existing?.memberId || '',
          evalCount: { increment: 1 },
          highRiskCount: { increment: isHighRisk ? 1 : 0 },
          maxRiskLevel,
          lastEvalAt: new Date(),
          lastEvalScore,
          topRules: JSON.stringify(topRules),
        },
        create: {
          memberName,
          memberId: memberId || '',
          evalCount: 1,
          highRiskCount: isHighRisk ? 1 : 0,
          maxRiskLevel: result.riskLevel,
          lastEvalAt: new Date(),
          lastEvalScore: result.totalScore,
          topRules: JSON.stringify(topRules),
        },
      });
      if (!proxyCode || isAgentWhitelisted(proxyCode)) return;

      const existingAgent = await tx.agentProfile.findUnique({ where: { proxyCode } });
      let agentTopRules: Record<string, number> = {};
      try { agentTopRules = existingAgent ? JSON.parse(existingAgent.topRules || '{}') : {}; } catch { agentTopRules = {}; }
      for (const r of result.triggeredRules) {
        agentTopRules[r.id] = (agentTopRules[r.id] || 0) + 1;
      }

      let baseScore = existingAgent?.riskScore || 0;
      if (existingAgent?.updatedAt) {
        const hoursSinceUpdate = (Date.now() - new Date(existingAgent.updatedAt).getTime()) / 3600000;
        baseScore = Math.floor(baseScore * Math.pow(0.999, hoursSinceUpdate));
      }
      const newRiskScore = Math.min(100, baseScore + (isHighRisk ? 5 : 0));

      await tx.agentProfile.upsert({
        where: { proxyCode },
        update: {
          evalCount: { increment: 1 },
          highRiskCount: { increment: isHighRisk ? 1 : 0 },
          riskScore: newRiskScore,
          topRules: JSON.stringify(agentTopRules),
          updatedAt: new Date(),
        },
        create: {
          proxyCode,
          memberCount: 1,
          evalCount: 1,
          highRiskCount: isHighRisk ? 1 : 0,
          riskScore: isHighRisk ? 5 : 0,
          topRules: JSON.stringify(agentTopRules),
        },
      });
    });
  } catch (err) {
    logger.error({ orderId, err: (err as Error).message }, '[画像] 记录订单画像贡献失败');
    throw err;
  }
}

/**
 * 只有平台 A 返回 cashStatus=3（已出款）后才调用。
 * 返回 false 表示本轮未能持久化，调用方必须保留跟踪记录以便下轮重试。
 */
export async function recordSuccessfulWithdrawal(order: WithdrawOrder): Promise<boolean> {
  const orderId = String(order.orderNo || order.id || '');
  const memberId = String(order.memberId || order.member_id || '');
  const memberName = String(order.memberName || order.member_name || '').trim();
  // 上游偶发缺少 memberId 时，仍可用订单号和账号安全去重并保留成功提款历史。
  // 不能因此丢失后续的收款信息变更与同收款关联基准。
  if (!orderId || !memberName || isAgentWhitelisted(memberName)) return true;

  const amount = parseFloat(String(order.amount || '0')) || 0;
  const createTimeMs = parseTimeStr(order.createTime) || Date.now();
  const method = getWithdrawalMethod(order);
  const fingerprint = receivingFingerprint(order);
  const proxyCode = extractProxyCode(order);

  try {
    return await dbHolder.db.$transaction(async (tx) => {
      const existingWithdrawal = await tx.successfulWithdrawal.findUnique({ where: { orderId } });
      if (existingWithdrawal) return true;

      await tx.successfulWithdrawal.create({
        data: {
          orderId,
          memberId,
          memberName,
          amount,
          receivingBank: method?.bank || '',
          receivingName: method?.name || '',
          receivingCardNo: method?.card || '',
          receivingFingerprint: fingerprint,
          createTime: new Date(createTimeMs),
        },
      });

      const existingProfile = await tx.memberProfile.findUnique({ where: { memberName } });
      let trend: { time: number; amount: number }[] = [];
      try { trend = existingProfile ? JSON.parse(existingProfile.recentWithdrawTrend || '[]') : []; } catch { trend = []; }
      trend.push({ time: createTimeMs, amount });
      const recentTrend = trend.filter(item => item.time >= createTimeMs - 7 * 86400000).slice(-20);

      await tx.memberProfile.upsert({
        where: { memberName },
        update: {
          memberId,
          totalWithdrawAmount: { increment: amount },
          recentWithdrawTrend: JSON.stringify(recentTrend),
          ...(method ? { lastWithdrawMethod: JSON.stringify(method) } : {}),
        },
        create: {
          memberName,
          memberId,
          totalWithdrawAmount: amount,
          recentWithdrawTrend: JSON.stringify(recentTrend),
          ...(method ? { lastWithdrawMethod: JSON.stringify(method) } : {}),
        },
      });

      if (proxyCode && !isAgentWhitelisted(proxyCode)) {
        await tx.agentProfile.upsert({
          where: { proxyCode },
          update: { totalWithdrawAmount: { increment: amount } },
          create: { proxyCode, memberCount: 1, totalWithdrawAmount: amount },
        });
      }
      return true;
    });
  } catch (err) {
    logger.error({ orderId, err: (err as Error).message }, '[画像] 记录成功提款失败，将保留状态跟踪以便重试');
    return false;
  }
}

function riskLevelPriority(level: string): number {
  switch (level) {
    case 'CRITICAL': return 4;
    case 'HIGH': return 3;
    case 'MEDIUM': return 2;
    case 'LOW': return 1;
    default: return 0;
  }
}

export async function getMemberProfileText(memberName: string): Promise<string | null> {
  try {
    const profile = await dbHolder.db.memberProfile.findUnique({ where: { memberName } });
    if (!profile) return null;

    const topRules: Record<string, number> = JSON.parse(profile.topRules || '{}');
    const sortedRules = Object.entries(topRules).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const rulesText = sortedRules.map(([id, count]) => `${id}(${count}次)`).join('、') || '无';

    const lastEval = profile.lastEvalAt ? formatBeijingTime(profile.lastEvalAt) : '无';

    return [
      `📊 会员风险画像：${memberName}`,
      ``,
      `评估次数：${profile.evalCount}`,
      `高风险次数：${profile.highRiskCount}`,
      `最高风险：${profile.maxRiskLevel || '无'}`,
      `最高评分：${profile.lastEvalScore}`,
      `累计提现：${fmtNum(profile.totalWithdrawAmount)}`,
      `最近评估：${lastEval}`,
      `高频规则：${rulesText}`,
    ].join('\n');
  } catch {
    return null;
  }
}

export async function getAgentRiskScore(proxyCode: string): Promise<number> {
  try {
    const profile = await dbHolder.db.agentProfile.findUnique({ where: { proxyCode } });
    return profile?.riskScore || 0;
  } catch {
    return 0;
  }
}
