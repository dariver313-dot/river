/**
 * ApiClient — 委托 auth-client 调用 auth-service
 * 保留原 ApiClient 接口，内部全部委托给 auth-client.ts
 */

import { logger } from './logger';
import { type WithdrawOrder } from './types';
import type {
  ApiResponse, PagedResponse, MemberInfo, UserDetailsResponse, BetRecord,
  WithdrawalRecord, PaymentOrder, BetsCount,
  LoginLogItem, NewRechReport, NewRechargeOrderHistory,
} from './types';

// auth-service 客户端
import * as auth from './auth-client';
// 统一使用 utils.ts 的时区偏移函数，确保验证逻辑一致
import { getTzOffsetMinutes } from './utils';

// ============================================================
// 字段映射（保留原业务逻辑）
// ============================================================

function safeParseInt(val: unknown, defaultVal: number = 0): number {
  const n = parseInt(String(val), 10);
  return isNaN(n) ? defaultVal : n;
}

function getWithdrawPageLimit(): number {
  return Math.min(Math.max(safeParseInt(process.env.WITHDRAW_ORDER_MAX_PAGES, 1), 1), 200);
}

const withdrawTruncationWarnAt = new Map<number, number>();

function warnWithdrawTruncation(status: number, maxPages: number): void {
  const now = Date.now();
  const last = withdrawTruncationWarnAt.get(status) || 0;
  if (now - last < 5 * 60 * 1000) return;
  withdrawTruncationWarnAt.set(status, now);
  logger.warn({ status, maxPages }, '[API] 提现订单达到分页上限，本轮只处理最新订单；请根据负载调整 WITHDRAW_ORDER_MAX_PAGES');
}

function getTzOffset(): number { return getTzOffsetMinutes() / 60; }

interface ApiRequestOptions {
  signal?: AbortSignal;
}

interface LoginLogFetchOptions extends ApiRequestOptions {
  maxPages?: number;
  pageSize?: number;
}

function formatLocalDate(ms: number): string {
  const tzMs = getTzOffset() * 3600000;
  return new Date(ms + tzMs).toISOString().slice(0, 10);
}

function formatLocalDateTime(ms: number): string {
  const tzMs = getTzOffset() * 3600000;
  return new Date(ms + tzMs).toISOString().replace('T', ' ').slice(0, 19);
}

function dateRangeToDateStrings(dateRange?: { start: number; end: number }): { startDate?: string; endDate?: string } | undefined {
  if (!dateRange) return undefined;
  return { startDate: formatLocalDate(dateRange.start), endDate: formatLocalDate(dateRange.end) };
}

function dateRangeToDateTimeStrings(dateRange?: { start: number; end: number }): { beginTime?: string; endTime?: string } {
  if (!dateRange) return {};
  return { beginTime: formatLocalDateTime(dateRange.start), endTime: formatLocalDateTime(dateRange.end) };
}

function mapWithdrawOrder(n: any): WithdrawOrder {
  return {
    orderNo: n.cashOrderNo, id: n.id, status: n.cashStatus,
    amount: n.cashMoney, memberName: n.account, member_name: n.account,
    memberId: String(n.memberId || n.userId || ''), member_id: String(n.memberId || n.userId || ''),
    createTime: n.createTime, proxyCode: n.superName, proxy_code: n.superName,
    agencyMemberName: n.superName, receivingBank: n.bankName,
    receivingName: n.realName, receivingCardNo: n.bankCard,
    vipLevel: n.vipLevel || n.memberLevel, currency: n.currency, balance: n.accountMoney,
    memberRemark: n.userRemark || n.memberMemo || undefined,
  };
}

function mapMemberInfo(n: any): MemberInfo {
  return {
    memberId: String(n.id || n.popularizeId), memberName: n.account,
    userName: n.nickname, id: n.id, createTime: n.createTime,
    createdAt: n.createTime, sumBet: n.betAmount || 0,
    sumRecharge: Math.abs(n.totalRechAmount) || 0,
    sumWithdraw: Math.abs(n.totalWithdrawAmount) || 0,
    sumRechargeTimes: n.totalRechTimes, sumWithdrawTimes: n.totalWithdrawTimes,
    sumRolling: n.validAmount, balance: n.balance,
    balanceDifference: n.balanceDifference, vipLevel: n.vipLevel, remark: n.remark,
    latestRechargeTime: n.lastRechTime, agencyMemberName: n.parentName,
    proxyCode: n.parentName, proxy_code: n.parentName, parentName: n.parentName,
    lastLoginIp: n.lastLoginIp, lastLoginDeviceClientId: n.lastLoginDeviceClientId,
    registerIp: n.registerIp,
  };
}

