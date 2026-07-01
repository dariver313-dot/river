import type { MemberInfo, BetRecord, WithdrawalRecord, ThirdGameOrder, PaymentOrder, BetsCount, LoginLogItem } from './types';
import type { WithdrawOrder } from './ws-client';
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

export interface RuleContext {
  order: WithdrawOrder;
  member: MemberInfo;
  bets: BetRecord[];
  withdrawals: WithdrawalRecord[];
  relatedByLoginIp: LoginLogItem[];
  relatedByLoginDevice: LoginLogItem[];
  relatedByLoginIpCount: number;
  relatedByLoginDeviceCount: number;
  receivingInfoCache: LRUCache<string, { data: Set<string> }>;
  agentWithdrawCache: LRUCache<string, { count: number; memberIds: Set<string>; lastUpdate: number }>;
  payChannelCache: LRUCache<string, { data: Set<string> }>;
  thirdGameBets: ThirdGameOrder[];
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
  _lhcResult?: LHCCheckResult;
  _sscResult?: SSCCheckResult;
  _k3Result?: K3CheckResult;
  _pk10Result?: PK10CheckResult;
  reviewedPeriodKeys?: Set<string>;
  traceId?: string;
  lastWithdrawMethod?: { bank: string; card: string; name: string } | null;
  mainGameType?: string;  // 近7天主投游戏类型（如"电子类游戏"），仅用于信息展示
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
  daysSinceReg: number;
  rechargeWithdrawDiff: number;
  proxyCode: string;
  orderAmount: string;
  balance: string;
  associatedGroup?: string[];
  isEarlyMorning?: boolean;
  periodInfo?: string;
  mainGameType?: string;  // 近7天主投游戏类型（如"电子类游戏"），仅用于信息展示
}
