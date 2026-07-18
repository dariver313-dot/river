import crypto from 'crypto';
import { apiClient } from './api-client';
import type { RuleContext, EvaluationResult, LoginAssociationSummary } from './rule-types';
import { evaluateRules, getActiveRuleIds } from './rule-engine';
import { dbHolder } from './db';
import { logger } from './logger';
import { isAgentWhitelisted } from './constants';
import { parseTimeStr, extractProxyCode } from './utils';
import { type WithdrawOrder } from './ws-client';
import type { MemberInfo, LoginLogItem, MemberCacheData, UserDetailsResponse, ApiResponse, PagedResponse, QueryQuality } from './types';
import { LRUCache } from 'lru-cache';
import { buildRiskDataWindows, loadRiskData, type RiskDataSnapshot } from './risk-data-loader';

const MAX_MEMBER_CACHE = 500;
const MAX_RECEIVING_CACHE = 5000;

const CACHE_TTL = 5 * 60 * 1000;
const BET_CACHE_TTL = 120 * 1000;

const memberCache = new LRUCache<string, { data: MemberCacheData; betExpire: number; queryEnd?: number }>({
  max: MAX_MEMBER_CACHE,
  ttl: CACHE_TTL,
});

const RECEIVING_CACHE_TTL = 10 * 60 * 1000;
const AGENT_CACHE_TTL = 30 * 60 * 1000;

const receivingInfoCache = new LRUCache<string, { data: Set<string> }>({
  max: MAX_RECEIVING_CACHE,
  ttl: RECEIVING_CACHE_TTL,
});

const agentWithdrawCache = new LRUCache<string, { count: number; memberIds: Set<string>; lastUpdate: number }>({
  max: MAX_MEMBER_CACHE,
  ttl: AGENT_CACHE_TTL,
});

const IP_DEVICE_CACHE_TTL = 60 * 60 * 1000;
const DAILY_LOGIN_ASSOC_CACHE_TTL = 2 * 60 * 1000;

interface LoginAssociationCacheEntry {
  members: Set<string>;
  latestLoginAtByMember?: Map<string, number>;
  fetchedCount: number;
  totalCount: number;
  truncated: boolean;
  quality?: QueryQuality;
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
  quality?: QueryQuality;
}

const dailyLoginAssociationCache = new LRUCache<string, DailyLoginAssociations>({
  max: 2000,
  ttl: DAILY_LOGIN_ASSOC_CACHE_TTL,
});

