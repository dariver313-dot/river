import type { MemberInfo, BetRecord, WithdrawalRecord, PaymentOrder, BetsCount, LoginLogItem } from './types';
import type { WithdrawOrder } from './types';
import type { LHCCheckResult } from './lhc-checker';
import type { SSCCheckResult } from './ssc-checker';
import type { K3CheckResult } from './k3-checker';
import type { PK10CheckResult } from './pk10-checker';
import { type LRUCache } from 'lru-cache';

export interface RiskRule {
  id: string;
  name: string;
  description: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  weight: number;
  group: 'identity' | 'association' | 'behavior' | 'environment' | 'marking';
  enabled: boolean;
  precondition?: (ctx: RuleContext) => boolean;
  evaluate: (ctx: RuleContext) => RuleResult;
}

export interface LoginAssociationSummary {
  value: string;
  memberNames: string[];
  otherMemberNames: string[];
  latestLoginAtByMember?: Record<string, number>;
  accountCount: number;
  fetchedCount?: number;
  totalCount?: number;
  truncated?: boolean;
}

export interface RuleContext {
  order: WithdrawOrder;
  member: MemberInfo;
  bets: BetRecord[];
  withdrawals: WithdrawalRecord[];
  relatedByLoginIp: LoginLogItem[];
  relatedByLoginDevice: LoginLogItem[];
  relatedByLoginIpCount: number;
  relatedByLoginDeviceCount: number;
  dailyLoginIpAssociations?: LoginAssociationSummary[];
  dailyLoginDeviceAssociations?: LoginAssociationSummary[];
  /** 同收款信息的已成功提款关联账号；白名单账号已在查询阶段排除。 */
  receivingAssociations?: string[];
  agentWithdrawCache: LRUCache<string, { count: number; memberIds: Set<string>; lastUpdate: number }>;
  paymentOrders: PaymentOrder[];
  betsCount: BetsCount | null;
  manualRechargeToday: number;
  manualRecharge3Day: number;
  manualRecharge7Day: number;
  thirdPartyRechargeToday: number;
  thirdPartyRecharge3Day: number;
  thirdPartyRecharge7Day: number;
  agentRiskScore?: number;
  tzOffset?: number;
  associatedMemberBets: Map<string, BetRecord[]>;
  issueGroups?: Map<string, BetRecord[]>;
  isEarlyMorning?: boolean;
  /** 会员近7天充值渠道（payTypeName 去重集合），用于渠道一致性检测 */
  rechargePayTypes?: Set<string>;
  _lhcResult?: LHCCheckResult;
  _sscResult?: SSCCheckResult;
  _k3Result?: K3CheckResult;
  _pk10Result?: PK10CheckResult;
  reviewedPeriodKeys?: Set<string>;
  traceId?: string;
  lastWithdrawMethod?: { bank: string; card: string; name: string; version?: number } | null;
  currentWithdrawMethod?: { bank: string; card: string; name: string; version?: number } | null;
}

export interface RuleResult {
  triggered: boolean;
  reason?: string;
  score: number;
}

export interface EvaluationResult {
  orderId: string;
  memberId: string;
  memberName: string;
  totalScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  triggeredRules: Array<{
    id: string;
    name: string;
    severity: string;
    group: string;
    reason: string;
    score: number;
  }>;
  groupScores: Record<string, number>;
  depositCount: number;
  withdrawCount: number;
  registerTime: string;
  daysSinceReg?: number;
  rechargeWithdrawDiff: number;
  totalRecharge?: number;
  totalWithdraw?: number;
  vipLevel?: number | string;
  sumBet?: number;
  proxyCode: string;
  orderAmount: string;
  balance: string;
  /** 规范后的会员备注，仅作为通知上下文展示，不参与风险评分。 */
  remark?: string;
  associatedGroup?: string[];
  isEarlyMorning?: boolean;
  periodInfo?: string;
  topGameTypes?: string;
}
