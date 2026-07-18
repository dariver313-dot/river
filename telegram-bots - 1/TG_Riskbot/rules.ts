/**
 * 风控规则定义
 *
 * 所有规则的 evaluate 函数都定义在此文件中。
 * 引擎逻辑（evaluateRules、缓存、handledRules 等）在 rule-engine.ts 中。
 */

import type { AccountChangeRecord, BetRecord, ThirdGameOrder, WithdrawalRecord, PaymentOrder } from './types';
import type { LoginAssociationSummary, RiskRule, RuleContext, RuleResult } from './rule-types';
import { checkLiuHeCai } from './lhc-checker';
import { checkShiShiCai } from './ssc-checker';
import { checkKuaiSan } from './k3-checker';
import { checkPK10 } from './pk10-checker';
import { parseTimeStr, absFloat, sum, extractProxyCode, formatBeijingTime, combineMemberRemarks } from './utils';
import { isAgentWhitelisted } from './constants';

// ============================================================
// 通用辅助函数
// ============================================================

const _defaultKeywords = ['套利', '刷子', '团伙', '同人', '代充', '代付', '黑名单', '风险', '异常', '冻结', '封号', '多号', '关联'];
function getSuspiciousKeywords(): string[] {
  const raw = process.env.RISK_REMARK_KEYWORDS;
  if (raw !== undefined && raw.trim() !== '') {
    return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
  }
  return _defaultKeywords;
}

const _proxyBlacklistCache = { value: '' as string, parsed: [] as string[] };
const STRONG_REMARK_KEYWORDS = new Set(['套利', '刷子', '团伙', '同人', '刷单', '对打', '代充', '代付', '黑名单', '冻结', '封号', '多号']);
function getProxyBlacklist(): string[] {
  const current = process.env.PROXY_BLACKLIST || '';
  if (current !== _proxyBlacklistCache.value) {
    _proxyBlacklistCache.value = current;
    _proxyBlacklistCache.parsed = current.split(',').map(s => s.trim()).filter(Boolean);
  }
  return _proxyBlacklistCache.parsed;
}

function formatRuleMoney(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  const fixed = amount.toFixed(2);
  return fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed.replace(/0+$/, '').replace(/\.$/, '');
}

// 平台 B 的 174 账变同时承载后台人工加款和“礼金/彩金”。
// 只有明确可识别为非彩金的人工加款才作为风控信号，避免把运营赠送误判为资金异常。
const BONUS_CREDIT_KEYWORDS = ['彩金', '礼金', '周卡', '救援', '转运', '推荐', '神秘', '生日', '活动', '红包', '奖励', '返利', '返水', '会员日'];
function isBonusCredit(change: AccountChangeRecord): boolean {
  const detail = [change.transDetail, change.transDesc, change.operatorRemark]
    .filter(Boolean)
    .join(' ');
  return BONUS_CREDIT_KEYWORDS.some(keyword => detail.includes(keyword));
}

