import type { RiskRule, RuleContext, RuleResult, EvaluationResult } from './rule-types';
import { rules } from './rules';
import { LRUCache } from 'lru-cache';
import { logger } from './logger';
import { parseTimeStr, absFloat, extractProxyCode, formatBeijingTime, combineMemberRemarks } from './utils';
import { dbHolder } from './db';

// ============================================================
// 规则引擎执行器（分组去重）
// ============================================================

const GROUP_MAX_SCORES: Record<string, number> = {
  identity: 80,
  association: 80,
  behavior: 80,
  environment: 60,
  marking: 80,
};

/**
 * 平台 A 在待受理/已受理阶段会先扣减余额，但会员汇总的 totalWithdraw*
 * 只累计已出款记录。因此风控通知展示资金快照时，必须将当前提款计入一次。
 * 该函数只服务于展示结果，不改变规则使用的历史数据。
 */
export function calculateCurrentWithdrawalPresentation(
  totalRecharge: string | number | null | undefined,
  historicalWithdraw: string | number | null | undefined,
  historicalWithdrawCount: unknown,
  currentWithdrawal: string | number | null | undefined,
): { rechargeAmount: number; withdrawAmount: number; withdrawCount: number; rechargeWithdrawDiff: number } {
  const rechargeAmount = absFloat(totalRecharge);
  const currentAmount = absFloat(currentWithdrawal);
  const withdrawAmount = absFloat(historicalWithdraw) + currentAmount;
  const historicalCount = Math.max(0, Math.trunc(Number(historicalWithdrawCount) || 0));
  const withdrawCount = historicalCount + (currentAmount > 0 ? 1 : 0);

  return {
    rechargeAmount,
    withdrawAmount,
    withdrawCount,
    rechargeWithdrawDiff: rechargeAmount - withdrawAmount,
  };
}

const handledRulesCache = new LRUCache<string, { rules: string[]; ts: number }>({
  max: 500,
  ttl: 5 * 60 * 1000,
});

/** 批量预热 handledRulesCache，减少 N+1 查询。
 *  key 为 orderId（与 evaluateRules 中的缓存键一致），仅跳过同一订单已审核的规则。
 */
export function warmHandledRulesCache(feedbacks: { key: string; ruleId: string }[]): void {
  const byKey = new Map<string, string[]>();
  for (const f of feedbacks) {
    const arr = byKey.get(f.key) || [];
    arr.push(f.ruleId);
    byKey.set(f.key, arr);
  }
  const now = Date.now();
  for (const [key, ruleIds] of byKey) {
    const existing = handledRulesCache.get(key);
    const merged = existing ? [...new Set([...existing.rules, ...ruleIds])] : [...new Set(ruleIds)];
    handledRulesCache.set(key, { rules: merged, ts: now });
  }
}

// ============================================================
// 已审核期号缓存（防止新订单重复提醒已人工审核过的期号）
// ============================================================

const memberReviewedPeriodsCache = new LRUCache<string, Set<string>>({
  max: 500,
  ttl: 5 * 60 * 1000,
});

function parsePeriodKeyFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // violation line format: "{lotteryName} {issue} {cateName}：{details...}"
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  if (parts.length < 3) return `${parts[0]}:::${parts[1]}`; // 兼容旧格式
  const cateName = parts[2].split(/[：:]/)[0];
  if (!cateName) return `${parts[0]}:::${parts[1]}`;
  return `${parts[0]}:::${parts[1]}:::${cateName}`;
}

function parseReviewedPeriodKeys(periodInfo: string): Set<string> {
  const keys = new Set<string>();
  if (!periodInfo) return keys;
  for (const line of periodInfo.split('\n')) {
    const key = parsePeriodKeyFromLine(line);
    if (key) keys.add(key);
  }
  return keys;
}

