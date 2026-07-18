import test from 'node:test';
import assert from 'node:assert/strict';
import { rules } from '../rules';
import { buildRiskDataWindows, filterSuccessfulWithdrawals } from '../risk-data-loader';
import { buildLowAmountAlertText, buildRiskAlertText, isTelegramMessageNotModified, withReviewStatus } from '../telegram';
import { computeMainGameType, mapMemberInfo } from '../api-client';
import { shouldRetryAuthRequestError } from '../auth-client';
import { combineMemberRemarks, normalizeMemberRemark } from '../utils';

function rule(id: string) {
  const found = rules.find(item => item.id === id);
  assert.ok(found, `missing rule ${id}`);
  return found;
}

function baseContext(overrides: Record<string, unknown> = {}): any {
  return {
    order: { orderNo: 'w1', memberId: 'm1', memberName: 'user1', amount: 1000, createTime: Date.parse('2026-07-11T04:00:00Z') },
    member: { memberId: 'm1', memberName: 'user1', sumRechargeTimes: 10, sumWithdrawTimes: 5 },
    bets: [],
    dailyBets: [],
    withdrawals: [],
    relatedByLoginIp: [],
    relatedByLoginDevice: [],
    relatedByLoginIpCount: 0,
    relatedByLoginDeviceCount: 0,
    agentWithdrawCache: new Map(),
    thirdGameBets: [],
    paymentOrders: [],
    accountChanges: [],
    betsCount: null,
    manualRechargeToday: 0,
    manualRecharge3Day: 0,
    manualRecharge7Day: 0,
    thirdPartyRechargeToday: 0,
    thirdPartyRecharge3Day: 0,
    thirdPartyRecharge7Day: 0,
    associatedMemberBets: new Map(),
    tzOffset: 8,
    ...overrides,
  };
}

test('auth client does not retry an explicitly non-retryable upstream error', () => {
  assert.equal(shouldRetryAuthRequestError({ response: { status: 502, data: { retryable: false } } }), false);
  assert.equal(shouldRetryAuthRequestError({ retryable: false }), false);
  assert.equal(shouldRetryAuthRequestError({ response: { status: 502, data: { retryable: true } } }), true);
  assert.equal(shouldRetryAuthRequestError({ response: { status: 403 } }), false);
});

test('lottery history is a rolling seven-day window ending at withdrawal time', () => {
  const orderTime = Date.parse('2026-07-11T07:30:00Z');
  const windows = buildRiskDataWindows(orderTime);
  assert.equal(windows.lotteryHistory.end, orderTime);
  assert.equal(windows.lotteryHistory.end - windows.lotteryHistory.start, 7 * 24 * 3600 * 1000);
  assert.equal(windows.orderDay.end, orderTime);
});

test('main game display accepts aggregate aliases and game-type rows', () => {
  assert.equal(computeMainGameType({ liveBetAmount: '1200', lotteryBetAmount: '800' }), '真人类游戏');
  assert.equal(computeMainGameType({
    items: [
      { gameTypeName: '彩票', betAmount: '900' },
      { gameTypeName: '真人', validBetAmount: '1500' },
    ],
  }), '真人类游戏');
});

test('member mapping preserves VIP0 and rejects invalid money values', () => {
  const member = mapMemberInfo({
    memberId: 'm1', memberName: 'user1', vipLevel: 0, levelId: '29',
    sumRecharge: 'not-a-number', sumWithdraw: '-12.5', sumRolling: 'bad',
  });
  assert.equal(member.vipLevel, 0);
  assert.equal(member.sumRecharge, undefined);
  assert.equal(member.sumWithdraw, 12.5);
  assert.equal(member.sumRolling, undefined);
});

test('withdrawal history accepts only success statuses 4 and 8 and excludes current order', () => {
  const result = filterSuccessfulWithdrawals([
    { orderNo: 'current', status: 4, createTime: 4 },
    { orderNo: 'a', status: 4, createTime: 3 },
    { orderNo: 'b', status: 8, createTime: 2 },
    { orderNo: 'c', status: 3, createTime: 1 },
  ], 'current');
  assert.deepEqual(result.map(item => item.orderNo), ['a', 'b']);
});

