/**
 * 六合彩系列注单违规判定引擎
 *
 * 覆盖所有玩法：特码、平特、特肖、两面、正码1-6、正特(1-6)、半波(红/蓝/绿)、
 * 尾数(全尾/特尾)、不中、六肖(连中/连不中)、连肖(二/三/四连)、连尾(二/三/四连)、
 * 龙虎、五行、合肖
 *
 * 判定分为两大类：
 * - R24（对打/互斥）：两面互斥、波色互斥、半波同色互斥 等
 * - R25（覆盖超限）：同金额号码数、跨金额号码总数、生肖数、尾数 等
 */

import type { BetRecord } from './types';
import { logger } from './logger';

// ============================================================
// 基础类型
// ============================================================

export interface LHCCheckResult {
  /** R24 类违规描述（对打/互斥），每项是一个独立的违规说明 */
  twoSideViolations: string[];
  /** R25 类违规描述（覆盖超限），每项是一个独立的违规说明 */
  coverageViolations: string[];
  /** 格式化后的违规详情文本（用于通知展示） */
  periodInfo: string;
  /** R24 最高分 */
  maxScoreR24: number;
  /** R25 最高分 */
  maxScoreR25: number;
}

function emptyResult(): LHCCheckResult {
  return { twoSideViolations: [], coverageViolations: [], periodInfo: '', maxScoreR24: 0, maxScoreR25: 0 };
}

// ============================================================
// 可配置限制常量（后期可随意修改）
// ============================================================

export const LHC_LIMITS = {
  /** 【1】特码：同金额最多下注号码数 */
  teMa_sameAmtMax: 20,
  /** 【1】特码：不同金额最多下注号码数 */
  teMa_totalMax: 32,

  /** 【2】平特：最多投注生肖数 */
  pingTe_maxZodiac: 3,

  /** 【3】特肖：最多下注生肖数 */
  teXiao_maxZodiac: 6,

  /** 【6】正特：同金额最多下注号码数 */
  zhengTe_sameAmtMax: 20,
  /** 【6】正特：不同金额最多下注号码数 */
  zhengTe_totalMax: 32,

  /** 【7】半波：同期总投注条目数上限 */
  banBo_maxItems: 6,

  /** 【8】尾数-全尾：最多投注尾数 */
  weiShu_quanWeiMax: 4,
  /** 【8】尾数-特尾：最多投注尾数 */
  weiShu_teWeiMax: 5,
  /** 【8】尾数-跨组合并：最多尾数（0 表示不检查跨组） */
  weiShu_crossMax: 0,

  /** 【10】六肖：最多投注生肖数 */
  liuXiao_maxZodiac: 6,

  /** 【11】连肖：最多投注生肖数 */
  lianXiao_maxZodiac: 4,

  /** 【12】连尾：最多投注尾数 */
  lianWei_maxTail: 5,

  /** 【14】五行：最多投注元素数 */
  wuXing_maxElement: 2,

  /** 【15】合肖：最多下注生肖数 */
  heXiao_maxZodiac: 4,
};

// ============================================================
// 常量
// ============================================================

/** 两面互斥对（同一组中不能同时出现） */
const TWO_SIDE_MUTEX: [string, string][] = [
  ['单', '双'],
  ['大', '小'],
  ['合单', '合双'],
  ['家禽', '野兽'],
  ['尾大', '尾小'],
];

const COLOR_SET = new Set(['红波', '蓝波', '绿波']);

/** 半波同色内部互斥对 */
/** 半波全包互补对：每一对合起来覆盖该波色全部号码 */
const BANBO_FULL_COVER_PAIRS: Record<string, [string, string][]> = {
  '红波': [['红单', '红双'], ['红大', '红小'], ['红合单', '红合双']],
  '蓝波': [['蓝单', '蓝双'], ['蓝大', '蓝小'], ['蓝合单', '蓝合双']],
  '绿波': [['绿单', '绿双'], ['绿大', '绿小'], ['绿合单', '绿合双']],
};


// ============================================================
// 工具函数
// ============================================================

function parseNum(n: string | number | undefined | null): number {
  return parseFloat(String(n || '0')) || 0;
}

