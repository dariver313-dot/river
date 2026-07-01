/**
 * PK10 / 赛车 / 飞艇 系列注单违规判定引擎
 *
 * 覆盖所有玩法：两面、冠亚和、1-5名、6-10名、冠军/亚军/第1～10名（特殊）
 *
 * 判定分为两大类：
 * - R24（对打/互斥）：单双、大小、龙虎、冠亚大/小、冠亚单/双 互斥
 * - R25（覆盖超限）：冠亚和数字 ≤11、各名次号码 ≤7
 */

import type { BetRecord } from './types';
import { logger } from './logger';

// ============================================================
// 基础类型
// ============================================================

export interface PK10CheckResult {
  twoSideViolations: string[];
  coverageViolations: string[];
  periodInfo: string;
  maxScoreR24: number;
  maxScoreR25: number;
}

function emptyResult(): PK10CheckResult {
  return { twoSideViolations: [], coverageViolations: [], periodInfo: '', maxScoreR24: 0, maxScoreR25: 0 };
}

// ============================================================
// 可配置限制常量
// ============================================================

export const PK10_LIMITS = {
  /** 冠亚和：数字投注上限 */
  guanYaHe_maxNumbers: 11,
  /** 各名次号码上限（1-5名 / 6-10名 / 特殊） */
  position_maxNumbers: 7,
};

// ============================================================
// 名次映射
// ============================================================

function getPositionRank(prefix: string): number {
  const map: Record<string, number> = {
    '冠军': 1, '亚军': 2,
    '第三名': 3, '第四名': 4, '第五名': 5,
    '第六名': 6, '第七名': 7, '第八名': 8, '第九名': 9, '第十名': 10,
    '第1名': 1, '第2名': 2, '第3名': 3, '第4名': 4, '第5名': 5,
    '第6名': 6, '第7名': 7, '第8名': 8, '第9名': 9, '第10名': 10,
  };
  return map[prefix] ?? 0;
}

function isPosition1to5(prefix: string): boolean {
  const rank = getPositionRank(prefix);
  return rank >= 1 && rank <= 5;
}

function isPosition6to10(prefix: string): boolean {
  const rank = getPositionRank(prefix);
  return rank >= 6 && rank <= 10;
}

// ============================================================
// 通用解析工具
// ============================================================

/**
 * PK10 numbers 格式： prefix1-val1,val2,...,prefix2-val1,val2,...
 * 返回 Map<前缀, 值数组>
 */
const PK10_PREFIX_REGEX = /(冠军|亚军|第[一二三四五六七八九十\d]+名|冠亚和|两面)-/g;