test('quick withdrawal uses latest successful recharge amount and time', () => {
  const result = rule('R12').evaluate(baseContext({
    latestRechargeTime: Date.parse('2026-07-11T03:50:00Z'),
    latestRechargeAmount: 1000,
  }));
  assert.equal(result.triggered, true);
  assert.equal(result.score, 35);
  assert.match(result.reason || '', /10 分钟/);
});

test('manual recharge rule reads account changes', () => {
  const result = rule('R29').evaluate(baseContext({
    accountChanges: [
      { amount: 88, operatorName: '客服A', createTime: Date.parse('2026-07-10T04:00:00Z') },
      { amount: 12, operatorName: '客服A', createTime: Date.parse('2026-07-11T02:00:00Z') },
    ],
  }));
  assert.equal(result.triggered, true);
  assert.equal(result.score, 10);
  assert.match(result.reason || '', /2 笔 \/ 100 元/);

  const bonusOnly = rule('R29').evaluate(baseContext({
    accountChanges: [
      { amount: 88, operatorName: '客服A', transDetail: '礼金', operatorRemark: '推荐彩金' },
    ],
  }));
  assert.equal(bonusOnly.triggered, false);
});

test('withdrawal frequency checks three consecutive Beijing dates', () => {
  const withdrawals = [
    { createTime: Date.parse('2026-07-09T04:00:00Z'), amount: 10 },
    { createTime: Date.parse('2026-07-10T04:00:00Z'), amount: 10 },
    { createTime: Date.parse('2026-07-10T05:00:00Z'), amount: 10 },
    { createTime: Date.parse('2026-07-11T01:00:00Z'), amount: 10 },
    { createTime: Date.parse('2026-07-11T02:00:00Z'), amount: 10 },
    { createTime: Date.parse('2026-07-11T03:00:00Z'), amount: 10 },
  ];
  const result = rule('R35').evaluate(baseContext({ withdrawals }));
  assert.equal(result.triggered, true);
  assert.match(result.reason || '', /1→2→3/);
});

test('receiving-name change is stronger than channel-only change', () => {
  const nameChange = rule('R41').evaluate(baseContext({
    order: { receivingBank: 'ABpay', receivingName: '李四', receivingCardNo: '1' },
    lastWithdrawMethod: { bank: 'JDpay', name: '张三', card: '2' },
  }));
  assert.equal(nameChange.score, 30);

  const channelChange = rule('R41').evaluate(baseContext({
    order: { receivingBank: 'ABpay', receivingName: '张三', receivingCardNo: '1' },
    lastWithdrawMethod: { bank: 'JDpay', name: '张三', card: '1' },
  }));
  assert.equal(channelChange.score, 10);
});

test('new-account and missing-remark signals remain auxiliary', () => {
  const newAccount = rule('R40').evaluate(baseContext({
    member: { memberId: 'm1', memberName: 'user1', createTime: Date.now() - 2 * 3600000 },
    order: { amount: 1000 },
  }));
  const noRemark = rule('R17a').evaluate(baseContext({
    member: { memberId: 'm1', memberName: 'user1', sumRechargeTimes: 2, sumWithdrawTimes: 1 },
    order: {},
  }));
  assert.equal(newAccount.score, 0);
  assert.equal(newAccount.presentation, 'support');
  assert.equal(noRemark.score, 0);
});

test('IP association chooses stronger small cluster over a large shared exit', () => {
  const result = rule('R02D').evaluate(baseContext({
    dailyLoginIpAssociations: [
      { value: '1.1.1.1', memberNames: ['user1', ...Array.from({ length: 99 }, (_, i) => `u${i}`)], otherMemberNames: Array.from({ length: 99 }, (_, i) => `u${i}`), accountCount: 100 },
      { value: '2.2.2.2', memberNames: ['user1', 'a', 'b'], otherMemberNames: ['a', 'b'], accountCount: 3 },
    ],
    dailyLoginDeviceAssociations: [],
  }));
  assert.equal(result.triggered, true);
  assert.equal(result.score, 20);
  assert.match(result.reason || '', /2\.2\.2\.2/);
});

