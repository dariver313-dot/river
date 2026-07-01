/**
 * 时时彩 / 分分彩 系列注单违规判定引擎
 *
 * 覆盖所有玩法：两面、斗牛、1-5球、前中后、第1球～第5球
 *
 * 判定分为两大类：
 * - R24（对打/互斥）：两面互斥、前中后三选一、第X球大/小+单/双互斥
 * - R25（覆盖超限）：斗牛/1-5球/第X球号码上限
 */

import type { BetRecord } from './types';
import { logger } from './logger';

// ============================================================
// 基础类型（复用 LHC 的结果类型）
// ============================================================

export interface SSCCheckResult {
  /** R24 类违规描述（对打/互斥） */
  twoSideViolations: string[];
  /** R25 类违规描述（覆盖超限） */
  coverageViolations: string[];
  /** 格式化后的违规详情文本 */
  periodInfo: string;
  /** R24 最高分 */
  maxScoreR24: number;
  /** R25 最高分 */
  maxScoreR25: number;
}

function emptyResult(): SSCCheckResult {
  return { twoSideViolations: [], coverageViolations: [], periodInfo: '', maxScoreR24: 0, maxScoreR25: 0 };
}

// ============================================================
// 可配置限制常量
// ============================================================

export const SSC_LIMITS = {
  /** 斗牛：投注项上限 */
  douNiu_maxItems: 7,
  /** 1-5球：每球位置号码上限 */
  ball15_maxPerPosition: 7,
  /** 第X球：号码类投注上限 */
  diXQiu_maxNumbers: 7,
};

// ============================================================
// 前中后互斥定义
// ============================================================

/** 前中后：每个位置内部三选一（对子/半顺/杂六） */
const QIAN_ZHONG_HOU_3_OF_1 = new Set(['对子', '半顺', '杂六']);

// ============================================================
// 通用解析工具
// ============================================================

/**
 * 通用 SSC numbers 解析器。
 * SSC 的 numbers 格式为： prefix1-val1,val2,...,prefix2-val1,val2,...
 * 即前缀-值列表，多个前缀段用逗号拼接。
 * 返回 Map<前缀, 值数组>
 */
function parseSscSegments(numbers: string): Map<string, string[]> {
  const segments = new Map<string, string[]>();
  const prefixRegex = /(总和、龙虎|龙虎|第[一二三四五]球|两面|中三|后三|前三|斗牛)-/g;
  let lastEnd = 0;
  let lastPrefix = '';
  let match: RegExpExecArray | null;

  while ((match = prefixRegex.exec(numbers)) !== null) {
    if (lastEnd > 0 && lastPrefix) {
      const segment = numbers.substring(lastEnd, match.index);
      const values = segment.split(',').map(s => s.trim()).filter(Boolean);
      const existing = segments.get(lastPrefix) || [];
      segments.set(lastPrefix, [...existing, ...values]);
    }
    lastPrefix = match[1];
    lastEnd = match.index + match[0].length;
  }
  // 最后一个段
  if (lastEnd > 0 && lastPrefix) {
    const segment = numbers.substring(lastEnd);
    const values = segment.split(',').map(s => s.trim()).filter(Boolean);
    const existing = segments.get(lastPrefix) || [];
    segments.set(lastPrefix, [...existing, ...values]);
  }

  return segments;
}

// ============================================================
// 各玩法判定函数
// ============================================================

/**
 * 【1】两面 - 按位置独立互斥检查 → R24
 * 每个球位置（第一球～第五球）内部：大↔小、单↔双
 * 总和、龙虎内部：总和大↔总和小、总和单↔总和双、龙↔虎
 * 不同位置之间不互斥（如"第一球-大,第二球-小"合法）
 */
function checkSscTwoSides(group: BetRecord[], lotteryName: string, issue: string): SSCCheckResult {
  const result = emptyResult();

  // 合并组内所有注单，按前缀收集属性
  const prefixAttrs = new Map<string, Set<string>>();
  for (const b of group) {
    const segments = parseSscSegments(b.numbers || '');
    for (const [prefix, values] of segments) {
      const set = prefixAttrs.get(prefix) || new Set<string>();
      for (const v of values) set.add(v);
      prefixAttrs.set(prefix, set);
    }
  }

  // 每个球位置：大↔小、单↔双
  const ballMutex: [string, string][] = [['大', '小'], ['单', '双']];
  // 龙虎/总和龙虎位置：总和大↔总和小、总和单↔总和双、龙↔虎
  const longHuMutex: [string, string][] = [['总和大', '总和小'], ['总和单', '总和双'], ['龙', '虎']];

  for (const [prefix, attrs] of prefixAttrs) {
    if (/^第[一二三四五]球$/.test(prefix)) {
      for (const [a, b] of ballMutex) {
        if (attrs.has(a) && attrs.has(b)) {
          result.twoSideViolations.push(
            `${lotteryName} ${issue} 两面 ${prefix} ${a}↔${b}（对打）`
          );
          result.maxScoreR24 = 40;
        }
      }
    } else if (prefix === '总和、龙虎' || prefix === '龙虎') {
      for (const [a, b] of longHuMutex) {
        if (attrs.has(a) && attrs.has(b)) {
          result.twoSideViolations.push(
            `${lotteryName} ${issue} 两面 ${prefix} ${a}↔${b}（对打）`
          );
          result.maxScoreR24 = 40;
        }
      }
    }
  }

  return result;
}

