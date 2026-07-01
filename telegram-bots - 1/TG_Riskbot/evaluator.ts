import crypto from 'crypto';
import { apiClient } from './api-client';
import type { RuleContext, EvaluationResult } from './rule-types';
import { evaluateRules } from './rule-engine';
import { dbHolder } from './db';
import { logger } from './logger';
import { AGENT_WHITELIST } from './constants';
import { parseTimeStr, absFloat, fmtNum, extractProxyCode, formatBeijingTime } from './utils';
import { type WithdrawOrder } from './ws-client';
import type { MemberInfo, BetRecord, WithdrawalRecord, ThirdGameOrder, PaymentOrder, BetsCount, LoginLogItem, MemberCacheData, UserDetailsResponse, RechargeSumResponse, ApiResponse, PagedResponse, MemberInOutReport } from './types';
import { LRUCache } from 'lru-cache';

const MAX_MEMBER_CACHE = 500;
const MAX_RECEIVING_CACHE = 5000;
const MAX_PAY_CHANNEL_CACHE = 5000;

const CACHE_TTL = 5 * 60 * 1000;
const BET_CACHE_TTL = 120 * 1000;

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

function extractSumAmount(res: RechargeSumResponse | null): number {
  if (!res) return 0;
  const d = res.data;
  if (d && typeof d === 'object') return parseFloat(String(d.sumAmount || d.amount || '0'));
  if (typeof d === 'string' || typeof d === 'number') return parseFloat(String(d)) || 0;
  return parseFloat(String(res.sumAmount || '0'));
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

function updateAgentCache(order: WithdrawOrder): void {
  const proxyCode = extractProxyCode(order);
  const memberName = String(order?.memberName || order?.member_name || '');
  if (!proxyCode || !memberName) return;
  if (AGENT_WHITELIST.has(proxyCode)) return;

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

interface StringMap<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): this;
  delete(key: string): boolean;
  has(key: string): boolean;
}

let _prefetchStore: StringMap<Promise<UserDetailsResponse | null>> | null = null;

export function setPrefetchStore(store: StringMap<Promise<UserDetailsResponse | null>>): void {
  _prefetchStore = store;
}

export function consumePrefetchedDetail(orderNo: string): Promise<UserDetailsResponse | null> | null {
  if (!_prefetchStore) return null;
  const p = _prefetchStore.get(orderNo) || null;
  if (p) _prefetchStore.delete(orderNo);
  return p;
}

