/* ===== 新 API 通用响应结构 ===== */

export interface NewApiResponse<T = unknown> {
  code?: number | string;
  message?: string;
  msg?: string;
  data?: T & {
    records?: T[];
    total?: number;
    current?: number;
    size?: number;
    pages?: number;
    sum?: Record<string, unknown>;
  };
  succeed?: boolean;
  traceId?: string | null;
}

export interface NewPageData<T = unknown> {
  records: T[];
  total: number;
  current: number;
  size: number;
  pages: number;
}

export interface NewBetPageData<T = unknown> {
  page: NewPageData<T>;
  otherData?: NewBetOtherData;
}

export interface NewBetOtherData {
  payoutAmount: number;
  betAmount: number;
  validAmount: number;
  winAmount: number;
  totalNums: number;
  companyRebateMoney: number;
  rebateMoney: number;
  winnableAmount: number;
  recoverMoney: number;
}

/* ===== 新 API 提现订单 ===== */

export interface NewWithdrawRecord {
  id: number;
  brandId: number;
  cashOrderNo: string;
  account: string;
  realName: string;
  accountMoney: number;
  cashMoney: number;
  bankName: string;
  bankCard: string;
  bankAddress: string | null;
  cashStatus: number;
  approveMoney: number;
  memberLevel: string;
  superName: string;
  ipAddress: string;
  proxyPayStatus: unknown | null;
  memberMemo: string | null;
  memberType: string;
  withdrawType: string;
  currencyRate: number;
  currencyCount: string;
  approveCurrencyCount: string;
  createTime: number;
  counterFee: number;
  cashReason: string;
  memberId: number;
  acceptAccount: string | null;
  acceptTime: number | null;
  isBankBlacklist: number;
  currency: string;
  ppMerchantName: string | null;
  cashMode: number;
  userRemark: string;
  taxNumber: string | null;
  proxyPayDesc: string | null;
  approveReason: string;
  iconIds: unknown | null;
  ifscCode: string | null;
  phone: string | null;
  email: string | null;
  beneficiaryType: string | null;
  beneficiaryId: string | null;
  beneficiaryBankType: string | null;
  operatorTime: number | null;
  operatorAccount: string | null;
  popularizeId: number;
  parentPopularizeId: number;
  vipLevel: number;
  agentLevel: string | null;
  superPath: string;
  iconId: unknown | null;
  qrCode: unknown | null;
  depositWithdrawalBalance: number;
  isFirst: number;
  riskOpraccount: string;
  riskOprtime: number;
  riskStatus: number;
}

/* ===== 新 API 会员详情 (getAccountDetail) ===== */

export interface NewMemberDetail {
  realName: string;
  nickname: string;
  dialCode: string;
  phone: string;
  taxType: string | null;
  taxNum: string | null;
  email: string | null;
  wechat: string | null;
  qq: string | null;
  tikTok: string | null;
  facebook: string | null;
  google: string | null;
  zalo: string | null;
  zaloAreaCode: string | null;
  zaloPhone: string | null;
  cnpjTaxNum: string | null;
  telegramCode: string | null;
  telegram: string | null;
  telegramAccount: string | null;
  whatsCode: string | null;
  whatsApp: string | null;
  cardNo: string | null;
  bankCard: string | null;
  cardHolder: string | null;
  fullName: string | null;
  id: number;
  brandId: number;
  popularizeId: number;
  account: string;
  vipLevel: number;
  remark: string;
  parentId: number | null;
  parentPopularizeId: number;
  parentName: string;
  userType: string;
  superPath: string;
  userLevel: number;
  lowerNum: string;
  withdrawFlag: string;
  currency: string;
  balance: number;
  freeze: number;
  gameFreeze: number;
  totalRechAmount: number;
  totalRechTimes: number;
  totalWithdrawAmount: number;
  totalWithdrawTimes: number;
  registerIp: string;
  registerIpCount: number;
  createTime: number;
  invitationCode: string;
  registerHost: string;
  registerSource: number;
  status: number;
  online: boolean;
  lastLoginIp: string;
  lastLoginIpCount: number;
  lastLoginTime: number;
  lastLoginDeviceClientId: string;
  agentLevel: string;
  registerBrowser: string | null;
  registerDeviceClientId: string | null;
  registerDeviceCount: number | null;
  registerOs: string;
  growth: unknown | null;
  goldCoin: number;
  salaryFlag: number;
  balanceDifference: number;
  winAmount: number;
  waterAmount: number;
  betAmount: number;
  validAmount: number;
  iconId: unknown | null;
  adSource: number;
  adInfo: unknown | null;
  registerMode: string | null;
  validAmountToday: number | null;
  validAmountHistory: number | null;
  winAmountToday: number;
  winAmountHistory: number;
  waterAmountToday: number;
  waterAmountHistory: number;
  bonusAmountToday: number;
  bonusAmountHistory: number;
  exceptionRechargeTotalAmount: number;
  exceptionWithdrawTotalAmount: number;
  commissionAmountToday: number;
  commissionAmountHistory: number;
  inviter: string | null;
  interestAmount: number;
  firstRechTime: number;
  firstRechAmount: number;
  firstWithdrawTime: number;
  firstWithdrawAmount: number;
  lastRechTime: number;
  lastRechAmount: number;
  appVersion: string;
}