function mapBetRecord(n: any): BetRecord {
  return {
    lotteryName: n.gameName, issue: n.issueNum, playClassName: n.cateName,
    playName: n.betInfoName || n.betInfo, numbers: n.betInfo,
    amount: n.money, profit: n.reward, betTime: n.betTime,
    allbet: n.totalMoney, bet: n.money,
  };
}

function mapBetAnalysis(n: any): BetsCount {
  const gameTypes = [
    { name: '彩票', amount: n.lotteryValidAmount },
    { name: '体育', amount: n.sportValidAmount },
    { name: '真人', amount: n.realValidAmount },
    { name: '电子', amount: n.egameValidAmount },
    { name: '棋牌', amount: n.chessValidAmount },
    { name: '捕鱼', amount: n.hunterValidAmount },
    { name: '电竞', amount: n.esportValidAmount },
  ];
  const top2 = gameTypes.filter(g => g.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 2).map(g => g.name);
  return {
    countAmount: String(gameTypes.reduce((sum, g) => sum + g.amount, 0)),
    realAmount: String(gameTypes.reduce((sum, g) => sum + g.amount, 0)),
    countWin: String(n.allWinAmount), countProfit: String(n.allWinAmount),
    topGameTypes: top2.length > 0 ? top2.join('、') : undefined,
  };
}

function mapRechargeOrder(n: any): PaymentOrder {
  return {
    amount: n.amount, createTime: n.createTime, createdAt: n.createTime,
    remark: n.remark || n.remarks || n.auditRemarks || n.userRemark,
    operatorName: n.operatorName, payPlatformName: n.payPlatformName || n.payTypeName || n.tpMerchantName,
  };
}

function mapLoginLog(n: any): LoginLogItem {
  return {
    memberName: n.account || n.memberName,
    loginIp: n.ipAddress || n.loginIp,
    device: n.deviceClientId || n.device,
    loginTime: n.loginTime || n.createTime || n.loginDate,
  };
}

async function fetchLoginLogs(params: Record<string, unknown>, options: LoginLogFetchOptions = {}): Promise<PagedResponse<LoginLogItem>> {
  const maxPages = Math.max(1, options.maxPages ?? 10);
  const pageSize = Math.min(Math.max(1, options.pageSize ?? 50), 100);
  const allItems: LoginLogItem[] = [];
  let totalNum = 0;

  for (let page = 1; page <= maxPages; page++) {
    const raw = await auth.getLoginLogs({
      current: page,
      size: pageSize,
      ...params,
    }, { signal: options.signal });
    const data = raw?.data || raw;
    const records: any[] = data?.records || [];
    if (page === 1) totalNum = safeParseInt(data?.total, records.length);
    for (const item of records) allItems.push(mapLoginLog(item));
    if (records.length < pageSize) break;
  }

  return { items: allItems, totalNum: String(totalNum || allItems.length) };
}

// ============================================================
// ApiClient
// ============================================================

export class ApiClient {
  private lastHealthResult: boolean | null = null;
  private lastHealthTime: number = 0;
  private static HEALTH_CACHE_TTL = 60 * 1000;

  // ===== Token 管理（已由 auth-service 接管，保留为兼容桩） =====
  onTokenUpdate(_cb: (token: string | null) => void) {}
  setToken(_token: string | null) { this.invalidateHealthCache(); }
  getToken(): string | null { return null; }
  validateToken(_token: string): { valid: boolean; reason?: string } {
    return { valid: true };
  }

  // ===== 提现订单 =====

  async getPendingWithdrawOrders(): Promise<WithdrawOrder[]> {
    const now = new Date();
    const lookbackHours = Math.min(Math.max(safeParseInt(process.env.PENDING_ORDER_LOOKBACK_HOURS, 12), 1), 72);
    return this.getAllWithdrawOrdersByStatuses([1, 2], {
      start: now.getTime() - lookbackHours * 3600000,
      end: now.getTime(),
    });
  }

