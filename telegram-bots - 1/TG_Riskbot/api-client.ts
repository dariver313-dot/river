/**
 * ApiClient — 委托 auth-client 调用 auth-service
 * 保留原 ApiClient 接口，内部全部委托给 auth-client.ts
 */

import { logger } from './logger';
import { type WithdrawOrder } from './ws-client';
import type {
  ApiResponse, PagedResponse, MemberInfo, UserDetailsResponse, BetRecord,
  ThirdGameOrder, WithdrawalRecord, PaymentOrder, BetsCount,
  RechargeSumResponse, LoginLogItem, MemberInOutReport, AccountChangeRecord, QueryQuality,
} from './types';

import * as auth from './auth-client';

// ============================================================
// 工具函数
// ============================================================

function safeParseInt(val: unknown, defaultVal: number = 0): number {
  const n = parseInt(String(val), 10);
  return isNaN(n) ? defaultVal : n;
}

function getWithdrawPageLimit(): number {
  return Math.min(Math.max(safeParseInt(process.env.WITHDRAW_ORDER_MAX_PAGES, 2), 1), 20);
}

const withdrawTruncationWarnAt = new Map<number, number>();

function warnWithdrawTruncation(status: number, maxPages: number): void {
  const now = Date.now();
  const last = withdrawTruncationWarnAt.get(status) || 0;
  if (now - last < 5 * 60 * 1000) return;
  withdrawTruncationWarnAt.set(status, now);
  logger.warn({ status, maxPages }, '[API] 提现订单达到分页上限，本轮优先处理最新订单；请按负载调整 WITHDRAW_ORDER_MAX_PAGES');
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || String(value).trim() === '') return undefined;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getTzOffset(): number { return safeParseInt(process.env.TZ_OFFSET, 8); }

function mapWithdrawOrder(n: any): WithdrawOrder {
  return {
    orderNo: n.orderNo, id: n.id || n.orderNo, status: n.status,
    amount: n.amount, memberName: n.memberName, memberId: n.memberId != null ? String(n.memberId) : '',
    member_name: n.memberName, member_id: n.memberId != null ? String(n.memberId) : '',
    createTime: n.createTime, proxyCode: n.proxyCode, agencyMemberName: n.proxyCode || n.agencyMemberName,
    receivingBank: n.receivingBank, receivingName: n.receivingName,
    receivingCardNo: n.receivingCardNo, vipLevel: n.vipLevel,
    currency: n.currency, balance: n.balance,
    sumRecharge: n.sumRecharge,
    sumWithdraw: n.sumWithdraw,
    memberRemark: n.memberRemark,
  };
}

export function mapMemberInfo(n: any): MemberInfo {
  const sumRecharge = finiteNumber(n.sumRecharge);
  const sumWithdraw = finiteNumber(n.sumWithdraw);
  return {
    memberId: n.memberId != null || n.id != null ? String(n.memberId ?? n.id) : '', memberName: n.memberName,
    id: n.memberId, createTime: n.createTime,
    // getUserDetails 返回 sumRecharge/sumWithdraw 为字符串金额，统一 parseFloat
    sumRecharge: sumRecharge === undefined ? undefined : Math.abs(sumRecharge),
    sumWithdraw: sumWithdraw === undefined ? undefined : Math.abs(sumWithdraw),
    sumRechargeTimes: n.sumRechargeTimes, sumWithdrawTimes: n.sumWithdrawTimes,
    sumRolling: finiteNumber(n.sumRolling),
    balance: n.balance, vipLevel: n.vipLevel ?? n.levelId,
    remark: n.remark, agencyMemberName: n.agencyMemberName,
    lastLoginIp: n.latestLoginIp, lastLoginDeviceClientId: n.latestLoginDevice,
    registerIp: n.registerIp,
    profitAndLoss: n.profitAndLoss,
  };
}