test('same account on both device and IP is merged into one stronger device signal', () => {
  const ctx = baseContext({
    dailyLoginIpAssociations: [{ value: '2.2.2.2', memberNames: ['user1', 'a'], otherMemberNames: ['a'], accountCount: 2 }],
    dailyLoginDeviceAssociations: [{ value: 'android:abc', memberNames: ['user1', 'a'], otherMemberNames: ['a'], accountCount: 2 }],
  });
  assert.equal(rule('R02D').evaluate(ctx).triggered, false);
  const device = rule('R03D').evaluate(ctx);
  assert.equal(device.score, 30);
  assert.match(device.reason || '', /同时命中同IP/);
});

test('R26 ignores lottery issues that were already reviewed', () => {
  const bets = Array.from({ length: 10 }, () => ({
    lotteryName: '1分快三', issue: '20260714001', playClassName: '和值', amount: 10,
  }));
  const issueGroups = new Map([['1分快三 20260714001 和值', bets]]);
  assert.equal(rule('R26').evaluate(baseContext({ issueGroups })).triggered, true);
  assert.equal(
    rule('R26').evaluate(baseContext({
      issueGroups,
      reviewedPeriodKeys: new Set(['1分快三:::20260714001:::和值']),
    })).triggered,
    false,
  );
});

test('alert is compact and limits game details to three', () => {
  const reason = Array.from({ length: 5 }, (_, index) => `1分快三 2026071100${index} 07-11 和值 金额10：单 - 双（对打）`).join('\n');
  const text = buildRiskAlertText({
    riskLevel: 'CRITICAL',
    totalScore: 55,
    memberName: 'user1',
    proxyCode: 'agent1',
    balance: 100,
    depositCount: 2,
    withdrawCount: 1,
    rechargeWithdrawDiff: -100,
    rechargeAmount: 1000,
    withdrawAmount: 1100,
    profitLoss: 200,
    estimatedProfitLoss: false,
    receivingBank: 'ABpay',
    receivingName: '张三',
    registerTime: '2026-07-01 12:00:00',
    amount: 500,
    triggeredRules: [{ id: 'R24', name: '彩票同期双向下注', severity: 'CRITICAL', reason, presentation: 'core' }],
    dataIssues: [],
  });
  assert.match(text, /💲 提款：500  余额：100  净赢: 200\n💰 充1,000（2）\/提1,100（1）/);
  assert.doesNotMatch(text, /📅 注册：/);
  assert.match(text, /另有 2 条隐藏/);
  assert.doesNotMatch(text, /20260711003/);
  assert.doesNotMatch(text, /数据状态：完整/);
  assert.doesNotMatch(text, /核心问题|辅助关注/);
});

test('high-score evidence appears before supporting signals without blank lines', () => {
  const text = buildRiskAlertText({
    riskLevel: 'HIGH',
    totalScore: 40,
    memberName: 'user1',
    proxyCode: 'agent1',
    balance: 100,
    depositCount: 2,
    withdrawCount: 1,
    rechargeWithdrawDiff: 200,
    rechargeAmount: 1000,
    withdrawAmount: 800,
    profitLoss: -100,
    estimatedProfitLoss: false,
    receivingBank: '银行卡',
    receivingName: '张三',
    registerTime: '2026-07-01 12:00:00',
    amount: 800,
    triggeredRules: [
      { id: 'R12', name: '充值后快速提现', severity: 'CRITICAL', reason: '充值后 8 分钟提现，回流比 80%', score: 35, presentation: 'core' },
      { id: 'R30', name: '低活跃度提现', severity: 'MEDIUM', reason: '偏低活跃度：充值 2 次，提款 1 次', score: 8, presentation: 'support' },
    ],
    dataIssues: [],
  });
  assert.match(text, /🟡高风险 40分/);
  assert.match(text, /🔴 充值后 8 分钟提现，回流比 80%\n🟡 偏低活跃度/);
  assert.doesNotMatch(text, /核心问题|辅助关注/);
});

