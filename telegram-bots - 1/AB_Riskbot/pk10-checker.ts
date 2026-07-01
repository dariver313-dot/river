/**
 * PK10 / 赛车 / 飞艇 系列注单违规判定引擎（新 API 适配版）
 *
 * 新 API 数据模型：每条 BetRecord 对应一个投注项
 * - playClassName (cateName)：玩法分类，如"冠亚和值"、"冠军"
 * - playName (betInfoName)：投注值（完整数据），如"01"、"单"、"大"
 * - amount (money)：投注金额
 *
 * 判定：
 * - R25（覆盖超限）：冠亚和值 ≤11、各名次号码 ≤7
 * - 平台已限制大小/单双/龙虎同时投注，R24 无需检查
 */

import type { BetRecord } from './types';
import { addSplit, emptyCheckResult, runChecker, type CheckResult } from './checker-base';

// 向后兼容的类型别名
export type { CheckResult as PK10CheckResult };

// ============================================================
// 可配置限制常量
// ============================================================

export const PK10_LIMITS = {
  /** 冠亚和值：数字投注上限 */
  guanYaHe_maxNumbers: 11,
  /** 各名次号码上限 */
  position_maxNumbers: 7,
};

// ============================================================
// 工具函数
// ============================================================

const POSITION_RANK: Record<string, number> = {
  '冠军': 1, '亚军': 2,
  '第三名': 3, '第四名': 4, '第五名': 5,
  '第六名': 6, '第七名': 7, '第八名': 8, '第九名': 9, '第十名': 10,
  '第1名': 1, '第2名': 2, '第3名': 3, '第4名': 4, '第5名': 5,
  '第6名': 6, '第7名': 7, '第8名': 8, '第9名': 9, '第10名': 10,
};

function getRank(cateName: string): number {
  const exact = POSITION_RANK[cateName];
  if (exact) return exact;
  // 正则回退：匹配 "第X名" 格式（含中文数字如 "第一名" → 暂不支持，仅数字）
  const m = cateName.match(/第(\d+)名/);
  if (m) {
    const num = parseInt(m[1], 10);
    if (num >= 1 && num <= 10) return num;
  }
  return 0;
}

function isGuanYaHe(cateName: string): boolean {
  return /冠亚和/.test(cateName);
}

function isPosition(cateName: string): boolean {
  return getRank(cateName) > 0;
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
    if (isGuanYaHe(cate)) {
      if (vals.size > PK10_LIMITS.guanYaHe_maxNumbers) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${vals.size} 个号码（限${PK10_LIMITS.guanYaHe_maxNumbers}）`
        );
        result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
      }
    }

    if (isPosition(cate)) {
      if (vals.size > PK10_LIMITS.position_maxNumbers) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${vals.size} 个号码（限${PK10_LIMITS.position_maxNumbers}）`
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

export function checkPK10(bets: BetRecord[]): CheckResult {
  return runChecker(bets, /PK10|赛车|飞艇/, 'PK10', checkIssueGroup);
}
