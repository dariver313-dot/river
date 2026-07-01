/**
 * 共享的彩票玩法检测基础工具
 *
 * 四个 checker (lhc/k3/ssc/pk10) 共享：
 * - addSplit：逗号分隔值展开
 * - CheckResult：统一的检测结果接口
 * - runChecker：通用的过滤→分组→逐期检测→合并→periodInfo 编排
 */

import type { BetRecord } from './types';
import { logger } from './logger';

export interface CheckResult {
  twoSideViolations: string[];
  coverageViolations: string[];
  periodInfo: string;
  maxScoreR24: number;
  maxScoreR25: number;
}

export function emptyCheckResult(): CheckResult {
  return { twoSideViolations: [], coverageViolations: [], periodInfo: '', maxScoreR24: 0, maxScoreR25: 0 };
}

export function addSplit(values: Set<string>, raw: string): void {
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (t) values.add(t);
  }
}

export function mergeCheckResult(merged: CheckResult, sub: CheckResult): void {
  merged.twoSideViolations.push(...sub.twoSideViolations);
  merged.coverageViolations.push(...sub.coverageViolations);
  if (sub.maxScoreR24 > merged.maxScoreR24) merged.maxScoreR24 = sub.maxScoreR24;
  if (sub.maxScoreR25 > merged.maxScoreR25) merged.maxScoreR25 = sub.maxScoreR25;
}

export function buildCheckPeriodInfo(merged: CheckResult): void {
  const all: string[] = [];
  for (const v of merged.twoSideViolations) all.push(`  ${v}`);
  for (const v of merged.coverageViolations) all.push(`  ${v}`);
  if (all.length > 0) {
    merged.periodInfo = all.join('\n');
  }
}

/**
 * 通用检测编排器。
 *
 * @param bets        全部投注记录
 * @param lotteryRe   彩票名称过滤正则
 * @param tag         日志标签（如 'LHC'）
 * @param checkFn     逐期检测函数 (bets, lotteryName, issue) => CheckResult
 * @returns 合并后的检测结果
 */
export function runChecker(
  bets: BetRecord[],
  lotteryRe: RegExp,
  tag: string,
  checkFn: (bets: BetRecord[], lotteryName: string, issue: string) => CheckResult,
): CheckResult {
  if (!bets || bets.length === 0) return emptyCheckResult();

  const filtered = bets.filter(b => lotteryRe.test(b.lotteryName || ''));
  if (filtered.length === 0) return emptyCheckResult();

  const issueMap = new Map<string, BetRecord[]>();
  for (const b of filtered) {
    const key = `${b.lotteryName || ''}:::${b.issue || ''}`;
    const arr = issueMap.get(key) || [];
    arr.push(b);
    issueMap.set(key, arr);
  }

  const merged = emptyCheckResult();

  for (const [issueKey, issueBets] of issueMap) {
    const [lotteryName, issue] = issueKey.split(':::');
    try {
      mergeCheckResult(merged, checkFn(issueBets, lotteryName, issue));
    } catch (err) {
      logger.warn(
        { lotteryName, issue, err: (err as Error).message },
        `[${tag}] 玩法判定异常，跳过该期`,
      );
    }
  }

  buildCheckPeriodInfo(merged);

  logger.info(
    {
      totalBets: bets.length,
      filteredBets: filtered.length,
      twoSideCount: merged.twoSideViolations.length,
      coverageCount: merged.coverageViolations.length,
      maxScoreR24: merged.maxScoreR24,
      maxScoreR25: merged.maxScoreR25,
    },
    `[${tag}] 检查完成`,
  );

  return merged;
}
