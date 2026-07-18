/* ===== API 响应通用结构 ===== */

export interface ApiResponse<T = unknown> {
  code?: string;
  success?: boolean;
  msg?: string;
  data?: T;
  items?: T[];
  list?: T[];
  totalPage?: string;
  totalNum?: string;
  total?: string | number;
  quality?: QueryQuality;
}

export type PagedResponse<T = unknown> = ApiResponse<T>;

export type QueryStatus = 'complete' | 'partial' | 'failed' | 'skipped';

export interface QueryQuality {
  source: string;
  status: QueryStatus;
  fetched: number;
  total: number;
  message?: string;
}

/* ===== 会员相关 ===== */

export interface MemberInfo {
  memberId: string;
  memberName: string;
  userName?: string;
  id?: string | number;
  createTime?: string | number;
  createdAt?: string | number;
  sumBet?: string | number;
  // sumRecharge/sumWithdraw: /getAllUsersByCondition 不返回这些字段, 由 getRechargeSum 等专用接口获取
  sumRecharge?: number;
  sumWithdraw?: number;
  sumRechargeTimes?: number;
  sumWithdrawTimes?: number;
  sumRolling?: number;
  balance?: string | number;
  vipLevel?: number | string;
  remark?: string;
  agencyMemberName?: string;
  proxyCode?: string;
  proxy_code?: string;
  agentCode?: string;
  agent_code?: string;
  proxyName?: string;
  parentName?: string;
  lastLoginIp?: string;
  lastLoginDeviceClientId?: string;
  registerIp?: string;
  profitAndLoss?: string | number;
}

/* ===== 投注记录 ===== */

export interface BetRecord {
  orderNo?: string;
  status?: number;
  lotteryName?: string;
  issue?: string;
  playClassName?: string;
  playName?: string;
  numbers?: string;
  amount?: string | number;
  seriesTag?: number;
  profit?: string | number;
  betTime?: string | number;
  allbet?: string | number;
  bet?: string | number;
}

/* ===== 投注统计 ===== */

export interface BetsCount {
  countAmount?: string;
  realAmount?: string;
  countWin?: string;
  countProfit?: string;
  countMember?: string;
  numberCount?: number;
}

/* ===== 会员进出报表（近7天各游戏类型投注汇总） ===== */

export interface MemberInOutReport {
  rechargeAmount?: string;
  withdrawAmount?: string;
  // 各游戏类型投注金额
  lotteryBetAmount?: string;  // 彩票
  truemanBetAmount?: string;  // 真人
  boardBetAmount?: string;    // 棋牌
  slotsBetAmount?: string;    // 老虎机（电子）
  fishBetAmount?: string;     // 捕鱼
  raceBetAmount?: string;     // 竞技
  sportBetAmount?: string;    // 体育
  // 各游戏类型输赢
  lotteryProfit?: string;
  truemanProfit?: string;
  boardProfit?: string;
  slotsProfit?: string;
  fishProfit?: string;
  raceProfit?: string;
  sportProfit?: string;
  // 总输赢
  profit?: string;
}

/* ===== 三方游戏订单 ===== */

export interface ThirdGameOrder {
  orderNo?: string;
  memberName?: string;
  amount?: string | number;
  createTime?: string | number;
  gameName?: string;
  allbet?: string | number;
  bet?: string | number;
  betTime?: string | number;
  profit?: string | number;
}

/* ===== 提现记录（历史） ===== */

export interface WithdrawalRecord {
  orderNo?: string;
  status?: number;
  memberName?: string;
  createTime?: string | number;
  amount?: string | number;
  receivingBank?: string;
  receivingName?: string;
  receivingCardNo?: string;
}

export interface AccountChangeRecord {
  id?: string;
  memberId?: string;
  memberName?: string;
  transType?: number;
  amount?: string | number;
  oldBalance?: string | number;
  newBalance?: string | number;
  operatorRemark?: string;
  operatorName?: string;
  createTime?: string | number;
  transSeq?: string;
  transDesc?: string;
  transDetail?: string;
}

/* ===== 支付订单 ===== */

export interface PaymentOrder {
  amount?: string | number;
  createTime?: string | number;
  createdAt?: string | number;
  remark?: string;
  operatorName?: string;
  payPlatformName?: string;
  paywayName?: string;
  payPlatformCode?: string;
}

/* ===== 登录日志 ===== */

export interface LoginLogItem {
  memberName?: string;
  loginIp?: string;
  device?: string;
  loginTime?: string | number;
  [key: string]: unknown;
}

/* ===== 域名配置 ===== */

export interface DomainItem {
  tenantCode?: string;
  domainUrl?: string;
  domain_url?: string;
  url?: string;
}

/* ===== 会员缓存数据 ===== */

export interface MemberCacheData {
  member: MemberInfo;
  bets: BetRecord[];
  withdrawals: WithdrawalRecord[];
  thirdGames: ThirdGameOrder[];
  paymentOrders: PaymentOrder[];
  betsCount: BetsCount | null;
  manualRechargeToday: number;
  manualRecharge3Day: number;
  manualRecharge7Day: number;
  thirdPartyRechargeToday: number;
  thirdPartyRecharge3Day: number;
  thirdPartyRecharge7Day: number;
  agentRiskScore: number | null;
  lastWithdrawMethod: { bank: string; card: string; name: string; time?: number } | null;
  mainGameType?: string;        // 近7天主投游戏类型（如"电子类游戏"）
  inOutReport?: MemberInOutReport | null;  // 近7天进出报表原始数据
  accountChanges?: AccountChangeRecord[];
  latestRechargeTime?: number;
  latestRechargeAmount?: number;
  dataQuality?: QueryQuality[];
}

/* ===== 会员详情 API 响应 ===== */

export interface UserDetailsResponse {
  code?: string | number;
  success?: boolean;
  msg?: string;
  data?: MemberInfo;
  items?: MemberInfo[];
}

/* ===== 充值汇总 API 响应 ===== */

export interface RechargeSumResponse {
  data?: { amount?: string | number; sumAmount?: string | number } | string | number;
  sumAmount?: string | number;
  quality?: QueryQuality;
}

/* ===== 触发规则 ===== */

export interface TriggeredRule {
  id: string;
  name: string;
  reason: string;
  severity: string;
  group: string;
  score: number;
  weight?: number;
  presentation?: 'core' | 'support';
}
