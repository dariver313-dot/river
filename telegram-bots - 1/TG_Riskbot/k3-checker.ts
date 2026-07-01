/**
 * 快三 系列注单违规判定引擎
 *
 * 覆盖所有玩法：和值、独胆、二不同号、二同号、三不同号、三同号
 *
 * 判定分为两大类：
 * - R24（对打/互斥）：和值两面大/小+单/双互斥
 * - R25（覆盖超限）：和值/独胆/二不同号/三不同号号码上限
 */

import type { BetRecord } from './types';
import { logger } from './logger';

// ============================================================
// 基础类型
// ============================================================

export interface K3CheckResult {
  twoSideViolations: string[];
  coverageViolations: string[];
  periodInfo: string;
  maxScoreR24: number;
  maxScoreR25: number;
}

function emptyResult(): K3CheckResult {
  return { twoSideViolations: [], coverageViolations: [], periodInfo: '', maxScoreR24: 0, maxScoreR25: 0 };
}

// ============================================================
// 可配置限制常量
// ============================================================

export const K3_LIMITS = {
  /** 和值：号码类投注上限 */
  heZhi_maxNumbers: 11,
  /** 独胆：投注上限 */
  duDan_maxItems: 3,
  /** 二不同号：投注上限 */
  erBuTongHao_maxItems: 4,
  /** 三不同号：投注上限 */
  sanBuTongHao_maxItems: 4,
};

// ============================================================
// 通用解析工具
// ============================================================

/**
 * 快三 numbers 格式： prefix1-val1,val2,...,prefix2-val1,val2,...
 * 返回 Map<前缀, 值数组>
 */
const K3_PREFIX_REGEX = /(和值|两面|独胆|二不同号|二同号|三不同号|三同号|不同号)-/g;

function parseK3Segments(numbers: string): Map<string, string[]> {
  const segments = new Map<string, string[]>();
  let lastEnd = 0;
  let lastPrefix = '';
  let match: RegExpExecArray | null;

  while ((match = K3_PREFIX_REGEX.exec(numbers)) !== null) {
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
 * 【1】和值 - 号码上限 + 大/小+单/双互斥
 * 号码 > 11 → R25
 * 大↔小、单↔双 → R24
 */
function checkHeZhi(group: BetRecord[], lotteryName: string, issue: string): K3CheckResult {
  const result = emptyResult();
  const allNums = new Set<string>();
  const allAttrs = new Set<string>();

  for (const b of group) {
    const segments = parseK3Segments(b.numbers || '');
    for (const [prefix, values] of segments) {
      if (prefix === '和值') {
        for (const v of values) allNums.add(v);
      } else if (prefix === '两面') {
        for (const v of values) allAttrs.add(v);
      }
    }
  }

  // 号码上限 → R25
  if (allNums.size > K3_LIMITS.heZhi_maxNumbers) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 和值：${allNums.size} 个号码（限${K3_LIMITS.heZhi_maxNumbers}）`
    );
    result.maxScoreR25 = 15;
  }

  // 互斥 → R24
  if (allAttrs.has('大') && allAttrs.has('小')) {
    result.twoSideViolations.push(
      `${lotteryName} ${issue} 和值 大↔小（对打）`
    );
    result.maxScoreR24 = 40;
  }
  if (allAttrs.has('单') && allAttrs.has('双')) {
    result.twoSideViolations.push(
      `${lotteryName} ${issue} 和值 单↔双（对打）`
    );
    result.maxScoreR24 = 40;
  }

  return result;
}

/**
 * 【2】独胆 - 投注数 > 3 → R25
 */
function checkDuDan(group: BetRecord[], lotteryName: string, issue: string): K3CheckResult {
  const result = emptyResult();
  const allItems = new Set<string>();

  for (const b of group) {
    const segments = parseK3Segments(b.numbers || '');
    for (const [prefix, values] of segments) {
      if (prefix === '独胆') {
        for (const v of values) allItems.add(v);
      }
    }
  }

  if (allItems.size > K3_LIMITS.duDan_maxItems) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 独胆：${allItems.size} 个号码（限${K3_LIMITS.duDan_maxItems}）`
    );
    result.maxScoreR25 = 15;
  }

  return result;
}

/**
 * 【3】二不同号 - 投注数 > 4 → R25
 */
