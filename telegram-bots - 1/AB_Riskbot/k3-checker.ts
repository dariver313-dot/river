/**
 * 快三系列注单违规判定引擎（新 API 适配版）
 *
 * 新 API 数据模型：每条 BetRecord 对应一个投注项
 * - playClassName (cateName)：玩法分类，如"和值"、"独胆"、"二不同号"
 * - playName (betInfoName)：投注值（完整数据），如"3"、"大"、"单"
 *
 * 判定：
 * - R25（覆盖超限）：和值/独胆/二不同号/三不同号 号码上限
 * - 平台已限制大小/单双同时投注，R24 无需检查
 */

import type { BetRecord } from './types';
import { addSplit, emptyCheckResult, runChecker, type CheckResult } from './checker-base';

// 向后兼容的类型别名
export type { CheckResult as K3CheckResult };

// ============================================================
// 可配置限制常量
// ============================================================

export const K3_LIMITS = {
  /** 和值：号码类投注上限 */
  heZhi_maxNumbers: 11,
  /** 独胆：投注上限（已关闭） */
  duDan_maxItems: 99,
  /** 二不同号：投注上限（已关闭） */
  erBuTongHao_maxItems: 99,
  /** 三不同号：投注上限（已关闭） */
  sanBuTongHao_maxItems: 99,
};

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
    if (cate.includes('和值')) {
      if (vals.size > K3_LIMITS.heZhi_maxNumbers) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} 和值：${vals.size} 个号码（限${K3_LIMITS.heZhi_maxNumbers}）`
        );
        result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
      }
    }

    if (cate.includes('独胆')) {
      if (vals.size > K3_LIMITS.duDan_maxItems) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} 独胆：${vals.size} 个号码（限${K3_LIMITS.duDan_maxItems}）`
        );
        result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
      }
    }

    if (cate.includes('二不同号')) {
      if (vals.size > K3_LIMITS.erBuTongHao_maxItems) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} 二不同号：${vals.size} 个号码（限${K3_LIMITS.erBuTongHao_maxItems}）`
        );
        result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
      }
    }

    if (cate.includes('三不同号')) {
      if (vals.size > K3_LIMITS.sanBuTongHao_maxItems) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} 三不同号：${vals.size} 个号码（限${K3_LIMITS.sanBuTongHao_maxItems}）`
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

export function checkKuaiSan(bets: BetRecord[]): CheckResult {
  return runChecker(bets, /快三/, 'K3', checkIssueGroup);
}
