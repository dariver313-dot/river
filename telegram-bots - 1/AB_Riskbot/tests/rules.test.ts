import assert from 'node:assert/strict';
import test from 'node:test';
import { rules } from '../rules';
import type { RuleContext } from '../rule-types';
import { calculateCurrentWithdrawalPresentation } from '../rule-engine';
import { buildRiskAlertText, isTelegramMessageNotModified, withReviewStatus } from '../telegram';
import { combineMemberRemarks, normalizeMemberRemark } from '../utils';

function rule(id: string) {
  const found = rules.find(item => item.id === id);
  assert.ok(found, `missing rule ${id}`);
  return found;
}

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    order: {
      orderNo: 'WD-1',
      status: 1,
      amount: 1000,
      memberId: 'member-1',
      memberName: 'member-a',
      createTime: '2026-07-13 12:00:00',
    },
    member: { memberId: 'member-1', memberName: 'member-a', sumRechargeTimes: 5, sumWithdrawTimes: 5 },
    bets: [],
    withdrawals: [],
    relatedByLoginIp: [],
    relatedByLoginDevice: [],
    relatedByLoginIpCount: 0,
    relatedByLoginDeviceCount: 0,
    agentWithdrawCache: {} as RuleContext['agentWithdrawCache'],
    paymentOrders: [],
    betsCount: null,
    manualRechargeToday: 0,
    manualRecharge3Day: 0,
    manualRecharge7Day: 0,
    thirdPartyRechargeToday: 0,
    thirdPartyRecharge3Day: 0,
    thirdPartyRecharge7Day: 0,
    associatedMemberBets: new Map(),
    ...overrides,
  };
}

test('R14 only uses confirmed receiving associations supplied by the evaluator', () => {
  const result = rule('R14').evaluate(context({ receivingAssociations: ['member-b', 'member-c'] }));
  assert.equal(result.triggered, true);
  assert.equal(result.score, 30);
  assert.match(result.reason || '', /member-b member-c/);
});

test('R30 flags either low deposit or withdrawal activity', () => {
  const result = rule('R30').evaluate(context({
    member: { memberId: 'member-1', memberName: 'member-a', sumRechargeTimes: 5, sumWithdrawTimes: 2 },
  }));
  assert.equal(result.triggered, true);
  assert.equal(result.score, 8);
});

test('funds presentation adds the current pending withdrawal exactly once', () => {
  const funds = calculateCurrentWithdrawalPresentation(920, 810, 2, 700);
  assert.deepEqual(funds, {
    rechargeAmount: 920,
    withdrawAmount: 1510,
    withdrawCount: 3,
    rechargeWithdrawDiff: -590,
  });

  const text = buildRiskAlertText({
    riskLevel: 'HIGH', totalScore: 48, memberName: 'fei203888', proxyCode: 'lixin555',
    balance: 58.58, depositCount: 4, withdrawCount: funds.withdrawCount,
    rechargeWithdrawDiff: funds.rechargeWithdrawDiff, totalRecharge: funds.rechargeAmount, totalWithdraw: funds.withdrawAmount,
    receivingBank: '988pay', receivingName: '******', registerTime: '', amount: 700, triggeredRules: [],
  });
  assert.match(text, /💲 提款：700  余额：58\.58  净赢: 648\.58/);
  assert.match(text, /💰 充920（4）\/提1,510（3）/);
});

test('R41 compares only versioned fingerprints from successful withdrawals', () => {
  const result = rule('R41').evaluate(context({
    lastWithdrawMethod: { bank: 'ABpay', name: 'name-fingerprint-a', card: 'card-fingerprint-a', version: 2 },
    currentWithdrawMethod: { bank: 'ABpay', name: 'name-fingerprint-b', card: 'card-fingerprint-a', version: 2 },
  }));
  assert.equal(result.triggered, true);
  assert.equal(result.score, 30);
  assert.match(result.reason || '', /收款人变更/);
});

test('R41 ignores unversioned legacy profile data to avoid false positives', () => {
  const result = rule('R41').evaluate(context({
    lastWithdrawMethod: { bank: 'ABpay', name: 'legacy-name', card: 'legacy-card' },
    currentWithdrawMethod: { bank: 'ABpay', name: 'name-fingerprint-b', card: 'card-fingerprint-a', version: 2 },
  }));
  assert.equal(result.triggered, false);
});

test('R33 is anchored to the withdrawal timestamp instead of the current server clock', () => {
  const result = rule('R33').evaluate(context({
    order: {
      orderNo: 'WD-2', status: 1, amount: 1000, memberId: 'member-1', memberName: 'member-a', createTime: '2026-07-13 12:00:00',
    },
    member: {
      memberId: 'member-1', memberName: 'member-a', createTime: '2026-07-01 12:00:00', sumRechargeTimes: 5, sumWithdrawTimes: 2,
    },
  }));
  assert.equal(result.triggered, true);
  assert.match(result.reason || '', /近7天无充值/);

  const newMember = rule('R33').evaluate(context({
    member: { memberId: 'member-1', memberName: 'member-a', createTime: '2026-07-10 12:00:00', sumRechargeTimes: 1, sumWithdrawTimes: 0 },
  }));
  assert.equal(newMember.triggered, true);
  assert.equal(newMember.score, 0);
});