/* ===== 新 API 会员列表项 (member/list) ===== */

export interface NewMemberListItem {
  id: number;
  account: string;
  realName: string;
  vipLevel: number;
  parentName: string;
  userType: string;
  balance: number;
  totalRechAmount: number;
  totalRechTimes: number;
  totalWithdrawAmount: number;
  totalWithdrawTimes: number;
  createTime: number;
  lastLoginTime: number;
  lastLoginIp: string;
  status: number;
  remark: string;
  agentLevel: string;
  superPath: string;
  registerIp: string;
  lastLoginDeviceClientId: string;
  // 可能还有其他字段
  [key: string]: unknown;
}

/* ===== 新 API 投注记录 (lot/bet/queryPage) ===== */

export interface NewBetRecord {
  orderNo: string;
  userId: number;
  account: string;
  superName: string;
  userName: string;
  fullName: string | null;
  userType: string;
  cateCode: string;
  cateName: string;
  betInfo: string;
  betInfoName: string;
  currency: string;
  walletType: string | null;
  fixedMultiple: number;
  model: number;
  money: number;
  validAmount: number;
  betModel: number;
  multiple: number;
  totalNums: number;
  totalMoney: number;
  odds: string;
  oddsName: string;
  rebate: number;
  rebateMoney: number;
  companyRebate: number;
  companyRebateMoney: number;
  gameId: number;
  gameName: string;
  issueNum: string;
  openNum: string;
  openNumJson: string | null;
  openNumTemplate: string;
  openTime: number;
  statTime: number;
  betStartTime: number;
  betEndTime: number;
  winCount: number;
  status: number;
  reward: number;
  payoutAmount: number | null;
  drawMoney: number;
  result: number;
  betTime: number;
  createTime: number;
  updateTime: number;
  settleTime: number | null;
  winnableAmount: number;
  traceOrderNo: string | null;
  recoverMoney: number | null;
  followCode: string | null;
  popularizeId: number;
}

/* ===== 新 API 投注分析 (findMemberbetAnalysis) ===== */

export interface NewBetAnalysis {
  lotteryOrderCount: number;
  sportOrderCount: number;
  realOrderCount: number;
  hunterOrderCount: number;
  chessOrderCount: number;
  lotteryWinOrderCount: number;
  sportWinOrderCount: number;
  realWinOrderCount: number;
  hunterWinOrderCount: number;
  chessWinOrderCount: number;
  lotteryValidAmount: number;
  sportValidAmount: number;
  realValidAmount: number;
  hunterValidAmount: number;
  chessValidAmount: number;
  lotteryWinAmount: number;
  sportWinAmount: number;
  realWinAmount: number;
  hunterWinAmount: number;
  chessWinAmount: number;
  lotteryWaterAmount: number;
  sportWaterAmount: number;
  realWaterAmount: number;
  hunterWaterAmount: number;
  chessWaterAmount: number;
  lotteryProfitRate: number;
  sportProfitRate: number;
  realProfitRate: number;
  hunterProfitRate: number;
  chessProfitRate: number;
  lotteryWinRate: number;
  sportWinRate: number;
  realWinRate: number;
  hunterWinRate: number;
  chessWinRate: number;
  allWinAmount: number;
  currency: string;
  egameWinAmount: number;
  esportWinAmount: number;
  egameWaterAmount: number;
  esportWaterAmount: number;
  egameValidAmount: number;
  esportValidAmount: number;
  egameWinRate: number;
  esportWinRate: number;
  egameOrderCount: number;
  esportOrderCount: number;
  egameWinOrderCount: number;
  esportWinOrderCount: number;
  egameProfitRate: number;
  esportProfitRate: number;
}

/* ===== 新 API 充值订单 (rechargeOrder/page) ===== */

export interface NewRechargeOrder {
  id: number;
  account: string;
  realName: string;
  amount: number;
  createTime: number;
  status: number;
  payPlatformName: string;
  remark: string;
  operatorName: string;
  orderNo: string;
  currency: string;
  [key: string]: unknown;
}

/* ===== 新 API 登录日志 (report/ip/page) ===== */

export interface NewLoginLogItem {
  account: string;
  popularizeId: number;
  ipAddress: string;
  ipCount: number | null;
  loginAddress: string | null;
  deviceClientId: string;
  offline: number;
  uuid: string | null;
  brandId: number;
}

