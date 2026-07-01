/**
 * ApiClient — 委托 auth-client 调用 auth-service
 * 保留原 ApiClient 接口，内部全部委托给 auth-client.ts
 */

import { logger } from './logger';
import { type WithdrawOrder } from './ws-client';
import type {
  ApiResponse, PagedResponse, MemberInfo, UserDetailsResponse, BetRecord,
  ThirdGameOrder, WithdrawalRecord, PaymentOrder, BetsCount,
  RechargeSumResponse, LoginLogItem, DomainItem, MemberInOutReport,
} from './types';

import * as auth from './auth-client';

// ============================================================
// 工具函数
// ============================================================

function safeParseInt(val: unknown, defaultVal: number = 0): number {
  const n = parseInt(String(val), 10);
  return isNaN(n) ? defaultVal : n;
}

function getTzOffset(): number { return safeParseInt(process.env.TZ_OFFSET, 8); }

function mapWithdrawOrder(n: any): WithdrawOrder {
  return {
    orderNo: n.orderNo, id: n.id || n.orderNo, status: n.status,
    amount: n.amount, memberName: n.memberName, memberId: String(n.memberId),
    member_name: n.memberName, member_id: String(n.memberId),
    createTime: n.createTime, agencyMemberName: n.proxyCode || n.agencyMemberName,
    receivingBank: n.receivingBank, receivingName: n.receivingName,
    receivingCardNo: n.receivingCardNo, vipLevel: n.vipLevel,
    currency: n.currency, balance: n.balance || n.sumRecharge,
  };
}

function mapMemberInfo(n: any): MemberInfo {
  return {
    memberId: String(n.memberId || n.id), memberName: n.memberName,
    id: n.memberId, createTime: n.createTime,
    // getUserDetails 返回 sumRecharge/sumWithdraw 为字符串金额，统一 parseFloat
    sumRecharge: n.sumRecharge != null ? Math.abs(parseFloat(String(n.sumRecharge))) : undefined,
    sumWithdraw: n.sumWithdraw != null ? Math.abs(parseFloat(String(n.sumWithdraw))) : undefined,
    sumRechargeTimes: n.sumRechargeTimes, sumWithdrawTimes: n.sumWithdrawTimes,
    sumRolling: n.sumRolling != null ? parseFloat(String(n.sumRolling)) : undefined,
    balance: n.balance, vipLevel: n.vipLevel || n.levelId,
    remark: n.remark, agencyMemberName: n.agencyMemberName,
    lastLoginIp: n.latestLoginIp, lastLoginDeviceClientId: n.latestLoginDevice,
    registerIp: n.registerIp,
  };
}

function mapBetRecord(n: any): BetRecord {
  return {
    lotteryName: n.lotteryName, issue: n.issue, playClassName: n.playClassName,
    playName: n.playName, numbers: n.numbers,
    amount: n.amount, profit: n.profit, betTime: n.betTime || n.createTime,
  };
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
    amount: n.allbet || n.bet, createTime: n.betTime || n.createTime,
    gameName: n.subRespList?.[0]?.gameName || n.gameName,
  };
}

function mapLoginLog(n: any): LoginLogItem {
  return { memberName: n.memberName, loginIp: n.loginIp, device: n.device };
}

// 游戏类型字段 → 中文标签映射（用于主投游戏判断）
const GAME_TYPE_FIELDS: Array<{ field: keyof MemberInOutReport; label: string }> = [
  { field: 'lotteryBetAmount', label: '彩票类游戏' },
  { field: 'truemanBetAmount', label: '真人类游戏' },
  { field: 'boardBetAmount',   label: '棋牌类游戏' },
  { field: 'slotsBetAmount',   label: '电子类游戏' },
  { field: 'fishBetAmount',    label: '捕鱼类游戏' },
  { field: 'raceBetAmount',    label: '竞技类游戏' },
  { field: 'sportBetAmount',   label: '体育类游戏' },
];