test('member remark is neutral context and ignores punctuation-only content', () => {
  const text = buildRiskAlertText({
    riskLevel: 'HIGH', totalScore: 40, memberName: 'user1', proxyCode: 'agent1',
    balance: 100, depositCount: 2, withdrawCount: 1, rechargeWithdrawDiff: 200,
    rechargeAmount: 1000, withdrawAmount: 800, profitLoss: -100, estimatedProfitLoss: false,
    receivingBank: '银行卡', receivingName: '张三', registerTime: '2026-07-01 12:00:00', amount: 800,
    triggeredRules: [{ id: 'R12', name: '充值后快速提现', severity: 'CRITICAL', reason: '充值后 8 分钟提现，回流比 80%', score: 35, presentation: 'core' }],
    remark: '  卡钱包  ', dataIssues: [],
  });
  assert.match(text, /🔴 充值后 8 分钟提现，回流比 80%\n📝 备注：卡钱包/);
  assert.equal(normalizeMemberRemark('A'), 'A');
  assert.equal(normalizeMemberRemark(' --- '), '');
  assert.equal(combineMemberRemarks(['卡钱包', ' 卡钱包 ', '活动备注']), '卡钱包；活动备注');
  assert.match(text, /💲 提款：800  余额：100  净输: 100/);
});

test('low-risk alert includes the main game type when available', () => {
  const text = buildLowAmountAlertText({
    memberName: 'member-a', proxyCode: 'agent-a', balance: 101.31,
    depositCount: 109, withdrawCount: 63, rechargeWithdrawDiff: 5400,
    rechargeAmount: 37900, withdrawAmount: 32500,
    receivingBank: 'ABpay', receivingName: '张三',
    registerTime: '2026-07-14 12:00:00', amount: 100,
    mainGameType: '棋牌类游戏',
    remark: '234 365领了别人一百红包需要退回1月9号 不给群码！！！',
  });
  assert.match(text, /💲 提款：100  余额：101\.31  净输: 5,298\.69\n💰 充37,900（109）\/提32,500（63）\n🎮 棋牌  🏦 ABpay·张三/);
  assert.doesNotMatch(text, /📅 注册：/);
  assert.match(text, /🏦 ABpay·张三\n\n📝 备注：234 365领了别人一百红包需要退回1月9号 不给群码！！！/);
});

test('registration date is shown only for registration-related rules', () => {
  const text = buildRiskAlertText({
    riskLevel: 'MEDIUM', totalScore: 15, memberName: 'member-a', proxyCode: 'agent-a',
    balance: 100, depositCount: 1, withdrawCount: 0, rechargeWithdrawDiff: 200,
    rechargeAmount: 200, withdrawAmount: 0, profitLoss: -100, estimatedProfitLoss: false,
    receivingBank: 'ABpay', receivingName: '张三', registerTime: '2026-07-13 12:00:00', amount: 100,
    triggeredRules: [{ id: 'R40', name: '新注册账号提现', severity: 'MEDIUM', reason: '注册1.0天（2026/07/13 12:00:00），提现100' }],
    dataIssues: [],
  });
  assert.match(text, /📅 注册：2026-7-13 12:00/);
});

test('review status stays in the title without changing the alert body', () => {
  const original = '🟡中等风险 15分 · 凌晨提款\n\n👤 账号: member-a\n📝 备注：测试';
  const reviewed = withReviewStatus(original, '已自动审核');
  assert.equal(reviewed, '🟡中等风险 15分 · 凌晨提款 · 已自动审核\n\n👤 账号: member-a\n📝 备注：测试');
  assert.equal(withReviewStatus(reviewed, '已自动审核'), reviewed);
});

test('Telegram repeated message edit is treated as an already successful update', () => {
  assert.equal(isTelegramMessageNotModified(new Error('400: Bad Request: message is not modified')), true);
  assert.equal(isTelegramMessageNotModified(new Error('400: Bad Request: message to edit not found')), false);
});
