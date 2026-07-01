/**
 * 六合彩系列注单违规判定引擎（新 API 适配版）
 *
 * 新 API 数据模型：每条 BetRecord 对应一个投注项
 * - playClassName (cateName)：玩法分类，如"特码A"、"特码色波"、"合肖"
 * - playName (betInfoName)：投注值（完整数据），如"01"、"红波"、"鼠"
 * - numbers (betInfo)：辅助值
 * - amount (money)：投注金额
 *
 * 判定：
 * - R24（对打/互斥）：色波互斥、半波同色互斥
 * - R25（覆盖超限）：各玩法投注项数量上限
 * - 平台已限制大小/单双同时投注，两面互斥无需检查
 */

import type { BetRecord } from './types';
import { logger } from './logger';
import { addSplit, emptyCheckResult, runChecker, type CheckResult } from './checker-base';

// 向后兼容的类型别名
export type { CheckResult as LHCCheckResult };

// ============================================================
// 可配置限制常量
// ============================================================

export const LHC_LIMITS = {
  /** 特码A：同金额最多号码数 */
  teMa_sameAmtMax: 20,
  /** 特码A：不同金额最多号码数 */
  teMa_totalMax: 32,

  /** 特码半波大小：最多项数 */
  banBoDaXiao_max: 4,
  /** 特码半波单双：最多项数 */
  banBoDanShuang_max: 4,

  /** 特码尾数：最多尾数 */
  teMaWeiShu_max: 5,

  /** 合肖：最多生肖数 */
  heXiao_maxZodiac: 4,

  /** 五行：最多元素数 */
  wuXing_maxElement: 2,

  /** 一肖：最多生肖数 */
  yiXiao_maxZodiac: 3,

  /** 总肖：最多生肖数 */
  zongXiao_maxZodiac: 2,

  /** 正特尾数：最多尾数 */
  zhengTeWeiShu_max: 4,

  /** 连肖（二/三/四/五连肖）：最多生肖数（已关闭） */
  lianXiao_maxZodiac: 99,

  /** 连尾（二/三/四/五连尾）：最多尾数 */
  lianWei_maxTail: 5,

  /** 特肖：最多生肖数 */
  teXiao_maxZodiac: 6,
};

// ============================================================
// 常量
// ============================================================

const COLOR_SET = new Set(['红波', '蓝波', '绿波']);

/** 半波同色互补对 */
const BANBO_PAIRS: Record<string, [string, string][]> = {
  '红波': [['红单', '红双'], ['红大', '红小'], ['红合单', '红合双']],
  '蓝波': [['蓝单', '蓝双'], ['蓝大', '蓝小'], ['蓝合单', '蓝合双']],
  '绿波': [['绿单', '绿双'], ['绿大', '绿小'], ['绿合单', '绿合双']],
};

// ============================================================
// 工具函数
// ============================================================

function isTeMaA(cateName: string): boolean {
  return /^特码A?$/.test(cateName);
}

function isTeMaSeBo(cateName: string): boolean {
  return /特码色波/.test(cateName);
}

function isTeMaBanBoDaXiao(cateName: string): boolean {
  return /半波.*大小/.test(cateName);
}

function isTeMaBanBoDanShuang(cateName: string): boolean {
  return /半波.*单双/.test(cateName);
}

function isTeMaWeiShu(cateName: string): boolean {
  return /特码尾数|尾数/.test(cateName);
}

function isHeXiao(cateName: string): boolean {
  return /合肖/.test(cateName);
}

function isWuXing(cateName: string): boolean {
  return /五行/.test(cateName);
}

function isYiXiao(cateName: string): boolean {
  return /一肖/.test(cateName);
}

function isZongXiao(cateName: string): boolean {
  return /总肖/.test(cateName);
}

function isZhengTeWeiShu(cateName: string): boolean {
  return /正特尾数/.test(cateName);
}

// 连肖和连尾的"二连肖/三连肖"等均已包含"连肖/连尾"，简化正则
function isLianXiao(cateName: string): boolean {
  return /连肖/.test(cateName);
}

function isLianWei(cateName: string): boolean {
  return /连尾/.test(cateName);
}

function isTeXiao(cateName: string): boolean {
  return cateName === '特肖';
}

/** 提取纯数字值 */
function extractNumbers(values: Set<string>): Set<string> {
  return new Set([...values].filter(v => /^\d{1,2}$/.test(v)));
}

/** 英文生肖 → 中文映射 */
const EN_ZODIAC_MAP: Record<string, string> = {
  rat: '鼠', ox: '牛', tiger: '虎', rabbit: '兔',
  dragon: '龙', snake: '蛇', horse: '马', goat: '羊', sheep: '羊',
  monkey: '猴', rooster: '鸡', cock: '鸡', chicken: '鸡',
  dog: '狗', pig: '猪',
};