function latestLoginTimesFromLogs(logs: LoginLogItem[]): Map<string, number> {
  const times = new Map<string, number>();
  for (const log of logs) {
    const name = String(log.memberName || '').trim();
    if (!name) continue;
    const ts = parseTimeStr(log.loginTime);
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function failedQuality(source: string, message: string): QueryQuality {
  return { source, status: 'failed', fetched: 0, total: 0, message };
}

const QUALITY_SOURCE_LABELS: Record<string, string> = {
  memberInfo: '会员详情',
  lotteryBets: '近7日彩票注单',
  betsCount: '当日投注汇总',
  withdrawals: '成功提款历史',
  paymentOrders: '成功充值订单',
  accountChanges: '人工加款明细',
  manualRechargeToday: '当日人工充值汇总',
  manualRecharge3Day: '近3日人工充值汇总',
  manualRecharge7Day: '近7日人工充值汇总',
  thirdGameOrders: '三方游戏注单',
  loginAssociations: '当天同IP/同设备',
  receivingAssociations: '历史同收款信息',
};

function skippedQuality(source: string): QueryQuality {
  return { source, status: 'skipped', fetched: 0, total: 0 };
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
    quality: skippedQuality('loginAssociations'),
  };
  if (!memberName || isAgentWhitelisted(memberName)) return empty;

  const activeRuleIds = getActiveRuleIds();
  const needIpAssociations = activeRuleIds.has('R02D') || activeRuleIds.has('R02');
  const needDeviceAssociations = activeRuleIds.has('R03D') || activeRuleIds.has('R03');
  if (!needIpAssociations && !needDeviceAssociations) return empty;

  const qualityParts: QueryQuality[] = [];

  const todayRange = apiClient.getTimezoneDateRange(orderTime, true);
  const memberKey = `today:${todayRange.start}:${memberName}:${needIpAssociations ? 'ip' : 'noip'}:${needDeviceAssociations ? 'dev' : 'nodev'}`;
  const cachedDaily = dailyLoginAssociationCache.get(memberKey);
  if (cachedDaily) return cachedDaily;

  try {
    if (abortSignal?.aborted) return empty;
    const fetchOptions = getDailyLoginFetchOptions(abortSignal);
    const ownLogsRes = await apiClient.getLoginLogsByMember(memberName, todayRange, fetchOptions);
    if (ownLogsRes.quality) qualityParts.push(ownLogsRes.quality);
    if (abortSignal?.aborted) return empty;

    // 当前会员当天的登录日志都未能取得时，最后登录 IP/设备可能属于其他日期。
    // 不再发起基于历史值的反查：既避免误关联，也避免权限/网络故障时额外阻塞评估。
    if (ownLogsRes.quality?.status === 'failed') {
      const result: DailyLoginAssociations = {
        ...empty,
        quality: failedQuality('loginAssociations', '当天同IP/同设备登录日志查询不完整'),
      };
      dailyLoginAssociationCache.set(memberKey, result);
      return result;
    }

    const ownLogs = extractList<LoginLogItem>(ownLogsRes);
    const ownIps = new Set(ownLogs.map(l => String(l.loginIp || '').trim()).filter(Boolean));
    const ownDevices = new Set(ownLogs.map(l => String(l.device || '').trim()).filter(Boolean));

    // getLoginLogsByMember 偶发为空时，用会员详情里的最后登录 IP/设备作为候选；
    // 但只有在当天日志反查中确实包含当前会员时才计入，避免拿历史设备误判为当天关联。
    if (member.lastLoginIp) ownIps.add(member.lastLoginIp);
    if (member.lastLoginDeviceClientId) ownDevices.add(member.lastLoginDeviceClientId);

    const ownIpValues = needIpAssociations ? [...ownIps] : [];
    const ownDeviceValues = needDeviceAssociations ? [...ownDevices] : [];
    const ipValues = ownIpValues.slice(0, 5);
    const deviceValues = ownDeviceValues.slice(0, 5);
    if (ownIpValues.length > ipValues.length || ownDeviceValues.length > deviceValues.length) {
      qualityParts.push({
        source: 'loginAssociations',
        status: 'partial',
        fetched: ipValues.length + deviceValues.length,
        total: ownIpValues.length + ownDeviceValues.length,
        message: '会员当天登录IP/设备数量超过关联查询上限',
      });
    }

    const ipResults = await Promise.all(ipValues.map(async (ip): Promise<LoginAssociationSummary | null> => {
      if (abortSignal?.aborted) return null;
      const cacheKey = associationCacheKey('ip', ip, todayRange.start);
      let cached = ipMemberCache.get(cacheKey);
      let members = cached?.members;
      let latestLoginAtByMember = cached?.latestLoginAtByMember;
      let fetchedCount = cached?.fetchedCount ?? 0;
      let totalCount = cached?.totalCount ?? 0;
      let truncated = cached?.truncated ?? false;
      if (cached?.quality) qualityParts.push(cached.quality);
      if (!members) {
        const logsRes = await apiClient.getLoginLogsByIp(ip, todayRange, fetchOptions);
        if (logsRes.quality) qualityParts.push(logsRes.quality);
        if (abortSignal?.aborted) return null;
        const logs = extractList<LoginLogItem>(logsRes);
        latestLoginAtByMember = latestLoginTimesFromLogs(logs);
        members = new Set(latestLoginAtByMember.keys());
        fetchedCount = logs.length;
        totalCount = getPagedTotalCount(logsRes, fetchedCount);
        truncated = totalCount > fetchedCount;
        ipMemberCache.set(cacheKey, { members, latestLoginAtByMember, fetchedCount, totalCount, truncated, quality: logsRes.quality });
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
      if (cached?.quality) qualityParts.push(cached.quality);
      if (!members) {
        const logsRes = await apiClient.getLoginLogsByDevice(device, todayRange, fetchOptions);
        if (logsRes.quality) qualityParts.push(logsRes.quality);
        if (abortSignal?.aborted) return null;
        const logs = extractList<LoginLogItem>(logsRes);
        latestLoginAtByMember = latestLoginTimesFromLogs(logs);
        members = new Set(latestLoginAtByMember.keys());
        fetchedCount = logs.length;
        totalCount = getPagedTotalCount(logsRes, fetchedCount);
        truncated = totalCount > fetchedCount;
        deviceMemberCache.set(cacheKey, { members, latestLoginAtByMember, fetchedCount, totalCount, truncated, quality: logsRes.quality });
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

    const worstStatus = qualityParts.some(q => q.status === 'failed')
      ? 'failed'
      : qualityParts.some(q => q.status === 'partial') ? 'partial' : 'complete';
    const quality: QueryQuality = {
      source: 'loginAssociations',
      status: worstStatus,
      fetched: qualityParts.reduce((sum, q) => sum + q.fetched, 0),
      total: qualityParts.reduce((sum, q) => sum + q.total, 0),
      ...(worstStatus === 'complete' ? {} : { message: '当天同IP/同设备登录日志查询不完整' }),
    };
    const result = {
      relatedByLoginIp,
      relatedByLoginDevice,
      relatedByLoginIpCount: Math.max(0, ...ipSummaries.map(s => s.accountCount)),
      relatedByLoginDeviceCount: Math.max(0, ...deviceSummaries.map(s => s.accountCount)),
      dailyLoginIpAssociations: ipSummaries,
      dailyLoginDeviceAssociations: deviceSummaries,
      quality,
    };
    dailyLoginAssociationCache.set(memberKey, result);
    return result;
  } catch (err) {
    logger.debug({ memberName, err: (err as Error).message }, '[评估器] 查询当天登录关联会员失败');
    return { ...empty, quality: failedQuality('loginAssociations', (err as Error).message || '当天登录关联会员查询失败') };
  }
}

function getCachedMember(memberId: string, queryEnd?: number): { data: MemberCacheData; betStale: boolean } | null {
  const entry = memberCache.get(memberId);
  if (!entry) return null;
  // 风控快照严格绑定提款发生时间，禁止复用包含该笔提款之后数据的快照。
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

export function updateReceivingCache(order: WithdrawOrder): void {
  const receivingName = order?.receivingName;
  const receivingCardNo = order?.receivingCardNo;
  const memberName = String(order?.memberName || order?.member_name || '').trim();
  if (!receivingName || !receivingCardNo || !memberName || isAgentWhitelisted(memberName)) return;

  const key = `${receivingName}:${receivingCardNo}`;
  const entry = receivingInfoCache.get(key);
  if (entry) {
    entry.data.add(memberName);
    receivingInfoCache.set(key, entry);
  } else {
    receivingInfoCache.set(key, { data: new Set<string>([memberName]) });
  }
}

function receivingFingerprint(order: WithdrawOrder): string {
  const name = String(order.receivingName || '').trim().replace(/\s+/g, '').toLowerCase();
  const card = String(order.receivingCardNo || '').trim().replace(/[\s-]+/g, '').toLowerCase();
  if (!name || !card) return '';
  const secret = process.env.RISK_FINGERPRINT_SECRET || '';
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(`${name}|${card}`).digest('hex');
}

async function getReceivingAssociations(order: WithdrawOrder): Promise<{ names: string[]; quality: QueryQuality }> {
  const currentName = String(order.memberName || order.member_name || '').trim();
  if (isAgentWhitelisted(currentName)) {
    return { names: [], quality: skippedQuality('receivingAssociations') };
  }
  const names = new Set<string>();
  const cacheKey = `${order.receivingName || ''}:${order.receivingCardNo || ''}`;
  for (const name of receivingInfoCache.get(cacheKey)?.data || []) names.add(name);

  const fingerprint = receivingFingerprint(order);
  let quality: QueryQuality = fingerprint
    ? { source: 'receivingAssociations', status: 'complete', fetched: 0, total: 0 }
    : skippedQuality('receivingAssociations');
  if (fingerprint) {
    try {
      const associationDays = Math.min(parsePositiveInt(process.env.RECEIVING_ASSOCIATION_DAYS, 180), 3650);
      const orderTime = parseTimeStr(order.createTime) || Date.now();
      const rows = await dbHolder.db.successfulWithdrawal.findMany({
        where: {
          receivingFingerprint: fingerprint,
          createTime: { gte: new Date(orderTime - associationDays * 86400000), lte: new Date(orderTime) },
        },
        select: { memberName: true },
        orderBy: { createTime: 'desc' },
        take: 50,
      });
      for (const row of rows) names.add(row.memberName);
      quality = { source: 'receivingAssociations', status: 'complete', fetched: rows.length, total: rows.length };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[评估器] 查询历史同收款信息失败');
      quality = failedQuality('receivingAssociations', '历史同收款信息查询失败');
    }
  }

  return { names: [...names].filter(name => name && name !== currentName && !isAgentWhitelisted(name)), quality };
}

function updateAgentCache(order: WithdrawOrder): void {
  const proxyCode = extractProxyCode(order);
  const memberName = String(order?.memberName || order?.member_name || '');
  if (!proxyCode || !memberName) return;
  if (isAgentWhitelisted(proxyCode)) return;

  const entry = agentWithdrawCache.get(proxyCode) || { count: 0, memberIds: new Set<string>(), lastUpdate: 0 };
  entry.memberIds.add(memberName);
  entry.count++;
  entry.lastUpdate = Date.now();
  agentWithdrawCache.set(proxyCode, entry);
}

export function getReceivingInfoCache(): LRUCache<string, { data: Set<string> }> {
  return receivingInfoCache;
}

export function getAgentWithdrawCache(): LRUCache<string, { count: number; memberIds: Set<string>; lastUpdate: number }> {
  return agentWithdrawCache;
}

/** 获取所有缓存的容量统计（用于监控和调试） */
export function getCacheStats(): Record<string, { size: number; max: number; utilization: string }> {
  const stats: Record<string, { size: number; max: number; utilization: string }> = {};
  for (const [name, cache] of [
    ['memberCache', memberCache],
    ['receivingInfoCache', receivingInfoCache],
    ['agentWithdrawCache', agentWithdrawCache],
    ['ipMemberCache', ipMemberCache],
    ['deviceMemberCache', deviceMemberCache],
    ['dailyLoginAssociationCache', dailyLoginAssociationCache],
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
    // 同一会员的多笔提款串行评估，复用刚写入的缓存，但每笔订单独立执行规则。
    await existing;
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
    const orderCtx = { ...order };
    updateReceivingCache(order);
    updateAgentCache(order);

    const orderTime = parseTimeStr(order.createTime || (order as Record<string, unknown>).createdAt as string | number | undefined) || Date.now();
    const orderId = String(order.orderNo || order.id || '');
    const memberName = order.memberName || order.member_name || '';
    const queryName = memberName || memberId;
    const activeRuleIds = getActiveRuleIds();
    const cached = getCachedMember(memberId, orderTime);
    const prefetched = consumePrefetchedDetail(orderId);

    const detailPromise = prefetched
      || (!cached ? apiClient.getUserDetails(queryName, abortSignal ? { signal: abortSignal } : undefined).catch(() => null) : Promise.resolve(null));

    const dataPromise: Promise<RiskDataSnapshot> = cached && !cached.betStale
      ? Promise.resolve({
          bets: cached.data.bets,
          dailyBets: cached.data.bets.filter((bet) => {
            const time = parseTimeStr(bet.betTime);
            const range = buildRiskDataWindows(orderTime).orderDay;
            return time >= range.start && time <= orderTime;
          }),
          withdrawals: cached.data.withdrawals,
          thirdGames: cached.data.thirdGames || [],
          paymentOrders: cached.data.paymentOrders || [],
          accountChanges: cached.data.accountChanges || [],
          betsCount: cached.data.betsCount || null,
          manualRechargeToday: cached.data.manualRechargeToday || 0,
          manualRecharge3Day: cached.data.manualRecharge3Day || 0,
          manualRecharge7Day: cached.data.manualRecharge7Day || 0,
          thirdPartyRechargeToday: cached.data.thirdPartyRechargeToday || 0,
          thirdPartyRecharge3Day: cached.data.thirdPartyRecharge3Day || 0,
          thirdPartyRecharge7Day: cached.data.thirdPartyRecharge7Day || 0,
          latestRechargeTime: cached.data.latestRechargeTime,
          latestRechargeAmount: cached.data.latestRechargeAmount,
          mainGameType: cached.data.mainGameType || null,
          inOutReport: cached.data.inOutReport || null,
          quality: cached.data.dataQuality || [],
          windows: buildRiskDataWindows(orderTime),
        })
      : loadRiskData({
          memberName: queryName,
          orderId,
          orderTime,
          activeRuleIds,
          signal: abortSignal,
        });

    const [snapshot, details] = await Promise.all([dataPromise, detailPromise]);
    if (isCancelled?.()) return null;

    let member: MemberInfo = cached?.data.member || { memberId, memberName: queryName };
    const detail = details?.data || details?.items?.[0];
    if (detail) member = detail;

    if (orderCtx.sumRecharge == null && member.sumRecharge != null) orderCtx.sumRecharge = Math.abs(Number(member.sumRecharge)) || 0;
    if (orderCtx.sumWithdraw == null && member.sumWithdraw != null) orderCtx.sumWithdraw = Math.abs(Number(member.sumWithdraw)) || 0;
    if (orderCtx.balance == null && member.balance != null) orderCtx.balance = member.balance;
    if (orderCtx.sumBet == null && member.sumRolling != null) orderCtx.sumBet = member.sumRolling;

    const memberInfoQuality: QueryQuality = detail || cached
      ? { source: 'memberInfo', status: 'complete', fetched: 1, total: 1 }
      : failedQuality('memberInfo', '会员详情查询失败');

    const proxyCode = extractProxyCode(orderCtx, member);
    const loginMemberName = member.memberName || memberName || queryName;
    const [agentRiskScore, loginAssociations, receivingAssociationResult] = await Promise.all([
      proxyCode
        ? dbHolder.db.agentProfile.findUnique({ where: { proxyCode } }).then(profile => profile?.riskScore || 0).catch((err) => {
            logger.debug({ proxyCode, err: (err as Error).message }, '[评估器] 查询代理风险评分失败');
            return 0;
          })
        : Promise.resolve(0),
      getDailyLoginAssociations(member, loginMemberName, orderTime, abortSignal),
      getReceivingAssociations(orderCtx),
    ]);
    if (isCancelled?.()) return null;

    const latestSuccessfulWithdrawal = snapshot.withdrawals[0];
    let lastWithdrawMethod: { bank: string; card: string; name: string; time?: number } | null = latestSuccessfulWithdrawal
      ? {
          bank: String(latestSuccessfulWithdrawal.receivingBank || '').trim(),
          card: String(latestSuccessfulWithdrawal.receivingCardNo || '').trim(),
          name: String(latestSuccessfulWithdrawal.receivingName || '').trim(),
          time: parseTimeStr(latestSuccessfulWithdrawal.createTime),
        }
      : null;

    if (!lastWithdrawMethod || (!lastWithdrawMethod.bank && !lastWithdrawMethod.card && !lastWithdrawMethod.name)) {
      try {
        const profile = await dbHolder.db.memberProfile.findUnique({ where: { memberName: queryName } });
        if (profile?.lastWithdrawMethod) {
          const parsed = JSON.parse(profile.lastWithdrawMethod) as { bank: string; card: string; name: string; time?: number };
          if (!parsed.time || parsed.time <= orderTime) lastWithdrawMethod = parsed;
        }
      } catch {
        lastWithdrawMethod = null;
      }
    }

    const dataQuality = [
      ...snapshot.quality,
      memberInfoQuality,
      ...(loginAssociations.quality ? [loginAssociations.quality] : []),
      receivingAssociationResult.quality,
    ];

    const ctx: RuleContext = {
      order: orderCtx,
      member,
      bets: snapshot.bets,
      dailyBets: snapshot.dailyBets,
      withdrawals: snapshot.withdrawals,
      relatedByLoginIp: loginAssociations.relatedByLoginIp,
      relatedByLoginDevice: loginAssociations.relatedByLoginDevice,
      relatedByLoginIpCount: loginAssociations.relatedByLoginIpCount,
      relatedByLoginDeviceCount: loginAssociations.relatedByLoginDeviceCount,
      dailyLoginIpAssociations: loginAssociations.dailyLoginIpAssociations,
      dailyLoginDeviceAssociations: loginAssociations.dailyLoginDeviceAssociations,
      receivingAssociations: receivingAssociationResult.names,
      agentWithdrawCache,
      thirdGameBets: snapshot.thirdGames,
      paymentOrders: snapshot.paymentOrders,
      accountChanges: snapshot.accountChanges,
      betsCount: snapshot.betsCount,
      manualRechargeToday: snapshot.manualRechargeToday,
      manualRecharge3Day: snapshot.manualRecharge3Day,
      manualRecharge7Day: snapshot.manualRecharge7Day,
      thirdPartyRechargeToday: snapshot.thirdPartyRechargeToday,
      thirdPartyRecharge3Day: snapshot.thirdPartyRecharge3Day,
      thirdPartyRecharge7Day: snapshot.thirdPartyRecharge7Day,
      latestRechargeTime: snapshot.latestRechargeTime,
      latestRechargeAmount: snapshot.latestRechargeAmount,
      agentRiskScore,
      tzOffset: parseInt(process.env.TZ_OFFSET || '8', 10) || 8,
      associatedMemberBets: new Map(),
      isEarlyMorning: snapshot.windows.orderDay.isEarlyMorning,
      traceId: tid,
      lastWithdrawMethod,
      mainGameType: snapshot.mainGameType || undefined,
      dataQuality,
    };

    const result = await evaluateRules(ctx);
    result.isEarlyMorning = snapshot.windows.orderDay.isEarlyMorning;
    result.dataQuality = dataQuality;

    const dataIssues = [...new Set(
      dataQuality
        .filter(item => item.status === 'failed' || item.status === 'partial')
        .map(item => `${QUALITY_SOURCE_LABELS[item.source] || item.source}查询不完整`)
    )];
    result.dataIssues = dataIssues;

    // 数据不完整只作为告警中的复核提示，不能凭空抬高风险等级或制造一条风险规则。

    const explicitProfitLoss = Number(member.profitAndLoss);
    if (member.profitAndLoss != null && Number.isFinite(explicitProfitLoss)) {
      result.profitLoss = explicitProfitLoss;
      result.estimatedProfitLoss = false;
    } else {
      const balance = Number(member.balance ?? orderCtx.balance ?? 0) || 0;
      result.profitLoss = balance - result.rechargeWithdrawDiff;
      result.estimatedProfitLoss = true;
    }

    if (!cached || cached.betStale) {
      setCachedMember(memberId, {
        member,
        bets: snapshot.bets,
        withdrawals: snapshot.withdrawals,
        thirdGames: snapshot.thirdGames,
        paymentOrders: snapshot.paymentOrders,
        accountChanges: snapshot.accountChanges,
        betsCount: snapshot.betsCount,
        manualRechargeToday: snapshot.manualRechargeToday,
        manualRecharge3Day: snapshot.manualRecharge3Day,
        manualRecharge7Day: snapshot.manualRecharge7Day,
        thirdPartyRechargeToday: snapshot.thirdPartyRechargeToday,
        thirdPartyRecharge3Day: snapshot.thirdPartyRecharge3Day,
        thirdPartyRecharge7Day: snapshot.thirdPartyRecharge7Day,
        agentRiskScore,
        lastWithdrawMethod,
        mainGameType: snapshot.mainGameType || undefined,
        inOutReport: snapshot.inOutReport,
        latestRechargeTime: snapshot.latestRechargeTime,
        latestRechargeAmount: snapshot.latestRechargeAmount,
        dataQuality: snapshot.quality,
      }, orderTime);
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > 3000) {
      logger.warn({
        traceId: tid,
        orderNo: orderId,
        elapsedMs: elapsed,
        memberName: queryName,
        betsCount: snapshot.bets.length,
        withdrawalsCount: snapshot.withdrawals.length,
        dataIssues: dataIssues.length,
      }, `[评估器] 订单评估耗时 ${elapsed}ms`);
    }

    return result;
  } catch (err) {
    logger.error({ orderNo: order.orderNo || order.id, err: (err as Error).message }, `[评估器] 评估订单 ${order.orderNo || order.id} 失败`);
    return null;
  }
}

export async function updateMemberProfile(memberName: string, memberId: string, result: EvaluationResult, _order: WithdrawOrder): Promise<void> {
  try {
    const isHighRisk = ['HIGH', 'CRITICAL'].includes(result.riskLevel);

    // 使用事务 + 乐观锁避免 TOCTOU 竞态
    await dbHolder.db.$transaction(async (tx) => {
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
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[画像] 更新会员画像失败');
  }
}

export async function recordSuccessfulWithdrawal(order: WithdrawOrder): Promise<void> {
  const orderId = String(order.orderNo || order.id || '');
  const memberId = String(order.memberId || order.member_id || '');
  const memberName = String(order.memberName || order.member_name || '').trim();
  if (!orderId || !memberId || !memberName) return;

  const amount = parseFloat(String(order.amount || '0')) || 0;
  const createTimeMs = parseTimeStr(order.createTime) || Date.now();
  const method = {
    bank: String(order.receivingBank || '').trim(),
    card: String(order.receivingCardNo || '').trim(),
    name: String(order.receivingName || '').trim(),
    time: createTimeMs,
  };
  const fingerprint = receivingFingerprint(order);
  const proxyCode = extractProxyCode(order);

  try {
    await dbHolder.db.$transaction(async (tx) => {
      const existingWithdrawal = await tx.successfulWithdrawal.findUnique({ where: { orderId } });
      if (existingWithdrawal) return;

      await tx.successfulWithdrawal.create({
        data: {
          orderId,
          memberId,
          memberName,
          amount,
          receivingBank: method.bank,
          receivingName: method.name,
          receivingCardNo: method.card,
          receivingFingerprint: fingerprint,
          createTime: new Date(createTimeMs),
        },
      });

      const existingProfile = await tx.memberProfile.findUnique({ where: { memberName } });
      let trend: { time: number; amount: number }[] = [];
      try { trend = existingProfile ? JSON.parse(existingProfile.recentWithdrawTrend || '[]') : []; } catch { trend = []; }
      trend.push({ time: createTimeMs, amount });
      const sevenDaysAgo = createTimeMs - 7 * 86400000;
      const recentTrend = trend.filter(item => item.time >= sevenDaysAgo).slice(-20);

      await tx.memberProfile.upsert({
        where: { memberName },
        update: {
          memberId,
          totalWithdrawAmount: { increment: amount },
          recentWithdrawTrend: JSON.stringify(recentTrend),
          lastWithdrawMethod: JSON.stringify(method),
        },
        create: {
          memberName,
          memberId,
          totalWithdrawAmount: amount,
          recentWithdrawTrend: JSON.stringify(recentTrend),
          lastWithdrawMethod: JSON.stringify(method),
        },
      });

      if (proxyCode && !isAgentWhitelisted(proxyCode)) {
        await tx.agentProfile.upsert({
          where: { proxyCode },
          update: { totalWithdrawAmount: { increment: amount } },
          create: { proxyCode, memberCount: 1, totalWithdrawAmount: amount },
        });
      }
    });
  } catch (err) {
    logger.error({ orderId, err: (err as Error).message }, '[画像] 记录成功提款失败');
  }
}

export async function updateAgentProfile(proxyCode: string, _memberName: string, result: EvaluationResult, _order: WithdrawOrder): Promise<void> {
  if (!proxyCode) return;
  if (isAgentWhitelisted(proxyCode)) return;
  try {
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
          riskScore: newRiskScore,
          topRules: JSON.stringify(topRules),
          updatedAt: new Date(),
        },
        create: {
          proxyCode,
          memberCount: 1,
          evalCount: 1,
          highRiskCount: isHighRisk ? 1 : 0,
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

export async function getAgentRiskScore(proxyCode: string): Promise<number> {
  try {
    const profile = await dbHolder.db.agentProfile.findUnique({ where: { proxyCode } });
    return profile?.riskScore || 0;
  } catch {
    return 0;
  }
}