function parsePK10Segments(numbers: string): Map<string, string[]> {
  const segments = new Map<string, string[]>();
  let lastEnd = 0;
  let lastPrefix = '';
  let match: RegExpExecArray | null;

  while ((match = PK10_PREFIX_REGEX.exec(numbers)) !== null) {
    if (lastEnd > 0 && lastPrefix) {
      const segment = numbers.substring(lastEnd, match.index);
      const values = segment.split(',').map(s => s.trim()).filter(Boolean);
      const existing = segments.get(lastPrefix) || [];
      segments.set(lastPrefix, [...existing, ...values]);
    }
    lastPrefix = match[1];
    lastEnd = match.index + match[0].length;
  }
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
 * 【1】两面 - 按名次独立互斥检查 → R24
 * 冠亚和：冠亚大↔冠亚小、冠亚单↔冠亚双
 * 冠军～第五名：单↔双、大↔小、龙↔虎
 * 第六名～第十名：单↔双、大↔小
 */
function checkTwoSides(group: BetRecord[], lotteryName: string, issue: string): PK10CheckResult {
  const result = emptyResult();

  const prefixAttrs = new Map<string, Set<string>>();
  for (const b of group) {
    const segments = parsePK10Segments(b.numbers || '');
    for (const [prefix, values] of segments) {
      const set = prefixAttrs.get(prefix) || new Set<string>();
      for (const v of values) set.add(v);
      prefixAttrs.set(prefix, set);
    }
  }

  for (const [prefix, attrs] of prefixAttrs) {
    if (prefix === '冠亚和') {
      if (attrs.has('冠亚大') && attrs.has('冠亚小')) {
        result.twoSideViolations.push(
          `${lotteryName} ${issue} 两面 冠亚和 冠亚大↔冠亚小（对打）`
        );
        result.maxScoreR24 = 40;
      }
      if (attrs.has('冠亚单') && attrs.has('冠亚双')) {
        result.twoSideViolations.push(
          `${lotteryName} ${issue} 两面 冠亚和 冠亚单↔冠亚双（对打）`
        );
        result.maxScoreR24 = 40;
      }
    } else if (isPosition1to5(prefix)) {
      if (attrs.has('单') && attrs.has('双')) {
        result.twoSideViolations.push(
          `${lotteryName} ${issue} 两面 ${prefix} 单↔双（对打）`
        );
        result.maxScoreR24 = 40;
      }
      if (attrs.has('大') && attrs.has('小')) {
        result.twoSideViolations.push(
          `${lotteryName} ${issue} 两面 ${prefix} 大↔小（对打）`
        );
        result.maxScoreR24 = 40;
      }
      if (attrs.has('龙') && attrs.has('虎')) {
        result.twoSideViolations.push(
          `${lotteryName} ${issue} 两面 ${prefix} 龙↔虎（对打）`
        );
        result.maxScoreR24 = 40;
      }
    } else if (isPosition6to10(prefix)) {
      if (attrs.has('单') && attrs.has('双')) {
        result.twoSideViolations.push(
          `${lotteryName} ${issue} 两面 ${prefix} 单↔双（对打）`
        );
        result.maxScoreR24 = 40;
      }
      if (attrs.has('大') && attrs.has('小')) {
        result.twoSideViolations.push(
          `${lotteryName} ${issue} 两面 ${prefix} 大↔小（对打）`
        );
        result.maxScoreR24 = 40;
      }
    }
  }

  return result;
}

/**
 * 【2】冠亚和 - 互斥 + 号码上限 → R24 + R25
 * 冠亚大↔冠亚小、冠亚单↔冠亚双 互斥
 * 数字投注 ≤ 11 个
 */
function checkGuanYaHe(group: BetRecord[], lotteryName: string, issue: string): PK10CheckResult {
  const result = emptyResult();
  const allAttrs = new Set<string>();
  const allNums = new Set<string>();
  const numberRegex = /^\d+$/;

  for (const b of group) {
    const segments = parsePK10Segments(b.numbers || '');
    for (const values of segments.values()) {
      for (const v of values) {
        if (numberRegex.test(v)) {
          allNums.add(v);
        } else {
          allAttrs.add(v);
        }
      }
    }
  }

  if (allAttrs.has('冠亚大') && allAttrs.has('冠亚小')) {
    result.twoSideViolations.push(
      `${lotteryName} ${issue} 冠亚和 冠亚大↔冠亚小（对打）`
    );
    result.maxScoreR24 = 40;
  }
  if (allAttrs.has('冠亚单') && allAttrs.has('冠亚双')) {
    result.twoSideViolations.push(
      `${lotteryName} ${issue} 冠亚和 冠亚单↔冠亚双（对打）`
    );
    result.maxScoreR24 = 40;
  }

  if (allNums.size > PK10_LIMITS.guanYaHe_maxNumbers) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 冠亚和：${allNums.size} 个号码（限${PK10_LIMITS.guanYaHe_maxNumbers}）`
    );
    result.maxScoreR25 = 15;
  }

  return result;
}

/**
 * 【3】1-5名 - 每个名次号码上限 ≤ 7 → R25
 */
function checkPositions1to5(group: BetRecord[], lotteryName: string, issue: string): PK10CheckResult {
  const result = emptyResult();
  const posNums = new Map<string, Set<string>>();

  for (const b of group) {
    const segments = parsePK10Segments(b.numbers || '');
    for (const [prefix, values] of segments) {
      if (isPosition1to5(prefix)) {
        const set = posNums.get(prefix) || new Set<string>();
        for (const v of values) set.add(v);
        posNums.set(prefix, set);
      }
    }
  }

  for (const [pos, nums] of posNums) {
    if (nums.size > PK10_LIMITS.position_maxNumbers) {
      result.coverageViolations.push(
        `${lotteryName} ${issue} 1-5名 ${pos}：${nums.size} 个号码（限${PK10_LIMITS.position_maxNumbers}）`
      );
      result.maxScoreR25 = 15;
    }
  }

  return result;
}

/**
 * 【4】6-10名 - 每个名次号码上限 ≤ 7 → R25
 */
function checkPositions6to10(group: BetRecord[], lotteryName: string, issue: string): PK10CheckResult {
  const result = emptyResult();
  const posNums = new Map<string, Set<string>>();

  for (const b of group) {
    const segments = parsePK10Segments(b.numbers || '');
    for (const [prefix, values] of segments) {
      if (isPosition6to10(prefix)) {
        const set = posNums.get(prefix) || new Set<string>();
        for (const v of values) set.add(v);
        posNums.set(prefix, set);
      }
    }
  }

  for (const [pos, nums] of posNums) {
    if (nums.size > PK10_LIMITS.position_maxNumbers) {
      result.coverageViolations.push(
        `${lotteryName} ${issue} 6-10名 ${pos}：${nums.size} 个号码（限${PK10_LIMITS.position_maxNumbers}）`
      );
      result.maxScoreR25 = 15;
    }
  }

  return result;
}

/**
 * 【5】特殊 - 两面互斥 + 名次号码上限 → R24 + R25
 * playName/playClassName ∈ {冠军, 亚军, 第1名, ..., 第10名}
 * 两面-：单↔双、大↔小、龙↔虎 互斥
 * 名次-：号码 ≤ 7
 */
function checkSpecial(
  group: BetRecord[], lotteryName: string, issue: string,
  playClassName: string,
): PK10CheckResult {
  const result = emptyResult();
  const twoSideAttrs = new Set<string>();
  const posNums = new Set<string>();

  for (const b of group) {
    const segments = parsePK10Segments(b.numbers || '');
    for (const [prefix, values] of segments) {
      if (prefix === '两面') {
        for (const v of values) twoSideAttrs.add(v);
      } else if (prefix === playClassName) {
        for (const v of values) posNums.add(v);
      }
    }
  }

  if (twoSideAttrs.has('单') && twoSideAttrs.has('双')) {
    result.twoSideViolations.push(
      `${lotteryName} ${issue} ${playClassName} 单↔双（对打）`
    );
    result.maxScoreR24 = 40;
  }
  if (twoSideAttrs.has('大') && twoSideAttrs.has('小')) {
    result.twoSideViolations.push(
      `${lotteryName} ${issue} ${playClassName} 大↔小（对打）`
    );
    result.maxScoreR24 = 40;
  }
  if (twoSideAttrs.has('龙') && twoSideAttrs.has('虎')) {
    result.twoSideViolations.push(
      `${lotteryName} ${issue} ${playClassName} 龙↔虎（对打）`
    );
    result.maxScoreR24 = 40;
  }

  if (posNums.size > PK10_LIMITS.position_maxNumbers) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} ${playClassName}：${posNums.size} 个号码（限${PK10_LIMITS.position_maxNumbers}）`
    );
    result.maxScoreR25 = 15;
  }

  return result;
}