/** 检查两面互斥：返回第一个冲突对描述，无冲突返回 null */
function checkTwoSideMutex(attrs: string[]): string | null {
  const set = new Set(attrs);
  for (const [a, b] of TWO_SIDE_MUTEX) {
    if (set.has(a) && set.has(b)) return `${a}↔${b}（${a}${b}对打）`;
  }
  const colors = attrs.filter(a => COLOR_SET.has(a));
  if (new Set(colors).size >= 2) return `${[...new Set(colors)].join('↔')}（多波色）`;
  return null;
}

// ============================================================
// 解析函数
// ============================================================

function parseTeMaNumbers(numbers: string): string[] {
  const m = numbers.match(/^特码-(.+)$/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

function parsePingTeZodiacs(numbers: string): string[] {
  const m = numbers.match(/^平特-(.+)$/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

function parseTeXiaoZodiacs(numbers: string): string[] {
  const m = numbers.match(/^特肖-(.+)$/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

function parseTwoSideAttrs(numbers: string): string[] {
  const m = numbers.match(/^特码两面-(.+)$/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

/** 解析 正码1-6 的 numbers，按正码位置分组（每个正码X为独立子类） */
function parseZhengMa16ByPosition(numbers: string): Map<string, string[]> {
  const posMap = new Map<string, string[]>();
  // 匹配每个 "正码X-..." 片段，[^正]* 保证不跨到下一个正码前缀
  const regex = /正码([一二三四五六])-([^正]*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(numbers)) !== null) {
    const pos = `正码${match[1]}`;
    const attrs = match[2].split(',').map(s => s.trim()).filter(Boolean);
    if (attrs.length > 0) {
      posMap.set(pos, attrs);
    }
  }
  return posMap;
}

/** 解析 正X特 的 numbers */
function parseZhengTe(numbers: string, prefix: string): { attrs: string[]; nums: string[] } {
  // 示例: "正1特两面-单,大,尾小,红波,正1特-05,12,38"
  //       "正6特两面-单"
  //       "正1特-05,06,07"

  const allAttrs: string[] = [];
  const allNums: string[] = [];

  // 1. 提取两面属性：匹配 "正X特两面-" 后面的内容（到下一个 "正X特" 前缀或结尾）
  const twoSideMatch = numbers.match(new RegExp(`${prefix}两面-(.+?)(?=,${prefix}-|$)`));
  if (twoSideMatch) {
    allAttrs.push(...twoSideMatch[1].split(',').map(s => s.trim()).filter(Boolean));
  }

  // 2. 提取号码：匹配 "正X特-" 后面紧跟数字的部分（排除 "正X特两面-"）
  //    用负向前瞻排除 "两面" 前缀
  const numMatch = numbers.match(new RegExp(`${prefix}-(?!两面)(\\d[\\d,]*)`));
  if (numMatch) {
    for (const p of numMatch[1].split(',')) {
      const t = p.trim();
      if (/^\d{1,2}$/.test(t)) {
        allNums.push(t);
      }
    }
  }

  return { attrs: [...new Set(allAttrs)], nums: [...new Set(allNums)] };
}

function parseBanBoAttrs(numbers: string, playClassName: string): string[] {
  const m = numbers.match(new RegExp(`^${playClassName}-(.+)$`));
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

function parseWeiShu(numbers: string): string[] {
  const m = numbers.match(/[全特]尾-(.+)$/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

function parseLiuXiaoZodiacs(numbers: string): string[] {
  const m = numbers.match(/六肖[连中连不中]+-(.+)$/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

function parseLianXiaoZodiacs(numbers: string): string[] {
  const m = numbers.match(/[二三四]连肖[^(]*\([中不]+\)-(.+)$/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

/** 【12】连尾 - "三连尾(中)-1尾,3尾,5尾" */
function parseLianWei(numbers: string): string[] {
  const m = numbers.match(/[二三四]连尾[^(]*\([中不]+\)-(.+)$/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

/** 【13】龙虎 - "龙-1-2球,1-5球,虎-2-4球,5-6球" → { dragon: [...], tiger: [...] } */
function parseLongHu(numbers: string): { dragon: string[]; tiger: string[] } {
  const parts = numbers.split(',').map(s => s.trim());
  const dragon: string[] = [];
  const tiger: string[] = [];
  for (const p of parts) {
    if (p.startsWith('龙-')) {
      dragon.push(p.replace(/^龙-/, '').trim());
    } else if (p.startsWith('虎-')) {
      tiger.push(p.replace(/^虎-/, '').trim());
    }
  }
  return { dragon, tiger };
}

/** 【14】五行 - "五行-金,水" */
function parseWuXing(numbers: string): string[] {
  const m = numbers.match(/^五行-(.+)$/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

/** 【15】合肖 - "三合肖-鼠,牛,虎" */
function parseHeXiao(numbers: string): string[] {
  const m = numbers.match(/^[一二三四五六七八九十]+合肖-(.+)$/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

/** 同金额分组键（保留 2 位小数） */
function amtKey(amount: number): string {
  return amount.toFixed(2);
}

// ============================================================
// 各玩法判定函数
// ============================================================

/**
 * 【1】特码
 * - 单注金额 = amount / (号码个数 + 1)
 * - 同金额号码 > 20 → R25
 * - 全部号码 > 32 → R25
 */
function checkTeMa(group: BetRecord[], lotteryName: string, issue: string): LHCCheckResult {
  const result = emptyResult();
  const items: { num: string; amt: number }[] = [];

  for (const b of group) {
    const nums = parseTeMaNumbers(b.numbers || '');
    const totalAmt = parseNum(b.amount);
    if (nums.length === 0) continue;
    const perAmt = totalAmt / (nums.length + 1); // 分母 +1
    for (const n of nums) {
      items.push({ num: n, amt: perAmt });
    }
  }
  if (items.length === 0) return result;

  // 按同金额分组（每组内去重，同一号码下多注不重复计数）
  const amtGroups = new Map<string, Set<string>>();
  for (const item of items) {
    const k = amtKey(item.amt);
    const set = amtGroups.get(k) || new Set<string>();
    set.add(item.num);
    amtGroups.set(k, set);
  }

  for (const [amt, nums] of amtGroups) {
    if (nums.size > LHC_LIMITS.teMa_sameAmtMax) {
      result.coverageViolations.push(
        `${lotteryName} ${issue} 特码：同金额 ${parseFloat(amt).toFixed(2)} 覆盖 ${nums.size} 个号码（限${LHC_LIMITS.teMa_sameAmtMax}）`
      );
      result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
    }
  }

  const totalNums = new Set(items.map(i => i.num));
  if (totalNums.size > LHC_LIMITS.teMa_totalMax) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 特码：不同金额共覆盖 ${totalNums.size} 个号码（限${LHC_LIMITS.teMa_totalMax}）`
    );
    result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
  }

  return result;
}

/**
 * 【2】平特 - 生肖数 > 3 → R25
 */
function checkPingTe(group: BetRecord[], lotteryName: string, issue: string): LHCCheckResult {
  const result = emptyResult();
  const zodiacs = new Set<string>();
  for (const b of group) {
    for (const z of parsePingTeZodiacs(b.numbers || '')) {
      zodiacs.add(z);
    }
  }
  if (zodiacs.size > LHC_LIMITS.pingTe_maxZodiac) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 平特：${zodiacs.size} 个生肖（限${LHC_LIMITS.pingTe_maxZodiac}）`
    );
    result.maxScoreR25 = 15;
  }
  return result;
}

/**
 * 【3】特肖 - 生肖数 > 6 → R25
 */
function checkTeXiao(group: BetRecord[], lotteryName: string, issue: string): LHCCheckResult {
  const result = emptyResult();
  const zodiacs = new Set<string>();
  for (const b of group) {
    for (const z of parseTeXiaoZodiacs(b.numbers || '')) {
      zodiacs.add(z);
    }
  }
  if (zodiacs.size > LHC_LIMITS.teXiao_maxZodiac) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 特肖：${zodiacs.size} 个生肖（限${LHC_LIMITS.teXiao_maxZodiac}）`
    );
    result.maxScoreR25 = 15;
  }
  return result;
}

/**
 * 【4】两面 - 互斥检查 → R24
 */
function checkTwoSides(group: BetRecord[], lotteryName: string, issue: string): LHCCheckResult {
  const result = emptyResult();
  const allAttrs: string[] = [];
  for (const b of group) {
    allAttrs.push(...parseTwoSideAttrs(b.numbers || ''));
  }
  const mutex = checkTwoSideMutex(allAttrs);
  if (mutex) {
    result.twoSideViolations.push(
      `${lotteryName} ${issue} 两面 ${mutex}`
    );
    result.maxScoreR24 = 40;
  }
  return result;
}

/**
 * 【5】正码1-6 - 每个正码X位置独立做互斥检查 → R24
 * 规则：每个正码X（一~六）视为独立子类，子类内部单/双、大/小等不能同时出现，
 *       不同位置之间不互斥（如正码一-单 和 正码二-双 是合法的）。
 */
function checkZhengMa16(group: BetRecord[], lotteryName: string, issue: string): LHCCheckResult {
  const result = emptyResult();

  // 收集每个正码位置的所有属性（跨注单合并）
  const posAttrs = new Map<string, Set<string>>();
  for (const b of group) {
    const parsed = parseZhengMa16ByPosition(b.numbers || '');
    for (const [pos, attrs] of parsed) {
      const set = posAttrs.get(pos) || new Set<string>();
      for (const a of attrs) set.add(a);
      posAttrs.set(pos, set);
    }
  }

  // 每个位置独立做互斥检查
  for (const [pos, attrs] of posAttrs) {
    const mutex = checkTwoSideMutex([...attrs]);
    if (mutex) {
      result.twoSideViolations.push(
        `${lotteryName} ${issue} 正码1-6 ${pos} ${mutex}`
      );
      result.maxScoreR24 = 40;
    }
  }

  return result;
}

/**
 * 【6】正特（正1特～正6特）
 * - 同金额项数 > 20 → R25
 * - 总项数 > 32 → R25
 * - 两面互斥 → R24
 */
function checkZhengTe(
  group: BetRecord[], lotteryName: string, issue: string,
  playClassName: string,
): LHCCheckResult {
  const result = emptyResult();
  const prefix = playClassName; // 正1特, 正2特, ...
  const allItems: { val: string; amt: number }[] = [];

  for (const b of group) {
    const { attrs, nums } = parseZhengTe(b.numbers || '', prefix);
    const totalItems = attrs.length + nums.length;
    if (totalItems === 0) continue;
    const perAmt = parseNum(b.amount) / totalItems;

    // 两面互斥检查（仅属性部分）
    const mutex = checkTwoSideMutex(attrs);
    if (mutex) {
      result.twoSideViolations.push(
        `${lotteryName} ${issue} ${playClassName} ${mutex}`
      );
      result.maxScoreR24 = 40;
    }

    for (const a of attrs) allItems.push({ val: a, amt: perAmt });
    for (const n of nums) allItems.push({ val: n, amt: perAmt });
  }

  if (allItems.length === 0) return result;

  // 按同金额分组（每组内去重，同号码/属性多注不重复计数）
  const amtGroups = new Map<string, Set<string>>();
  for (const item of allItems) {
    const k = amtKey(item.amt);
    const set = amtGroups.get(k) || new Set<string>();
    set.add(item.val);
    amtGroups.set(k, set);
  }

  for (const [amt, vals] of amtGroups) {
    if (vals.size > LHC_LIMITS.zhengTe_sameAmtMax) {
      result.coverageViolations.push(
        `${lotteryName} ${issue} ${playClassName}：同金额 ${parseFloat(amt).toFixed(2)} 覆盖 ${vals.size} 项（限${LHC_LIMITS.zhengTe_sameAmtMax}）`
      );
      result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
    }
  }

  const uniqueItems = [...new Set(allItems.map(i => `${i.val}|${amtKey(i.amt)}`))];
  if (uniqueItems.length > LHC_LIMITS.zhengTe_totalMax) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} ${playClassName}：不同金额共覆盖 ${uniqueItems.length} 项（限${LHC_LIMITS.zhengTe_totalMax}）`
    );
    result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
  }

  return result;
}

/**
 * 【7】半波 - 跨色合并检测
 * 违规条件（满足任一）：
 *   1. 三个波色投注项总数 > 6
 *   2. ≥2 个波色全包（同一波色内任一互补对均被投注即为全包）
 */
function checkBanBoCombined(
  allBanBoBets: BetRecord[], lotteryName: string, issue: string,
): LHCCheckResult {
  const result = emptyResult();

  // 按波色分组，收集各色唯一投注项
  const colorItems = new Map<string, Set<string>>();
  for (const b of allBanBoBets) {
    const color = b.playClassName || '';
    if (!['红波', '蓝波', '绿波'].includes(color)) continue;
    const set = colorItems.get(color) || new Set<string>();
    for (const attr of parseBanBoAttrs(b.numbers || '', color)) {
      set.add(attr);
    }
    colorItems.set(color, set);
  }

  // 条件1：总投注项数 > 6（去重后）
  let totalItems = 0;
  for (const items of colorItems.values()) {
    totalItems += items.size;
  }
  if (totalItems > LHC_LIMITS.banBo_maxItems) {
    const details: string[] = [];
    for (const [color, items] of colorItems) {
      if (items.size > 0) details.push(`${color}:${[...items].join(',')}`);
    }
    result.coverageViolations.push(
      `${lotteryName} ${issue} 半波：${totalItems} 项（限${LHC_LIMITS.banBo_maxItems}）${details.join('；')}`
    );
    result.maxScoreR25 = Math.max(result.maxScoreR25, 15);
  }

  // 条件2：≥2 个波色全包
  const fullColors: string[] = [];
  for (const [color, items] of colorItems) {
    const pairs = BANBO_FULL_COVER_PAIRS[color];
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

  return result;
}

/**
 * 【8】尾数 - 组内限制 + 跨组限制
 * 返回空结果（跨组检查在 checkWeiShuCrossGroup 中处理）
 */
function checkWeiShuGroup(
  group: BetRecord[], lotteryName: string, issue: string,
  playClassName: string,
): { tails: string[]; groupViolation: string | null } {
  const tails = new Set<string>();
  for (const b of group) {
    for (const t of parseWeiShu(b.numbers || '')) {
      tails.add(t);
    }
  }

  const limit = playClassName === '全尾' ? LHC_LIMITS.weiShu_quanWeiMax : LHC_LIMITS.weiShu_teWeiMax;
  const violation = tails.size > limit
    ? `${lotteryName} ${issue} ${playClassName}：${tails.size} 个尾数（限${limit}）`
    : null;

  return { tails: [...tails], groupViolation: violation };
}

/**
 * 【8】尾数 - 跨组限制（同一 lotteryName+issue 下所有尾数玩法合并）
 * 仅当 LHC_LIMITS.weiShu_crossMax > 0 时检查
 */
function checkWeiShuCrossGroup(
  lotteryName: string, issue: string,
  allTails: string[],
): string | null {
  if (LHC_LIMITS.weiShu_crossMax <= 0) return null;
  const uniq = [...new Set(allTails)];
  if (uniq.length > LHC_LIMITS.weiShu_crossMax) {
    return `${lotteryName} ${issue} 尾数合并：${uniq.length} 个尾数（限${LHC_LIMITS.weiShu_crossMax}）`;
  }
  return null;
}

/**
 * 【9】不中 - 永远合规，不做任何检查
 */

/**
 * 【10】六肖 - 生肖数 > 6 → R25
 */
function checkLiuXiao(group: BetRecord[], lotteryName: string, issue: string, playClassName: string): LHCCheckResult {
  const result = emptyResult();
  const zodiacs = new Set<string>();
  for (const b of group) {
    for (const z of parseLiuXiaoZodiacs(b.numbers || '')) {
      zodiacs.add(z);
    }
  }
  if (zodiacs.size > LHC_LIMITS.liuXiao_maxZodiac) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} ${playClassName}：${zodiacs.size} 个生肖（限${LHC_LIMITS.liuXiao_maxZodiac}）`
    );
    result.maxScoreR25 = 15;
  }
  return result;
}

/**
 * 【11】连肖 - 生肖数 > 对应玩法上限
 * 二连肖 ≤ 4, 三连肖 ≤ 4, 四连肖 ≤ 4（按现有规则统一4）
 */
function checkLianXiao(group: BetRecord[], lotteryName: string, issue: string, playClassName: string): LHCCheckResult {
  const result = emptyResult();
  const zodiacs = new Set<string>();
  for (const b of group) {
    for (const z of parseLianXiaoZodiacs(b.numbers || '')) {
      zodiacs.add(z);
    }
  }
  if (zodiacs.size > LHC_LIMITS.lianXiao_maxZodiac) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 连肖${playClassName}：${zodiacs.size} 个生肖（限${LHC_LIMITS.lianXiao_maxZodiac}）`
    );
    result.maxScoreR25 = 15;
  }
  return result;
}

/**
 * 【12】连尾 - 尾数个数 > 5 → R25
 * playClassName: 二连尾(中/不中), 三连尾(中/不中), 四连尾(中/不中)
 */
function checkLianWei(group: BetRecord[], lotteryName: string, issue: string, playClassName: string): LHCCheckResult {
  const result = emptyResult();
  const tails = new Set<string>();
  for (const b of group) {
    for (const t of parseLianWei(b.numbers || '')) {
      tails.add(t);
    }
  }
  if (tails.size > LHC_LIMITS.lianWei_maxTail) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 连尾${playClassName}：${tails.size} 个尾数（限${LHC_LIMITS.lianWei_maxTail}）`
    );
    result.maxScoreR25 = 15;
  }
  return result;
}

/**
 * 【13】龙虎 - 龙虎球号交集非空 → R24（对打）
 * playClassName: "1-6龙虎"
 */
function checkLongHu(group: BetRecord[], lotteryName: string, issue: string): LHCCheckResult {
  const result = emptyResult();
  const allDragon = new Set<string>();
  const allTiger = new Set<string>();
  for (const b of group) {
    const { dragon, tiger } = parseLongHu(b.numbers || '');
    for (const d of dragon) allDragon.add(d);
    for (const t of tiger) allTiger.add(t);
  }
  // 取交集
  const intersection: string[] = [];
  for (const d of allDragon) {
    if (allTiger.has(d)) intersection.push(d);
  }
  if (intersection.length > 0) {
    result.twoSideViolations.push(
      `${lotteryName} ${issue} 龙虎 球号${intersection.join('、')} 龙虎对打`
    );
    result.maxScoreR24 = 40;
  }
  return result;
}

/**
 * 【14】五行 - 元素个数 > 2 → R25
 */
function checkWuXing(group: BetRecord[], lotteryName: string, issue: string): LHCCheckResult {
  const result = emptyResult();
  const elements = new Set<string>();
  for (const b of group) {
    for (const e of parseWuXing(b.numbers || '')) {
      elements.add(e);
    }
  }
  if (elements.size > LHC_LIMITS.wuXing_maxElement) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 五行：${elements.size} 个元素（限${LHC_LIMITS.wuXing_maxElement}）`
    );
    result.maxScoreR25 = 15;
  }
  return result;
}

/**
 * 【15】合肖 - 生肖个数 > 4 → R25
 * playClassName: 二合肖 ~ 十一合肖
 */
function checkHeXiao(group: BetRecord[], lotteryName: string, issue: string, playClassName: string): LHCCheckResult {
  const result = emptyResult();
  const zodiacs = new Set<string>();
  for (const b of group) {
    for (const z of parseHeXiao(b.numbers || '')) {
      zodiacs.add(z);
    }
  }
  if (zodiacs.size > LHC_LIMITS.heXiao_maxZodiac) {
    result.coverageViolations.push(
      `${lotteryName} ${issue} 合肖${playClassName}：${zodiacs.size} 个生肖（限${LHC_LIMITS.heXiao_maxZodiac}）`
    );
    result.maxScoreR25 = 15;
  }
  return result;
}

// ============================================================
// 主入口
// ============================================================

/**
 * 对一批 BetRecord 做六合彩违规检查。
 * 外部需先过滤 lotteryName 包含 "六合彩"。
 * 返回值中 twoSideViolations 对应 R24，coverageViolations 对应 R25。
 */
export function checkLiuHeCai(bets: BetRecord[]): LHCCheckResult {
  if (!bets || bets.length === 0) return emptyResult();

  // 1. 过滤六合彩相关
  const lhcBets = bets.filter(b => /六合彩|6合彩/.test(b.lotteryName || ''));
  if (lhcBets.length === 0) return emptyResult();

  // 2. 按 (lotteryName, issue) 分组
  const issueMap = new Map<string, BetRecord[]>();
  for (const b of lhcBets) {
    const key = `${b.lotteryName || ''}:::${b.issue || ''}`;
    const arr = issueMap.get(key) || [];
    arr.push(b);
    issueMap.set(key, arr);
  }

  // 3. 汇总结果
  const merged: LHCCheckResult = {
    twoSideViolations: [],
    coverageViolations: [],
    periodInfo: '',
    maxScoreR24: 0,
    maxScoreR25: 0,
  };

  const merge = (sub: LHCCheckResult) => {
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

    // 3b. 收集半波注单（跨色合并检测）
    const allBanBoBets: BetRecord[] = [];
    for (const [subKey, playBets] of playMap) {
      const [playName, playClassName] = subKey.split(':::');
      if (playName === '半波' && ['红波', '蓝波', '绿波'].includes(playClassName)) {
        allBanBoBets.push(...playBets);
      }
    }
    if (allBanBoBets.length > 0) {
      merge(checkBanBoCombined(allBanBoBets, lotteryName, issue));
    }

    // 3c. 收集尾数数据，用于跨组检查
    const allTailsForIssue: string[] = [];

    for (const [subKey, playBets] of playMap) {
      const [playName, playClassName] = subKey.split(':::');

      // 半波已在上方跨色合并处理，跳过逐色分发
      if (playName === '半波') continue;

      try {
        if (playName === '特码' && playClassName === '特码') {
          merge(checkTeMa(playBets, lotteryName, issue));
        } else if (playName === '平特' && playClassName === '平特') {
          merge(checkPingTe(playBets, lotteryName, issue));
        } else if (playName === '特肖' && playClassName === '特肖') {
          merge(checkTeXiao(playBets, lotteryName, issue));
        } else if (playName === '两面' && playClassName === '两面') {
          merge(checkTwoSides(playBets, lotteryName, issue));
        } else if (playName === '正码1-6' && playClassName === '正码1-6') {
          merge(checkZhengMa16(playBets, lotteryName, issue));
        } else if (playName === '正特' && /^正[1-6]特$/.test(playClassName)) {
          merge(checkZhengTe(playBets, lotteryName, issue, playClassName));
        } else if (playName === '尾数' && ['全尾', '特尾'].includes(playClassName)) {
          const { tails, groupViolation } = checkWeiShuGroup(playBets, lotteryName, issue, playClassName);
          allTailsForIssue.push(...tails);
          if (groupViolation) {
            merged.coverageViolations.push(groupViolation);
            merged.maxScoreR25 = Math.max(merged.maxScoreR25, 15);
          }
        } else if (playName === '不中') {
          // 【9】不中 - 永远合规
        } else if (playName === '六肖' && ['六肖连中', '六肖连不中'].includes(playClassName)) {
          merge(checkLiuXiao(playBets, lotteryName, issue, playClassName));
        } else if (playName === '连肖' && /^[二三四]连肖\([中不]+\)$/.test(playClassName)) {
          merge(checkLianXiao(playBets, lotteryName, issue, playClassName));
        } else if (playName === '连尾' && /^[二三四]连尾\([中不]+\)$/.test(playClassName)) {
          merge(checkLianWei(playBets, lotteryName, issue, playClassName));
        } else if (playName === '龙虎' && ['1-6龙虎'].includes(playClassName)) {
          merge(checkLongHu(playBets, lotteryName, issue));
        } else if (playName === '五行' && playClassName === '五行') {
          merge(checkWuXing(playBets, lotteryName, issue));
        } else if (playName === '合肖' && /^[一二三四五六七八九十]+合肖$/.test(playClassName)) {
          merge(checkHeXiao(playBets, lotteryName, issue, playClassName));
        }
        // 未匹配的玩法不做特殊处理，保持向后兼容
      } catch (err) {
        logger.warn(
          { lotteryName, issue, playName, playClassName, err: (err as Error).message },
          '[六合彩] 玩法判定异常，跳过该组',
        );
      }
    }

    // 3d. 尾数跨组检查
    if (allTailsForIssue.length > 0) {
      const crossViolation = checkWeiShuCrossGroup(lotteryName, issue, allTailsForIssue);
      if (crossViolation) {
        merged.coverageViolations.push(crossViolation);
        merged.maxScoreR25 = Math.max(merged.maxScoreR25, 15);
      }
    }
  }

  // 4. 拼接 periodInfo（格式化展示用）
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
