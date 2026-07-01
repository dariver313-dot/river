import crypto from 'crypto';
import { apiClient } from './api-client';
import type { RuleContext, EvaluationResult } from './rule-types';
import { evaluateRules } from './rule-engine';
import { dbHolder } from './db';
import { logger } from './logger';
import { AGENT_WHITELIST } from './constants';
import { parseTimeStr, absFloat, fmtNum, extractProxyCode, formatBeijingTime, getTzOffsetMinutes } from './utils';
import type { WithdrawOrder } from './types';
import type { MemberInfo, BetRecord, WithdrawalRecord, PaymentOrder, BetsCount, MemberCacheData, UserDetailsResponse, ApiResponse, PagedResponse, LoginLogItem, NewRechReport, NewRechargeOrderHistory } from './types';
import { LRUCache } from 'lru-cache';

const MAX_MEMBER_CACHE = 500;
const MAX_RECEIVING_CACHE = 5000;
const MAX_PAY_CHANNEL_CACHE = 5000;

const CACHE_TTL = 5 * 60 * 1000;
const BET_CACHE_TTL = 180 * 1000; // 3分钟投注缓存：平衡 API 调用量与时效性

// 同会话内已见期号缓存，防止短时间内同一会员多次提现重复检查相同期号
const memberSeenIssueKeys = new LRUCache<string, Set<string>>({
  max: MAX_MEMBER_CACHE,
  ttl: CACHE_TTL,
});

const memberCache = new LRUCache<string, { data: MemberCacheData; betExpire: number; dateRangeStart?: number }>({
  max: MAX_MEMBER_CACHE,
  ttl: CACHE_TTL,
});

const RECEIVING_CACHE_TTL = 10 * 60 * 1000;
const AGENT_CACHE_TTL = 30 * 60 * 1000;
const PAY_CHANNEL_CACHE_TTL = 10 * 60 * 1000;

const receivingInfoCache = new LRUCache<string, { data: Set<string> }>({
  max: MAX_RECEIVING_CACHE,
  ttl: RECEIVING_CACHE_TTL,
});

const agentWithdrawCache = new LRUCache<string, { count: number; memberIds: Set<string>; lastUpdate: number }>({
  max: MAX_MEMBER_CACHE,
  ttl: AGENT_CACHE_TTL,
});

const payChannelCache = new LRUCache<string, { data: Set<string> }>({
  max: MAX_PAY_CHANNEL_CACHE,
  ttl: PAY_CHANNEL_CACHE_TTL,
});

// 代理风险评分短期缓存，避免同一代理在并发评估中被重复查询
const agentScoreCache = new LRUCache<string, number>({
  max: 500,
  ttl: 5 * 60 * 1000,
});

const IP_DEVICE_CACHE_TTL = 60 * 60 * 1000;

export const ipMemberCache = new LRUCache<string, { members: Set<string> }>({
  max: 2000,
  ttl: IP_DEVICE_CACHE_TTL,
});

export const deviceMemberCache = new LRUCache<string, { members: Set<string> }>({
  max: 2000,
  ttl: IP_DEVICE_CACHE_TTL,
});

// 缓存会员的登录日志，避免 /checkuser 每次都调用 API
export const memberLoginLogsCache = new LRUCache<string, { ips: string[]; devices: string[] }>({
  max: 500,
  ttl: 10 * 60 * 1000,
});

function getCachedMember(memberId: string, dateRangeStart?: number): { data: MemberCacheData; betStale: boolean } | null {
  const entry = memberCache.get(memberId);
  if (!entry) return null;
  const betStale = Date.now() > entry.betExpire || (dateRangeStart !== undefined && entry.dateRangeStart !== dateRangeStart);
  return { data: entry.data, betStale };
}