async function getMemberReviewedPeriods(memberId: string): Promise<Set<string>> {
  if (!memberId) return new Set();

  const cached = memberReviewedPeriodsCache.get(memberId);
  if (cached) return cached;

  const allKeys = new Set<string>();

  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

    const [feedbacks, oldEvals] = await Promise.all([
      // 1. 已审核的期号（人工或超时自动审核，来自 RuleFeedback，仅查最近7天）
      dbHolder.db.ruleFeedback.findMany({
        where: { memberId, feedback: 'review', ruleId: { in: ['R24', 'R25', 'R26'] }, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
        select: { periodInfo: true },
      }).catch((err) => {
        logger.warn({ memberId, err: (err as Error).message }, '[规则引擎] 查询已审核期号失败');
        return [] as { periodInfo: string }[];
      }),
      // 2. 超过 5 分钟的旧订单，期号自动过期（无论是否手动审核过）
      dbHolder.db.riskEval.findMany({
        where: { memberId, createdAt: { lt: fiveMinAgo }, triggeredRules: { not: '[]' } },
        select: { detail: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }).catch((err) => {
        logger.warn({ memberId, err: (err as Error).message }, '[规则引擎] 查询过期期号失败');
        return [] as { detail: string }[];
      }),
    ]);

    for (const f of feedbacks) {
      const keys = parseReviewedPeriodKeys(f.periodInfo || '');
      for (const k of keys) allKeys.add(k);
    }
    for (const e of oldEvals) {
      try {
        const d = JSON.parse(e.detail || '{}');
        if (d.periodInfo) {
          const keys = parseReviewedPeriodKeys(d.periodInfo);
          for (const k of keys) allKeys.add(k);
        }
      } catch { /* detail JSON parse 失败则跳过 */ }
    }
  } catch (err) {
    logger.warn({ memberId, err: (err as Error).message }, '[规则引擎] 获取已审核期号失败');
  }

  memberReviewedPeriodsCache.set(memberId, allKeys);
  if (allKeys.size > 0) {
    logger.info({ memberId, count: allKeys.size }, '[规则引擎] 已审核期号加载完成');
  }
  return allKeys;
}

/** 清除指定会员的已审核期号缓存（人工审核后调用） */
export function invalidateMemberReviewedPeriods(memberId: string): void {
  memberReviewedPeriodsCache.delete(memberId);
}

let cachedNeedsIssueGroups: boolean | null = null;

function needsIssueGroupsCheck(): boolean {
  if (cachedNeedsIssueGroups === null) {
    cachedNeedsIssueGroups = rules.some(r => r.enabled && ['R26'].includes(r.id));
  }
  return cachedNeedsIssueGroups;
}

export async function evaluateRules(ctx: RuleContext): Promise<EvaluationResult> {
  if (needsIssueGroupsCheck() && ctx.bets?.length > 0) {
    const issueGroups = new Map<string, any[]>();
    for (const b of ctx.bets) {
      const key = `${b.lotteryName} ${b.issue} ${b.playClassName}`;
      if (!issueGroups.has(key)) issueGroups.set(key, []);
      issueGroups.get(key)!.push(b);
    }
    ctx.issueGroups = issueGroups;
  }

  const handledRules = new Set<string>();
  try {
    const orderId = String(ctx.order?.orderNo || ctx.order?.id || '');
    if (orderId) {
      // 仅跳过当前订单已人工审核的规则，防止跨订单误跳过
      if (handledRulesCache.has(orderId)) {
        const cached = handledRulesCache.get(orderId)!;
        if (Date.now() - cached.ts < 60 * 1000) {
          for (const rid of cached.rules) handledRules.add(rid);
        } else {
          handledRulesCache.delete(orderId);
        }
      }
      if (handledRules.size === 0) {
        const riskEval = await dbHolder.db.riskEval.findUnique({
          where: { orderId },
          select: { id: true },
        });
        if (riskEval) {
          const handled = await dbHolder.db.ruleFeedback.findMany({
            where: {
              evalId: riskEval.id,
              feedback: 'review',
            },
            select: { ruleId: true },
          });
          for (const h of handled) handledRules.add(h.ruleId);
          handledRulesCache.set(orderId, { rules: [...handledRules], ts: Date.now() });
        }
      }
    }
  } catch (err) {
    logger.warn({ traceId: ctx.traceId, err: (err as Error).message }, '[规则引擎] 查询已审核规则失败，将评估所有规则');
  }

  // 加载该会员已审核过的期号，防止新订单重复提醒同一期号的违规
  // memberId 取值优先级与 RiskEval.memberId 一致，确保能匹配 RuleFeedback 和旧订单记录
  // 始终合并：ctx 中可能已有 evaluator 预置的 session 级已见期号
  {
    const mid = String(ctx.order?.memberId || ctx.order?.member_id || ctx.member?.memberId || ctx.member?.id || '');
    const dbKeys = await getMemberReviewedPeriods(mid);
    if (ctx.reviewedPeriodKeys) {
      for (const k of dbKeys) ctx.reviewedPeriodKeys.add(k);
    } else {
      ctx.reviewedPeriodKeys = dbKeys;
    }
  }

  const groupScores: Record<string, number> = {};
  const triggeredRules: EvaluationResult['triggeredRules'] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.precondition && !rule.precondition(ctx)) continue;
    if (handledRules.has(rule.id)) continue;
    try {
      const result = rule.evaluate(ctx);
      if (result.triggered) {
        triggeredRules.push({
          id: rule.id,
          name: rule.name,
          severity: rule.severity,
          group: rule.group,
          reason: result.reason || rule.description,
          score: result.score,
        });
        const prev = groupScores[rule.group] || 0;
        const groupMax = GROUP_MAX_SCORES[rule.group] || 80;
        groupScores[rule.group] = Math.min(prev + result.score, groupMax);
      }
    } catch (err) {
      logger.error({ traceId: ctx.traceId, ruleId: rule.id, err: (err as Error).message }, `[规则引擎] 规则 ${rule.id} 执行异常`);
    }
  }

  const totalScore = Object.values(groupScores).reduce((sum, s) => sum + s, 0);

  let riskLevel: EvaluationResult['riskLevel'] = 'LOW';
  if (totalScore >= 50) riskLevel = 'CRITICAL';
  else if (totalScore >= 30) riskLevel = 'HIGH';
  else if (totalScore >= 15) riskLevel = 'MEDIUM';

  // 仅使用会员真实的 createTime；缺失时 daysSinceReg 为 undefined，
  // 各规则应自行判断：detect new-account 规则的 precondition 会自然跳过
  const memberCreateTimeRaw = ctx.member?.createTime;
  const memberCreateTime = parseTimeStr(memberCreateTimeRaw);
  const registerTimeStr = memberCreateTime ? formatBeijingTime(memberCreateTime) : '';

  const orderTime = parseTimeStr(
    ctx.order?.createTime || (ctx.order as Record<string, unknown>)?.createdAt as string | number | undefined,
  ) || Date.now();
  const daysSinceReg = memberCreateTime
    ? Math.max(0, (orderTime - memberCreateTime) / 86400000)
    : undefined;

  // 平台 A 会员汇总在 1/2 状态尚未写入本次提款，但余额已按申请额扣减。
  // 通知中展示的是当前提款后的资金快照，因此只在展示结果中补入本单。
  const funds = calculateCurrentWithdrawalPresentation(
    ctx.member?.sumRecharge,
    ctx.member?.sumWithdraw,
    ctx.member?.sumWithdrawTimes,
    ctx.order?.amount,
  );

  return {
    orderId: String(ctx.order?.orderNo || ctx.order?.id || ''),
    memberId: String(ctx.order?.memberId || ctx.order?.member_id || ctx.member?.memberId || ctx.member?.id || ''),
    memberName: ctx.order?.memberName || ctx.member?.memberName || '',
    totalScore,
    riskLevel,
    triggeredRules,
    groupScores,
    depositCount: ctx.member?.sumRechargeTimes ?? 0,
    withdrawCount: funds.withdrawCount,
    registerTime: registerTimeStr,
    daysSinceReg,
    rechargeWithdrawDiff: funds.rechargeWithdrawDiff,
    totalRecharge: funds.rechargeAmount,
    totalWithdraw: funds.withdrawAmount,
    proxyCode: extractProxyCode(ctx.order, ctx.member),
    orderAmount: String(ctx.order?.amount || ''),
    balance: String(ctx.member?.balance ?? ctx.order?.balance ?? ''),
    remark: combineMemberRemarks([ctx.member?.remark, ctx.order?.memberRemark]),
    periodInfo: [ctx._lhcResult?.periodInfo, ctx._sscResult?.periodInfo, ctx._k3Result?.periodInfo, ctx._pk10Result?.periodInfo].filter(Boolean).join('\n') || '',
    topGameTypes: ctx.betsCount?.topGameTypes || undefined,
    vipLevel: ctx.member?.vipLevel,
    sumBet: absFloat(ctx.member?.sumBet),
  };
}

export function getAllRules(): RiskRule[] {
  return [...rules];
}

export function setRuleEnabled(ruleId: string, enabled: boolean): boolean {
  const rule = rules.find(r => r.id === ruleId);
  if (rule) { rule.enabled = enabled; invalidateActiveRuleIds(); cachedNeedsIssueGroups = null; return true; }
  return false;
}

let cachedActiveRuleIds: Set<string> | null = null;

export function getActiveRuleIds(): Set<string> {
  if (!cachedActiveRuleIds) {
    cachedActiveRuleIds = new Set(rules.filter(r => r.enabled).map(r => r.id));
  }
  return cachedActiveRuleIds;
}

export function invalidateActiveRuleIds(): void {
  cachedActiveRuleIds = null;
}

export function getRuleStates(): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const r of rules) {
    states[r.id] = r.enabled;
  }
  return states;
}

export function applyRuleStates(states: Record<string, boolean>): void {
  for (const r of rules) {
    if (r.id in states) {
      r.enabled = states[r.id];
    }
  }
  cachedNeedsIssueGroups = null;
}