/** 根据近7天各游戏类型投注金额，返回金额最大的游戏类型标签 */
function computeMainGameType(report: MemberInOutReport): string | null {
  let maxAmt = 0;
  let maxLabel: string | null = null;
  for (const { field, label } of GAME_TYPE_FIELDS) {
    const amt = Math.abs(parseFloat(String(report[field] ?? '0')) || 0);
    if (amt > maxAmt) {
      maxAmt = amt;
      maxLabel = label;
    }
  }
  // 所有金额均为0时不返回主投类型
  return maxAmt > 0 ? maxLabel : null;
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

  async getAllWithdrawOrdersByStatuses(statuses: number[], dateRange?: { start: number; end: number }): Promise<WithdrawOrder[]> {
    const seenOrderNos = new Set<string>();
    const results = await Promise.all(statuses.map(async (status) => {
      const orders: WithdrawOrder[] = [];
      let page = 1; const pageSize = 50; const maxPages = 200;
      while (page <= maxPages) {
        try {
          const raw: any = await auth.getWithdrawOrders({
            currentPage: page, pageSize, status,
            startTime: dateRange?.start, endTime: dateRange?.end,
          });
          const data = raw?.data || raw;
          const items: any[] = data?.items || [];
          for (const r of items) {
            const key = r.orderNo || r.cashOrderNo;
            if (!seenOrderNos.has(key)) { seenOrderNos.add(key); orders.push(mapWithdrawOrder(r)); }
          }
          if (items.length < pageSize) break;
          page++;
        } catch (err) { logger.error({ status, page, err: (err as Error).message }, '[API] 提现订单失败'); break; }
      }
      return orders;
    }));
    return results.flat();
  }

  // ===== 会员信息 =====

  async getMemberInfo(memberName: string): Promise<ApiResponse<MemberInfo>> {
    const raw: any = await auth.getMemberInfo(memberName);
    const data = raw?.data || raw;
    const items: any[] = data?.items || [data].filter(Boolean);
    return { items: items.map(mapMemberInfo), totalNum: String(data?.totalNum || items.length) };
  }

  async getMembersByAgency(agencyUsername: string, page = 1, pageSize = 200): Promise<ApiResponse<MemberInfo>> {
    const raw: any = await auth.getMembersByAgency(agencyUsername, page, pageSize);
    const data = raw?.data || raw;
    const items: any[] = data?.items || [];
    return { items: items.map(mapMemberInfo), totalNum: String(data?.totalNum || items.length) };
  }

  async getMemberInfoByName(memberName: string): Promise<ApiResponse<MemberInfo>> {
    return this.getMemberInfo(memberName);
  }

  async getUserDetails(memberName: string): Promise<UserDetailsResponse> {
    const result = await this.getMemberInfo(memberName);
    const items = result.items || [];
    return { data: items[0], items };
  }

  // ===== 投注记录 =====

  async getMemberBetsToday(memberName: string, startPage = 1, dateRange?: { start: number; end: number }, maxPages = 3): Promise<PagedResponse<BetRecord>> {
    const allBets: BetRecord[] = [];
    for (let page = startPage; page < startPage + maxPages; page++) {
      try {
        const raw: any = await auth.getMemberBets({
          memberName, page, size: 200,
          startTime: dateRange?.start, endTime: dateRange?.end,
        });
        const data = raw?.data || raw;
        const items: any[] = data?.items || [];
        for (const r of items) allBets.push(mapBetRecord(r));
        if (items.length < 200) break;
      } catch (err) { logger.warn({ memberName, page }, '[API] 投注记录失败'); break; }
    }
    return { items: allBets, totalNum: String(allBets.length) };
  }

  async getBetsCountToday(memberName: string, dateRange?: { start: number; end: number }): Promise<ApiResponse<BetsCount>> {
    try {
      const raw: any = await auth.getBetsCount(memberName, dateRange);
      const data = raw?.data || raw;
      const countData = data?.data || data;
      return { data: mapBetAnalysis(countData) };
    } catch (err) { return { data: undefined }; }
  }

  // ===== 第三方游戏 =====

  async getThirdGameOrders(memberName: string, startPage = 1, dateRange?: { start: number; end: number }, maxPages = 3): Promise<PagedResponse<ThirdGameOrder>> {
    const allItems: ThirdGameOrder[] = [];
    for (let page = startPage; page < startPage + maxPages; page++) {
      try {
        const raw: any = await auth.getThirdGameOrders(memberName, page, dateRange);
        const data = raw?.data || raw;
        const items: any[] = data?.items || [];
        for (const r of items) allItems.push(mapThirdGameOrder(r));
        if (items.length < 200) break;
      } catch (err) { break; }
    }
    return { items: allItems, totalNum: String(allItems.length) };
  }

  // ===== 会员进出报表（近7天主投游戏判断） =====

  /** 获取近7天会员进出报表，并计算主投游戏类型 */
  async getMemberInOutReport(memberName: string): Promise<{ report: MemberInOutReport | null; mainGameType: string | null }> {
    try {
      // 计算近7天日期范围（北京时间，含今天）
      const tzOffset = getTzOffset() * 3600000;
      const localNow = new Date(Date.now() + tzOffset);
      const endDate = localNow.toISOString().slice(0, 10);
      const startLocal = new Date(localNow);
      startLocal.setUTCDate(startLocal.getUTCDate() - 6);
      const startDate = startLocal.toISOString().slice(0, 10);

      const raw: any = await auth.getMemberInOutReport(memberName, startDate, endDate);
      const data = raw?.data || raw;
      const report: MemberInOutReport | null = (data && typeof data === 'object') ? data : null;
      const mainGameType = report ? computeMainGameType(report) : null;
      return { report, mainGameType };
    } catch (err) {
      return { report: null, mainGameType: null };
    }
  }

  // ===== 提现历史 =====

  async getMemberWithdrawals(memberName: string, startPage = 1, dateRange?: { start: number; end: number }, maxPages = 2): Promise<PagedResponse<WithdrawalRecord>> {
    const allItems: WithdrawalRecord[] = [];
    for (let page = startPage; page < startPage + maxPages; page++) {
      try {
        const raw: any = await auth.getMemberWithdrawals({
          memberName, page,
          startTime: dateRange?.start, endTime: dateRange?.end,
        });
        const data = raw?.data || raw;
        const items: any[] = data?.items || [];
        for (const r of items) allItems.push({ createTime: r.createTime, amount: r.amount || r.cashMoney });
        if (items.length < 200) break;
      } catch (err) { break; }
    }
    return { items: allItems, totalNum: String(allItems.length) };
  }

  // ===== 充值订单 =====

  async getPaymentOrders(memberName: string, startPage = 1, timeRange?: { start: number; end: number }, maxPages = 3): Promise<PagedResponse<PaymentOrder>> {
    const allItems: PaymentOrder[] = [];
    for (let page = startPage; page < startPage + maxPages; page++) {
      try {
        const raw: any = await auth.getPaymentOrders(memberName, page, timeRange);
        const data = raw?.data || raw;
        const items: any[] = data?.items || [];
        for (const r of items) allItems.push({ amount: r.amount, createTime: r.createTime, remark: r.remark });
        if (items.length < 200) break;
      } catch (err) { break; }
    }
    return { items: allItems, totalNum: String(allItems.length) };
  }

  // ===== 充值汇总 =====

  async getManualRechargeSum(memberName: string, start: number, end: number): Promise<RechargeSumResponse> {
    try {
      const raw: any = await auth.getRechargeSum({ memberName, startTime: start, endTime: end });
      const data = raw?.data || raw;
      return { sumAmount: data?.sumAmount || data?.data?.sumAmount || '0' };
    } catch (err) { return { sumAmount: '0' }; }
  }

  // ===== 登录日志 =====

  async getLoginLogsByMember(memberName: string): Promise<PagedResponse<LoginLogItem>> {
    try {
      const raw: any = await auth.getLoginLogs({ memberName });
      const data = raw?.data || raw;
      const items: any[] = data?.items || [];
      return { items: items.map(mapLoginLog), totalNum: String(items.length) };
    } catch (err) { return { items: [], totalNum: '0' }; }
  }

  async getLoginLogsByIp(ip: string): Promise<PagedResponse<LoginLogItem>> {
    try {
      const raw: any = await auth.getLoginLogs({ loginIp: ip });
      const data = raw?.data || raw;
      const items: any[] = data?.items || [];
      return { items: items.map(mapLoginLog), totalNum: String(data?.totalNum || items.length) };
    } catch (err) { return { items: [], totalNum: '0' }; }
  }

  async getLoginLogsByDevice(device: string): Promise<PagedResponse<LoginLogItem>> {
    try {
      const raw: any = await auth.getLoginLogs({ device });
      const data = raw?.data || raw;
      const items: any[] = data?.items || [];
      return { items: items.map(mapLoginLog), totalNum: String(data?.totalNum || items.length) };
    } catch (err) { return { items: [], totalNum: '0' }; }
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
    if (orderCreateTime) {
      const localTime = new Date(orderCreateTime + getTzOffset() * 3600000);
      if (localTime.getUTCHours() < 6) return { ...this.getTwoDayDateRange(), isEarlyMorning: true };
    }
    return { ...this.getTimezoneDateRange(), isEarlyMorning: false };
  }

  getTimezoneDateRange(): { start: number; end: number } {
    const now = new Date();
    const offset = getTzOffset() * 3600000;
    const localNow = new Date(now.getTime() + offset);
    const startOfDay = new Date(localNow); startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(localNow); endOfDay.setUTCHours(23, 59, 59, 999);
    return { start: startOfDay.getTime() - offset, end: endOfDay.getTime() - offset };
  }

  getTwoDayDateRange(): { start: number; end: number } {
    const now = new Date();
    const offset = getTzOffset() * 3600000;
    const localNow = new Date(now.getTime() + offset);
    const startOfYesterday = new Date(localNow); startOfYesterday.setUTCHours(0, 0, 0, 0);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const endOfDay = new Date(localNow); endOfDay.setUTCHours(23, 59, 59, 999);
    return { start: startOfYesterday.getTime() - offset, end: endOfDay.getTime() - offset };
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
