/**
 * 风控规则定义
 *
 * 所有规则的 evaluate 函数都定义在此文件中。
 * 引擎逻辑（evaluateRules、缓存、handledRules 等）在 rule-engine.ts 中。
 */

import type { BetRecord, ThirdGameOrder, WithdrawalRecord, PaymentOrder } from './types';
import type { RiskRule, RuleContext, RuleResult } from './rule-types';
import { checkLiuHeCai } from './lhc-checker';
import { checkShiShiCai } from './ssc-checker';
import { checkKuaiSan } from './k3-checker';
import { checkPK10 } from './pk10-checker';
import { parseTimeStr, absFloat, sum, extractProxyCode, formatBeijingTime } from './utils';

// ============================================================
// 通用辅助函数
// ============================================================

const _defaultKeywords = ['套利', '刷子', '团伙', '同人', '代充', '代付', '黑名单', '风险', '异常', '冻结', '封号', '多号', '关联'];
function getSuspiciousKeywords(): string[] {
  const raw = process.env.RISK_REMARK_KEYWORDS;
  if (raw !== undefined && raw.trim() !== '') {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  return _defaultKeywords;
}

const _proxyBlacklistCache = { value: '' as string, parsed: [] as string[] };
function getProxyBlacklist(): string[] {
  const current = process.env.PROXY_BLACKLIST || '';
  if (current !== _proxyBlacklistCache.value) {
    _proxyBlacklistCache.value = current;
    _proxyBlacklistCache.parsed = current.split(',').map(s => s.trim()).filter(Boolean);
  }
  return _proxyBlacklistCache.parsed;
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

function normalizeChannel(name: string): string {
  for (const [pattern, canonical] of CHANNEL_ALIASES) {
    if (pattern.test(name)) return canonical;
  }
  return name;
}

function ipAssociationScore(count: number, maxScore: number): { triggered: boolean; score: number; label: string } {
  if (count < 3) return { triggered: false, score: 0, label: '' };
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

// ============================================================
// 已审核期号过滤（供 R24/R25 使用）
// ============================================================

function filterBetsByPeriods(bets: BetRecord[], excludedPeriods: Set<string>): BetRecord[] {
  if (excludedPeriods.size === 0) return bets;
  return bets.filter(b => {
    const key = `${b.lotteryName || ''}:::${b.issue || ''}`;
    return !excludedPeriods.has(key);
  });
}

function getUnreviewedBets(ctx: RuleContext): BetRecord[] {
  const bets = ctx.bets || [];
  const excluded = ctx.reviewedPeriodKeys;
  if (!excluded || excluded.size === 0) return bets;
  return filterBetsByPeriods(bets, excluded);
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

      const hoursSinceReg = (Date.now() - regTime) / 3600000;
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
    weight: 15,
    group: 'identity',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const depCount = ctx.member?.sumRechargeTimes ?? 0;
      const wdCount = ctx.member?.sumWithdrawTimes ?? 0;
      const amount = parseFloat(String(ctx.order?.amount)) || 0;

      if (depCount <= 1 && wdCount <= 1) {
        return { triggered: true, reason: `首次充值首次提款（充值${depCount}次，提款${wdCount}次）`, score: 15 };
      }
      if (depCount <= 1) {
        return { triggered: true, reason: `首次充值即提款（充值${depCount}次）`, score: 10 };
      }
      if (wdCount <= 1) {
        return { triggered: true, reason: `首次提款（提现${wdCount}次）`, score: 8 };
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
    id: 'R02',
    name: '同登录IP多账号',
    description: '同一登录IP下关联账号（3-20人高风险，>500公共IP忽略）',
    severity: 'HIGH',
    weight: 25,
    group: 'association',
    enabled: false,
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

      const key = `${receivingName}:${receivingCardNo}`;
      const cache = ctx.receivingInfoCache;
      const entry = cache.get(key);
      const memberIds = entry?.data || new Set<string>();
      const currentMemberId = String(order.memberId);

      const otherMemberIds = [...memberIds].filter(id => id !== currentMemberId);
      if (otherMemberIds.length >= 1) {
        return { triggered: true, reason: `收款人 ${receivingName} 关联 ${otherMemberIds.length + 1} 个不同会员`, score: 30 };
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
    description: '提款超过充值 10%轻度异常，30%以上明显套利/洗钱特征',
    severity: 'HIGH',
    weight: 25,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const sumRecharge = absFloat(order?.sumRecharge);
      const sumWithdraw = absFloat(order?.sumWithdraw);

      if (sumRecharge >= 1000) {
        const ratio = sumWithdraw / sumRecharge;
        if (ratio > 1.3) {
          return { triggered: true, reason: `充提回流比 ${(ratio * 100).toFixed(1)}%（充 ${sumRecharge} / 提 ${sumWithdraw}）`, score: 25 };
        }
        if (ratio > 1.1) {
          return { triggered: true, reason: `充提回流比 ${(ratio * 100).toFixed(1)}%（充 ${sumRecharge} / 提 ${sumWithdraw}）`, score: 15 };
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
      const member = ctx.member;
      const latestRechargeTime = parseTimeStr(member?.latestRechargeTime);
      const orderTime = parseTimeStr(order?.createTime || (order as Record<string, unknown>)?.createdAt as string | number | undefined);
      if (!latestRechargeTime || !orderTime) return { triggered: false, score: 0 };

      const diffMinutes = (orderTime - latestRechargeTime) / 60000;
      const amount = parseFloat(String(order?.amount)) || 0;
      const sumRecharge = absFloat(order?.sumRecharge);

      if (diffMinutes >= 0 && diffMinutes < 15 && sumRecharge > 0) {
        const ratio = amount / sumRecharge;
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
    description: '会员备注包含风险关键词',
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
        const fullRemark = [...new Set([remark, memberRemark].filter(Boolean))].join('；');
        const displayRemark = fullRemark.length > 100 ? fullRemark.substring(0, 100) + '...' : fullRemark;
        return { triggered: true, reason: `非常规备注: ${displayRemark}`, score: 25 };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R17a',
    name: '无备注会员',
    description: '会员没有任何备注信息且充值或提款次数<=5，缺乏人工审核标记',
    severity: 'MEDIUM',
    weight: 10,
    group: 'marking',
    enabled: true,
    precondition(ctx: RuleContext): boolean {
      const depCount = ctx.member?.sumRechargeTimes ?? 0;
      const wdCount = ctx.member?.sumWithdrawTimes ?? 0;
      return depCount <= 5 && wdCount <= 5;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const remark = (ctx.member?.remark || '').trim();
      const memberRemark = (ctx.order?.memberRemark || '').trim();

      if (!remark && !memberRemark) {
        return { triggered: true, reason: '会员无任何备注信息', score: 10 };
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
    description: '当日投注额大但盈亏率接近0（几乎不输不赢，对冲洗钱）',
    severity: 'CRITICAL',
    weight: 35,
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
          score: profit >= 0 ? 40 : 35,
        };
      }
      if (pnlRate < 0.02) {
        return {
          triggered: true,
          reason: `投注 ${totalBet.toFixed(0)}，盈亏率 ${(pnlRate * 100).toFixed(2)}%（疑似对冲）`,
          score: 20,
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R22',
    name: '代充代付检测',
    description: '同一支付渠道有多个不同会员充值',
    severity: 'HIGH',
    weight: 25,
    group: 'marking',
    enabled: false,
    evaluate(ctx: RuleContext): RuleResult {
      const cache = ctx.payChannelCache;
      const member = ctx.member;
      const memberId = String(ctx.order?.memberId || '');
      const rechargeOrders = member?.latestRechargeOrder || [];

      const hitSet = new Map<string, number>();
      for (const order of rechargeOrders) {
        const channel = order.paywayName || order.payPlatformCode;
        if (!channel) continue;
        if (hitSet.has(channel)) continue;
        const entry = cache.get(channel);
        const memberIds = entry?.data || new Set<string>();
        const otherMemberIds = [...memberIds].filter(id => id !== memberId);
        if (otherMemberIds.length >= 2) {
          hitSet.set(channel, otherMemberIds.length + 1);
        }
      }

      if (hitSet.size > 0) {
        const details = [...hitSet.entries()].map(([ch, count]) => `${ch}(${count}人)`).join(', ');
        return {
          triggered: true,
          reason: `充值渠道关联多会员: ${details}`,
          score: 25,
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R23',
    name: '异常流水检测',
    description: '当日投注额远超充值额（刷流水/对冲套利）',
    severity: 'HIGH',
    weight: 20,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const bc = ctx.betsCount;
      const order = ctx.order;
      const sumRecharge = absFloat(order?.sumRecharge);

      if (!bc || sumRecharge < 1000) return { triggered: false, score: 0 };

      const totalBet = parseFloat(bc.countAmount || '0');
      if (totalBet < 5000) return { triggered: false, score: 0 };

      const ratio = totalBet / sumRecharge;

      if (ratio > 50) {
        return {
          triggered: true,
          reason: `当日投注 ${totalBet.toFixed(0)} / 充值 ${sumRecharge} = ${ratio.toFixed(1)}x（极度异常流水）`,
          score: 30,
        };
      }
      if (ratio > 20) {
        return {
          triggered: true,
          reason: `当日投注 ${totalBet.toFixed(0)} / 充值 ${sumRecharge} = ${ratio.toFixed(1)}x（异常流水）`,
          score: 20,
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

      if (twoSideViolations.length === 0) {
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
        reason: twoSideViolations.join('\n'),
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

      if (coverageViolations.length === 0) {
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
        reason: coverageViolations.join('\n'),
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
      const bets = ctx.bets || [];
      const issueGroups = ctx.issueGroups || new Map<string, BetRecord[]>();

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
          hits.push(`${key}：${amounts.length} 注，金额浮动 ${(maxDiff * 100).toFixed(0)}%（<50%，疑似规避）`);
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
          reason: `${activeOrders.length} 次电子下注，${totalBet.toFixed(0)}，盈亏率 ${(pnlRate * 100).toFixed(1)}%（刷水可疑）`,
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
    name: '手工补单检测',
    description: '充值记录中存在手工补单/人工加款（remark含手工补单）',
    severity: 'HIGH',
    weight: 20,
    group: 'marking',
    enabled: true,
    precondition(ctx: RuleContext): boolean {
      return (ctx.paymentOrders?.length ?? 0) > 0;
    },
    evaluate(ctx: RuleContext): RuleResult {
      const orders = ctx.paymentOrders || [];
      const manualOrders = orders.filter((o: PaymentOrder) => {
        const remark = o.remark || '';
        return remark.includes('手工补单') || remark.includes('人工补单') || remark.includes('手动补单')
            || remark.includes('人工加款') || remark.includes('手动加款') || remark.includes('手工加款');
      });

      if (manualOrders.length === 0) return { triggered: false, score: 0 };

      const totalAmount = manualOrders.reduce((s: number, o: PaymentOrder) => s + (parseFloat(String(o.amount)) || 0), 0);
      const operators = [...new Set(manualOrders.map((o: PaymentOrder) => o.operatorName).filter(Boolean))];
      const operatorText = operators.length > 0 ? `，操作员: ${operators.join(',')}` : '';

      return {
        triggered: true,
        reason: `${manualOrders.length} 笔手工补单，${totalAmount.toFixed(0)} 元${operatorText}`,
        score: 20,
      };
    },
  },

  {
    id: 'R30',
    name: '低活跃度提现',
    description: '充值或提款次数<5，账号活跃度极低却申请提现（首充首提由R06a覆盖）',
    severity: 'HIGH',
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
          score: 15,
        };
      }
      return { triggered: false, score: 0 };
    },
  },

  {
    id: 'R33',
    name: '无近期充值却提现',
    description: '当天/3天/7天逐级检查充值记录，无充值却提现涉嫌套利',
    severity: 'HIGH',
    weight: 20,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const regTime = parseTimeStr(ctx.member?.createTime || ctx.member?.createdAt);
      if (regTime) {
        const daysSinceReg = (Date.now() - regTime) / 86400000;
        if (daysSinceReg < 3) return { triggered: false, score: 0 };
        if (daysSinceReg < 7) {
          const threeDayTotal = (ctx.manualRecharge3Day ?? 0) + (ctx.thirdPartyRecharge3Day ?? 0);
          if (threeDayTotal > 0) return { triggered: false, score: 0 };
          return { triggered: true, reason: `注册${daysSinceReg.toFixed(1)}天，3天无充值记录却提现`, score: 15 };
        }
      }

      // 1. 当天有人工加款或线上充值 → 不触发
      const todayTotal = (ctx.manualRechargeToday ?? 0) + (ctx.thirdPartyRechargeToday ?? 0);
      if (todayTotal > 0) return { triggered: false, score: 0 };

      // 2. 当天无充值，3天内有充值 → 关注
      const threeDayTotal = (ctx.manualRecharge3Day ?? 0) + (ctx.thirdPartyRecharge3Day ?? 0);
      if (threeDayTotal > 0) {
        return { triggered: true, reason: '当天无充值，3天内有充值记录，需关注', score: 10 };
      }

      // 3. 3天无充值，7天内有充值 → 关注
      const sevenDayTotal = (ctx.manualRecharge7Day ?? 0) + (ctx.thirdPartyRecharge7Day ?? 0);
      if (sevenDayTotal > 0) {
        return { triggered: true, reason: '3天无充值，7天内有充值记录，需关注', score: 15 };
      }

      // 4. 7天无充值 → 高风险
      return { triggered: true, reason: '7天无充值记录却提现，涉嫌套利', score: 20 };
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
      return (ctx.agentRiskScore ?? 0) >= 30;
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
    description: '首次提现金额远超首次充值金额（>1.5x），超出1倍打码量正常范围',
    severity: 'HIGH',
    weight: 25,
    group: 'behavior',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const depCount = ctx.member?.sumRechargeTimes ?? 0;
      const wdCount = ctx.member?.sumWithdrawTimes ?? 0;
      if (depCount !== 1 || wdCount > 0) return { triggered: false, score: 0 };

      const sumRecharge = parseFloat(String(ctx.order?.sumRecharge)) || 0;
      const amount = parseFloat(String(ctx.order?.amount)) || 0;

      if (sumRecharge > 0 && amount > sumRecharge * 1.5) {
        return {
          triggered: true,
          reason: `首提 ${amount.toFixed(0)} > 首充 ${sumRecharge.toFixed(0)}（${(amount / sumRecharge).toFixed(1)}x），超出1倍打码量正常范围`,
          score: 25,
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
      const myBets = ctx.bets || [];
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
      const myBets = ctx.bets || [];
      const myName = ctx.order?.memberName || ctx.member?.memberName || '';
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
      const entries = [...dayBuckets.entries()].sort(([a], [b]) => a.localeCompare(b));
      const recentDays = entries.slice(-3);
      const dailyCounts = recentDays.map(([, c]) => c);
      if (dailyCounts.length < 3) return { triggered: false, score: 0 };
      let ascendingFreq = true;
      for (let i = 1; i < dailyCounts.length; i++) {
        if (dailyCounts[i] < dailyCounts[i - 1]) { ascendingFreq = false; break; }
      }
      if (ascendingFreq && dailyCounts[dailyCounts.length - 1] >= 3) {
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
    description: '注册少于7天的账号申请提现，需高度关注',
    severity: 'HIGH',
    weight: 30,
    group: 'identity',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const member = ctx.member;
      const order = ctx.order;
      const regTime = parseTimeStr(member?.createTime || member?.createdAt);
      if (!regTime) return { triggered: false, score: 0 };

      const daysSinceReg = (Date.now() - regTime) / 86400000;
      const amount = parseFloat(String(order?.amount)) || 0;

      if (daysSinceReg >= 7) return { triggered: false, score: 0 };

      const regDate = formatBeijingTime(regTime);

      if (daysSinceReg < 1) {
        return { triggered: true, reason: `注册不足1天（${regDate}），提现 ${amount.toFixed(0)}`, score: 40 };
      }
      if (daysSinceReg < 3) {
        return { triggered: true, reason: `注册${daysSinceReg.toFixed(1)}天（${regDate}），提现 ${amount.toFixed(0)}`, score: 35 };
      }
      return { triggered: true, reason: `注册${daysSinceReg.toFixed(1)}天（${regDate}），提现 ${amount.toFixed(0)}`, score: 30 };
    },
  },
  {
    id: 'R41',
    name: '提款方式变更',
    description: '本次提款方式与上次提款方式不同，可能账号被盗或转手',
    severity: 'CRITICAL',
    weight: 50,
    group: 'identity',
    enabled: true,
    evaluate(ctx: RuleContext): RuleResult {
      const order = ctx.order;
      const last = ctx.lastWithdrawMethod;
      if (!last) return { triggered: false, score: 0 };

      const currentBank = normalizeChannel(String(order?.receivingBank || '').trim());
      const currentCard = String(order?.receivingCardNo || '').trim();
      if (!currentBank) return { triggered: false, score: 0 };

      const lastBank = normalizeChannel(last.bank);
      const lastCard = last.card;

      // 银行/渠道不同 → 严重风险
      if (currentBank !== lastBank && lastBank) {
        return { triggered: true, reason: `提款渠道变更：上次[${lastBank}] → 本次[${currentBank}]`, score: 50 };
      }

      // 同渠道但卡号不同 → 高风险
      if (currentCard && lastCard && currentCard !== lastCard) {
        return { triggered: true, reason: `提款卡号变更：同渠道[${currentBank}]内换卡`, score: 40 };
      }

      return { triggered: false, score: 0 };
    },
  },
];