function normalizeBetText(value: string | undefined): string {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function splitLotteryViolation(reason: string): { lotteryName: string; issue: string; play: string; problem: string } | null {
  const trimmed = reason.trim();
  const match = trimmed.match(/^(\S+)\s+(\S+)\s+(.+)$/);
  if (!match) return null;

  const [, lotteryName, issue, rest] = match;
  const colonIndex = rest.search(/[：:]/);
  if (colonIndex >= 0) {
    return {
      lotteryName,
      issue,
      play: rest.slice(0, colonIndex).trim(),
      problem: rest.slice(colonIndex + 1).trim(),
    };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return { lotteryName, issue, play: rest.trim(), problem: '玩法违规' };

  const problemIndex = tokens.findIndex((token, index) => index > 0 && /↔|对打|互斥|只能|限|覆盖|全包|规避/.test(token));
  if (problemIndex > 0) {
    return {
      lotteryName,
      issue,
      play: tokens.slice(0, problemIndex).join(' '),
      problem: tokens.slice(problemIndex).join(' '),
    };
  }

  return {
    lotteryName,
    issue,
    play: tokens[0],
    problem: tokens.slice(1).join(' '),
  };
}

function amountForViolation(bets: BetRecord[], lotteryName: string, issue: string, play: string): number {
  const sameIssue = bets.filter(b => String(b.lotteryName || '') === lotteryName && String(b.issue || '') === issue);
  const playKey = normalizeBetText(play);
  const playMatched = sameIssue.filter((b) => {
    const playClass = normalizeBetText(b.playClassName);
    const playName = normalizeBetText(b.playName);
    return (playClass && (playKey.includes(playClass) || playClass.includes(playKey))) ||
      (playName && (playKey.includes(playName) || playName.includes(playKey)));
  });
  const source = playMatched.length > 0 ? playMatched : sameIssue;
  return source.reduce((total, b) => total + (parseFloat(String(b.amount || 0)) || 0), 0);
}

function timeForViolation(bets: BetRecord[], lotteryName: string, issue: string): number {
  return bets
    .filter(b => String(b.lotteryName || '') === lotteryName && String(b.issue || '') === issue)
    .reduce((latest, bet) => Math.max(latest, parseTimeStr(bet.betTime)), 0);
}

function formatViolationDate(time: number): string {
  if (!time) return '';
  const local = new Date(time + 8 * 3600000);
  return `${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
}

function formatLotteryViolationReason(reason: string, bets: BetRecord[]): { text: string; time: number } {
  const parsed = splitLotteryViolation(reason);
  if (!parsed) return { text: reason.trim(), time: 0 };
  const amount = amountForViolation(bets, parsed.lotteryName, parsed.issue, parsed.play);
  const time = timeForViolation(bets, parsed.lotteryName, parsed.issue);
  const date = formatViolationDate(time);
  return {
    text: `${parsed.lotteryName} ${parsed.issue}${date ? ` ${date}` : ''} ${parsed.play} 金额${formatRuleMoney(amount)}：${parsed.problem}`,
    time,
  };
}

function formatLotteryViolationReasons(reasons: string[], bets: BetRecord[]): string[] {
  return reasons
    .map(reason => formatLotteryViolationReason(reason, bets))
    .sort((a, b) => b.time - a.time)
    .map(item => item.text);
}

export function extractTwoSideDirection(numbers: string): string | null {
  if (!numbers) return null;
  const n = numbers.trim();
  const twoSide = n.match(/两面[-_]([大小单双])/);
  if (twoSide) return twoSide[1];
  if (n.includes('总大') || n.includes('总小')) return n.includes('总大') ? '总大' : '总小';
  if (n.includes('总单') || n.includes('总双')) return n.includes('总单') ? '总单' : '总双';
  if (n.includes('大') && n.includes('小')) return '大+小';
  if (n.includes('单') && n.includes('双')) return '单+双';
  const singleDir = n.match(/(大|小|单|双)/);
  if (singleDir) return singleDir[1];
  const colorMatch = n.match(/(红|蓝|绿)/);
  if (colorMatch) return colorMatch[1];
  const longHuMatch = n.match(/(龙|虎|和)/);
  if (longHuMatch) return longHuMatch[1];
  const guanYaMatch = n.match(/(冠|亚)/);
  if (guanYaMatch) return guanYaMatch[1];
  const niuNiuMatch = n.match(/牛([一二三四五六七八九十])/);
  if (niuNiuMatch) return `牛${niuNiuMatch[1]}`;
  if (n.includes('庄') || n.includes('闲')) { if (n.includes('庄')) return '庄'; if (n.includes('闲')) return '闲'; }
  return null;
}

export function expandDirections(dir: string | null): string[] {
  if (!dir) return [];
  if (dir === '大+小') return ['大', '小'];
  if (dir === '单+双') return ['单', '双'];
  return [dir];
}

const MUTEX_PAIRS: [string, string][] = [
  ['大', '小'], ['单', '双'], ['红', '蓝'], ['红', '绿'], ['蓝', '绿'],
  ['龙', '虎'], ['庄', '闲'], ['总大', '总小'], ['总单', '总双'],
];
const MUTEX_MAP = new Map<string, Set<string>>();
for (const [a, b] of MUTEX_PAIRS) {
  let s = MUTEX_MAP.get(a); if (!s) { s = new Set<string>(); MUTEX_MAP.set(a, s); } s.add(b);
  s = MUTEX_MAP.get(b); if (!s) { s = new Set<string>(); MUTEX_MAP.set(b, s); } s.add(a);
}

export function isMutexDirection(dir1: string | null, dir2: string | null): boolean {
  if (!dir1 || !dir2 || dir1 === dir2) return false;
  const s = MUTEX_MAP.get(dir1);
  return s ? s.has(dir2) : false;
}

const CHANNEL_ALIASES: [RegExp, string][] = [
  [/ABpay内嵌划转/i, 'ABpay'],
  [/ABpay内嵌下单/i, 'ABpay'],
  [/ABPAY划转/i, 'ABpay'],
  [/988PAY/i, '988pay'],
  [/C币支付/i, 'CBpay'],
  [/JD钱包/i, 'JDPAY'],
  [/K豆支付/i, 'KDpay'],
  [/OKpay/i, 'OKpay'],
  [/CBpay/i, 'CBpay'],
  [/USDT/i, 'USDT'],
];

const ASSOCIATION_DISPLAY_LIMIT = 8;

function normalizeChannel(name: string): string {
  for (const [pattern, canonical] of CHANNEL_ALIASES) {
    if (pattern.test(name)) return canonical;
  }
  return name;
}

function formatWithdrawChannel(raw: string | undefined, normalized: string): string {
  const value = String(raw || normalized || '').trim();
  const key = value.toLowerCase().replace(/\s+/g, '');
  const displayMap: Record<string, string> = {
    alipay: '支付宝',
    wechat: '微信',
    wx: '微信',
    bank: '银行卡',
    unionpay: '云闪付',
    jdpay: 'JDpay',
    abpay: 'ABpay',
    cbpay: 'CBpay',
    kdpay: 'KDpay',
    usdt: 'USDT',
  };
  return displayMap[key] || value || '未知';
}

function ipAssociationScore(count: number, maxScore: number): { triggered: boolean; score: number; label: string } {
  if (count < 2) return { triggered: false, score: 0, label: '' };
  if (count === 2) return { triggered: true, score: 5, label: '同IP2人' };
  if (count <= 20) return { triggered: true, score: maxScore, label: `小群体(${count}人)` };
  if (count <= 100) return { triggered: true, score: Math.round(maxScore * 0.5), label: `中群体(${count}人)` };
  if (count <= 500) return { triggered: true, score: Math.round(maxScore * 0.2), label: `大群体(${count}人)` };
  return { triggered: false, score: 0, label: `公共出口(${count}人)` };
}

function deviceAssociationScore(count: number, maxScore: number): { triggered: boolean; score: number; label: string } {
  if (count < 2) return { triggered: false, score: 0, label: '' };
  if (count <= 5) return { triggered: true, score: maxScore, label: `同设备${count}人` };
  if (count <= 20) return { triggered: true, score: Math.round(maxScore * 0.6), label: `同设备${count}人` };
  if (count <= 100) return { triggered: true, score: Math.round(maxScore * 0.2), label: `疑似公共设备${count}人` };
  return { triggered: false, score: 0, label: `公共设备(${count}人)` };
}

function pickTopAssociation(
  summaries: LoginAssociationSummary[] | undefined,
  scorer: (count: number, maxScore: number) => { triggered: boolean; score: number; label: string },
  maxScore: number,
): { summary: LoginAssociationSummary; score: number; label: string } | null {
  const candidates = (summaries || [])
    .map(summary => ({ summary, result: scorer(summary.accountCount, maxScore) }))
    .filter(item => item.result.triggered)
    .sort((a, b) => b.result.score - a.result.score || a.summary.accountCount - b.summary.accountCount);
  const top = candidates[0];
  return top ? { summary: top.summary, score: top.result.score, label: top.result.label } : null;
}

function formatAssociationReason(prefix: string, value: string, summary: LoginAssociationSummary): string {
  const display = summary.otherMemberNames.slice(0, ASSOCIATION_DISPLAY_LIMIT);
  const hidden = Math.max(0, summary.otherMemberNames.length - display.length);
  const suffix = hidden > 0 ? `，另有${hidden}个隐藏` : '';
  const otherText = display.length > 0 ? `，其他账号：${display.join(' ')}${suffix}` : '';
  const fetched = summary.fetchedCount ?? summary.memberNames.length;
  const total = summary.totalCount ?? fetched;
  const truncatedText = summary.truncated && total > fetched ? `，仅查前${fetched}条/共${total}条登录` : '';
  return `${prefix} ${value} 共${summary.accountCount}个账号${otherText}${truncatedText}`;
}

function formatDevice(value: string): string {
  const separator = value.indexOf(':');
  if (separator < 0) return value;
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (id.length <= 12) return value;
  return `${type}:${id.slice(0, 6)}...${id.slice(-4)}`;
}

// ============================================================
// 已审核期号过滤（供 R24/R25 使用）
// ============================================================

function filterBetsByPeriods(bets: BetRecord[], excludedPeriods: Set<string>): BetRecord[] {
  if (excludedPeriods.size === 0) return bets;
  return bets.filter(b => {
    const baseKey = `${b.lotteryName || ''}:::${b.issue || ''}`;
    const fullKey = `${baseKey}:::${b.playClassName || ''}`;
    return !excludedPeriods.has(fullKey) && !excludedPeriods.has(baseKey);
  });
}

function getUnreviewedBets(ctx: RuleContext): BetRecord[] {
  const bets = ctx.bets || [];
  const excluded = ctx.reviewedPeriodKeys;
  if (!excluded || excluded.size === 0) return bets;
  return filterBetsByPeriods(bets, excluded);
}

/** R26 使用预分组投注，仍需排除已经审核过的彩种/期号/玩法。 */
function getUnreviewedIssueGroups(ctx: RuleContext): Map<string, BetRecord[]> {
  const issueGroups = ctx.issueGroups || new Map<string, BetRecord[]>();
  const excluded = ctx.reviewedPeriodKeys;
  if (!excluded || excluded.size === 0) return issueGroups;

  const filtered = new Map<string, BetRecord[]>();
  for (const [key, group] of issueGroups) {
    const remaining = filterBetsByPeriods(group, excluded);
    if (remaining.length > 0) filtered.set(key, remaining);
  }
  return filtered;
}

// ============================================================
// 规则定义
// ============================================================

export const rules: RiskRule[] = [

  // ============================================================
  // 身份风险 (identity)
  // ============================================================

  {
    id: 'R01',
    name: '新账号大额提现',
    description: '新注册账号短期内申请大额提现（梯度评分）',
    severity: 'CRITICAL',
    weight: 40,
    group: 'identity',
    enabled: false,
    precondition(ctx: RuleContext): boolean {
      const amount = parseFloat(String(ctx.order?.amount)) || 0;
      return amount > 5000;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const member = ctx.member;
      const order = ctx.order;
      const regTime = parseTimeStr(member?.createTime || member?.createdAt);
      if (!regTime || !order?.amount) return { triggered: false, score: 0 };

      const orderTime = parseTimeStr(
        order?.createTime || (order as Record<string, unknown>)?.createdAt as string | number | undefined,
      ) || Date.now();
      const hoursSinceReg = Math.max(0, (orderTime - regTime) / 3600000);
      const amount = parseFloat(String(order.amount)) || 0;
      const hasBet = absFloat(member?.sumBet) > 0;

      let score = 0;
      let reason = '';
      if (hoursSinceReg < 6 && !hasBet) { score = 40; reason = `注册 ${hoursSinceReg.toFixed(1)}h，无投注，提现 ${amount}`; }
      else if (hoursSinceReg < 6 && hasBet) { score = 20; reason = `注册 ${hoursSinceReg.toFixed(1)}h，有投注，提现 ${amount}`; }
      else if (hoursSinceReg < 24 && !hasBet) { score = 30; reason = `注册 ${hoursSinceReg.toFixed(1)}h，无投注，提现 ${amount}`; }
      else if (hoursSinceReg < 24 && hasBet) { score = 10; reason = `注册 ${hoursSinceReg.toFixed(1)}h，有投注，提现 ${amount}`; }
      else if (hoursSinceReg < 72 && !hasBet) { score = 20; reason = `注册 ${hoursSinceReg.toFixed(1)}h，无投注，提现 ${amount}`; }
      else if (hoursSinceReg < 72 && hasBet) { score = 5; reason = `注册 ${hoursSinceReg.toFixed(1)}h，有投注，提现 ${amount}`; }
      else if (!hasBet) { score = 10; reason = `注册 ${hoursSinceReg.toFixed(0)}h，无投注，提现 ${amount}`; }

      if (score > 0 && amount > 5000) {
        return { triggered: true, reason, score };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R06',
    name: '大额首次提现',
    description: '首次提现金额 > 10000',
    severity: 'HIGH',
    weight: 20,
    group: 'identity',
    enabled: false,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const sumWithdraw = absFloat(order?.sumWithdraw);
      const amount = parseFloat(String(order?.amount)) || 0;

      if (sumWithdraw === 0 && amount > 10000) {
        return { triggered: true, reason: `首次提现金额 ${amount}`, score: 20 };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R06a',
    name: '首次充值首次提现',
    description: '充值次数和提款次数均为1，首次充值后立即提款（平台有1倍打码量约束，仅作参考提示）',
    severity: 'MEDIUM',
    weight: 10,
    group: 'identity',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const depCount = ctx.member?.sumRechargeTimes ?? 0;
      const wdCount = ctx.member?.sumWithdrawTimes ?? 0;
      if (depCount <= 1 && wdCount <= 1) {
        return { triggered: true, reason: `首次充值首次提款（充值${depCount}次，提款${wdCount}次）`, score: 10 };
      }
      if (depCount <= 1) {
        return { triggered: true, reason: `首次充值即提款（充值${depCount}次）`, score: 5 };
      }
      if (wdCount <= 1) {
        return { triggered: true, reason: `首次提款（提现${wdCount}次）`, score: 5 };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R19',
    name: 'VIP等级不匹配',
    description: '低VIP等级大额提现或无投注行为',
    severity: 'MEDIUM',
    weight: 12,
    group: 'identity',
    enabled: false,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const member = ctx.member;
      const vip = Number(member?.vipLevel ?? order?.vipLevel ?? 0);
      const amount = parseFloat(String(order?.amount)) || 0;
      const sumBet = absFloat(member?.sumBet);

      if (vip <= 2 && amount > 10000) {
        return { triggered: true, reason: `VIP${vip}，提现 ${amount}`, score: 12 };
      }
      if (vip <= 2 && sumBet < 1000 && amount > 3000) {
        return { triggered: true, reason: `VIP${vip}，投注仅 ${sumBet}，提现 ${amount}`, score: 20 };
      }
      return { triggered: false, score: 0 };
    },
  },

  // ============================================================
  // 关联风险 (association)
  // ============================================================

  {
    id: 'R02D',
    name: '今日同IP账号数',
    description: '当天同一登录IP出现多个账号（3个账号起提示，>500公共出口忽略）',
    severity: 'HIGH',
    weight: 20,
    group: 'association',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const top = pickTopAssociation(ctx.dailyLoginIpAssociations, ipAssociationScore, 20);
      if (!top) return { triggered: false, score: 0 };
      const topDevice = pickTopAssociation(ctx.dailyLoginDeviceAssociations, deviceAssociationScore, 25);
      const sameAccountOnTopDevice = new Set(topDevice?.summary.otherMemberNames || []);
      if (top.summary.otherMemberNames.some(name => sameAccountOnTopDevice.has(name))) {
        // 同一账号同时命中IP和设备时由设备规则合并展示，避免重复计分。
        return { triggered: false, score: 0 };
      }
      return {
        triggered: true,
        reason: formatAssociationReason('今日同IP', top.summary.value, top.summary),
        score: top.score,
      };
    },
  },

  {
    id: 'R03D',
    name: '今日同设备账号数',
    description: '当天同一登录设备出现多个账号（2个账号起提示，>100公共设备忽略）',
    severity: 'HIGH',
    weight: 25,
    group: 'association',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const top = pickTopAssociation(ctx.dailyLoginDeviceAssociations, deviceAssociationScore, 25);
      if (!top) return { triggered: false, score: 0 };
      const shortDevice = formatDevice(top.summary.value);
      const ipAccounts = new Set((ctx.dailyLoginIpAssociations || []).flatMap(summary => summary.otherMemberNames));
      const both = top.summary.otherMemberNames.filter(name => ipAccounts.has(name));
      const bothText = both.length > 0 ? `，其中 ${both.slice(0, 3).join(' ')} 同时命中同IP` : '';
      return {
        triggered: true,
        reason: `${formatAssociationReason('今日同设备', shortDevice, top.summary)}${bothText}`,
        score: Math.min(30, top.score + (both.length > 0 ? 5 : 0)),
      };
    },
  },

  {
    id: 'R02',
    name: '同登录IP多账号',
    description: '同一登录IP下关联账号（3-20人高风险，>500公共IP忽略）',
    severity: 'HIGH',
    weight: 25,
    group: 'association',
    enabled: false,
    precondition(ctx: RuleContext): boolean {
      return !ctx.dailyLoginIpAssociations || ctx.dailyLoginIpAssociations.length === 0;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const count = ctx.relatedByLoginIpCount ?? 0;
      const result = ipAssociationScore(count, 25);
      if (result.triggered) {
        const allNames = [...new Set(
          (ctx.relatedByLoginIp || [])
            .map((l) => l.memberName)
            .filter((n): n is string => !!n && n !== ctx.member?.memberName)
        )];
        const display = allNames.slice(0, 10);
        const suffix = allNames.length > 10 ? ` 等共${allNames.length}人` : '';
        const nameList = display.length > 0 ? `：${display.join(' ')}${suffix}` : '';
        return { triggered: true, reason: `同IP ${allNames.length}人${nameList}`, score: result.score };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R03',
    name: '同登录设备多账号',
    description: '同一登录设备关联账号（2-5人高风险，>100公共设备忽略）',
    severity: 'HIGH',
    weight: 25,
    group: 'association',
    enabled: false,
    precondition(ctx: RuleContext): boolean {
      return !ctx.dailyLoginDeviceAssociations || ctx.dailyLoginDeviceAssociations.length === 0;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const count = ctx.relatedByLoginDeviceCount ?? 0;
      const result = deviceAssociationScore(count, 25);
      if (result.triggered) {
        const allNames = [...new Set(
          (ctx.relatedByLoginDevice || [])
            .map((l) => l.memberName)
            .filter((n): n is string => !!n && n !== ctx.member?.memberName)
        )];
        const display = allNames.slice(0, 10);
        const suffix = allNames.length > 10 ? ` 等共${allNames.length}人` : '';
        const nameList = display.length > 0 ? `：${display.join(' ')}${suffix}` : '';
        return { triggered: true, reason: `同设备${allNames.length}人${nameList}`, score: result.score };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R14',
    name: '同收款信息多账号',
    description: '不同会员提现到同一收款人/银行卡',
    severity: 'CRITICAL',
    weight: 30,
    group: 'association',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const receivingName = order?.receivingName;
      const receivingCardNo = order?.receivingCardNo;
      if (!receivingName || !receivingCardNo) return { triggered: false, score: 0 };

      const relatedNames = [...new Set(ctx.receivingAssociations || [])];
      if (relatedNames.length >= 1) {
        const display = relatedNames.slice(0, 5).join(' ');
        const hidden = relatedNames.length > 5 ? `，另有${relatedNames.length - 5}个隐藏` : '';
        return { triggered: true, reason: `同收款信息关联账号：${display}${hidden}`, score: 30 };
      }
      return { triggered: false, score: 0 };
    },
  },

  // ============================================================
  // 行为风险 (behavior)
  // ============================================================

  {
    id: 'R04',
    name: '充提回流比异常',
    description: '累计提款明显超过充值且会员当前为净赢，作为资金辅助信号',
    severity: 'MEDIUM',
    weight: 15,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const sumRecharge = absFloat(order?.sumRecharge);
      const sumWithdraw = absFloat(order?.sumWithdraw);

      const balance = absFloat(ctx.member?.balance ?? order?.balance);
      const estimatedNet = sumWithdraw + balance - sumRecharge;
      if (sumRecharge >= 1000 && estimatedNet > 0) {
        const ratio = sumWithdraw / sumRecharge;
        if (ratio > 1.5) {
          return { triggered: true, reason: `累计提充比 ${(ratio * 100).toFixed(1)}%（充 ${sumRecharge} / 提 ${sumWithdraw}），当前净赢`, score: 15 };
        }
        if (ratio > 1.2) {
          return { triggered: true, reason: `累计提充比 ${(ratio * 100).toFixed(1)}%（充 ${sumRecharge} / 提 ${sumWithdraw}），需结合投注核对`, score: 8 };
        }
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R08',
    name: '投注异常',
    description: '投注额占充值额极低且大额提现',
    severity: 'HIGH',
    weight: 20,
    group: 'behavior',
    enabled: false,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const member = ctx.member;
      const sumBet = absFloat(member?.sumBet);
      const sumRecharge = absFloat(order?.sumRecharge);
      const amount = parseFloat(String(order?.amount)) || 0;

      if (sumBet === 0 && amount > 1000) {
        return { triggered: true, reason: `从未投注，提现 ${amount}`, score: 25 };
      }
      if (sumRecharge > 0 && sumBet / sumRecharge < 0.1 && amount > 3000) {
        return { triggered: true, reason: `投注仅 ${sumBet}（充值 ${sumRecharge} 的 ${(sumBet / sumRecharge * 100).toFixed(1)}%），提现 ${amount}`, score: 20 };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R10',
    name: '等额充提',
    description: '单次提现金额 ≈ 累计充值金额（差异 < 5%）',
    severity: 'MEDIUM',
    weight: 8,
    group: 'behavior',
    enabled: false,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const sumRecharge = absFloat(order?.sumRecharge);
      const amount = parseFloat(String(order?.amount)) || 0;

      if (sumRecharge > 0 && amount > 0) {
        const diff = Math.abs(amount - sumRecharge) / sumRecharge;
        if (diff < 0.05) {
          return { triggered: true, reason: `提现 ${amount} ≈ 充值 ${sumRecharge}（差异 ${(diff * 100).toFixed(1)}%）`, score: 8 };
        }
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R12',
    name: '充值后快速提现',
    description: '充值后15分钟内申请提现且回流比高（有1倍打码量约束）',
    severity: 'CRITICAL',
    weight: 35,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const latestRechargeTime = ctx.latestRechargeTime || 0;
      const orderTime = parseTimeStr(order?.createTime || (order as Record<string, unknown>)?.createdAt as string | number | undefined);
      if (!latestRechargeTime || !orderTime) return { triggered: false, score: 0 };

      const diffMinutes = (orderTime - latestRechargeTime) / 60000;
      const amount = parseFloat(String(order?.amount)) || 0;
      const latestRechargeAmount = ctx.latestRechargeAmount || 0;

      if (diffMinutes >= 0 && diffMinutes < 15 && latestRechargeAmount > 0) {
        const ratio = amount / latestRechargeAmount;
        if (ratio > 0.8) {
          return { triggered: true, reason: `充值后 ${diffMinutes.toFixed(0)} 分钟提现，回流比 ${(ratio * 100).toFixed(0)}%`, score: 35 };
        }
        if (diffMinutes < 10) {
          return { triggered: true, reason: `充值后 ${diffMinutes.toFixed(0)} 分钟即提现 ${amount}`, score: 25 };
        }
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R20',
    name: '整数金额提现',
    description: '提现金额为整千或精确等于充值金额',
    severity: 'MEDIUM',
    weight: 8,
    group: 'behavior',
    enabled: false,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const amount = parseFloat(String(order?.amount)) || 0;
      if (amount <= 0) return { triggered: false, score: 0 };

      if (amount >= 1000 && amount % 1000 === 0) {
        return { triggered: true, reason: `提现金额 ${amount} 为整千`, score: 8 };
      }
      const sumRecharge = absFloat(order?.sumRecharge);
      if (sumRecharge > 0 && Math.abs(amount - sumRecharge) < 1) {
        return { triggered: true, reason: `提现 ${amount} 精确等于充值 ${sumRecharge}`, score: 25 };
      }
      return { triggered: false, score: 0 };
    },
  },

  // ============================================================
  // 环境风险 (environment)
  // ============================================================

  // ============================================================
  // 标记风险 (marking)
  // ============================================================

  {
    id: 'R17',
    name: '会员备注标记',
    description: '备注命中风险关键词时增加风险评分；备注内容统一作为上下文展示',
    severity: 'HIGH',
    weight: 25,
    group: 'marking',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const remark = ctx.member?.remark || '';
      const memberRemark = ctx.order?.memberRemark || '';

      const hitKeywords: string[] = [];
      const keywords = getSuspiciousKeywords();
      for (const kw of keywords) {
        if (remark.includes(kw) || memberRemark.includes(kw)) {
          hitKeywords.push(kw);
        }
      }

      if (hitKeywords.length > 0) {
        const strong = hitKeywords.some(keyword => STRONG_REMARK_KEYWORDS.has(keyword));
        return {
          triggered: true,
          reason: `备注命中风险词：${hitKeywords.join('、')}`,
          score: strong ? 25 : 5,
          severity: strong ? 'HIGH' : 'MEDIUM',
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R17a',
    name: '无备注会员',
    description: '会员没有任何备注信息且充值或提款次数<=5，仅作辅助展示',
    severity: 'MEDIUM',
    weight: 0,
    group: 'marking',
    enabled: true,
    precondition(ctx: RuleContext): boolean {
      const depCount = ctx.member?.sumRechargeTimes ?? 0;
      const wdCount = ctx.member?.sumWithdrawTimes ?? 0;
      return depCount <= 5 && wdCount <= 5;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const remark = combineMemberRemarks([ctx.member?.remark, ctx.order?.memberRemark]);
      if (!remark) {
        return { triggered: true, reason: '会员无任何备注信息', score: 0 };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R18',
    name: '同代理集中提现',
    description: '同一代理下4小时内多个会员申请提现',
    severity: 'HIGH',
    weight: 25,
    group: 'marking',
    enabled: false,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const proxyCode = extractProxyCode(order, ctx.member);
      if (!proxyCode) return { triggered: false, score: 0 };

      const cache = ctx.agentWithdrawCache;
      const entry = cache.get(proxyCode);
      if (!entry) return { triggered: false, score: 0 };

      if (entry.memberIds.size >= 5) {
        return { triggered: true, reason: `代理 ${proxyCode} 下 ${entry.memberIds.size} 个会员提现`, score: 25 };
      }
      if (entry.memberIds.size >= 4) {
        return { triggered: true, reason: `代理 ${proxyCode} 下 ${entry.memberIds.size} 个会员提现`, score: 20 };
      }
      return { triggered: false, score: 0 };
    },
  },

  // ============================================================
  // 对冲与违规检测
  // ============================================================

  {
    id: 'R21',
    name: '对冲投注检测',
    description: '当日投注额较大且盈亏率接近0，作为需核对对冲的辅助证据',
    severity: 'HIGH',
    weight: 20,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const bc = ctx.betsCount;
      if (!bc) return { triggered: false, score: 0 };

      const totalBet = parseFloat(bc.countAmount || '0');
      const profit = parseFloat(bc.countProfit || '0');
      if (totalBet < 50000) return { triggered: false, score: 0 };

      const pnlRate = Math.abs(profit) / totalBet;

      if (pnlRate < 0.01) {
        const direction = profit >= 0 ? '盈利' : '亏损';
        return {
          triggered: true,
          reason: `投注 ${totalBet.toFixed(0)}，${direction} ${Math.abs(profit).toFixed(0)}，盈亏率 ${(pnlRate * 100).toFixed(2)}%（对冲特征）`,
          score: 20,
        };
      }
      if (pnlRate < 0.02) {
        return {
          triggered: true,
          reason: `当日大额投注 ${totalBet.toFixed(0)}，盈亏率 ${(pnlRate * 100).toFixed(2)}%，需核对是否对冲`,
          score: 12,
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R23',
    name: '异常流水检测',
    description: '比较同一时间范围内的当日投注额和当日充值额',
    severity: 'HIGH',
    weight: 20,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const bc = ctx.betsCount;
      const sameWindowRecharge = (ctx.manualRechargeToday || 0) + (ctx.thirdPartyRechargeToday || 0);

      if (!bc || sameWindowRecharge < 1000) return { triggered: false, score: 0 };

      const totalBet = parseFloat(bc.countAmount || '0');
      if (totalBet < 5000) return { triggered: false, score: 0 };

      const ratio = totalBet / sameWindowRecharge;

      if (ratio > 50) {
        return {
          triggered: true,
          reason: `当日投注 ${totalBet.toFixed(0)} / 当日充值 ${sameWindowRecharge.toFixed(0)} = ${ratio.toFixed(1)}x（需核对异常流水）`,
          score: 20,
        };
      }
      if (ratio > 20) {
        return {
          triggered: true,
          reason: `当日投注 ${totalBet.toFixed(0)} / 当日充值 ${sameWindowRecharge.toFixed(0)} = ${ratio.toFixed(1)}x（需关注流水）`,
          score: 12,
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  // ============================================================
  // 彩票投注模式检测
  // ============================================================

  {
    id: 'R24',
    name: '彩票同期双向下注',
    description: '同一期同一玩法同时买互斥方向：大↔小、单↔双、龙↔虎、波色互斥、前中后三选一 等',
    severity: 'CRITICAL',
    weight: 40,
    group: 'behavior',
    enabled: true,
    precondition(ctx: RuleContext): boolean {
      return (ctx.bets?.length ?? 0) > 0;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const unreviewedBets = getUnreviewedBets(ctx);

      if (!ctx._lhcResult) {
        ctx._lhcResult = checkLiuHeCai(unreviewedBets);
      }
      if (!ctx._sscResult) {
        ctx._sscResult = checkShiShiCai(unreviewedBets);
      }
      if (!ctx._k3Result) {
        ctx._k3Result = checkKuaiSan(unreviewedBets);
      }
      if (!ctx._pk10Result) {
        ctx._pk10Result = checkPK10(unreviewedBets);
      }

      const twoSideViolations = [
        ...ctx._lhcResult.twoSideViolations,
        ...ctx._sscResult.twoSideViolations,
        ...ctx._k3Result.twoSideViolations,
        ...ctx._pk10Result.twoSideViolations,
      ];

      const formattedViolations = formatLotteryViolationReasons(twoSideViolations, unreviewedBets);

      if (formattedViolations.length === 0) {
        return { triggered: false, score: 0 };
      }

      const maxScore = Math.max(
        ctx._lhcResult.maxScoreR24,
        ctx._sscResult.maxScoreR24,
        ctx._k3Result.maxScoreR24,
        ctx._pk10Result.maxScoreR24,
      );

      return {
        triggered: true,
        reason: formattedViolations.join('\n'),
        score: maxScore || 40,
      };
    },
  },

  {
    id: 'R25',
    name: '彩票同期多号码覆盖',
    description: '按玩法设上限：特码(同金额20/共32)、平特(3)、特肖(6)、正特(20/32)、半波(6)、尾数(全尾4/特尾5)、六肖(6)、连肖(4)、连尾(5)、五行(2)、合肖(4)、斗牛(7)、1-5球(7)、第X球(7)、和值(11)、独胆(3)、二不同号(4)、三不同号(4)、冠亚和(11)、PK10名次(7)',
    severity: 'MEDIUM',
    weight: 15,
    group: 'behavior',
    enabled: true,
    precondition(ctx: RuleContext): boolean {
      return (ctx.bets?.length ?? 0) > 0;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const unreviewedBets = getUnreviewedBets(ctx);

      if (!ctx._lhcResult) {
        ctx._lhcResult = checkLiuHeCai(unreviewedBets);
      }
      if (!ctx._sscResult) {
        ctx._sscResult = checkShiShiCai(unreviewedBets);
      }
      if (!ctx._k3Result) {
        ctx._k3Result = checkKuaiSan(unreviewedBets);
      }
      if (!ctx._pk10Result) {
        ctx._pk10Result = checkPK10(unreviewedBets);
      }

      const coverageViolations = [
        ...ctx._lhcResult.coverageViolations,
        ...ctx._sscResult.coverageViolations,
        ...ctx._k3Result.coverageViolations,
        ...ctx._pk10Result.coverageViolations,
      ];

      const formattedViolations = formatLotteryViolationReasons(coverageViolations, unreviewedBets);

      if (formattedViolations.length === 0) {
        return { triggered: false, score: 0 };
      }

      const maxScore = Math.max(
        ctx._lhcResult.maxScoreR25,
        ctx._sscResult.maxScoreR25,
        ctx._k3Result.maxScoreR25,
        ctx._pk10Result.maxScoreR25,
      );

      return {
        triggered: true,
        reason: formattedViolations.join('\n'),
        score: maxScore || 15,
      };
    },
  },

  {
    id: 'R26',
    name: '彩票金额浮动规避',
    description: '同一期分散下注但金额浮动<50%（规避相同金额检测）',
    severity: 'MEDIUM',
    weight: 15,
    group: 'behavior',
    enabled: false,
    evaluate(ctx: RuleContext): RuleResult {
      const issueGroups = getUnreviewedIssueGroups(ctx);

      const hits: string[] = [];
      let maxScore = 0;

      for (const [key, group] of issueGroups) {
        if (group.length < 10) continue;
        const amounts = group.map((b: BetRecord) => parseFloat(String(b.amount)) || 0).filter((a: number) => a > 0);
        if (amounts.length < 10) continue;
        const avg = amounts.reduce((a: number, b: number) => a + b, 0) / amounts.length;
        if (avg < 1) continue;
        const maxDiff = Math.max(...amounts.map((a: number) => Math.abs(a - avg) / avg));
        if (maxDiff < 0.5) {
          hits.push(formatLotteryViolationReason(`${key}：${amounts.length} 注，金额浮动 ${(maxDiff * 100).toFixed(0)}%（<50%，疑似规避）`, group).text);
          maxScore = 15;
        }
      }

      if (hits.length > 0) {
        return { triggered: true, reason: hits.join('\n'), score: maxScore };
      }
      return { triggered: false, score: 0 };
    },
  },

  // ============================================================
  // 三方游戏检测（电子/捕鱼/棋牌）
  // ============================================================

  {
    id: 'R27',
    name: '三方游戏高频下注',
    description: '三方游戏下注间隔极短（疑似脚本/机器人）',
    severity: 'HIGH',
    weight: 25,
    group: 'behavior',
    enabled: false,
    precondition(ctx: RuleContext): boolean {
      return (ctx.thirdGameBets?.length ?? 0) >= 20;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const orders = ctx.thirdGameBets || [];
      const activeOrders = orders.filter((o: ThirdGameOrder) => parseFloat(String(o.allbet || o.bet)) > 0);
      if (activeOrders.length < 20) return { triggered: false, score: 0 };

      const sorted = [...activeOrders].sort((a: ThirdGameOrder, b: ThirdGameOrder) => parseTimeStr(a.betTime) - parseTimeStr(b.betTime));
      const intervals: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const diff = (parseTimeStr(sorted[i].betTime) - parseTimeStr(sorted[i - 1].betTime)) / 1000;
        if (diff >= 0) intervals.push(diff);
      }

      if (intervals.length === 0) return { triggered: false, score: 0 };
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const underOneSec = intervals.filter(t => t < 1).length;

      if (avgInterval < 0.5) {
        return {
          triggered: true,
          reason: `${activeOrders.length} 次下注，均间隔 ${(avgInterval * 1000).toFixed(0)}ms（脚本操作）`,
          score: 30,
        };
      }
      if (underOneSec >= activeOrders.length * 0.7) {
        return {
          triggered: true,
          reason: `${activeOrders.length} 次下注， ${underOneSec} 次间隔<1秒（疑似脚本）`,
          score: 25,
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R28',
    name: '三方游戏无波动检测',
    description: '电子游戏中大量下注但盈亏率极低',
    severity: 'MEDIUM',
    weight: 12,
    group: 'behavior',
    enabled: false,
    precondition(ctx: RuleContext): boolean {
      return (ctx.thirdGameBets?.length ?? 0) >= 30;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const orders = ctx.thirdGameBets || [];
      const activeOrders = orders.filter((o: ThirdGameOrder) => parseFloat(String(o.allbet || o.bet)) > 0);
      if (activeOrders.length < 30) return { triggered: false, score: 0 };

      const totalBet = activeOrders.reduce((sum: number, o: ThirdGameOrder) => sum + parseFloat(String(o.allbet || o.bet || '0')), 0);
      const totalProfit = activeOrders.reduce((sum: number, o: ThirdGameOrder) => sum + parseFloat(String(o.profit || '0')), 0);

      if (totalBet < 100) return { triggered: false, score: 0 };
      const pnlRate = Math.abs(totalProfit) / totalBet;

      if (pnlRate < 0.03) {
        return {
          triggered: true,
          reason: `${activeOrders.length} 次电子下注，${totalBet.toFixed(0)}，盈亏率 ${(pnlRate * 100).toFixed(1)}%（低波动流水）`,
          score: 12,
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  // ============================================================
  // 充值异常检测
  // ============================================================

  {
    id: 'R29',
    name: '非彩金人工加款',
    description: '近7日存在非彩金的后台人工加款账变',
    severity: 'MEDIUM',
    weight: 10,
    group: 'marking',
    enabled: true,
    precondition(ctx: RuleContext): boolean {
      return (ctx.accountChanges || []).some(change => !isBonusCredit(change));
    },
    evaluate(ctx: RuleContext): RuleResult {
      const manualOrders = (ctx.accountChanges || []).filter(change => !isBonusCredit(change));

      if (manualOrders.length === 0) return { triggered: false, score: 0 };

      const totalAmount = manualOrders.reduce((s, o) => s + (parseFloat(String(o.amount)) || 0), 0);
      const operators = [...new Set(manualOrders.map(o => o.operatorName).filter(Boolean))];
      const operatorText = operators.length > 0 ? `，操作员: ${operators.join(',')}` : '';
      const latest = manualOrders.reduce((max, o) => Math.max(max, parseTimeStr(o.createTime)), 0);
      const latestText = latest ? `，最近 ${formatBeijingTime(latest)}` : '';

      return {
        triggered: true,
        reason: `近7日非彩金人工加款 ${manualOrders.length} 笔 / ${totalAmount.toFixed(0)} 元${latestText}${operatorText}`,
        score: 10,
      };
    },
  },

  {
    id: 'R30',
    name: '低活跃度提现',
    description: '充值或提款次数<5，账号活跃度极低却申请提现（首充首提由R06a覆盖）',
    severity: 'MEDIUM',
    weight: 25,
    group: 'behavior',
    enabled: true,
    precondition(ctx: RuleContext): boolean {
      const depCount = ctx.member?.sumRechargeTimes ?? 0;
      const wdCount = ctx.member?.sumWithdrawTimes ?? 0;
      return depCount > 1 && wdCount > 1;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const depCount = ctx.member?.sumRechargeTimes ?? 0;
      const wdCount = ctx.member?.sumWithdrawTimes ?? 0;

      if (depCount < 5 || wdCount < 5) {
        return { triggered: true, reason: `偏低活跃度：充值 ${depCount} 次，提款 ${wdCount} 次`, score: 8 };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R31',
    name: '高风险代理',
    description: '提现会员的上级代理在黑名单中',
    severity: 'HIGH',
    weight: 30,
    group: 'marking',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const proxyCode = extractProxyCode(ctx.order, ctx.member);
      if (!proxyCode) return { triggered: false, score: 0 };
      if (isAgentWhitelisted(proxyCode)) return { triggered: false, score: 0 };

      const blacklist = getProxyBlacklist();

      if (blacklist.includes(proxyCode)) {
        return { triggered: true, reason: `上级代理为高风险代理`, score: 30 };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R32',
    name: '充提渠道不一致',
    description: '充值渠道与提款渠道不一致（排除已知别名后仍不匹配）',
    severity: 'MEDIUM',
    weight: 15,
    group: 'behavior',
    enabled: true,
    precondition(ctx: RuleContext): boolean {
      return !!(ctx.order?.receivingBank || '').trim();
    },
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const withdrawChannel = (order?.receivingBank || '').trim();
      if (!withdrawChannel) return { triggered: false, score: 0 };

      const paymentOrders = ctx.paymentOrders || [];
      if (paymentOrders.length === 0) {
        return { triggered: false, score: 0 };
      }

      const depositChannels = [...new Set(
        paymentOrders
          .map((o: PaymentOrder) => (o.payPlatformName || '').trim())
          .filter(Boolean)
      )];

      if (depositChannels.length === 0) return { triggered: false, score: 0 };

      const normalizedWithdraw = normalizeChannel(withdrawChannel);
      const matched = depositChannels.some(dc => normalizeChannel(dc) === normalizedWithdraw);

      if (!matched) {
        return {
          triggered: true,
          reason: `充值渠道 ${depositChannels.join('/')} 与提款渠道 ${withdrawChannel} 不一致`,
          score: 5,
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R33',
    name: '无近期充值却提现',
    description: '当天/3天/7天逐级检查充值记录，近期无充值仍提款需复核',
    severity: 'MEDIUM',
    weight: 10,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const regTime = parseTimeStr(ctx.member?.createTime || ctx.member?.createdAt);
      if (regTime) {
        const orderTime = parseTimeStr(
          ctx.order?.createTime || (ctx.order as Record<string, unknown>)?.createdAt as string | number | undefined,
        ) || Date.now();
        const daysSinceReg = Math.max(0, (orderTime - regTime) / 86400000);
        if (daysSinceReg < 3) return { triggered: false, score: 0 };
        if (daysSinceReg < 7) {
          const threeDayTotal = (ctx.manualRecharge3Day ?? 0) + (ctx.thirdPartyRecharge3Day ?? 0);
          if (threeDayTotal > 0) return { triggered: false, score: 0 };
          return { triggered: true, reason: `注册${daysSinceReg.toFixed(1)}天，近3天无充值后提款`, score: 0, presentation: 'support' };
        }
      }

      // 1. 当天有人工加款或线上充值 → 不触发
      const todayTotal = (ctx.manualRechargeToday ?? 0) + (ctx.thirdPartyRechargeToday ?? 0);
      if (todayTotal > 0) return { triggered: false, score: 0 };

      // 2. 当天无充值，3天内有充值 → 关注
      const threeDayTotal = (ctx.manualRecharge3Day ?? 0) + (ctx.thirdPartyRecharge3Day ?? 0);
      if (threeDayTotal > 0) {
        return { triggered: true, reason: '当天无充值，3天内有充值记录', score: 0 };
      }

      // 3. 近3天无充值，7天内有充值 → 关注
      const sevenDayTotal = (ctx.manualRecharge7Day ?? 0) + (ctx.thirdPartyRecharge7Day ?? 0);
      if (sevenDayTotal > 0) {
        return { triggered: true, reason: '近3天无充值，7天内有充值记录，需关注', score: 5 };
      }

      // 4. 近7天无充值 → 高风险
      return { triggered: true, reason: '近7天无充值，本次提款需结合投注和资金情况复核', score: 10 };
    },
  },

  {
    id: 'R36',
    name: '代理风险评分',
    description: '上级代理的风险评分过高，该代理下会员提现需额外关注',
    severity: 'MEDIUM',
    weight: 15,
    group: 'marking',
    enabled: false,
    precondition(ctx: RuleContext): boolean {
      const proxyCode = extractProxyCode(ctx.order, ctx.member);
      return !isAgentWhitelisted(proxyCode) && (ctx.agentRiskScore ?? 0) >= 30;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const score = ctx.agentRiskScore ?? 0;
      if (score >= 80) {
        return { triggered: true, reason: `上级代理风险评分 ${score}（极高风险）`, score: 25 };
      }
      if (score >= 50) {
        return { triggered: true, reason: `上级代理风险评分 ${score}（高风险）`, score: 15 };
      }
      if (score >= 30) {
        return { triggered: true, reason: `上级代理风险评分 ${score}（中等风险）`, score: 8 };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R37',
    name: '首提大于首充',
    description: '首次提现金额显著高于首充，需结合投注和派奖情况复核',
    severity: 'MEDIUM',
    weight: 15,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const depCount = ctx.member?.sumRechargeTimes ?? 0;
      const wdCount = ctx.member?.sumWithdrawTimes ?? 0;
      if (depCount !== 1 || wdCount > 1 || (ctx.withdrawals?.length ?? 0) > 0) return { triggered: false, score: 0 };

      const sumRecharge = parseFloat(String(ctx.order?.sumRecharge)) || 0;
      const amount = parseFloat(String(ctx.order?.amount)) || 0;

      if (sumRecharge > 0 && amount > sumRecharge * 1.5) {
        return {
          triggered: true,
          reason: `首提 ${amount.toFixed(0)} 为首充 ${sumRecharge.toFixed(0)} 的 ${(amount / sumRecharge).toFixed(1)}倍，需结合投注和派奖情况复核`,
          score: 15,
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  // NOTE: R38/R39 依赖 ctx.associatedMemberBets，当前评估器未填充该字段，
  // 因此这两条规则的 precondition 永远为 false，不会触发。待关联数据可用后启用。
  {
    id: 'R38',
    name: '关联账号对打检测',
    description: '关联会员在同一期同一玩法买互斥方向且金额一致（覆盖全部游戏类型：大小单双/龙虎/庄闲/波色/冠亚/牛牛等）',
    severity: 'CRITICAL',
    weight: 40,
    group: 'association',
    enabled: false,
    precondition(ctx: RuleContext): boolean {
      return ctx.associatedMemberBets.size > 0;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const myBets = ctx.dailyBets || [];
      const myName = ctx.order?.memberName || ctx.member?.memberName || '';
      const assocBets = ctx.associatedMemberBets;

      const allBetsByMember = new Map<string, any[]>();
      if (myBets.length > 0) allBetsByMember.set(myName, myBets);
      for (const [name, bets] of assocBets) {
        if (bets.length > 0) allBetsByMember.set(name, bets);
      }

      if (allBetsByMember.size < 2) return { triggered: false, score: 0 };

      const issueGroups = new Map<string, Map<string, any[]>>();

      for (const [memberName, bets] of allBetsByMember) {
        for (const b of bets) {
          const ltName = b.lotteryName || '';
          const key = `${ltName} ${b.issue} ${b.playClassName}`;
          if (!issueGroups.has(key)) issueGroups.set(key, new Map());
          const memberBets = issueGroups.get(key)!.get(memberName) || [];
          memberBets.push(b);
          issueGroups.get(key)!.set(memberName, memberBets);
        }
      }

      const hits: string[] = [];
      let maxScore = 0;

      for (const [issueKey, memberMap] of issueGroups) {
        if (memberMap.size < 2) continue;

        const memberDirections = new Map<string, Set<string>>();
        for (const [memberName, bets] of memberMap) {
          const dirs = new Set<string>();
          for (const b of bets) {
            for (const d of expandDirections(extractTwoSideDirection(b.numbers))) {
              dirs.add(d);
            }
          }
          if (dirs.size > 0) memberDirections.set(memberName, dirs);
        }

        if (memberDirections.size < 2) continue;

        const members = [...memberDirections.entries()];
        for (let i = 0; i < members.length; i++) {
          for (let j = i + 1; j < members.length; j++) {
            const [name1, dirs1] = members[i];
            const [name2, dirs2] = members[j];

            let foundMutex = false;
            let mutexPair = '';
            for (const d1 of dirs1) {
              for (const d2 of dirs2) {
                if (isMutexDirection(d1, d2)) {
                  foundMutex = true;
                  mutexPair = `${d1}↔${d2}`;
                  break;
                }
              }
              if (foundMutex) break;
            }

            if (foundMutex) {
              const bets1 = memberMap.get(name1) || [];
              const bets2 = memberMap.get(name2) || [];
              const amt1 = sum(bets1.map((b: BetRecord) => parseFloat(String(b.amount)) || 0));
              const amt2 = sum(bets2.map((b: BetRecord) => parseFloat(String(b.amount)) || 0));
              if (Math.abs(amt1 - amt2) < 0.001) {
                hits.push(`${issueKey} — ${name1} ${[...dirs1].join('/')} (${amt1.toFixed(0)}元) vs ${name2} ${[...dirs2].join('/')} (${amt2.toFixed(0)}元) [${mutexPair}]`);
                maxScore = 40;
              }
            }
          }
        }
      }

      if (hits.length > 0) {
        const displayHits = hits.slice(0, 5);
        return { triggered: true, reason: displayHits.join('\n'), score: maxScore };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R39',
    name: '关联群体盈亏抵消',
    description: '关联会员群体总盈亏接近零（互为对冲，盈亏抵消）',
    severity: 'HIGH',
    weight: 30,
    group: 'association',
    enabled: false,
    precondition(ctx: RuleContext): boolean {
      return ctx.associatedMemberBets.size > 0;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const myBets = ctx.dailyBets || [];
      const assocBets = ctx.associatedMemberBets;

      const allBets = [...myBets];
      for (const [, bets] of assocBets) {
        allBets.push(...bets);
      }

      if (allBets.length < 4) return { triggered: false, score: 0 };

      const totalBet = allBets.reduce((s: number, b: BetRecord) => s + (parseFloat(String(b.amount)) || 0), 0);
      const totalProfit = allBets.reduce((s: number, b: BetRecord) => s + (parseFloat(String(b.profit)) || 0), 0);

      if (totalBet < 10000) return { triggered: false, score: 0 };

      const pnlRate = Math.abs(totalProfit) / totalBet;

      if (pnlRate < 0.02) {
        const memberCount = 1 + assocBets.size;
        const profitDir = totalProfit >= 0 ? '微盈' : '微亏';
        return {
          triggered: true,
          reason: `${memberCount}人关联群体投注 ${totalBet.toFixed(0)}，${profitDir} ${Math.abs(totalProfit).toFixed(0)}，盈亏率 ${(pnlRate * 100).toFixed(2)}%（群体对冲）`,
          score: 30,
        };
      }
      if (pnlRate < 0.05) {
        const memberCount = 1 + assocBets.size;
        return {
          triggered: true,
          reason: `${memberCount}人关联群体投注 ${totalBet.toFixed(0)}，盈亏率 ${(pnlRate * 100).toFixed(2)}%（疑似群体对冲）`,
          score: 20,
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R34',
    name: '提现金额递增',
    description: '近3次提现金额逐步递增且最后一次超过第一次2倍',
    severity: 'MEDIUM',
    weight: 15,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const withdrawals = ctx.withdrawals || [];
      if (withdrawals.length < 3) return { triggered: false, score: 0 };
      const sorted = [...withdrawals]
        .filter((w: WithdrawalRecord) => w && w.createTime)
        .sort((a: WithdrawalRecord, b: WithdrawalRecord) => parseTimeStr(a.createTime) - parseTimeStr(b.createTime));
      const recent = sorted.slice(-3);
      if (recent.length < 3) return { triggered: false, score: 0 };
      const amounts = recent.map((w: WithdrawalRecord) => parseFloat(String(w.amount)) || 0);
      let ascending = true;
      for (let i = 1; i < amounts.length; i++) {
        if (amounts[i] <= amounts[i - 1]) { ascending = false; break; }
      }
      if (ascending && amounts[amounts.length - 1] > amounts[0] * 2) {
        return {
          triggered: true,
          reason: `提现金额递增：${amounts[0].toFixed(0)} → ${amounts[amounts.length - 1].toFixed(0)}（近${amounts.length}次）`,
          score: 15,
        };
      }
      return { triggered: false, score: 0 };
    },
  },
  {
    id: 'R35',
    name: '提现频率递增',
    description: '近3天每日提现次数递增且最新一天≥3次',
    severity: 'MEDIUM',
    weight: 15,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const withdrawals = ctx.withdrawals || [];
      if (withdrawals.length < 3) return { triggered: false, score: 0 };
      const sorted = [...withdrawals]
        .filter((w: WithdrawalRecord) => w && w.createTime)
        .sort((a: WithdrawalRecord, b: WithdrawalRecord) => parseTimeStr(a.createTime) - parseTimeStr(b.createTime));
      if (sorted.length < 3) return { triggered: false, score: 0 };
      const dayBuckets = new Map<string, number>();
      for (const w of sorted) {
        const t = parseTimeStr(w.createTime || 0);
        const tzOffset = ctx.tzOffset || 8;
        const localDate = new Date(t + tzOffset * 3600000);
        const d = localDate.toISOString().slice(0, 10);
        dayBuckets.set(d, (dayBuckets.get(d) || 0) + 1);
      }
      const orderTime = parseTimeStr(ctx.order?.createTime || Date.now()) || Date.now();
      const tzOffset = ctx.tzOffset || 8;
      const localOrderTime = new Date(orderTime + tzOffset * 3600000);
      const recentDayKeys: string[] = [];
      for (let daysAgo = 2; daysAgo >= 0; daysAgo--) {
        const day = new Date(localOrderTime);
        day.setUTCDate(day.getUTCDate() - daysAgo);
        recentDayKeys.push(day.toISOString().slice(0, 10));
      }
      const dailyCounts = recentDayKeys.map(day => dayBuckets.get(day) || 0);
      let ascendingFreq = true;
      for (let i = 1; i < dailyCounts.length; i++) {
        if (dailyCounts[i] < dailyCounts[i - 1]) { ascendingFreq = false; break; }
      }
      const hasIncrease = dailyCounts.some((count, index) => index > 0 && count > dailyCounts[index - 1]);
      if (ascendingFreq && hasIncrease && dailyCounts[dailyCounts.length - 1] >= 3) {
        return {
          triggered: true,
          reason: `提现频率递增：近${dailyCounts.length}天，${dailyCounts.join('→')}次/天`,
          score: 15,
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R40',
    name: '新注册账号提现',
    description: '注册少于7天的账号申请提现，仅作为会员阶段辅助信息',
    severity: 'MEDIUM',
    weight: 0,
    group: 'identity',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const member = ctx.member;
      const order = ctx.order;
      const regTime = parseTimeStr(member?.createTime || member?.createdAt);
      if (!regTime) return { triggered: false, score: 0 };

      const orderTime = parseTimeStr(
        ctx.order?.createTime || (ctx.order as Record<string, unknown>)?.createdAt as string | number | undefined,
      ) || Date.now();
      const daysSinceReg = Math.max(0, (orderTime - regTime) / 86400000);
      const amount = parseFloat(String(order?.amount)) || 0;

      if (daysSinceReg >= 7) return { triggered: false, score: 0 };

      const regDate = formatBeijingTime(regTime);

      if (daysSinceReg < 1) {
        return { triggered: true, reason: `注册不足1天（${regDate}），提现 ${amount.toFixed(0)}`, score: 0, presentation: 'support' };
      }
      if (daysSinceReg < 3) {
        return { triggered: true, reason: `注册${daysSinceReg.toFixed(1)}天（${regDate}），提现 ${amount.toFixed(0)}`, score: 0, presentation: 'support' };
      }
      return { triggered: true, reason: `注册${daysSinceReg.toFixed(1)}天（${regDate}），提现 ${amount.toFixed(0)}`, score: 0, presentation: 'support' };
    },
  },
  {
    id: 'R41',
    name: '提款收款信息变更',
    description: '与上次成功提款比较收款姓名、账号和渠道，按证据强度评分',
    severity: 'HIGH',
    weight: 30,
    group: 'identity',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const last = ctx.lastWithdrawMethod;
      if (!last) return { triggered: false, score: 0 };

      const currentBank = normalizeChannel(String(order?.receivingBank || '').trim());
      const currentCard = String(order?.receivingCardNo || '').trim();
      const currentName = String(order?.receivingName || '').trim().replace(/\s+/g, '').toLowerCase();
      if (!currentBank) return { triggered: false, score: 0 };

      const lastBank = normalizeChannel(last.bank);
      const lastCard = last.card;
      const lastName = String(last.name || '').trim().replace(/\s+/g, '').toLowerCase();

      if (currentName && lastName && currentName !== lastName) {
        return { triggered: true, reason: '提款收款人变更：本次收款姓名与上次成功提款不同', score: 30 };
      }

      if (currentCard && lastCard && currentCard !== lastCard) {
        return { triggered: true, reason: `提款卡号变更：${currentBank || '同渠道'}内更换收款账号`, score: 20 };
      }

      // 仅渠道变化作为辅助信息，不直接判定账号被盗。
      if (currentBank !== lastBank && lastBank) {
        return {
          triggered: true,
          reason: `提款方式变更：上次 ${formatWithdrawChannel(last.bank, lastBank)} → 本次 ${formatWithdrawChannel(String(order?.receivingBank || ''), currentBank)}`,
          score: 10,
        };
      }

      return { triggered: false, score: 0 };
    },
  },
];