// ============================================================
// 主入口
// ============================================================

const SPECIAL_PLAY_NAMES = new Set([
  '冠军', '亚军',
  '第1名', '第2名', '第3名', '第4名', '第5名',
  '第6名', '第7名', '第8名', '第9名', '第10名',
]);

export function checkPK10(bets: BetRecord[]): PK10CheckResult {
  if (!bets || bets.length === 0) return emptyResult();

  // 1. 过滤 PK10 / 赛车 / 飞艇
  const pk10Bets = bets.filter(b => /PK10|赛车|飞艇/.test(b.lotteryName || ''));
  if (pk10Bets.length === 0) return emptyResult();

  // 2. 按 (lotteryName, issue) 分组
  const issueMap = new Map<string, BetRecord[]>();
  for (const b of pk10Bets) {
    const key = `${b.lotteryName || ''}:::${b.issue || ''}`;
    const arr = issueMap.get(key) || [];
    arr.push(b);
    issueMap.set(key, arr);
  }

  // 3. 汇总
  const merged: PK10CheckResult = {
    twoSideViolations: [],
    coverageViolations: [],
    periodInfo: '',
    maxScoreR24: 0,
    maxScoreR25: 0,
  };

  const merge = (sub: PK10CheckResult) => {
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
          merge(checkTwoSides(playBets, lotteryName, issue));
        } else if (playName === '冠亚和' && playClassName === '冠亚和') {
          merge(checkGuanYaHe(playBets, lotteryName, issue));
        } else if (playName === '1-5名' && playClassName === '1-5名') {
          merge(checkPositions1to5(playBets, lotteryName, issue));
        } else if (playName === '6-10名' && playClassName === '6-10名') {
          merge(checkPositions6to10(playBets, lotteryName, issue));
        } else if (SPECIAL_PLAY_NAMES.has(playName) && playName === playClassName) {
          merge(checkSpecial(playBets, lotteryName, issue, playClassName));
        }
      } catch (err) {
        logger.warn(
          { lotteryName, issue, playName, playClassName, err: (err as Error).message },
          '[PK10] 玩法判定异常，跳过该组',
        );
      }
    }
  }

  // 4. 拼接 periodInfo
  const allViolations: string[] = [];
  for (const v of merged.twoSideViolations) allViolations.push(`  ${v}`);
  for (const v of merged.coverageViolations) allViolations.push(`  ${v}`);
  if (allViolations.length > 0) {
    merged.periodInfo = allViolations.join('\n');
  }

  return merged;
}