function mapBetRecord(n: any): BetRecord {
  return {
    orderNo: n.orderNo,
    status: n.status != null ? Number(n.status) : undefined,
    lotteryName: n.lotteryName, issue: n.issue, playClassName: n.playClassName,
    playName: n.playName, numbers: n.numbers,
    amount: n.amount, profit: n.profit, betTime: n.betTime || n.createTime,
  };
}

function makeQuality(source: string, status: QueryQuality['status'], fetched: number, total: number, message?: string): QueryQuality {
  return { source, status, fetched, total, ...(message ? { message } : {}) };
}

function mapBetAnalysis(n: any): BetsCount {
  return {
    countAmount: String(n.countAmount || 0),
    realAmount: String(n.realAmount || 0),
    countWin: String(n.countWin || 0),
    countProfit: String(n.countProfit || 0),
  };
}

function mapThirdGameOrder(n: any): ThirdGameOrder {
  return {
    orderNo: n.orderNo, memberName: n.memberName,
    amount: n.allbet ?? n.bet ?? n.amount,
    createTime: n.betTime || n.createTime,
    gameName: n.subRespList?.[0]?.gameName || n.gameName,
    allbet: n.allbet,
    bet: n.bet,
    betTime: n.betTime || n.createTime,
    profit: n.profit,
  };
}

interface ApiRequestOptions {
  signal?: AbortSignal;
}

interface LoginLogFetchOptions extends ApiRequestOptions {
  maxPages?: number;
  pageSize?: number;
}

function mapLoginLog(n: any): LoginLogItem {
  return { memberName: n.memberName, loginIp: n.loginIp, device: n.device, loginTime: n.loginTime };
}

async function fetchLoginLogs(params: Record<string, unknown>, options: LoginLogFetchOptions = {}): Promise<PagedResponse<LoginLogItem>> {
  const maxPages = Math.max(1, options.maxPages ?? 10);
  const pageSize = Math.min(Math.max(1, options.pageSize ?? 50), 100);
  const allItems: LoginLogItem[] = [];
  let totalNum = 0;

  for (let page = 1; page <= maxPages; page++) {
    const raw: any = await auth.getLoginLogs({
      currentPage: page,
      pageSize,
      ...params,
    }, { signal: options.signal });
    const data = raw?.data || raw;
    const items: any[] = data?.items || [];
    if (page === 1) totalNum = safeParseInt(data?.totalNum, items.length);
    for (const item of items) allItems.push(mapLoginLog(item));
    if (items.length < pageSize) break;
  }

  const total = totalNum || allItems.length;
  const complete = allItems.length >= total;
  return {
    items: allItems,
    totalNum: String(total),
    quality: makeQuality('loginLogs', complete ? 'complete' : 'partial', allItems.length, total, complete ? undefined : '登录日志达到分页上限'),
  };
}

type ReportRow = Record<string, unknown>;

interface GameTypeDefinition {
  label: string;
  aggregateFields: string[];
  matcher: RegExp;
}

// The report endpoint has returned both aggregate objects and per-game rows.
// Keep aliases here so a backend field rename does not silently hide the display line.
const GAME_TYPE_DEFINITIONS: GameTypeDefinition[] = [
  { label: '彩票类游戏', aggregateFields: ['lotteryBetAmount', 'lotteryAmount', 'cpBetAmount', 'cpValidAmount'], matcher: /彩票|lottery|cp/i },
  { label: '真人类游戏', aggregateFields: ['truemanBetAmount', 'realBetAmount', 'liveBetAmount', 'realValidAmount', 'liveValidAmount'], matcher: /真人|trueman|live|real|casino/i },
  { label: '棋牌类游戏', aggregateFields: ['boardBetAmount', 'chessBetAmount', 'chessValidAmount'], matcher: /棋牌|board|chess/i },
  { label: '电子类游戏', aggregateFields: ['slotsBetAmount', 'slotBetAmount', 'egameBetAmount', 'electronicBetAmount'], matcher: /电子|slots?|egame|electronic/i },
  { label: '捕鱼类游戏', aggregateFields: ['fishBetAmount', 'fishValidAmount'], matcher: /捕鱼|fish/i },
  { label: '竞技类游戏', aggregateFields: ['raceBetAmount', 'esportBetAmount', 'esportsBetAmount'], matcher: /竞技|race|esports?|电竞/i },
  { label: '体育类游戏', aggregateFields: ['sportBetAmount', 'sportsBetAmount', 'sportValidAmount'], matcher: /体育|sports?/i },
];