test('R26 ignores lottery issues that were already reviewed', () => {
  const bets = Array.from({ length: 10 }, () => ({
    lotteryName: '1分快三', issue: '20260714001', playClassName: '和值', amount: 10,
  }));
  const issueGroups = new Map([['1分快三 20260714001 和值', bets]]);
  assert.equal(rule('R26').evaluate(context({ issueGroups })).triggered, true);
  assert.equal(
    rule('R26').evaluate(context({
      issueGroups,
      reviewedPeriodKeys: new Set(['1分快三:::20260714001:::和值']),
    })).triggered,
    false,
  );
});

test('member remark is neutral context and ignores punctuation-only content', () => {
  const text = buildRiskAlertText({
    riskLevel: 'HIGH', totalScore: 40, memberName: 'member-a', proxyCode: 'agent-a',
    balance: 100, depositCount: 5, withdrawCount: 2, rechargeWithdrawDiff: 200,
    totalRecharge: 1000, totalWithdraw: 800, receivingBank: 'ABpay', receivingName: '张三',
    registerTime: '2026-07-13 12:00:00', amount: 800,
    triggeredRules: [{ id: 'R12', name: '充值后快速提现', severity: 'HIGH', reason: '充值后 8 分钟提现，回流比 80%' }],
    remark: '  卡钱包  ',
  });
  assert.match(text, /🟠 充值后 8 分钟提现，回流比 80%\n📝 备注：卡钱包/);
  assert.equal(normalizeMemberRemark('A'), 'A');
  assert.equal(normalizeMemberRemark(' --- '), '');
  assert.equal(combineMemberRemarks(['卡钱包', ' 卡钱包 ', '活动备注']), '卡钱包；活动备注');
  assert.match(text, /💲 提款：800  余额：100  净输: 100/);
  assert.match(text, /💰 充1,000（5）\/提800（2）/);
  assert.doesNotMatch(text, /📅 注册：/);
});

test('remark is separated from member details when no rule is triggered', () => {
  const text = buildRiskAlertText({
    riskLevel: 'LOW', totalScore: 0, memberName: 'member-a', proxyCode: 'agent-a',
    balance: 101.31, depositCount: 1, withdrawCount: 0, rechargeWithdrawDiff: 200,
    totalRecharge: 200, totalWithdraw: 0, receivingBank: 'ABpay', receivingName: '张三',
    registerTime: '2026-07-14 12:00:00', amount: 100, triggeredRules: [],
    remark: '234 365领了别人一百红包需要退回1月9号 不给群码！！！',
  });
  assert.match(text, /💲 提款：100  余额：101\.31  净输: 98\.69\n💰 充200（1）\/提0（0）\n🏦 提款方式: ABpay·张三\n\n📝 备注：234 365领了别人一百红包需要退回1月9号 不给群码！！！/);
});

test('registration date is shown only for registration-related rules', () => {
  const text = buildRiskAlertText({
    riskLevel: 'MEDIUM', totalScore: 15, memberName: 'member-a', proxyCode: 'agent-a',
    balance: 100, depositCount: 1, withdrawCount: 0, rechargeWithdrawDiff: 200,
    totalRecharge: 200, totalWithdraw: 0, receivingBank: 'ABpay', receivingName: '张三',
    registerTime: '2026-07-13 12:00:00', amount: 100,
    triggeredRules: [{ id: 'R40', name: '新注册账号提现', severity: 'MEDIUM', reason: '注册1.0天（2026/07/13 12:00:00），提现100' }],
  });
  assert.match(text, /📅 注册：2026-7-13 12:00/);
});

test('review status stays in the title without changing the alert body', () => {
  const original = '🟡中等风险 15分 · 凌晨提款\n\n👤 账号: member-a\n📝 备注：测试';
  const reviewed = withReviewStatus(original, '已人工审核');
  assert.equal(reviewed, '🟡中等风险 15分 · 凌晨提款 · 已人工审核\n\n👤 账号: member-a\n📝 备注：测试');
  assert.equal(withReviewStatus(reviewed, '已人工审核'), reviewed);
});

test('Telegram repeated message edit is treated as an already successful update', () => {
  assert.equal(isTelegramMessageNotModified(new Error('400: Bad Request: message is not modified')), true);
  assert.equal(isTelegramMessageNotModified(new Error('400: Bad Request: message to edit not found')), false);
});