/** 提取生肖值（支持中文 + 英文兜底） */
function extractZodiacs(values: Set<string>): Set<string> {
  const zodiacSet = new Set(['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪']);
  const result = new Set<string>();
  for (const v of values) {
    if (zodiacSet.has(v)) { result.add(v); continue; }
    const cn = EN_ZODIAC_MAP[v.toLowerCase()];
    if (cn) result.add(cn);
  }
  return result;
}

/** 提取尾数值（如 "1尾", "2尾"） */
function extractTails(values: Set<string>): Set<string> {
  return new Set([...values].filter(v => /\d尾/.test(v)));
}

// ============================================================
// 判定逻辑
// ============================================================

function checkIssueGroup(bets: BetRecord[], lotteryName: string, issue: string): CheckResult {
  const result = emptyCheckResult();

  // 按 playClassName (cateName) 分组
  const cateMap = new Map<string, {
    values: Set<string>;
    numbersSet: Set<string>;
    amtGroups: Map<string, Set<string>>; // amount → values
  }>();

  for (const b of bets) {
    const cate = b.playClassName || '';
    if (!cate) continue;
    let entry = cateMap.get(cate);
    if (!entry) {
      entry = { values: new Set(), numbersSet: new Set(), amtGroups: new Map() };
      cateMap.set(cate, entry);
    }
    const val = (b.playName || b.numbers || '').trim();
    if (val) addSplit(entry.values, val);
    const numVal = (b.numbers || '').trim();
    if (numVal) addSplit(entry.numbersSet, numVal);

    const amt = Number(b.amount || 0).toFixed(2);
    const amtSet = entry.amtGroups.get(amt) || new Set<string>();
    if (val) addSplit(amtSet, val);
    entry.amtGroups.set(amt, amtSet);
  }

  for (const [cate, entry] of cateMap) {
    const v = entry.values;
    const n = entry.numbersSet;
    const allVals = new Set([...v, ...n]);

    // --- R25: 特码A — 同金额≤20，不同金额≤32 ---
    if (isTeMaA(cate)) {
      logger.debug(
        { lotteryName, issue, cate, valuesCount: v.size, amtGroups: [...entry.amtGroups].map(([a, vs]) => ({ amt: parseFloat(a), count: vs.size })) },
        '[LHC] 特码A 检测',
      );
      for (const [amt, vals] of entry.amtGroups) {
        if (vals.size > LHC_LIMITS.teMa_sameAmtMax) {
          result.coverageViolations.push(
            `${lotteryName} ${issue} ${cate}：同金额 ${parseFloat(amt)} 覆盖 ${vals.size} 个号码（限${LHC_LIMITS.teMa_sameAmtMax}）`
          );
          result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
        }
      }
      if (v.size > LHC_LIMITS.teMa_totalMax) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：不同金额共覆盖 ${v.size} 个号码（限${LHC_LIMITS.teMa_totalMax}）`
        );
        result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
      }
    }

    // --- R24: 特码色波 — 红波/蓝波/绿波只能出现一个 ---
    if (isTeMaSeBo(cate)) {
      const colors = [...allVals].filter(c => COLOR_SET.has(c));
      if (new Set(colors).size >= 2) {
        result.twoSideViolations.push(
          `${lotteryName} ${issue} ${cate}：${[...new Set(colors)].join('↔')}（多波色对打）`
        );
        result.maxScoreR24 = 40;
      }
    }

    // --- R25: 特码半波大小 ≤ 4 ---
    if (isTeMaBanBoDaXiao(cate)) {
      if (v.size > LHC_LIMITS.banBoDaXiao_max) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${v.size} 项（限${LHC_LIMITS.banBoDaXiao_max}）`
        );
        result.maxScoreR25 = 15;
      }
    }

    // --- R25: 特码半波单双 ≤ 4 ---
    if (isTeMaBanBoDanShuang(cate)) {
      if (v.size > LHC_LIMITS.banBoDanShuang_max) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${v.size} 项（限${LHC_LIMITS.banBoDanShuang_max}）`
        );
        result.maxScoreR25 = 15;
      }
    }

    // --- R25: 特码尾数 ≤ 5 ---
    if (isTeMaWeiShu(cate)) {
      const tails = extractTails(v);
      if (tails.size > LHC_LIMITS.teMaWeiShu_max) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${tails.size} 个尾数（限${LHC_LIMITS.teMaWeiShu_max}）`
        );
        result.maxScoreR25 = 15;
      }
    }

    // --- R25: 合肖 ≤ 4 ---
    if (isHeXiao(cate)) {
      const zodiacs = extractZodiacs(v);
      if (zodiacs.size > LHC_LIMITS.heXiao_maxZodiac) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${zodiacs.size} 个生肖（限${LHC_LIMITS.heXiao_maxZodiac}）`
        );
        result.maxScoreR25 = 15;
      }
    }

    // --- R25: 五行 ≤ 2 ---
    if (isWuXing(cate)) {
      if (v.size > LHC_LIMITS.wuXing_maxElement) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${v.size} 个元素（限${LHC_LIMITS.wuXing_maxElement}）`
        );
        result.maxScoreR25 = 15;
      }
    }

    // --- R25: 一肖 ≤ 3 ---
    if (isYiXiao(cate)) {
      const zodiacs = extractZodiacs(v);
      logger.debug(
        { lotteryName, issue, cate, values: [...v], zodiacs: [...zodiacs], count: zodiacs.size, limit: LHC_LIMITS.yiXiao_maxZodiac },
        '[六合彩] 一肖检测',
      );
      if (zodiacs.size > LHC_LIMITS.yiXiao_maxZodiac) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${zodiacs.size} 个生肖（限${LHC_LIMITS.yiXiao_maxZodiac}）`
        );
        result.maxScoreR25 = 15;
      }
    }

    // --- R25: 总肖 ≤ 2 ---
    if (isZongXiao(cate)) {
      const zodiacs = extractZodiacs(v);
      if (zodiacs.size > LHC_LIMITS.zongXiao_maxZodiac) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${zodiacs.size} 个生肖（限${LHC_LIMITS.zongXiao_maxZodiac}）`
        );
        result.maxScoreR25 = 15;
      }
    }

    // --- R25: 正特尾数 ≤ 4 ---
    if (isZhengTeWeiShu(cate)) {
      const tails = extractTails(v);
      if (tails.size > LHC_LIMITS.zhengTeWeiShu_max) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${tails.size} 个尾数（限${LHC_LIMITS.zhengTeWeiShu_max}）`
        );
        result.maxScoreR25 = 15;
      }
    }

    // --- R25: 连肖 ≤ 5 ---
    if (isLianXiao(cate)) {
      const zodiacs = extractZodiacs(v);
      if (zodiacs.size > LHC_LIMITS.lianXiao_maxZodiac) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${zodiacs.size} 个生肖（限${LHC_LIMITS.lianXiao_maxZodiac}）`
        );
        result.maxScoreR25 = 15;
      }
    }

    // --- R25: 连尾 ≤ 5 ---
    if (isLianWei(cate)) {
      const nums = extractNumbers(v);
      if (nums.size > LHC_LIMITS.lianWei_maxTail) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${nums.size} 个尾数（限${LHC_LIMITS.lianWei_maxTail}）`
        );
        result.maxScoreR25 = 15;
      }
    }

    // --- R25: 特肖 ≤ 6 ---
    if (isTeXiao(cate)) {
      const zodiacs = extractZodiacs(v);
      if (zodiacs.size > LHC_LIMITS.teXiao_maxZodiac) {
        result.coverageViolations.push(
          `${lotteryName} ${issue} ${cate}：${zodiacs.size} 个生肖（限${LHC_LIMITS.teXiao_maxZodiac}）`
        );
        result.maxScoreR25 = 15;
      }
    }
  }

  // --- R24: 半波跨色全包检测 ---
  const colorItems = new Map<string, Set<string>>();
  for (const [cate, entry] of cateMap) {
    for (const color of ['红波', '蓝波', '绿波']) {
      if (!cate.includes('半波') || !cate.includes(color)) continue;
      const set = colorItems.get(color) || new Set<string>();
      for (const val of entry.values) set.add(val);
      for (const val of entry.numbersSet) set.add(val);
      colorItems.set(color, set);
    }
  }

  if (colorItems.size >= 2) {
    const fullColors: string[] = [];
    for (const [color, items] of colorItems) {
      const pairs = BANBO_PAIRS[color];
      if (pairs && pairs.some(([a, b]) => items.has(a) && items.has(b))) {
        fullColors.push(color);
      }
    }
    if (fullColors.length >= 2) {
      result.coverageViolations.push(
        `${lotteryName} ${issue} 半波：${fullColors.join('、')}全包（${fullColors.length}个波色，限1）`
      );
      result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
    }
  }

  return result;
}

// ============================================================
// 主入口
// ============================================================

export function checkLiuHeCai(bets: BetRecord[]): CheckResult {
  return runChecker(bets, /六合彩|6合彩/, 'LHC', checkIssueGroup);
}