const ROW_GAME_TYPE_FIELDS = ['gameTypeName', 'gameName', 'gameType', 'typeName', 'categoryName', 'category', 'platformType'];
const ROW_BET_AMOUNT_FIELDS = ['betAmount', 'validAmount', 'validBetAmount', 'totalBetAmount', 'allBetAmount', 'allbet', 'bet', 'amount'];

function toMoney(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? '0').replace(/,/g, ''));
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

function findGameType(value: unknown): GameTypeDefinition | undefined {
  const text = String(value ?? '').trim();
  return text ? GAME_TYPE_DEFINITIONS.find(item => item.matcher.test(text)) : undefined;
}

function findReportRows(payload: unknown): ReportRow[] {
  if (Array.isArray(payload)) return payload.filter((item): item is ReportRow => !!item && typeof item === 'object');
  if (!payload || typeof payload !== 'object') return [];

  const root = payload as ReportRow;
  for (const key of ['items', 'list', 'records', 'rows', 'data', 'result']) {
    if (Array.isArray(root[key])) return root[key].filter((item): item is ReportRow => !!item && typeof item === 'object');
  }
  return [];
}

/** 根据近7天进出报表的汇总字段或明细行，返回投注金额最大的游戏类型标签。 */
export function computeMainGameType(report: unknown): string | null {
  if (!report || typeof report !== 'object') return null;

  const amounts = new Map<string, number>();
  const add = (label: string, amount: number) => {
    if (amount <= 0) return;
    amounts.set(label, (amounts.get(label) || 0) + amount);
  };

  const aggregateCandidates: ReportRow[] = [];
  if (!Array.isArray(report)) {
    const root = report as ReportRow;
    aggregateCandidates.push(root);
    for (const key of ['data', 'result', 'summary']) {
      const nested = root[key];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        aggregateCandidates.push(nested as ReportRow);
      }
    }
  }
  for (const aggregate of aggregateCandidates) {
    for (const game of GAME_TYPE_DEFINITIONS) {
      for (const field of game.aggregateFields) add(game.label, toMoney(aggregate[field]));
    }
  }

  for (const row of findReportRows(report)) {
    const game = ROW_GAME_TYPE_FIELDS.map(field => findGameType(row[field])).find(Boolean);
    if (!game) continue;
    const amount = ROW_BET_AMOUNT_FIELDS.map(field => toMoney(row[field])).find(value => value > 0) || 0;
    add(game.label, amount);
  }

  let mainGameType: string | null = null;
  let maxAmount = 0;
  for (const [label, amount] of amounts) {
    if (amount > maxAmount) {
      mainGameType = label;
      maxAmount = amount;
    }
  }
  return mainGameType;
}

function reportShape(payload: unknown): Record<string, unknown> {
  if (Array.isArray(payload)) {
    const first = payload.find(item => !!item && typeof item === 'object') as ReportRow | undefined;
    return { kind: 'array', length: payload.length, itemKeys: first ? Object.keys(first).slice(0, 20) : [] };
  }
  if (payload && typeof payload === 'object') return { kind: 'object', keys: Object.keys(payload as ReportRow).slice(0, 30) };
  return { kind: typeof payload };
}

// ============================================================
// ApiClient
// ============================================================

export class ApiClient {
  private lastHealthResult: boolean | null = null;
  private lastHealthTime: number = 0;
  private static HEALTH_CACHE_TTL = 60 * 1000;