  async getAllWithdrawOrdersByStatuses(statuses: number[], dateRange?: { start: number; end: number }): Promise<WithdrawOrder[]> {
    const seenOrderNos = new Set<string>();
    const maxPages = getWithdrawPageLimit();
    const statusResults = await Promise.all(statuses.map(async (status) => {
      const statusOrders: WithdrawOrder[] = [];
      let page = 1;
      const pageSize = 100;
      while (page <= maxPages) {
        try {
          const tzMs = getTzOffset() * 3600000;
          const startStr = dateRange ? new Date(dateRange.start + tzMs).toISOString().replace('T', ' ').slice(0, 19) : undefined;
          const endStr = dateRange ? new Date(dateRange.end + tzMs).toISOString().replace('T', ' ').slice(0, 19) : undefined;
          const raw = await auth.getWithdrawOrders({
            current: page, size: pageSize, cashStatusList: Number(status),
            createTimeFrom: startStr, createTimeTo: endStr,
          });
          const data = raw?.data || raw;
          const records: any[] = data?.records || [];
          for (const r of records) {
            const key = r.cashOrderNo;
            if (!seenOrderNos.has(key)) { seenOrderNos.add(key); statusOrders.push(mapWithdrawOrder(r)); }
          }
          if (records.length < pageSize) break;
          if (page === maxPages) {
            warnWithdrawTruncation(status, maxPages);
            break;
          }
          page++;
        } catch (err) {
          logger.error({ status, page, err: (err as Error).message }, `[API] 获取提现订单失败`);
          throw err;
        }
      }
      return statusOrders;
    }));
    return statusResults.flat();
  }

  // ===== 会员信息 =====

  async getMembersByAgency(agencyUsername: string, page = 1, pageSize = 200): Promise<ApiResponse<MemberInfo>> {
    const raw = await auth.getMembersByAgency(agencyUsername, page, pageSize);
    const data = raw?.data || raw;
    const records: any[] = data?.records || [];
    return { items: records.map(mapMemberInfo), totalNum: String(data?.total || records.length) };
  }

  async getMemberInfoByName(memberName: string, options?: ApiRequestOptions): Promise<ApiResponse<MemberInfo>> {
    const raw = await auth.getMemberInfo(memberName, options);
    const data = raw?.data || raw;
    const records: any[] = Array.isArray(data?.records) ? data.records : [data].filter(Boolean);
    return { items: records.map(mapMemberInfo), totalNum: String(data?.total || records.length) };
  }

  async getUserDetails(account: string, options?: ApiRequestOptions): Promise<UserDetailsResponse> {
    const raw = await auth.getMemberInfo(account, options);
    const data = raw?.data || raw;
    const records: any[] = Array.isArray(data?.records) ? data.records : [data].filter(Boolean);
    if (records.length > 0) {
      const detail = records[0];
      return { data: mapMemberInfo(detail), items: [mapMemberInfo(detail)] };
    }
    return { data: undefined, items: [] };
  }

  // ===== 投注记录 =====

  /** 查询指定时间范围的彩票注单；调用方负责按提款时刻传入窗口。 */
  async getMemberBets(account: string, startPage = 1, dateRange?: { start: number; end: number }, maxPages = 3, options?: ApiRequestOptions): Promise<PagedResponse<BetRecord>> {
    const allBets: BetRecord[] = [];
    for (let page = startPage; page < startPage + maxPages; page++) {
      try {
        const raw = await auth.getMemberBets({
          account, page, size: 500,
          startTime: dateRange?.start, endTime: dateRange?.end,
        }, options);
        const data = raw?.data || raw;
        const pageData = data?.page || data;
        const records: any[] = pageData?.records || [];
        for (const r of records) allBets.push(mapBetRecord(r));
        if (records.length < 500) break;
      } catch (err) {
        logger.warn({ page, account, err: (err as Error).message }, '[API] 获取投注记录失败');
        throw err;
      }
    }
    return { items: allBets, totalNum: String(allBets.length) };
  }

  async getBetsCountToday(account: string, dateRange?: { start: number; end: number }, options?: ApiRequestOptions): Promise<ApiResponse<BetsCount>> {
    try {
      const raw = await auth.getBetsCount(account, dateRangeToDateStrings(dateRange), options);
      const data = raw?.data || raw;
      if (data && data.lotteryValidAmount != null) {
        const result = mapBetAnalysis(data);
        logger.debug({ account, topGameTypes: result.topGameTypes }, '[API] 投注分析结果');
        return { data: result };
      }
    } catch (err) {
      logger.warn({ account, err: (err as Error).message }, '[API] 获取投注分析失败');
      throw err;
    }
    return { data: undefined };
  }

  // ===== 提现历史 =====