/**
 * 【2】斗牛 - 投注项 > 7 → R25
 */
function checkDouNiu(group: BetRecord[], lotteryName: string, issue: string): SSCCheckResult {
  const result = emptyResult();
  const allItems = new Set<string>();

  for (const b of group) {
    const segments = parseSscSegments(b.numbers || '');
    for (const values of segments.values()) {
      for (const v of values) allItems.add(v);
    }
  }

  if (allItems.size > SSC_LIMITS.douNiu_maxItems) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 斗牛：${allItems.size} 项（限${SSC_LIMITS.douNiu_maxItems}）`
    );
    result.maxScoreR25 = 15;
  }

  return result;
}

/**
 * 【3】1-5球 - 每个球位置号码数 > 7 → R25
 * 规则：按每球位置独立检查，任一位置超限即违规
 */
function checkBall15(group: BetRecord[], lotteryName: string, issue: string): SSCCheckResult {
  const result = emptyResult();
  // 按位置收集号码
  const posNums = new Map<string, Set<string>>();

  for (const b of group) {
    const segments = parseSscSegments(b.numbers || '');
    for (const [prefix, values] of segments) {
      if (/^第[一二三四五]球$/.test(prefix)) {
        const set = posNums.get(prefix) || new Set<string>();
        for (const v of values) set.add(v);
        posNums.set(prefix, set);
      }
    }
  }

  for (const [pos, nums] of posNums) {
    if (nums.size > SSC_LIMITS.ball15_maxPerPosition) {
      result.coverageViolations.push(
        `${lotteryName} ${issue} 1-5球 ${pos}：${nums.size} 个号码（限${SSC_LIMITS.ball15_maxPerPosition}）`
      );
      result.maxScoreR25 = 15;
    }
  }

  return result;
}

/**
 * 【4】前中后 - 每个位置内部对子/半顺/杂六三选一 → R24
 * 豹子、顺子不受限
 */
function checkQianZhongHou(group: BetRecord[], lotteryName: string, issue: string): SSCCheckResult {
  const result = emptyResult();
  // 按位置收集属性
  const posAttrs = new Map<string, Set<string>>();

  for (const b of group) {
    const segments = parseSscSegments(b.numbers || '');
    for (const [prefix, values] of segments) {
      if (/^(前三|中三|后三)$/.test(prefix)) {
        const set = posAttrs.get(prefix) || new Set<string>();
        for (const v of values) set.add(v);
        posAttrs.set(prefix, set);
      }
    }
  }

  for (const [pos, attrs] of posAttrs) {
    // 检查对子/半顺/杂六是否超过 1 个
    const restricted = [...attrs].filter(a => QIAN_ZHONG_HOU_3_OF_1.has(a));
    if (restricted.length > 1) {
      result.twoSideViolations.push(
        `${lotteryName} ${issue} 前中后 ${pos}：${restricted.join('、')}（对子/半顺/杂六只能三选一）`
      );
      result.maxScoreR24 = 40;
    }
  }

  return result;
}

/**
 * 【5】第X球（X=1~5） - 号码上限 + 大/小+单/双互斥
 * 号码数 > 7 → R25
 * 大↔小、单↔双 → R24
 */
function checkDiXQiu(
  group: BetRecord[], lotteryName: string, issue: string,
  playClassName: string,
): SSCCheckResult {
  const result = emptyResult();
  // 提取球号前缀（第1球 → 第一球, 第2球 → 第二球, ...）
  const ballNum = playClassName.replace('第', '').replace('球', '');
  const numMap: Record<string, string> = { '1': '一', '2': '二', '3': '三', '4': '四', '5': '五' };
  const ballPrefix = `第${numMap[ballNum] || ballNum}球`;

  const allNums = new Set<string>();
  const allAttrs = new Set<string>();

  for (const b of group) {
    const segments = parseSscSegments(b.numbers || '');
    for (const [prefix, values] of segments) {
      if (prefix === ballPrefix) {
        for (const v of values) allNums.add(v);
      } else if (prefix === '两面') {
        for (const v of values) allAttrs.add(v);
      }
    }
  }

  // 号码上限检查 → R25
  if (allNums.size > SSC_LIMITS.diXQiu_maxNumbers) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} ${playClassName}：${allNums.size} 个号码（限${SSC_LIMITS.diXQiu_maxNumbers}）`
    );
    result.maxScoreR25 = 15;
  }

  // 互斥检查 → R24
  if (allAttrs.has('大') && allAttrs.has('小')) {
    result.twoSideViolations.push(
      `${lotteryName} ${issue} ${playClassName} 大↔小（对打）`
    );
    result.maxScoreR24 = 40;
  }
  if (allAttrs.has('单') && allAttrs.has('双')) {
    result.twoSideViolations.push(
      `${lotteryName} ${issue} ${playClassName} 单↔双（对打）`
    );
    result.maxScoreR24 = 40;
  }

  return result;
}