  // ===== Token 管理（auth-service 已接管，保留兼容桩） =====
  onTokenUpdate(_cb: (token: string | null) => void) {}
  setToken(_token: string | null) { this.invalidateHealthCache(); }
  getToken(): string | null { return null; }
  validateToken(_token: string): { valid: boolean; reason?: string } {
    return { valid: true };
  }

  // ===== 提现订单 =====

  async getPendingWithdrawOrders(): Promise<WithdrawOrder[]> {
    return this.getAllWithdrawOrdersByStatuses([1, 2]);
  }

  /**
   * 近期全状态对账：上游不按状态筛选，机器人本地仅保留待审核/处理中订单。
   * 常规轮询仍走状态页；该查询只用于覆盖状态页或 WS 的短暂遗漏。
   */
  async getRecentPendingWithdrawOrders(dateRange: { start: number; end: number }, options?: ApiRequestOptions): Promise<WithdrawOrder[]> {
    const pageSize = 100;
    const maxPages = Math.min(Math.max(parseInt(process.env.RECENT_ORDER_RECONCILE_MAX_PAGES || '1', 10) || 1, 1), 10);
    const seen = new Set<string>();
    const orders: WithdrawOrder[] = [];
    let total = 0;

    for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
      const raw: any = await auth.getWithdrawOrders({
        currentPage,
        pageSize,
        startTime: dateRange.start,
        endTime: dateRange.end,
      }, options);
      const data = raw?.data || raw;
      const items: any[] = data?.items || [];
      if (currentPage === 1) total = safeParseInt(data?.totalNum, items.length);

      for (const item of items) {
        const order = mapWithdrawOrder(item);
        const orderNo = String(order.orderNo || order.id || '');
        const status = Number(order.status);
        if (!orderNo || (status !== 1 && status !== 2) || seen.has(orderNo)) continue;
        order.status = status;
        seen.add(orderNo);
        orders.push(order);
      }

      if (items.length < pageSize || (total > 0 && currentPage * pageSize >= total)) break;
    }

    if (total > maxPages * pageSize) {
      logger.warn({ total, maxPages, pageSize }, '[API] 近期全状态对账达到分页上限，较早订单可能未覆盖');
    }

