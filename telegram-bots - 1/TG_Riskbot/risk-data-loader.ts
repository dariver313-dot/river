import { apiClient } from './api-client';
import { parseTimeStr } from './utils';
import type {
  AccountChangeRecord,
  ApiResponse,
  BetRecord,
  BetsCount,
  MemberInOutReport,
  PagedResponse,
  PaymentOrder,
  QueryQuality,
  RechargeSumResponse,
  ThirdGameOrder,
  WithdrawalRecord,
} from './types';

export interface RiskDataWindows {
  orderDay: { start: number; end: number; isEarlyMorning: boolean };
  lotteryHistory: { start: number; end: number };
  withdrawalHistory: { start: number; end: number };
  recharge3Day: { start: number; end: number };
  recharge7Day: { start: number; end: number };
}

export interface RiskDataSnapshot {
  bets: BetRecord[];
  dailyBets: BetRecord[];
  withdrawals: WithdrawalRecord[];
  thirdGames: ThirdGameOrder[];
  paymentOrders: PaymentOrder[];
  accountChanges: AccountChangeRecord[];
  betsCount: BetsCount | null;
  manualRechargeToday: number;
  manualRecharge3Day: number;
  manualRecharge7Day: number;
  thirdPartyRechargeToday: number;
  thirdPartyRecharge3Day: number;
  thirdPartyRecharge7Day: number;
  latestRechargeTime?: number;
  latestRechargeAmount?: number;
  mainGameType: string | null;
  inOutReport: MemberInOutReport | null;
  quality: QueryQuality[];
  windows: RiskDataWindows;
}