export interface NewRechReport {
  allRechAmount: number;
  allRechCount: number;
  bankMoney: number;
  bankCount: number;
  onlineMoney: number;
  onlineCount: number;
  handMoney: number;
  handCount: number;
  firstRechMoney: number;
  firstRechCount: number;
  secondRechMoney: number;
  secondRechCount: number;
  exceptionRechAmount: number;
  exceptionRechCount: number;
  virtualRechMoney: number;
  virtualRechCount: number;
  firstBankMoney: number;
  firstBankCount: number;
  firstOnlineMoney: number;
  firstOnlineCount: number;
  firstHandMoney: number;
  firstHandCount: number;
  commissionAmount: number;
  commissionCount: number;
  rechargeMerchantFee: number;
}

export interface NewRechargeOrderHistory {
  id: number;
  brandId: number;
  account: string;
  orderNo: string;
  payTypeName: string;
  tpInterfaceName: string;
  tpMerchantName: string;
  amount: number;
  payAmount: number;
  discountAmount: number;
  totalAmount: number;
  status: number;
  mode: number;
  createTime: number;
  auditTime: number;
  auditorAccount: string;
  ipAddress: string;
  rechargeTimes: number;
  popularizeId: number;
}

/* ================================================================
 * 以下为旧内部类型（保留，供规则引擎和内部逻辑使用）
 * ================================================================ */

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
}

export type PagedResponse<T = unknown> = ApiResponse<T>;

/* ===== 会员相关 ===== */

export interface MemberInfo {
  memberId: string;
  memberName: string;
  userName?: string;
  id?: string | number;
  createTime?: string | number;
  createdAt?: string | number;
  sumBet?: string | number;
  sumRecharge?: string | number;
  sumWithdraw?: string | number;
  sumRechargeTimes?: number;
  sumWithdrawTimes?: number;
  sumRolling?: number;
  balance?: string | number;
  balanceDifference?: number;
  vipLevel?: number | string;
  remark?: string;
  latestRechargeTime?: string | number;
  latestRechargeOrder?: RechargeOrder[];
  agencyMemberName?: string;
  proxyCode?: string;
  lastLoginIp?: string;
  lastLoginDeviceClientId?: string;
  registerIp?: string;
  proxy_code?: string;
  agentCode?: string;
  agent_code?: string;
  proxyName?: string;
  parentName?: string;
}

export interface RechargeOrder {
  paywayName?: string;
  payPlatformCode?: string;
  payPlatformName?: string;
}

/* ===== 投注记录（内部格式） ===== */

export interface BetRecord {
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
  topGameTypes?: string;
}

/* ===== 提现记录（历史） ===== */

export interface WithdrawalRecord {
  orderNo?: string;
  status?: number;
  createTime?: string | number;
  amount?: string | number;
  receivingBank?: string;
  receivingName?: string;
  receivingCardNo?: string;
}

/* ===== 支付订单 ===== */

export interface PaymentOrder {
  amount?: string | number;
  createTime?: string | number;
  createdAt?: string | number;
  remark?: string;
  operatorName?: string;
  payPlatformName?: string;
}

/* ===== 登录日志 ===== */

export interface LoginLogItem {
  memberName?: string;
  loginIp?: string;
  device?: string;
  [key: string]: unknown;
}

/* ===== 会员缓存数据 ===== */

export interface MemberCacheData {
  member: MemberInfo;
  bets: BetRecord[];
  withdrawals: WithdrawalRecord[];
  paymentOrders: PaymentOrder[];
  betsCount: BetsCount | null;
  manualRechargeToday: number;
  manualRecharge3Day: number;
  manualRecharge7Day: number;
  thirdPartyRechargeToday: number;
  thirdPartyRecharge3Day: number;
  thirdPartyRecharge7Day: number;
  agentRiskScore: number | null;
}

/* ===== 会员详情 API 响应 ===== */

export interface UserDetailsResponse {
  code?: string | number;
  success?: boolean;
  msg?: string;
  data?: MemberInfo;
  items?: MemberInfo[];
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
}

/* ===== 提现订单（内部格式，从 ws-client.ts 迁移） ===== */

export interface WithdrawOrder {
  orderNo: string;
  status: number;
  amount: string | number;
  memberName?: string;
  member_name?: string;
  memberId?: string;
  member_id?: string;
  createTime?: string | number;
  proxyCode?: string;
  proxy_code?: string;
  agencyMemberName?: string;
  receivingBank?: string;
  receivingName?: string;
  receivingCardNo?: string;
  vipLevel?: string | number;
  currency?: string;
  balance?: string | number;
  sumWithdraw?: string | number;
  sumRecharge?: string | number;
  memberRemark?: string;
  id?: string | number;
  [key: string]: unknown;
}