function checkErBuTongHao(group: BetRecord[], lotteryName: string, issue: string): K3CheckResult {
  const result = emptyResult();
  const allItems = new Set<string>();

  for (const b of group) {
    const segments = parseK3Segments(b.numbers || '');
    for (const [prefix, values] of segments) {
      if (prefix === '二不同号') {
        for (const v of values) allItems.add(v);
      }
    }
  }

  if (allItems.size > K3_LIMITS.erBuTongHao_maxItems) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 二不同号：${allItems.size} 个号码（限${K3_LIMITS.erBuTongHao_maxItems}）`
    );
    result.maxScoreR25 = 15;
  }

  return result;
}

/**
 * 【4】二同号 - 永远合规（单选/复选均不限）
 */

/**
 * 【5】三不同号 - 投注数 > 4 → R25
 */
function checkSanBuTongHao(group: BetRecord[], lotteryName: string, issue: string): K3CheckResult {
  const result = emptyResult();
  const allItems = new Set<string>();

  for (const b of group) {
    const segments = parseK3Segments(b.numbers || '');
    for (const [prefix, values] of segments) {
      if (prefix === '三不同号') {
        for (const v of values) allItems.add(v);
      }
    }
  }

  if (allItems.size > K3_LIMITS.sanBuTongHao_maxItems) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 三不同号：${allItems.size} 个号码（限${K3_LIMITS.sanBuTongHao_maxItems}）`
    );
    result.maxScoreR25 = 15;
  }

  return result;
}

/**
 * 【6】三同号 - 永远合规（单选/复选均不限）
 */

// ============================================================
// 主入口
// ============================================================

export function checkKuaiSan(bets: BetRecord[]): K3CheckResult {
  if (!bets || bets.length === 0) return emptyResult();

  // 1. 过滤快三
  const k3Bets = bets.filter(b => /快三/.test(b.lotteryName || ''));
  if (k3Bets.length === 0) return emptyResult();

  // 2. 按 (lotteryName, issue) 分组
  const issueMap = new Map<string, BetRecord[]>();
  for (const b of k3Bets) {
    const key = `${b.lotteryName || ''}:::${b.issue || ''}`;
    const arr = issueMap.get(key) || [];
    arr.push(b);
    issueMap.set(key, arr);
  }

  // 3. 汇总
  const merged: K3CheckResult = {
    twoSideViolations: [],
    coverageViolations: [],
    periodInfo: '',
    maxScoreR24: 0,
    maxScoreR25: 0,
  };

  const merge = (sub: K3CheckResult) => {
    merged.twoSideViolations.push(...sub.twoSideViolations);
    merged.coverageViolations.push(...sub.coverageViolations);
    if (sub.maxScoreR24 > merged.maxScoreR24) merged.maxScoreR24 = sub.maxScoreR24;
    if (sub.maxScoreR25 > merged.maxScoreR25) merged.maxScoreR25 = sub.maxScoreR25;
  };

  for (const [issueKey, issueBets] of issueMap) {
    const [lotteryName, issue] = issueKey.split(':::');

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
        if (playName === '和值' && playClassName === '和值') {
          merge(checkHeZhi(playBets, lotteryName, issue));
        } else if (playName === '独胆' && playClassName === '独胆') {
          merge(checkDuDan(playBets, lotteryName, issue));
        } else if (playName === '二不同号' && playClassName === '二不同号') {
          merge(checkErBuTongHao(playBets, lotteryName, issue));
        } else if (playName === '二同号' && ['单选', '复选'].includes(playClassName)) {
          // 永远合规
        } else if (playName === '三不同号' && playClassName === '三不同号') {
          merge(checkSanBuTongHao(playBets, lotteryName, issue));
        } else if (playName === '三同号' && ['单选', '复选'].includes(playClassName)) {
          // 永远合规
        }
      } catch (err) {
        logger.warn(
          { lotteryName, issue, playName, playClassName, err: (err as Error).message },
          '[K3] 玩法判定异常，跳过该组',
        );
      }
    }
  }

  // 4. periodInfo
  const allViolations: string[] = [];
  for (const v of merged.twoSideViolations) allViolations.push(`  ${v}`);
  for (const v of merged.coverageViolations) allViolations.push(`  ${v}`);
  if (allViolations.length > 0) {
    merged.periodInfo = allViolations.join('\n');
  }

  return merged;
}