interface LoadRiskDataOptions {
  memberName: string;
  orderId: string;
  orderTime: number;
  activeRuleIds: Set<string>;
  signal?: AbortSignal;
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function needs(activeRuleIds: Set<string>, ids: string[]): boolean {
  return ids.some(id => activeRuleIds.has(id));
}

function skipped(source: string): QueryQuality {
  return { source, status: 'skipped', fetched: 0, total: 0 };
}

function failed(source: string, message: string): QueryQuality {
  return { source, status: 'failed', fetched: 0, total: 0, message };
}

function itemsOf<T>(response: PagedResponse<T> | null | undefined): T[] {
  if (!response) return [];
  if (Array.isArray(response.items)) return response.items;
  if (Array.isArray(response.list)) return response.list;
  if (Array.isArray(response.data)) return response.data;
  if (response.data && typeof response.data === 'object') {
    const list = (response.data as { list?: T[] }).list;
    if (Array.isArray(list)) return list;
  }
  return [];
}

function qualityOf<T>(source: string, response: PagedResponse<T> | ApiResponse<T> | null | undefined, count: number): QueryQuality {
  return response?.quality || (response
    ? { source, status: 'complete', fetched: count, total: count }
    : failed(source, `${source}查询失败`));
}

function sumAmount(response: RechargeSumResponse | null): number {
  if (!response) return 0;
  const data = response.data;
  if (data && typeof data === 'object') return Number.parseFloat(String(data.sumAmount || data.amount || '0')) || 0;
  if (typeof data === 'string' || typeof data === 'number') return Number.parseFloat(String(data)) || 0;
  return Number.parseFloat(String(response.sumAmount || '0')) || 0;
}

function latestRecharge(orders: PaymentOrder[], orderTime: number): { time?: number; amount?: number } {
  let latestTime = 0;
  let latestAmount = 0;
  for (const order of orders) {
    const time = parseTimeStr(order.createTime || order.createdAt);
    if (!time || time > orderTime || time <= latestTime) continue;
    latestTime = time;
    latestAmount = Number.parseFloat(String(order.amount || '0')) || 0;
  }
  return latestTime ? { time: latestTime, amount: latestAmount } : {};
}

export function filterSuccessfulWithdrawals(items: WithdrawalRecord[], currentOrderId: string): WithdrawalRecord[] {
  const deduped = new Map<string, WithdrawalRecord>();
  for (const item of items) {
    if (item.status !== 4 && item.status !== 8) continue;
    if (item.orderNo && item.orderNo === currentOrderId) continue;
    const key = item.orderNo || `${item.createTime}|${item.amount}|${item.receivingCardNo}`;
    deduped.set(key, item);
  }
  return [...deduped.values()].sort((a, b) => parseTimeStr(b.createTime) - parseTimeStr(a.createTime));
}

export function buildRiskDataWindows(orderTime: number): RiskDataWindows {
  const lotteryDays = positiveInt(process.env.LOTTERY_VIOLATION_LOOKBACK_DAYS, 7, 31);
  const withdrawalDays = positiveInt(process.env.WITHDRAW_HISTORY_DAYS, 30, 365);
  const orderDay = apiClient.getEffectiveDateRange(orderTime);
  return {
    orderDay,
    lotteryHistory: apiClient.getRollingDateRange(orderTime, lotteryDays),
    withdrawalHistory: apiClient.getRollingDateRange(orderTime, withdrawalDays),
    recharge3Day: apiClient.getRollingDateRange(orderTime, 3),
    recharge7Day: apiClient.getRollingDateRange(orderTime, 7),
  };
}

export async function loadRiskData(options: LoadRiskDataOptions): Promise<RiskDataSnapshot> {
  const { memberName, orderId, orderTime, activeRuleIds, signal } = options;
  const windows = buildRiskDataWindows(orderTime);
  const requestOptions = signal ? { signal } : undefined;

  const needLottery = needs(activeRuleIds, ['R24', 'R25', 'R26', 'R38', 'R39']);
  const needThirdGames = needs(activeRuleIds, ['R27', 'R28']);
  const needBetsCount = needs(activeRuleIds, ['R21', 'R23']);
  const needWithdrawals = needs(activeRuleIds, ['R34', 'R35', 'R41']);
  const needPayments = needs(activeRuleIds, ['R12', 'R32', 'R33']);
  const needAccountChanges = activeRuleIds.has('R29');
  const needManualRecharge = activeRuleIds.has('R33');

  const lotteryPages = positiveInt(process.env.LOTTERY_BETS_MAX_PAGES, 5, 50);
  const withdrawalPages = positiveInt(process.env.WITHDRAW_HISTORY_MAX_PAGES, 5, 25);
  const accountChangePages = positiveInt(process.env.ACCOUNT_CHANGE_MAX_PAGES, 3, 20);
  const paymentPages = positiveInt(process.env.PAYMENT_ORDER_MAX_PAGES, 3, 20);

  const [
    betsResponse,
    thirdGameResponse,
    betsCountResponse,
    withdrawalResponse,
    paymentResponse,
    accountChangeResponse,
    manualTodayResponse,
    manual3DayResponse,
    manual7DayResponse,
    inOutResponse,
  ] = await Promise.all([
    needLottery
      ? apiClient.getMemberBets(memberName, 1, windows.lotteryHistory, lotteryPages, requestOptions)
      : Promise.resolve({ items: [], quality: skipped('lotteryBets') } as PagedResponse<BetRecord>),
    needThirdGames
      ? apiClient.getThirdGameOrders(memberName, 1, windows.orderDay, 3, requestOptions)
      : Promise.resolve({ items: [], quality: skipped('thirdGameOrders') } as PagedResponse<ThirdGameOrder>),
    needBetsCount
      ? apiClient.getBetsCountToday(memberName, windows.orderDay, requestOptions)
      : Promise.resolve({ quality: skipped('betsCount') } as ApiResponse<BetsCount>),
    needWithdrawals
      ? apiClient.getMemberWithdrawals(memberName, 1, windows.withdrawalHistory, withdrawalPages, requestOptions)
      : Promise.resolve({ items: [], quality: skipped('withdrawals') } as PagedResponse<WithdrawalRecord>),
    needPayments
      ? apiClient.getPaymentOrders(memberName, 1, windows.recharge7Day, paymentPages, requestOptions)
      : Promise.resolve({ items: [], quality: skipped('paymentOrders') } as PagedResponse<PaymentOrder>),
    needAccountChanges
      ? apiClient.getAccountChangeList(memberName, windows.recharge7Day.start, orderTime, accountChangePages, requestOptions)
      : Promise.resolve({ items: [], quality: skipped('accountChanges') } as PagedResponse<AccountChangeRecord>),
    needManualRecharge
      ? apiClient.getManualRechargeSum(memberName, windows.orderDay.start, orderTime, requestOptions)
      : Promise.resolve({ sumAmount: '0', quality: skipped('manualRechargeToday') } as RechargeSumResponse),
    needManualRecharge
      ? apiClient.getManualRechargeSum(memberName, windows.recharge3Day.start, orderTime, requestOptions)
      : Promise.resolve({ sumAmount: '0', quality: skipped('manualRecharge3Day') } as RechargeSumResponse),
    needManualRecharge
      ? apiClient.getManualRechargeSum(memberName, windows.recharge7Day.start, orderTime, requestOptions)
      : Promise.resolve({ sumAmount: '0', quality: skipped('manualRecharge7Day') } as RechargeSumResponse),
    apiClient.getMemberInOutReport(memberName, orderTime, requestOptions).catch(() => ({ report: null, mainGameType: null })),
  ]);

  const bets = itemsOf<BetRecord>(betsResponse);
  const thirdGames = itemsOf<ThirdGameOrder>(thirdGameResponse);
  const rawWithdrawals = itemsOf<WithdrawalRecord>(withdrawalResponse);
  const withdrawals = filterSuccessfulWithdrawals(rawWithdrawals, orderId);
  const paymentOrders = itemsOf<PaymentOrder>(paymentResponse);
  const accountChanges = itemsOf<AccountChangeRecord>(accountChangeResponse);
  const betsCount = betsCountResponse.data || null;
  const recharge = latestRecharge(paymentOrders, orderTime);

  let thirdPartyRechargeToday = 0;
  let thirdPartyRecharge3Day = 0;
  let thirdPartyRecharge7Day = 0;
  for (const order of paymentOrders) {
    const time = parseTimeStr(order.createTime || order.createdAt);
    if (!time || time > orderTime) continue;
    const amount = Number.parseFloat(String(order.amount || '0')) || 0;
    thirdPartyRecharge7Day += amount;
    if (time >= windows.recharge3Day.start) thirdPartyRecharge3Day += amount;
    if (time >= windows.orderDay.start) thirdPartyRechargeToday += amount;
  }

  const manualQuality = (source: string, response: RechargeSumResponse): QueryQuality => ({
    ...(response.quality || failed(source, `${source}查询失败`)),
    source,
  });

  return {
    bets,
    dailyBets: bets.filter(bet => {
      const time = parseTimeStr(bet.betTime);
      return time >= windows.orderDay.start && time <= orderTime;
    }),
    withdrawals,
    thirdGames,
    paymentOrders,
    accountChanges,
    betsCount,
    manualRechargeToday: sumAmount(manualTodayResponse),
    manualRecharge3Day: sumAmount(manual3DayResponse),
    manualRecharge7Day: sumAmount(manual7DayResponse),
    thirdPartyRechargeToday,
    thirdPartyRecharge3Day,
    thirdPartyRecharge7Day,
    latestRechargeTime: recharge.time,
    latestRechargeAmount: recharge.amount,
    mainGameType: inOutResponse.mainGameType,
    inOutReport: inOutResponse.report,
    quality: [
      qualityOf('lotteryBets', betsResponse, bets.length),
      qualityOf('thirdGameOrders', thirdGameResponse, thirdGames.length),
      qualityOf('betsCount', betsCountResponse, betsCount ? 1 : 0),
      qualityOf('withdrawals', withdrawalResponse, rawWithdrawals.length),
      qualityOf('paymentOrders', paymentResponse, paymentOrders.length),
      qualityOf('accountChanges', accountChangeResponse, accountChanges.length),
      manualQuality('manualRechargeToday', manualTodayResponse),
      manualQuality('manualRecharge3Day', manual3DayResponse),
      manualQuality('manualRecharge7Day', manual7DayResponse),
    ],
    windows,
  };
}