export async function evaluateOrder(order: WithdrawOrder): Promise<EvaluationResult | null> {
  const memberId = order.memberId || order.member_id;
  const traceId = crypto.randomUUID();
  if (!memberId) {
    logger.warn({ orderNo: order.orderNo || order.id, traceId }, '[评估器] 订单缺少 memberId');
    return null;
  }

  const existing = evaluatingMembers.get(memberId);
  if (existing) {
    consumePrefetchedDetail(String(order.orderNo || order.id));
    const result = await existing;
    if (result) {
      // 复用数据获取结果，但使用当前订单的上下文重新评估规则
      // 避免不同金额的订单复用相同的风险等级
      const orderCtx = { ...order };
      updateReceivingCache(order);
      updateAgentCache(order);

      const orderCreateTime = parseTimeStr(order.createTime || (order as Record<string, unknown>).createdAt as string | number | undefined);
      const effectiveDateRange = apiClient.getEffectiveDateRange(orderCreateTime);
      const { isEarlyMorning } = effectiveDateRange;

      // 从缓存获取该会员的数据
      const cached = getCachedMember(memberId, effectiveDateRange.start);
      if (cached) {
        const ctx: RuleContext = {
          order: orderCtx,
          member: cached.data.member,
          bets: cached.data.bets,
          withdrawals: cached.data.withdrawals,
          relatedByLoginIp: [],
          relatedByLoginDevice: [],
          relatedByLoginIpCount: 0,
          relatedByLoginDeviceCount: 0,
          receivingInfoCache,
          agentWithdrawCache,
          payChannelCache,
          thirdGameBets: cached.data.thirdGames || [],
          paymentOrders: cached.data.paymentOrders || [],
          betsCount: cached.data.betsCount || null,
          manualRechargeToday: cached.data.manualRechargeToday || 0,
          manualRecharge3Day: cached.data.manualRecharge3Day || 0,
          manualRecharge7Day: cached.data.manualRecharge7Day || 0,
          thirdPartyRechargeToday: cached.data.thirdPartyRechargeToday || 0,
          thirdPartyRecharge3Day: cached.data.thirdPartyRecharge3Day || 0,
          thirdPartyRecharge7Day: cached.data.thirdPartyRecharge7Day || 0,
          agentRiskScore: cached.data.agentRiskScore ?? 0,
      tzOffset: parseInt(process.env.TZ_OFFSET || '8', 10) || 8,
      associatedMemberBets: new Map(),
      isEarlyMorning,
      traceId: crypto.randomUUID(),
      lastWithdrawMethod: cached.data.lastWithdrawMethod,
    };
        const reevalResult = await evaluateRules(ctx);
        reevalResult.isEarlyMorning = isEarlyMorning;
        return {
          ...reevalResult,
          orderId: String(order.orderNo || order.id),
          orderAmount: String(order.amount ?? reevalResult.orderAmount),
          balance: String(order.balance ?? reevalResult.balance),
        };
      }
      // 缓存不可用时，返回复用结果（仅覆盖订单特定字段）
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
    const betsMaxPages = isEarlyMorning ? 5 : 3;
    const withdrawalsMaxPages = isEarlyMorning ? 3 : 2;

    const cached = getCachedMember(memberId, effectiveStart);
    const memberName = order.memberName || order.member_name || '';
    const queryName = memberName || order.memberName || memberId;
    let member: MemberInfo = { memberId, memberName: queryName };
    let betsData: BetRecord[];
    let withdrawalsData: WithdrawalRecord[];
    let thirdGameData: ThirdGameOrder[];
    let paymentOrdersData: PaymentOrder[];
    let betsCountData: BetsCount | null;
    let manualRechargeToday: number;
    let manualRecharge3Day: number;
    let manualRecharge7Day: number;
    let thirdPartyRechargeToday: number;
    let thirdPartyRecharge3Day: number;
    let thirdPartyRecharge7Day: number;

    if (!memberName && memberId) {
      logger.warn({ orderNo: order.orderNo || order.id, memberId }, '[评估器] 订单缺少 memberName，使用 memberId 作为查询参数，部分 API 可能返回空数据');
    }

    let agentRiskScore: number | null = null;
    let lastWithdrawMethod: { bank: string; card: string; name: string } | null = null;
    let mainGameType: string | null = null;

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
        mainGameType = cached.data.mainGameType ?? null;
      } else {
        const sevenDayStart = effectiveStart - 6 * 24 * 3600 * 1000;
        const threeDayStart = effectiveStart - 2 * 24 * 3600 * 1000;

        const proxyCode = extractProxyCode(orderCtx, member);
        const agentProfilePromise = proxyCode
          ? dbHolder.db.agentProfile.findUnique({ where: { proxyCode } }).then(ap => ({ proxyCode, agentRiskScore: ap?.riskScore || 0 })).catch(() => ({ proxyCode, agentRiskScore: 0 }))
          : Promise.resolve({ proxyCode: '', agentRiskScore: 0 });

        const memberRefreshPromise = apiClient.getUserDetails(queryName).catch(() => null);

        const [
          betsResult, thirdGameResult, betsCountResult,
          withdrawalsResult, paymentOrders7DayResult,
          manual7DayRes, manual3DayRes, manualTodayRes,
          agentProfileRes, memberRefreshRes,
          inOutReportRes,
        ] = await Promise.all([
          memberName ? apiClient.getMemberBetsToday(queryName, 1, effectiveDateRange, betsMaxPages).then(res => extractList<BetRecord>(res)).catch(() => [] as BetRecord[]) : Promise.resolve([] as BetRecord[]),
          memberName ? apiClient.getThirdGameOrders(queryName, 1, effectiveDateRange).then(res => extractList<ThirdGameOrder>(res)).catch(() => [] as ThirdGameOrder[]) : Promise.resolve([] as ThirdGameOrder[]),
          memberName ? apiClient.getBetsCountToday(queryName, effectiveDateRange).catch(() => null) : Promise.resolve(null as ApiResponse<BetsCount> | null),
          memberName ? apiClient.getMemberWithdrawals(queryName, 1, effectiveDateRange, withdrawalsMaxPages).then(res => extractList<WithdrawalRecord>(res)).catch(() => [] as WithdrawalRecord[]) : Promise.resolve([] as WithdrawalRecord[]),
          memberName ? apiClient.getPaymentOrders(queryName, 1, { start: sevenDayStart, end: effectiveEnd }).then(res => extractList<PaymentOrder>(res)).catch(() => [] as PaymentOrder[]) : Promise.resolve([] as PaymentOrder[]),
          memberName ? apiClient.getManualRechargeSum(queryName, sevenDayStart, effectiveEnd).catch(() => null) : Promise.resolve(null as RechargeSumResponse | null),
          memberName ? apiClient.getManualRechargeSum(queryName, threeDayStart, effectiveEnd).catch(() => null) : Promise.resolve(null as RechargeSumResponse | null),
          memberName ? apiClient.getManualRechargeSum(queryName, effectiveStart, effectiveEnd).catch(() => null) : Promise.resolve(null as RechargeSumResponse | null),
          agentProfilePromise,
          memberRefreshPromise,
          memberName ? apiClient.getMemberInOutReport(queryName).catch(() => ({ report: null, mainGameType: null })) : Promise.resolve({ report: null, mainGameType: null }),
        ]);
        betsData = betsResult;
        thirdGameData = thirdGameResult;
        betsCountData = (betsCountResult as ApiResponse<BetsCount> | null)?.data || null;
        withdrawalsData = withdrawalsResult;
        paymentOrdersData = paymentOrders7DayResult;
        mainGameType = inOutReportRes?.mainGameType ?? null;

        if (memberRefreshRes) {
          const arr = memberRefreshRes?.items || memberRefreshRes?.data;
          const refreshed = Array.isArray(arr) ? arr[0] : (arr && !(arr as unknown as Record<string, unknown>).code ? arr : null);
          if (refreshed && (refreshed.memberName || refreshed.userName)) {
            member = refreshed;
          }
        }
        manualRecharge7Day = extractSumAmount(manual7DayRes);
        manualRecharge3Day = extractSumAmount(manual3DayRes);
        manualRechargeToday = extractSumAmount(manualTodayRes);

        let todaySum = 0, threeDaySum = 0, sevenDaySum = 0;
        for (const o of paymentOrders7DayResult) {
          const amt = parseFloat(String(o.amount || '0'));
          sevenDaySum += amt;
          const t = parseTimeStr(o.createTime || o.createdAt);
          if (t >= threeDayStart) threeDaySum += amt;
          if (t >= effectiveStart && t <= effectiveEnd) todaySum += amt;
        }
        thirdPartyRechargeToday = todaySum;
        thirdPartyRecharge3Day = threeDaySum;
        thirdPartyRecharge7Day = sevenDaySum;

        agentRiskScore = agentProfileRes?.agentRiskScore ?? null;

        if (isCancelled?.()) return null;
        setCachedMember(memberId, { member, bets: betsData, withdrawals: withdrawalsData, thirdGames: thirdGameData, paymentOrders: paymentOrdersData, betsCount: betsCountData, manualRechargeToday, manualRecharge3Day, manualRecharge7Day, thirdPartyRechargeToday, thirdPartyRecharge3Day, thirdPartyRecharge7Day, agentRiskScore, lastWithdrawMethod, mainGameType: mainGameType ?? undefined, inOutReport: inOutReportRes?.report ?? null }, effectiveStart);
      }
    } else {
      const sevenDayStart = effectiveStart - 6 * 24 * 3600 * 1000;
      const threeDayStart = effectiveStart - 2 * 24 * 3600 * 1000;

      const t0 = Date.now();

      const prefetched = consumePrefetchedDetail(String(order.orderNo || order.id));
      const userDetailsPromise = prefetched || apiClient.getUserDetails(queryName).catch(() => null);
      const betsPromise = memberName
        ? apiClient.getMemberBetsToday(queryName, 1, effectiveDateRange, betsMaxPages).then(res => extractList<BetRecord>(res)).catch(() => [] as BetRecord[])
        : Promise.resolve([] as BetRecord[]);
      const thirdGamePromise = memberName
        ? apiClient.getThirdGameOrders(queryName, 1, effectiveDateRange).then(res => extractList<ThirdGameOrder>(res)).catch(() => [] as ThirdGameOrder[])
        : Promise.resolve([] as ThirdGameOrder[]);
      const betsCountPromise = memberName
        ? apiClient.getBetsCountToday(queryName, effectiveDateRange).catch(() => null)
        : Promise.resolve(null as BetsCount | null);
      const withdrawalsPromise = memberName
        ? apiClient.getMemberWithdrawals(queryName, 1, effectiveDateRange, withdrawalsMaxPages).then(res => extractList<WithdrawalRecord>(res)).catch(() => [] as WithdrawalRecord[])
        : Promise.resolve([] as WithdrawalRecord[]);
      const paymentOrdersPromise = memberName
        ? apiClient.getPaymentOrders(queryName, 1, { start: sevenDayStart, end: effectiveEnd }).then(res => extractList<PaymentOrder>(res)).catch(() => [] as PaymentOrder[])
        : Promise.resolve([] as PaymentOrder[]);
      const manual7DayPromise = memberName
        ? apiClient.getManualRechargeSum(queryName, sevenDayStart, effectiveEnd).catch(() => null)
        : Promise.resolve(null as RechargeSumResponse | null);
      const manual3DayPromise = memberName
        ? apiClient.getManualRechargeSum(queryName, threeDayStart, effectiveEnd).catch(() => null)
        : Promise.resolve(null as RechargeSumResponse | null);
      const manualTodayPromise = memberName
        ? apiClient.getManualRechargeSum(queryName, effectiveStart, effectiveEnd).catch(() => null)
        : Promise.resolve(null as RechargeSumResponse | null);
      const inOutReportPromise = memberName
        ? apiClient.getMemberInOutReport(queryName).catch(() => ({ report: null, mainGameType: null }))
        : Promise.resolve({ report: null as MemberInOutReport | null, mainGameType: null as string | null });

      const earlyProxyCode = extractProxyCode(orderCtx);
      const earlyAgentProfilePromise = earlyProxyCode
        ? dbHolder.db.agentProfile.findUnique({ where: { proxyCode: earlyProxyCode } }).then(ap => ({ proxyCode: earlyProxyCode, agentRiskScore: ap?.riskScore || 0 })).catch(() => ({ proxyCode: earlyProxyCode, agentRiskScore: 0 }))
        : Promise.resolve({ proxyCode: '', agentRiskScore: 0 });

      const userDetailsSideEffect = userDetailsPromise.then(details => {
        const detail = details?.data || null;
        if (detail) member = detail;
        if (detail) {
          if (orderCtx.sumRecharge == null && detail.sumRecharge != null) orderCtx.sumRecharge = Math.abs(parseFloat(String(detail.sumRecharge))) || 0;
          if (orderCtx.sumWithdraw == null && detail.sumWithdraw != null) orderCtx.sumWithdraw = Math.abs(parseFloat(String(detail.sumWithdraw))) || 0;
          if (orderCtx.balance == null && detail.balance != null) orderCtx.balance = detail.balance;
          if (orderCtx.sumBet == null && detail.sumRolling != null) orderCtx.sumBet = detail.sumRolling;
        }
        return details;
      });

      const [
        userDetails, betsResult, thirdGameResult, betsCountResult,
        withdrawalsResult, paymentOrders7DayResult, manual7DayRes, manual3DayRes, manualTodayRes,
        agentProfileRes, inOutReportRes,
      ] = await Promise.all([
        userDetailsSideEffect, betsPromise, thirdGamePromise, betsCountPromise,
        withdrawalsPromise, paymentOrdersPromise, manual7DayPromise, manual3DayPromise, manualTodayPromise,
        earlyAgentProfilePromise, inOutReportPromise,
      ]);

      const t1 = Date.now();

      betsData = betsResult;
      thirdGameData = thirdGameResult;
      betsCountData = (betsCountResult as ApiResponse<BetsCount> | null)?.data || null;
      withdrawalsData = withdrawalsResult;
      paymentOrdersData = paymentOrders7DayResult;
      manualRecharge7Day = extractSumAmount(manual7DayRes);
      manualRecharge3Day = extractSumAmount(manual3DayRes);
      manualRechargeToday = extractSumAmount(manualTodayRes);
      mainGameType = inOutReportRes?.mainGameType ?? null;

      let todaySum = 0, threeDaySum = 0, sevenDaySum = 0;
      for (const o of paymentOrders7DayResult) {
        const amt = parseFloat(String(o.amount || '0'));
        sevenDaySum += amt;
        const t = parseTimeStr(o.createTime || o.createdAt);
        if (t >= threeDayStart) threeDaySum += amt;
        if (t >= effectiveStart && t <= effectiveEnd) todaySum += amt;
      }
      thirdPartyRechargeToday = todaySum;
      thirdPartyRecharge3Day = threeDaySum;
      thirdPartyRecharge7Day = sevenDaySum;

      if (!member) member = userDetails?.data || { memberId, memberName: queryName };

      agentRiskScore = agentProfileRes?.agentRiskScore ?? null;

      if (!agentProfileRes?.proxyCode && member) {
        const lateProxyCode = extractProxyCode(orderCtx, member);
        if (lateProxyCode) {
          try {
            const ap = await dbHolder.db.agentProfile.findUnique({ where: { proxyCode: lateProxyCode } });
            agentRiskScore = ap?.riskScore || 0;
          } catch (err) {
            logger.debug({ proxyCode: lateProxyCode, err: (err as Error).message }, '[评估器] 延迟查询代理画像失败');
          }
        }
      }

      if (t1 - t0 > 3000) {
        logger.warn({
          traceId: tid,
          orderNo: order.orderNo || order.id,
          memberName: queryName,
          pipelineMs: t1 - t0,
          betsCount: betsData.length,
          thirdGameCount: thirdGameData.length,
          withdrawalsCount: withdrawalsData.length,
          paymentOrdersCount: paymentOrdersData.length,
        }, `[评估器] 流水线耗时 ${t1 - t0}ms`);
      }

      if (isCancelled?.()) return null;
      setCachedMember(memberId, { member, bets: betsData, withdrawals: withdrawalsData, thirdGames: thirdGameData, paymentOrders: paymentOrdersData, betsCount: betsCountData, manualRechargeToday, manualRecharge3Day, manualRecharge7Day,
        thirdPartyRechargeToday, thirdPartyRecharge3Day, thirdPartyRecharge7Day, agentRiskScore, lastWithdrawMethod, mainGameType: mainGameType ?? undefined, inOutReport: inOutReportRes?.report ?? null }, effectiveStart);
    }

    if (agentRiskScore === null) {
      const proxyCode = extractProxyCode(orderCtx, member);
      if (proxyCode) {
        try {
          const agentProfile = await dbHolder.db.agentProfile.findUnique({ where: { proxyCode } });
          agentRiskScore = agentProfile?.riskScore || 0;
        } catch (err) {
          logger.debug({ proxyCode, err: (err as Error).message }, '[评估器] 查询代理风险评分失败');
        }
      }
    }

    // 查询登录IP和设备关联会员，用于 R02/R03 规则
    let relatedByLoginIp: LoginLogItem[] = [];
    let relatedByLoginDevice: LoginLogItem[] = [];
    try {
      const memberIp = member?.lastLoginIp || '';
      const memberDevice = member?.lastLoginDeviceClientId || '';
      if (memberIp) {
        const ipMembers = ipMemberCache.get(memberIp);
        if (ipMembers) {
          relatedByLoginIp = [...ipMembers.members].filter(m => m !== memberName).map(m => ({ memberName: m, loginIp: memberIp }));
        } else {
          const ipLogs = await apiClient.getLoginLogsByIp(memberIp);
          const ipMemberSet = new Set<string>();
          const ipLogItems: LoginLogItem[] = extractList(ipLogs);
          for (const log of ipLogItems) {
            if (log.memberName && log.memberName !== memberName) {
              ipMemberSet.add(log.memberName);
            }
          }
          relatedByLoginIp = ipLogItems.filter(l => l.memberName !== memberName);
          ipMemberCache.set(memberIp, { members: new Set([memberName, ...ipMemberSet]) });
        }
      }
      if (memberDevice) {
        const deviceMembers = deviceMemberCache.get(memberDevice);
        if (deviceMembers) {
          relatedByLoginDevice = [...deviceMembers.members].filter(m => m !== memberName).map(m => ({ memberName: m, device: memberDevice }));
        } else {
          const deviceLogs = await apiClient.getLoginLogsByDevice(memberDevice);
          const deviceMemberSet = new Set<string>();
          const deviceLogItems: LoginLogItem[] = extractList(deviceLogs);
          for (const log of deviceLogItems) {
            if (log.memberName && log.memberName !== memberName) {
              deviceMemberSet.add(log.memberName);
            }
          }
          relatedByLoginDevice = deviceLogItems.filter(l => l.memberName !== memberName);
          deviceMemberCache.set(memberDevice, { members: new Set([memberName, ...deviceMemberSet]) });
        }
      }
    } catch (err) {
      logger.debug({ memberName, err: (err as Error).message }, '[评估器] 查询登录关联会员失败');
    }

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
      relatedByLoginIp,
      relatedByLoginDevice,
      relatedByLoginIpCount: relatedByLoginIp.length,
      relatedByLoginDeviceCount: relatedByLoginDevice.length,
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
      tzOffset: parseInt(process.env.TZ_OFFSET || '8', 10) || 8,
      associatedMemberBets: new Map(),
      isEarlyMorning,
      traceId: tid,
      lastWithdrawMethod,
      mainGameType: mainGameType ?? undefined,
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
        baseScore = Math.floor(baseScore * Math.pow(0.99, hoursSinceUpdate));
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