function setCachedMember(memberId: string, data: MemberCacheData, dateRangeStart?: number): void {
  memberCache.set(memberId, { data, betExpire: Date.now() + BET_CACHE_TTL, dateRangeStart });
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

export function updateReceivingCache(order: WithdrawOrder): void {
  const receivingName = order?.receivingName;
  const receivingCardNo = order?.receivingCardNo;
  const memberId = String(order?.memberId || '');
  if (!receivingName || !receivingCardNo || !memberId) return;

  const key = `${receivingName}:${receivingCardNo}`;
  const entry = receivingInfoCache.get(key);
  if (entry) {
    entry.data.add(memberId);
    receivingInfoCache.set(key, entry);
  } else {
    receivingInfoCache.set(key, { data: new Set<string>([memberId]) });
  }
}

// 防止同一订单重复计入代理缓存
const agentCacheOrderDedup = new LRUCache<string, boolean>({ max: 2000, ttl: 30 * 60 * 1000 });

function updateAgentCache(order: WithdrawOrder): void {
  const proxyCode = extractProxyCode(order);
  const memberName = String(order?.memberName || order?.member_name || '');
  const orderNo = String(order?.orderNo || order?.id || '');
  if (!proxyCode || !memberName) return;
  if (AGENT_WHITELIST.has(proxyCode)) return;

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

function updatePayChannelCache(memberId: string, memberDetail: MemberInfo): void {
  const rechargeOrders = memberDetail?.latestRechargeOrder || [];
  for (const order of rechargeOrders) {
    const channel = order.paywayName || order.payPlatformCode;
    if (!channel) continue;
    const entry = payChannelCache.get(channel);
    if (entry) {
      entry.data.add(memberId);
      payChannelCache.set(channel, entry);
    } else {
      payChannelCache.set(channel, { data: new Set<string>([memberId]) });
    }
  }
}

export function getReceivingInfoCache(): LRUCache<string, { data: Set<string> }> {
  return receivingInfoCache;
}

export function getAgentWithdrawCache(): LRUCache<string, { count: number; memberIds: Set<string>; lastUpdate: number }> {
  return agentWithdrawCache;
}

export function cleanupStaleCaches(): void {
  // LRU with TTL handles eviction automatically.
  // Kept as explicit API for future manual cleanup needs.
}

async function fetchRechargeStats(
  account: string,
  effectiveStart: number,
  effectiveEnd: number,
  threeDayStart: number,
  sevenDayStart: number,
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
      apiClient.getRechReport(account, sevenDayStart, effectiveEnd),
      apiClient.getRechReport(account, threeDayStart, effectiveEnd),
      apiClient.getRechReport(account, effectiveStart, effectiveEnd),
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
    return { manualRechargeToday: 0, manualRecharge3Day: 0, manualRecharge7Day: 0, thirdPartyRechargeToday: 0, thirdPartyRecharge3Day: 0, thirdPartyRecharge7Day: 0 };
  }
}

/** 提取会员近7天充值渠道（payTypeName 去重），用于检测充值/提款渠道不一致 */
async function fetchRechargePayTypes(account: string, sevenDayStart: number, effectiveEnd: number): Promise<Set<string>> {
  if (!account) return new Set();
  try {
    const records = await apiClient.getRechargeOrderHistory(account, sevenDayStart, effectiveEnd);
    const payTypes = new Set<string>();
    for (const r of records) {
      const pt = (r.payTypeName || '').trim();
      if (pt) payTypes.add(pt);
    }
    return payTypes;
  } catch (err) {
    logger.warn({ account, err: (err as Error).message }, '[评估器] 获取充值渠道失败');
    return new Set();
  }
}

/** 获取所有缓存的容量统计（用于监控和调试） */
export function getCacheStats(): Record<string, { size: number; max: number; utilization: string }> {
  const stats: Record<string, { size: number; max: number; utilization: string }> = {};
  for (const [name, cache] of [
    ['memberCache', memberCache],
    ['receivingInfoCache', receivingInfoCache],
    ['agentWithdrawCache', agentWithdrawCache],
    ['payChannelCache', payChannelCache],
    ['ipMemberCache', ipMemberCache],
    ['deviceMemberCache', deviceMemberCache],
    ['memberLoginLogsCache', memberLoginLogsCache],
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
    const result = await existing;
    if (result && order.orderNo) {
      return {
        ...result,
        orderId: String(order.orderNo || order.id),
        orderAmount: String(order.amount ?? result.orderAmount),
        balance: String(order.balance ?? result.balance),
        triggeredRules: result.triggeredRules.map(r => ({ ...r })),
      };
    }
    // 共享评估结果为 null（超时/失败），但 evaluatingMembers 中已被旧 IIFE 的 finally 清理。
    // 此时 memberId 不在 map 中，可以安全地重新注册。
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
    updateReceivingCache(order);
    updateAgentCache(order);

    const orderCreateTime = parseTimeStr(order.createTime || (order as Record<string, unknown>).createdAt as string | number | undefined);
    const effectiveDateRange = apiClient.getEffectiveDateRange(orderCreateTime);
    const { start: effectiveStart, end: effectiveEnd, isEarlyMorning } = effectiveDateRange;
    const sevenDayStart = effectiveStart - 6 * 24 * 3600 * 1000;
    const betsMaxPages = isEarlyMorning === true ? 5 : 3;
    const withdrawalsMaxPages = isEarlyMorning === true ? 3 : 2;

    const cached = getCachedMember(memberId, effectiveStart);
    const memberName = order.memberName || order.member_name || '';
    const queryName = memberName || order.memberName || memberId;
    let member: MemberInfo = { memberId, memberName: queryName };
    let betsData: BetRecord[];
    let withdrawalsData: WithdrawalRecord[];
    let thirdGameData: unknown[];
    let paymentOrdersData: PaymentOrder[];
    let betsCountData: BetsCount | null;
    let manualRechargeToday: number;
    let manualRecharge3Day: number;
    let manualRecharge7Day: number;
    let thirdPartyRechargeToday: number;
    let thirdPartyRecharge3Day: number;
    let thirdPartyRecharge7Day: number;
    let rechargePayTypes = new Set<string>();
    let loginIpResult: PagedResponse<LoginLogItem> = { items: [], totalNum: '0' };
    let loginDeviceResult: PagedResponse<LoginLogItem> = { items: [], totalNum: '0' };

    if (!memberName && memberId) {
      logger.warn({ orderNo: order.orderNo || order.id, memberId }, '[评估器] 订单缺少 memberName，使用 memberId 作为查询参数，部分 API 可能返回空数据');
    }

    let agentRiskScore: number | null = null;
    let lastWithdrawMethod: { bank: string; card: string; name: string } | null = null;

    if (cached) {
      member = cached.data.member;

      if (!cached.betStale) {
        betsData = cached.data.bets;
        withdrawalsData = cached.data.withdrawals;
        thirdGameData = cached.data.thirdGames || [];
        paymentOrdersData = cached.data.paymentOrders || [];
        betsCountData = cached.data.betsCount || null;
        manualRechargeToday = cached.data.manualRechargeToday || 0;
        manualRecharge3Day = cached.data.manualRecharge3Day || 0;
        manualRecharge7Day = cached.data.manualRecharge7Day || 0;
        thirdPartyRechargeToday = cached.data.thirdPartyRechargeToday || 0;
        thirdPartyRecharge3Day = cached.data.thirdPartyRecharge3Day || 0;
        thirdPartyRecharge7Day = cached.data.thirdPartyRecharge7Day || 0;
        agentRiskScore = cached.data.agentRiskScore ?? null;
        lastWithdrawMethod = cached.data.lastWithdrawMethod ?? null;

        // login logs + pay types 并行（member 在缓存中可用，无需等待其他 API）
        const [lipRes, ldRes, payTypes] = await Promise.all([
          member.lastLoginIp
            ? apiClient.getLoginLogsByIp(member.lastLoginIp).catch(() => ({ items: [] as LoginLogItem[], totalNum: '0' }))
            : Promise.resolve({ items: [] as LoginLogItem[], totalNum: '0' }),
          member.lastLoginDeviceClientId
            ? apiClient.getLoginLogsByDevice(member.lastLoginDeviceClientId).catch(() => ({ items: [] as LoginLogItem[], totalNum: '0' }))
            : Promise.resolve({ items: [] as LoginLogItem[], totalNum: '0' }),
          fetchRechargePayTypes(queryName, sevenDayStart, effectiveEnd),
        ]);
        loginIpResult = lipRes;
        loginDeviceResult = ldRes;
        rechargePayTypes = payTypes;

        if (isCancelled?.()) return null;
      } else {
        const threeDayStart = effectiveStart - 2 * 24 * 3600 * 1000;

        const proxyCode = extractProxyCode(orderCtx, member);
        const agentProfilePromise = proxyCode
          ? dbHolder.db.agentProfile.findUnique({ where: { proxyCode } }).then(ap => ({ proxyCode, agentRiskScore: ap?.riskScore || 0 })).catch(() => ({ proxyCode, agentRiskScore: 0 }))
          : Promise.resolve({ proxyCode: '', agentRiskScore: 0 });

        const memberRefreshPromise = apiClient.getUserDetails(queryName).catch(() => null);

        // 所有独立 API 调用合并为一个并行批次（member 在缓存中，login logs 也可并行）
        const [
          betsResult, betsCountResult,
          withdrawalsResult, paymentOrders7DayResult,
          agentProfileRes, memberRefreshRes,
          rechargeStats, payTypes,
          lipRes, ldRes,
        ] = await Promise.all([
          memberName ? apiClient.getMemberBetsToday(queryName, 1, effectiveDateRange, betsMaxPages).then(res => extractList<BetRecord>(res)).catch(() => [] as BetRecord[]) : Promise.resolve([] as BetRecord[]),
          memberName ? apiClient.getBetsCountToday(queryName, effectiveDateRange).catch(() => null) : Promise.resolve(null as ApiResponse<BetsCount> | null),
          memberName ? apiClient.getMemberWithdrawals(queryName, 1, effectiveDateRange, withdrawalsMaxPages).then(res => extractList<WithdrawalRecord>(res)).catch(() => [] as WithdrawalRecord[]) : Promise.resolve([] as WithdrawalRecord[]),
          memberName ? apiClient.getPaymentOrders(queryName, 1, { start: sevenDayStart, end: effectiveEnd }).then(res => extractList<PaymentOrder>(res)).catch(() => [] as PaymentOrder[]) : Promise.resolve([] as PaymentOrder[]),
          agentProfilePromise,
          memberRefreshPromise,
          fetchRechargeStats(queryName, effectiveStart, effectiveEnd, threeDayStart, sevenDayStart),
          fetchRechargePayTypes(queryName, sevenDayStart, effectiveEnd),
          member.lastLoginIp
            ? apiClient.getLoginLogsByIp(member.lastLoginIp).catch(() => ({ items: [] as LoginLogItem[], totalNum: '0' }))
            : Promise.resolve({ items: [] as LoginLogItem[], totalNum: '0' }),
          member.lastLoginDeviceClientId
            ? apiClient.getLoginLogsByDevice(member.lastLoginDeviceClientId).catch(() => ({ items: [] as LoginLogItem[], totalNum: '0' }))
            : Promise.resolve({ items: [] as LoginLogItem[], totalNum: '0' }),
        ]);
        betsData = betsResult;
        thirdGameData = [];
        betsCountData = (betsCountResult as ApiResponse<BetsCount> | null)?.data || null;
        withdrawalsData = withdrawalsResult;
        paymentOrdersData = paymentOrders7DayResult;
        loginIpResult = lipRes;
        loginDeviceResult = ldRes;
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
        setCachedMember(memberId, { member, bets: betsData, withdrawals: withdrawalsData, thirdGames: thirdGameData, paymentOrders: paymentOrdersData, betsCount: betsCountData, manualRechargeToday, manualRecharge3Day, manualRecharge7Day, thirdPartyRechargeToday, thirdPartyRecharge3Day, thirdPartyRecharge7Day, agentRiskScore, lastWithdrawMethod }, effectiveStart);
      }
    } else {
      const threeDayStart = effectiveStart - 2 * 24 * 3600 * 1000;

      const t0 = Date.now();

      const userDetailsPromise = apiClient.getUserDetails(queryName).catch(() => null);
      const betsPromise = memberName
        ? apiClient.getMemberBetsToday(queryName, 1, effectiveDateRange, betsMaxPages).then(res => extractList<BetRecord>(res)).catch(() => [] as BetRecord[])
        : Promise.resolve([] as BetRecord[]);
      const betsCountPromise = memberName
        ? apiClient.getBetsCountToday(queryName, effectiveDateRange).catch(() => null)
        : Promise.resolve(null as ApiResponse<BetsCount> | null);
      const withdrawalsPromise = memberName
        ? apiClient.getMemberWithdrawals(queryName, 1, effectiveDateRange, withdrawalsMaxPages).then(res => extractList<WithdrawalRecord>(res)).catch(() => [] as WithdrawalRecord[])
        : Promise.resolve([] as WithdrawalRecord[]);
      const paymentOrdersPromise = memberName
        ? apiClient.getPaymentOrders(queryName, 1, { start: sevenDayStart, end: effectiveEnd }).then(res => extractList<PaymentOrder>(res)).catch(() => [] as PaymentOrder[])
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
        fetchRechargeStats(queryName, effectiveStart, effectiveEnd, threeDayStart, sevenDayStart),
        fetchRechargePayTypes(queryName, sevenDayStart, effectiveEnd),
      ]);

      const t1 = Date.now();

      betsData = betsResult;
      thirdGameData = [];
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

      // Stage2: login logs + lateProxyCode 并行（都需要 member 数据）
      const lateProxyCode = (!agentProfileRes?.proxyCode && member)
        ? extractProxyCode(orderCtx, member)
        : '';
      const lateAgentPromise = lateProxyCode
        ? dbHolder.db.agentProfile.findUnique({ where: { proxyCode: lateProxyCode } }).then(ap => ap?.riskScore || 0).catch(() => -1)
        : Promise.resolve(-1);

      const [lipRes, ldRes, lateAgentScore] = await Promise.all([
        member.lastLoginIp
          ? apiClient.getLoginLogsByIp(member.lastLoginIp).catch(() => ({ items: [] as LoginLogItem[], totalNum: '0' }))
          : Promise.resolve({ items: [] as LoginLogItem[], totalNum: '0' }),
        member.lastLoginDeviceClientId
          ? apiClient.getLoginLogsByDevice(member.lastLoginDeviceClientId).catch(() => ({ items: [] as LoginLogItem[], totalNum: '0' }))
          : Promise.resolve({ items: [] as LoginLogItem[], totalNum: '0' }),
        lateAgentPromise,
      ]);
      loginIpResult = lipRes;
      loginDeviceResult = ldRes;
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
      setCachedMember(memberId, { member, bets: betsData, withdrawals: withdrawalsData, thirdGames: thirdGameData, paymentOrders: paymentOrdersData, betsCount: betsCountData, manualRechargeToday, manualRecharge3Day, manualRecharge7Day,
        thirdPartyRechargeToday, thirdPartyRecharge3Day, thirdPartyRecharge7Day, agentRiskScore, lastWithdrawMethod }, effectiveStart);
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

    // 同会话内已见期号：预填充 reviewedPeriodKeys 以减少对相同期号的重复规则匹配
    const seenIssueKeys = memberSeenIssueKeys.get(memberId) || new Set<string>();
    // 将当前投注的期号加入已见集合（下次同会员评估时自动跳过）
    for (const b of betsData) {
      if (b.lotteryName && b.issue) {
        seenIssueKeys.add(`${b.lotteryName}::${b.issue}`);
      }
    }
    memberSeenIssueKeys.set(memberId, seenIssueKeys);

    try {
      const profile = await dbHolder.db.memberProfile.findUnique({ where: { memberName: queryName } });
      if (profile?.lastWithdrawMethod) {
        lastWithdrawMethod = JSON.parse(profile.lastWithdrawMethod);
      }
    } catch { /* 首次评估时可能无记录 */ }

    const ctx: RuleContext = {
      order: orderCtx,
      member,
      bets: betsData,
      withdrawals: withdrawalsData,
      relatedByLoginIp: loginIpResult.items || [],
      relatedByLoginDevice: loginDeviceResult.items || [],
      relatedByLoginIpCount: Number(loginIpResult.totalNum) || (loginIpResult.items || []).length,
      relatedByLoginDeviceCount: Number(loginDeviceResult.totalNum) || (loginDeviceResult.items || []).length,
      receivingInfoCache,
      agentWithdrawCache,
      payChannelCache,
      thirdGameBets: thirdGameData,
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
      reviewedPeriodKeys: seenIssueKeys.size > 0 ? seenIssueKeys : undefined,
      lastWithdrawMethod,
    };

    const result = await evaluateRules(ctx);
    result.isEarlyMorning = isEarlyMorning;

    if (member) {
      updatePayChannelCache(String(memberId), member);
    }

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

export async function updateMemberProfile(memberName: string, memberId: string, result: EvaluationResult, order: WithdrawOrder): Promise<void> {
  try {
    const amount = parseFloat(String(order?.amount || '0'));
    const isHighRisk = ['HIGH', 'CRITICAL'].includes(result.riskLevel);

    const lastWithdrawMethod = JSON.stringify({
      bank: String(order?.receivingBank || '').trim(),
      card: String(order?.receivingCardNo || '').trim(),
      name: String(order?.receivingName || '').trim(),
    });

    // 使用事务 + 乐观锁避免 TOCTOU 竞态
    await dbHolder.db.$transaction(async (tx) => {
      const existing = await tx.memberProfile.findUnique({ where: { memberName } });

      let topRules: Record<string, number> = {};
      try { topRules = existing ? JSON.parse(existing.topRules || '{}') : {}; } catch { topRules = {}; }
      for (const r of result.triggeredRules) {
        topRules[r.id] = (topRules[r.id] || 0) + 1;
      }

      let trend: { time: number; amount: number }[] = [];
      try { trend = existing ? JSON.parse(existing.recentWithdrawTrend || '[]') : []; } catch { trend = []; }
      trend.push({ time: Date.now(), amount });
      const sevenDaysAgo = Date.now() - 7 * 86400000;
      const recentTrend = trend.filter(t => t.time > sevenDaysAgo).slice(-20);

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
          totalWithdrawAmount: { increment: amount },
          recentWithdrawTrend: JSON.stringify(recentTrend),
          lastWithdrawMethod,
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
          totalWithdrawAmount: amount,
          recentWithdrawTrend: JSON.stringify(recentTrend),
          lastWithdrawMethod,
        },
      });
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[画像] 更新会员画像失败');
  }
}

export async function updateAgentProfile(proxyCode: string, memberName: string, result: EvaluationResult, order: WithdrawOrder): Promise<void> {
  if (!proxyCode) return;
  if (AGENT_WHITELIST.has(proxyCode)) return;
  try {
    const amount = parseFloat(String(order?.amount || '0'));
    const isHighRisk = ['HIGH', 'CRITICAL'].includes(result.riskLevel);

    // 使用事务避免 TOCTOU 竞态
    await dbHolder.db.$transaction(async (tx) => {
      const existing = await tx.agentProfile.findUnique({ where: { proxyCode } });

      let topRules: Record<string, number> = {};
      try { topRules = existing ? JSON.parse(existing.topRules || '{}') : {}; } catch { topRules = {}; }
      for (const r of result.triggeredRules) {
        topRules[r.id] = (topRules[r.id] || 0) + 1;
      }

      let baseScore = existing?.riskScore || 0;
      if (existing?.updatedAt) {
        const hoursSinceUpdate = (Date.now() - new Date(existing.updatedAt).getTime()) / 3600000;
        baseScore = Math.floor(baseScore * Math.pow(0.999, hoursSinceUpdate));
      }
      const newRiskScore = Math.min(100, baseScore + (isHighRisk ? 5 : 0));

      await tx.agentProfile.upsert({
        where: { proxyCode },
        update: {
          evalCount: { increment: 1 },
          highRiskCount: { increment: isHighRisk ? 1 : 0 },
          totalWithdrawAmount: { increment: amount },
          riskScore: newRiskScore,
          topRules: JSON.stringify(topRules),
          updatedAt: new Date(),
        },
        create: {
          proxyCode,
          memberCount: 1,
          evalCount: 1,
          highRiskCount: isHighRisk ? 1 : 0,
          totalWithdrawAmount: amount,
          riskScore: isHighRisk ? 5 : 0,
          topRules: JSON.stringify(topRules),
        },
      });
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[画像] 更新代理画像失败');
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