  async getMemberWithdrawals(account: string, startPage = 1, dateRange?: { start: number; end: number }, maxPages = 2, options?: ApiRequestOptions): Promise<PagedResponse<WithdrawalRecord>> {
    const allItems: WithdrawalRecord[] = [];
    for (let page = startPage; page < startPage + maxPages; page++) {
      try {
        const raw = await auth.getMemberWithdrawals({ account, page, startTime: dateRange?.start, endTime: dateRange?.end }, options);
        const data = raw?.data || raw;
        const records: any[] = data?.records || [];
        for (const r of records) {
          // 递增/频率等历史规则只认平台已确认出款，拒绝和取消申请不能计入。
          if (Number(r.cashStatus ?? r.status) !== 3) continue;
          allItems.push({
            orderNo: r.cashOrderNo || r.orderNo,
            status: r.cashStatus ?? r.status,
            createTime: r.createTime,
            amount: r.cashMoney ?? r.amount,
            receivingBank: r.bankName,
            receivingName: r.realName,
            receivingCardNo: r.bankCard,
          });
        }
        if (records.length < 200) break;
      } catch (err) {
        logger.warn({ page, account, err: (err as Error).message }, '[API] 获取提现历史失败');
        throw err;
      }
    }
    return { items: allItems, totalNum: String(allItems.length) };
  }

  // ===== 充值订单 =====

  async getPaymentOrders(account: string, startPage = 1, timeRange?: { start: number; end: number }, maxPages = 3, options?: ApiRequestOptions): Promise<PagedResponse<PaymentOrder>> {
    const allItems: PaymentOrder[] = [];
    for (let page = startPage; page < startPage + maxPages; page++) {
      try {
        const raw = await auth.getPaymentOrders(account, page, timeRange, options);
        const data = raw?.data || raw;
        const records: any[] = data?.records || [];
        for (const r of records) allItems.push(mapRechargeOrder(r));
        if (records.length < 200) break;
      } catch (err) {
        logger.warn({ page, account, err: (err as Error).message }, '[API] 获取充值订单失败');
        throw err;
      }
    }
    return { items: allItems, totalNum: String(allItems.length) };
  }

  // ===== 充值汇总/历史 =====

  async getRechReport(account: string, start: number, end: number, options?: ApiRequestOptions): Promise<NewRechReport | null> {
    try {
      const raw = await auth.getRechReport(account, start, end, options);
      const data = raw?.data || raw;
      return (data as NewRechReport) || null;
    } catch (err) {
      logger.warn({ account, err: (err as Error).message }, '[API] 获取充值汇总失败');
      throw err;
    }
  }

  async getRechargeOrderHistory(account: string, start: number, end: number, options?: ApiRequestOptions): Promise<NewRechargeOrderHistory[]> {
    try {
      const tzMs = getTzOffset() * 3600000;
      const beginStr = new Date(start + tzMs).toISOString().replace('T', ' ').slice(0, 19);
      const endStr = new Date(end + tzMs).toISOString().replace('T', ' ').slice(0, 19);
      const raw = await auth.getRechargeHistory(account, beginStr, endStr, options);
      const data = raw?.data || raw;
      const records: any[] = data?.records || [];
      return records as NewRechargeOrderHistory[];
    } catch (err) {
      logger.warn({ account, err: (err as Error).message }, '[API] 获取充值历史失败');
      throw err;
    }
  }

  // ===== 登录日志 =====

  async getLoginLogsByMember(account: string, dateRange?: { start: number; end: number }, options?: LoginLogFetchOptions): Promise<PagedResponse<LoginLogItem>> {
    try {
      return await fetchLoginLogs({
        account,
        ...dateRangeToDateTimeStrings(dateRange),
      }, options);
    } catch (err) {
      logger.warn({ account, err: (err as Error).message }, '[API] 获取登录日志失败');
      throw err;
    }
  }

  async getLoginLogsByIp(ip: string, dateRange?: { start: number; end: number }, options?: LoginLogFetchOptions): Promise<PagedResponse<LoginLogItem>> {
    try {
      return await fetchLoginLogs({
        loginIp: ip,
        ...dateRangeToDateTimeStrings(dateRange),
      }, options);
    } catch (err) {
      logger.warn({ ip, err: (err as Error).message }, '[API] 获取IP登录日志失败');
      throw err;
    }
  }

  async getLoginLogsByDevice(device: string, dateRange?: { start: number; end: number }, options?: LoginLogFetchOptions): Promise<PagedResponse<LoginLogItem>> {
    try {
      return await fetchLoginLogs({
        deviceClientId: device,
        ...dateRangeToDateTimeStrings(dateRange),
      }, options);
    } catch (err) {
      logger.warn({ device, err: (err as Error).message }, '[API] 获取设备登录日志失败');
      throw err;
    }
  }

  // ===== 日期范围工具（保留 api-client 旧接口兼容） =====

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
    return { start: safeEnd - safeDays * 24 * 3600000, end: safeEnd };
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

  // ===== 自动登录（auth-service 已接管） =====
  async autoLogin(): Promise<string | null> { return null; }
}

export const apiClient = new ApiClient();
