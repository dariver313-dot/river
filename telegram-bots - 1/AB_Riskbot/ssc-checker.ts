/**
 * 时时彩 / 分分彩 系列注单违规判定引擎（新 API 适配版）
 *
 * 新 API 数据模型：每条 BetRecord 对应一个投注项
 * - playClassName (cateName)：玩法分类，如"斗牛"、"第1球"
 * - playName (betInfoName)：投注值（完整数据）
 * - numbers (betInfo)：辅助信息
 *
 * 判定：
 * - R25（覆盖超限）：斗牛 ≤7、各位置号码 ≤7
 * - 平台已限制大小/单双/龙虎同时投注，R24 无需检查
 */

import type { BetRecord } from './types';
import { addSplit, emptyCheckResult, runChecker, type CheckResult } from './checker-base';

// 向后兼容的类型别名
export type { CheckResult as SSCCheckResult };

// ============================================================
// 可配置限制常量
// ============================================================

export const SSC_LIMITS = {
  /** 斗牛：投注项上限 */
  douNiu_maxItems: 7,
  /** 第X球号码上限 */
  position_maxNumbers: 7,
};

// ============================================================
// 工具函数
// ============================================================

function isDouNiu(cateName: string): boolean {
  return /斗牛/.test(cateName);
}

function isPositionPlay(cateName: string): boolean {
  return /第[一二三四五\d]球/.test(cateName);
}

// ============================================================
// 判定逻辑
// ============================================================

function checkIssueGroup(bets: BetRecord[], lotteryName: string, issue: string): CheckResult {
  const result = emptyCheckResult();

  const cateMap = new Map<string, Set<string>>();
  for (const b of bets) {
    const cate = b.playClassName || '';
    if (!cate) continue;
    let entry = cateMap.get(cate);
    if (!entry) {
      entry = new Set();
      cateMap.set(cate, entry);
    }
    const val = (b.playName || b.numbers || '').trim();
    if (val) addSplit(entry, val);
  }

  for (const [cate, vals] of cateMap) {
    if (isDouNiu(cate)) {
      if (vals.size > SSC_LIMITS.douNiu_maxItems) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${vals.size} 项（限${SSC_LIMITS.douNiu_maxItems}）`
        );
        result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
      }
    }

    if (isPositionPlay(cate)) {
      const numValues = [...vals].filter(x => /^\d+$/.test(x));
      if (numValues.length > SSC_LIMITS.position_maxNumbers) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${numValues.length} 个号码（限${SSC_LIMITS.position_maxNumbers}）`
        );
        result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
      }
    }
  }

  return result;
}

// ============================================================
// 主入口
// ============================================================

export function checkShiShiCai(bets: BetRecord[]): CheckResult {
  return runChecker(bets, /时时彩|分分彩/, 'SSC', checkIssueGroup);
}
