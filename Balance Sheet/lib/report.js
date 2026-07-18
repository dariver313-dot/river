'use strict';

const { calculateFee, isNonNegativeDecimal, sumDecimals } = require('./decimal');
const { defaultChannelSetting } = require('./config');

function normaliseName(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[()（）\-_/\\.·]/g, '')
    .toLocaleLowerCase('zh-CN');
}

function splitNames(value) {
  return String(value || '')
    .split(/[\n,，]/)
    .map(normaliseName)
    .filter(Boolean);
}

function sum(current, amount) {
  return sumDecimals([current, amount]);
}

function feeRule(rate, fixed) {
  const hasRate = rate !== '0';
  const hasFixed = fixed !== '0';
  return {
    mode: hasRate && hasFixed ? 'fixed_plus_percent' : (hasRate ? 'percent' : (hasFixed ? 'fixed' : 'none')),
    percent: rate,
    fixed,
  };
}

function sourceName(order, direction) {
  const value = direction === 'recharge' ? order.payPlatformName : order.receivingBank;
  return String(value || '').trim();
}

function settingFor(config, channelName) {
  return { ...defaultChannelSetting(channelName), ...(config.channelSettings[channelName] || {}) };
}

function buildMatchers(schema, config, direction) {
  return schema.channels.map(channel => {
    const setting = settingFor(config, channel.name);
    const names = splitNames(direction === 'recharge' ? setting.rechargeNames : setting.withdrawNames);
    return { channel, setting, names: new Set(names) };
  });
}

function groupIssues(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.direction}\u0000${row.name}`;
    const current = groups.get(key) || { ...row, count: 0, amount: '0' };
    current.count += 1;
    current.amount = sum(current.amount, row.amount);
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => left.direction.localeCompare(right.direction) || left.name.localeCompare(right.name, 'zh-CN'));
}

function validateAdjustments(entries, channelIds) {
  if (!Array.isArray(entries) || entries.length > 200) throw new Error('补录项目不能超过 200 项');
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || !channelIds.has(entry.channelId)) throw new Error(`第 ${index + 1} 项补录的渠道无效`);
    const values = {};
    for (const key of ['pendingAmount', 'manualRechargeAmount', 'transferOutAmount']) {
      const value = String(entry[key] ?? '0').trim() || '0';
      if (!isNonNegativeDecimal(value)) throw new Error(`第 ${index + 1} 项补录金额无效`);
      values[key] = value;
    }
    const note = String(entry.note || '').trim();
    if (note.length > 300) throw new Error(`第 ${index + 1} 项补录备注不能超过 300 个字符`);
    return { channelId: entry.channelId, ...values, note };
  });
}

function createSummary(channel, setting) {
  return {
    id: channel.id,
    name: channel.name,
    adapter: channel,
    setting,
    rechargeAmount: '0',
    withdrawAmount: '0',
    feeAmount: '0',
    pendingAmount: '0',
    manualRechargeAmount: '0',
    transferOutAmount: '0',
    rechargeCount: 0,
    withdrawCount: 0,
    notes: [],
  };
}

function applyOrders(summaries, matchers, orders, direction, unresolved, ambiguous) {
  for (const order of orders) {
    const name = sourceName(order, direction);
    const normalized = normaliseName(name);
    const matches = normalized ? matchers.filter(matcher => matcher.names.has(normalized)) : [];
    if (matches.length !== 1) {
      (matches.length ? ambiguous : unresolved).push({ direction, name: name || '未返回渠道名称', amount: String(order.amount) });
      continue;
    }
    const { channel, setting } = matches[0];
    const summary = summaries.get(channel.id);
    const amount = String(order.amount);
    if (direction === 'recharge') {
      summary.rechargeAmount = sum(summary.rechargeAmount, amount);
      summary.rechargeCount += 1;
      summary.feeAmount = sum(summary.feeAmount, calculateFee(amount, feeRule(setting.rechargeRate, setting.rechargeFixed)));
    } else {
      summary.withdrawAmount = sum(summary.withdrawAmount, amount);
      summary.withdrawCount += 1;
      summary.feeAmount = sum(summary.feeAmount, calculateFee(amount, feeRule(setting.withdrawRate, setting.withdrawFixed)));
    }
  }
}

function buildReport(schema, config, orders, adjustments = []) {
  const summaries = new Map(schema.channels.map(channel => [channel.id, createSummary(channel, settingFor(config, channel.name))]));
  const unresolved = [];
  const ambiguous = [];
  applyOrders(summaries, buildMatchers(schema, config, 'recharge'), orders.recharge.items, 'recharge', unresolved, ambiguous);
  applyOrders(summaries, buildMatchers(schema, config, 'withdraw'), orders.withdraw.items, 'withdraw', unresolved, ambiguous);

  for (const entry of validateAdjustments(adjustments, new Set(summaries.keys()))) {
    const summary = summaries.get(entry.channelId);
    summary.pendingAmount = sum(summary.pendingAmount, entry.pendingAmount);
    summary.manualRechargeAmount = sum(summary.manualRechargeAmount, entry.manualRechargeAmount);
    summary.transferOutAmount = sum(summary.transferOutAmount, entry.transferOutAmount);
    if (entry.note) summary.notes.push(entry.note);
  }

  const channels = [...summaries.values()].map(summary => ({
    ...summary,
    note: [summary.setting.note, ...summary.notes].filter(Boolean).join('；'),
  }));
  const unresolvedGroups = groupIssues(unresolved);
  const ambiguousGroups = groupIssues(ambiguous);
  return {
    date: orders.recharge.date,
    channels,
    unresolved: unresolvedGroups,
    ambiguous: ambiguousGroups,
    canExport: unresolvedGroups.length === 0 && ambiguousGroups.length === 0,
    sources: orders,
    totals: {
      rechargeAmount: sumDecimals(channels.map(channel => channel.rechargeAmount)),
      withdrawAmount: sumDecimals(channels.map(channel => channel.withdrawAmount)),
      feeAmount: sumDecimals(channels.map(channel => channel.feeAmount)),
    },
  };
}

module.exports = { buildReport, normaliseName, splitNames };