    return orders;
  }

  async getAllWithdrawOrdersByStatuses(statuses: number[], dateRange?: { start: number; end: number }, options?: ApiRequestOptions): Promise<WithdrawOrder[]> {
    const seenOrderNos = new Set<string>();
    const results = await Promise.all(statuses.map(async (status) => {
      const orders: WithdrawOrder[] = [];
      let page = 1;
      const pageSize = 100;
      const maxPages = getWithdrawPageLimit();
      while (page <= maxPages) {
        try {
          const raw: any = await auth.getWithdrawOrders({
            currentPage: page, pageSize, status,
            startTime: dateRange?.start, endTime: dateRange?.end,
          }, options);
          const data = raw?.data || raw;
          const items: any[] = data?.items || [];
          for (const r of items) {
            const key = r.orderNo || r.cashOrderNo;
            if (!seenOrderNos.has(key)) { seenOrderNos.add(key); orders.push(mapWithdrawOrder(r)); }
          }
          if (items.length < pageSize) break;
          if (page === maxPages) {
            warnWithdrawTruncation(status, maxPages);
            break;
          }
          page++;
        } catch (err) {
          logger.error({ status, page, err: (err as Error).message }, '[API] 提现订单分页查询失败');
          throw new Error(`提款状态 ${status} 第 ${page} 页查询失败`, { cause: err });
        }
      }
      return orders;
    }));
    return results.flat();
  }

  // ===== 会员信息 =====

  async getMemberInfo(memberName: string, options?: ApiRequestOptions): Promise<ApiResponse<MemberInfo>> {
    const raw: any = await auth.getMemberInfo(memberName, options);
    const data = raw?.data || raw;
    const items: any[] = data?.items || [data].filter(Boolean);
    return { items: items.map(mapMemberInfo), totalNum: String(data?.totalNum || items.length) };
  }

  async getMembersByAgency(agencyUsername: string, page = 1, pageSize = 200, options?: ApiRequestOptions): Promise<ApiResponse<MemberInfo>> {
    const raw: any = await auth.getMembersByAgency(agencyUsername, page, pageSize, options);
    const data = raw?.data || raw;
    const items: any[] = data?.items || [];
    return { items: items.map(mapMemberInfo), totalNum: String(data?.totalNum || items.length) };
  }

  async getMemberInfoByName(memberName: string, options?: ApiRequestOptions): Promise<ApiResponse<MemberInfo>> {
    return this.getMemberInfo(memberName, options);
  }

  async getUserDetails(memberName: string, options?: ApiRequestOptions): Promise<UserDetailsResponse> {
    const result = await this.getMemberInfo(memberName, options);
    const items = result.items || [];
    return { data: items[0], items };
  }

  // ===== 投注记录 =====

  async getMemberBets(memberName: string, startPage = 1, dateRange?: { start: number; end: number }, maxPages = 3, options?: ApiRequestOptions): Promise<PagedResponse<BetRecord>> {
    const deduped = new Map<string, BetRecord>();
    let total = 0;
    let errorMessage = '';
    for (let page = startPage; page < startPage + maxPages; page++) {
      try {
        const raw: any = await auth.getMemberBets({
          memberName, page, size: 200,
          startTime: dateRange?.start, endTime: dateRange?.end,
        }, options);
        const data = raw?.data || raw;
        const items: any[] = data?.items || [];
        total = Math.max(total, safeParseInt(data?.totalNum, items.length));
        for (const r of items) {
          const mapped = mapBetRecord(r);
          const key = mapped.orderNo || `${mapped.lotteryName}|${mapped.issue}|${mapped.playClassName}|${mapped.playName}|${mapped.numbers}|${mapped.amount}|${mapped.betTime}`;
          deduped.set(key, mapped);
        }
        if (deduped.size >= total || items.length === 0) break;
      } catch (err) {
        errorMessage = (err as Error).message || '投注记录查询失败';
        logger.warn({ memberName, page, err: errorMessage }, '[API] 投注记录失败');
        break;
      }
    }
    const allBets = [...deduped.values()];
    const expected = Math.max(total, allBets.length);
    const complete = !errorMessage && allBets.length >= expected;
    return {
      items: allBets,
      totalNum: String(expected),
      quality: makeQuality('lotteryBets', complete ? 'complete' : (allBets.length > 0 ? 'partial' : 'failed'), allBets.length, expected, errorMessage || (complete ? undefined : '彩票注单达到分页上限')),
    };
  }

  async getBetsCountToday(memberName: string, dateRange?: { start: number; end: number }, options?: ApiRequestOptions): Promise<ApiResponse<BetsCount>> {
    try {
      const raw: any = await auth.getBetsCount(memberName, dateRange, options);
      const data = raw?.data || raw;
      const countData = data?.data || data;
      return { data: mapBetAnalysis(countData), quality: makeQuality('betsCount', 'complete', 1, 1) };
    } catch (err) { return { data: undefined, quality: makeQuality('betsCount', 'failed', 0, 1, (err as Error).message) }; }
  }

  // ===== 第三方游戏 =====

  async getThirdGameOrders(memberName: string, startPage = 1, dateRange?: { start: number; end: number }, maxPages = 3, options?: ApiRequestOptions): Promise<PagedResponse<ThirdGameOrder>> {
    const allItems: ThirdGameOrder[] = [];
    let total = 0;
    let errorMessage = '';
    for (let page = startPage; page < startPage + maxPages; page++) {
      try {
        const raw: any = await auth.getThirdGameOrders(memberName, page, dateRange, options);
        const data = raw?.data || raw;
        const items: any[] = data?.items || [];
        total = Math.max(total, safeParseInt(data?.totalNum, items.length));
        for (const r of items) allItems.push(mapThirdGameOrder(r));
        if (allItems.length >= total || items.length === 0) break;
      } catch (err) { errorMessage = (err as Error).message || '三方游戏订单查询失败'; break; }
    }
    const expected = Math.max(total, allItems.length);
    const complete = !errorMessage && allItems.length >= expected;
    return {
      items: allItems,
      totalNum: String(expected),
      quality: makeQuality('thirdGameOrders', complete ? 'complete' : (allItems.length > 0 ? 'partial' : 'failed'), allItems.length, expected, errorMessage || (complete ? undefined : '三方游戏订单达到分页上限')),
    };
  }

  // ===== 会员进出报表（近7天主投游戏判断） =====

  /** 获取近7天会员进出报表，并计算主投游戏类型 */
  async getMemberInOutReport(
    memberName: string,
    referenceTime: number,
    options?: ApiRequestOptions,
  ): Promise<{ report: MemberInOutReport | null; mainGameType: string | null }> {
    try {
      // 计算近7天日期范围（北京时间，含今天）
      const tzOffset = getTzOffset() * 3600000;
      const localNow = new Date(referenceTime + tzOffset);
      const endDate = localNow.toISOString().slice(0, 10);
      const startLocal = new Date(localNow);
      startLocal.setUTCDate(startLocal.getUTCDate() - 6);
      const startDate = startLocal.toISOString().slice(0, 10);

      const raw: any = await auth.getMemberInOutReport(memberName, startDate, endDate, options);
      const data = raw?.data || raw;
      const report: MemberInOutReport | null = (data && typeof data === 'object') ? data : null;
      const mainGameType = report ? computeMainGameType(report) : null;
      if (!mainGameType) {
        logger.debug({ memberName, startDate, endDate, shape: reportShape(data) }, '[API] 会员进出报表未识别出主投游戏');
      }
      return { report, mainGameType };
    } catch (err) {
      logger.debug({ memberName, referenceTime, err: (err as Error).message }, '[API] 会员进出报表查询失败');
      return { report: null, mainGameType: null };
    }
  }

  // ===== 提现历史 =====

  async getMemberWithdrawals(memberName: string, startPage = 1, dateRange?: { start: number; end: number }, maxPages = 2, options?: ApiRequestOptions): Promise<PagedResponse<WithdrawalRecord>> {
    const allItems: WithdrawalRecord[] = [];
    let total = 0;
    let errorMessage = '';
    for (let page = startPage; page < startPage + maxPages; page++) {
      try {
        const raw: any = await auth.getMemberWithdrawals({
          memberName, page,
          startTime: dateRange?.start, endTime: dateRange?.end,
        }, options);
        const data = raw?.data || raw;
        const items: any[] = data?.items || [];
        total = Math.max(total, safeParseInt(data?.totalNum, items.length));
        for (const r of items) allItems.push({
          orderNo: r.orderNo,
          status: r.status != null ? Number(r.status) : undefined,
          memberName: r.memberName,
          createTime: r.createTime,
          amount: r.amount ?? r.cashMoney,
          receivingBank: r.receivingBank,
          receivingName: r.receivingName,
          receivingCardNo: r.receivingCardNo,
        });
        if (allItems.length >= total || items.length === 0) break;
      } catch (err) { errorMessage = (err as Error).message || '提款历史查询失败'; break; }
    }
    const expected = Math.max(total, allItems.length);
    const complete = !errorMessage && allItems.length >= expected;
    return {
      items: allItems,
      totalNum: String(expected),
      quality: makeQuality('withdrawals', complete ? 'complete' : (allItems.length > 0 ? 'partial' : 'failed'), allItems.length, expected, errorMessage || (complete ? undefined : '提款历史达到分页上限')),
    };
  }

  // ===== 充值订单 =====

  async getPaymentOrders(memberName: string, startPage = 1, timeRange?: { start: number; end: number }, maxPages = 3, options?: ApiRequestOptions): Promise<PagedResponse<PaymentOrder>> {
    const allItems: PaymentOrder[] = [];
    let total = 0;
    let errorMessage = '';
    for (let page = startPage; page < startPage + maxPages; page++) {
      try {
        const raw: any = await auth.getPaymentOrders(memberName, page, timeRange, options);
        const data = raw?.data || raw;
        const items: any[] = data?.items || [];
        total = Math.max(total, safeParseInt(data?.totalNum, items.length));
        for (const r of items) {
          allItems.push({
            amount: r.amount,
            createTime: r.createTime,
            createdAt: r.createdAt,
            remark: r.remark,
            operatorName: r.operatorName,
            payPlatformName: r.payPlatformName || r.paywayName || r.payPlatformCode,
            paywayName: r.paywayName,
            payPlatformCode: r.payPlatformCode,
          });
        }
        if (allItems.length >= total || items.length === 0) break;
      } catch (err) { errorMessage = (err as Error).message || '充值订单查询失败'; break; }
    }
    const expected = Math.max(total, allItems.length);
    const complete = !errorMessage && allItems.length >= expected;
    return {
      items: allItems,
      totalNum: String(expected),
      quality: makeQuality('paymentOrders', complete ? 'complete' : (allItems.length > 0 ? 'partial' : 'failed'), allItems.length, expected, errorMessage || (complete ? undefined : '充值订单达到分页上限')),
    };
  }

  async getAccountChangeList(memberName: string, start: number, end: number, maxPages = 3, options?: ApiRequestOptions): Promise<PagedResponse<AccountChangeRecord>> {
    const allItems: AccountChangeRecord[] = [];
    let total = 0;
    let errorMessage = '';
    for (let page = 1; page <= maxPages; page++) {
      try {
        const raw: any = await auth.getAccountChangeList({ memberName, startTime: start, endTime: end, page, pageSize: 200 }, options);
        const data = raw?.data || raw;
        const items: any[] = data?.items || [];
        total = Math.max(total, safeParseInt(data?.totalNum, items.length));
        for (const r of items) {
          allItems.push({
            id: r.id,
            memberId: r.memberId != null ? String(r.memberId) : undefined,
            memberName: r.memberName,
            transType: r.transType != null ? Number(r.transType) : undefined,
            amount: r.amount,
            oldBalance: r.oldBalance,
            newBalance: r.newBalance,
            operatorRemark: r.operatorRemark,
            operatorName: r.operatorName,
            createTime: r.createTime,
            transSeq: r.transSeq,
            transDesc: r.transDesc,
            transDetail: r.transDetail,
          });
        }
        if (allItems.length >= total || items.length === 0) break;
      } catch (err) { errorMessage = (err as Error).message || '人工加款明细查询失败'; break; }
    }
    const expected = Math.max(total, allItems.length);
    const complete = !errorMessage && allItems.length >= expected;
    return {
      items: allItems,
      totalNum: String(expected),
      quality: makeQuality('accountChanges', complete ? 'complete' : (allItems.length > 0 ? 'partial' : 'failed'), allItems.length, expected, errorMessage || (complete ? undefined : '人工加款明细达到分页上限')),
    };
  }

  // ===== 充值汇总 =====

  async getManualRechargeSum(memberName: string, start: number, end: number, options?: ApiRequestOptions): Promise<RechargeSumResponse> {
    try {
      const raw: any = await auth.getRechargeSum({ memberName, startTime: start, endTime: end }, options);
      const data = raw?.data || raw;
      return { sumAmount: data?.sumAmount || data?.data?.sumAmount || '0', quality: makeQuality('manualRecharge', 'complete', 1, 1) };
    } catch (err) { return { sumAmount: '0', quality: makeQuality('manualRecharge', 'failed', 0, 1, (err as Error).message) }; }
  }

  // ===== 登录日志 =====

  async getLoginLogsByMember(memberName: string, dateRange?: { start: number; end: number }, options?: LoginLogFetchOptions): Promise<PagedResponse<LoginLogItem>> {
    try {
      return await fetchLoginLogs({
        memberName,
        startTime: dateRange?.start,
        endTime: dateRange?.end,
      }, options);
    } catch (err) { return { items: [], totalNum: '0', quality: makeQuality('loginLogs', 'failed', 0, 0, (err as Error).message) }; }
  }

  async getLoginLogsByIp(ip: string, dateRange?: { start: number; end: number }, options?: LoginLogFetchOptions): Promise<PagedResponse<LoginLogItem>> {
    try {
      return await fetchLoginLogs({
        loginIp: ip,
        startTime: dateRange?.start,
        endTime: dateRange?.end,
      }, options);
    } catch (err) { return { items: [], totalNum: '0', quality: makeQuality('loginLogs', 'failed', 0, 0, (err as Error).message) }; }
  }

  async getLoginLogsByDevice(device: string, dateRange?: { start: number; end: number }, options?: LoginLogFetchOptions): Promise<PagedResponse<LoginLogItem>> {
    try {
      return await fetchLoginLogs({
        device,
        startTime: dateRange?.start,
        endTime: dateRange?.end,
      }, options);
    } catch (err) { return { items: [], totalNum: '0', quality: makeQuality('loginLogs', 'failed', 0, 0, (err as Error).message) }; }
  }

  // ===== WS域名 =====

  async getWebSocketDomain(): Promise<string | null> {
    try {
      const tokenInfo = await auth.getWsToken();
      return tokenInfo?.wsUrl || null;
    } catch { return null; }
  }

  // ===== 日期范围（保留原接口兼容） =====

  getEffectiveDateRange(orderCreateTime?: number): { start: number; end: number; isEarlyMorning: boolean } {
    const referenceTime = orderCreateTime && Number.isFinite(orderCreateTime) ? orderCreateTime : Date.now();
    const localTime = new Date(referenceTime + getTzOffset() * 3600000);
    if (localTime.getUTCHours() < 6) return { ...this.getTwoDayDateRange(referenceTime, true), isEarlyMorning: true };
    return { ...this.getTimezoneDateRange(referenceTime, true), isEarlyMorning: false };
  }

  getTimezoneDateRange(referenceTime = Date.now(), endAtReference = false): { start: number; end: number } {
    const now = new Date(referenceTime);
    const offset = getTzOffset() * 3600000;
    const localNow = new Date(now.getTime() + offset);
    const startOfDay = new Date(localNow); startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(localNow); endOfDay.setUTCHours(23, 59, 59, 999);
    return { start: startOfDay.getTime() - offset, end: endAtReference ? referenceTime : endOfDay.getTime() - offset };
  }

  getTwoDayDateRange(referenceTime = Date.now(), endAtReference = false): { start: number; end: number } {
    const now = new Date(referenceTime);
    const offset = getTzOffset() * 3600000;
    const localNow = new Date(now.getTime() + offset);
    const startOfYesterday = new Date(localNow); startOfYesterday.setUTCHours(0, 0, 0, 0);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const endOfDay = new Date(localNow); endOfDay.setUTCHours(23, 59, 59, 999);
    return { start: startOfYesterday.getTime() - offset, end: endAtReference ? referenceTime : endOfDay.getTime() - offset };
  }

  getRollingDateRange(endTime: number, days: number): { start: number; end: number } {
    const safeEnd = Number.isFinite(endTime) && endTime > 0 ? endTime : Date.now();
    const safeDays = Math.min(Math.max(Math.trunc(days) || 1, 1), 31);
    return { start: safeEnd - safeDays * 24 * 3600 * 1000, end: safeEnd };
  }

  // ===== 健康检查 =====

  async checkHealth(): Promise<boolean> {
    const now = Date.now();
    if (this.lastHealthResult !== null && (now - this.lastHealthTime) < ApiClient.HEALTH_CACHE_TTL) {
      return this.lastHealthResult;
    }
    this.lastHealthResult = await auth.checkHealth();
    this.lastHealthTime = now;
    return this.lastHealthResult;
  }

  invalidateHealthCache(): void {
    this.lastHealthResult = null;
    this.lastHealthTime = 0;
  }
}

export const apiClient = new ApiClient();