// ============================================================
// 主入口
// ============================================================

/**
 * 对一批 BetRecord 做时时彩/分分彩违规检查。
 * 外部需先过滤 lotteryName 包含 "时时彩" 或 "分分彩"。
 */
export function checkShiShiCai(bets: BetRecord[]): SSCCheckResult {
  if (!bets || bets.length === 0) return emptyResult();

  // 1. 过滤时时彩/分分彩
  const sscBets = bets.filter(b => /时时彩|分分彩/.test(b.lotteryName || ''));
  if (sscBets.length === 0) return emptyResult();

  // 2. 按 (lotteryName, issue) 分组
  const issueMap = new Map<string, BetRecord[]>();
  for (const b of sscBets) {
    const key = `${b.lotteryName || ''}:::${b.issue || ''}`;
    const arr = issueMap.get(key) || [];
    arr.push(b);
    issueMap.set(key, arr);
  }

  // 3. 汇总结果
  const merged: SSCCheckResult = {
    twoSideViolations: [],
    coverageViolations: [],
    periodInfo: '',
    maxScoreR24: 0,
    maxScoreR25: 0,
  };

  const merge = (sub: SSCCheckResult) => {
    merged.twoSideViolations.push(...sub.twoSideViolations);
    merged.coverageViolations.push(...sub.coverageViolations);
    if (sub.maxScoreR24 > merged.maxScoreR24) merged.maxScoreR24 = sub.maxScoreR24;
    if (sub.maxScoreR25 > merged.maxScoreR25) merged.maxScoreR25 = sub.maxScoreR25;
  };

  for (const [issueKey, issueBets] of issueMap) {
    const [lotteryName, issue] = issueKey.split(':::');

    // 3a. 按 (playName, playClassName) 子分组
    const playMap = new Map<string, BetRecord[]>();
    for (const b of issueBets) {
      const subKey = `${b.playName || ''}:::${b.playClassName || ''}`;
      const arr = playMap.get(subKey) || [];
      arr.push(b);
      playMap.set(subKey, arr);
    }

    for (const [subKey, playBets] of playMap) {
      const [playName, playClassName] = subKey.split(':::');

      try {
        if (playName === '两面' && playClassName === '两面') {
          merge(checkSscTwoSides(playBets, lotteryName, issue));
        } else if (playName === '斗牛' && playClassName === '斗牛') {
          merge(checkDouNiu(playBets, lotteryName, issue));
        } else if (playName === '1-5球' && playClassName === '1-5球') {
          merge(checkBall15(playBets, lotteryName, issue));
        } else if (playName === '前中后' && playClassName === '前中后') {
          merge(checkQianZhongHou(playBets, lotteryName, issue));
        } else if (playName === '第1球' && playClassName === '第1球') {
          merge(checkDiXQiu(playBets, lotteryName, issue, playClassName));
        } else if (playName === '第2球' && playClassName === '第2球') {
          merge(checkDiXQiu(playBets, lotteryName, issue, playClassName));
        } else if (playName === '第3球' && playClassName === '第3球') {
          merge(checkDiXQiu(playBets, lotteryName, issue, playClassName));
        } else if (playName === '第4球' && playClassName === '第4球') {
          merge(checkDiXQiu(playBets, lotteryName, issue, playClassName));
        } else if (playName === '第5球' && playClassName === '第5球') {
          merge(checkDiXQiu(playBets, lotteryName, issue, playClassName));
        }
      } catch (err) {
        logger.warn(
          { lotteryName, issue, playName, playClassName, err: (err as Error).message },
          '[SSC] 玩法判定异常，跳过该组',
        );
      }
    }
  }

  // 4. 拼接 periodInfo
  const allViolations: string[] = [];
  for (const v of merged.twoSideViolations) {
    allViolations.push(`  ${v}`);
  }
  for (const v of merged.coverageViolations) {
    allViolations.push(`  ${v}`);
  }
  if (allViolations.length > 0) {
    merged.periodInfo = allViolations.join('\n');
  }

  return merged;
}