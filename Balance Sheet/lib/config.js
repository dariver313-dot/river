'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isNonNegativeDecimal } = require('./decimal');

const DEFAULT_TEMPLATE = '2026澳门娱乐城.xlsx';

function defaultChannelSetting(name) {
  return {
    rechargeNames: name,
    withdrawNames: name,
    rechargeRate: '0',
    rechargeFixed: '0',
    withdrawRate: '0',
    withdrawFixed: '0',
    note: '',
  };
}

function defaultConfig() {
  return {
    version: 2,
    templateFile: DEFAULT_TEMPLATE,
    pageSize: 100,
    channelSettings: {},
  };
}

function cleanText(value, max, field, errors, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : fallback;
  if (text.length > max) errors.push(`${field}不能超过${max}个字符`);
  return text;
}

function cleanAmount(value, field, errors) {
  const amount = String(value ?? '0').trim() || '0';
  if (!isNonNegativeDecimal(amount)) errors.push(`${field}必须是大于等于 0 的数字`);
  return amount;
}

function validateConfig(input) {
  const errors = [];
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const templateFile = cleanText(source.templateFile, 100, '模板文件', errors, DEFAULT_TEMPLATE);
  if (path.basename(templateFile) !== templateFile || !templateFile.toLowerCase().endsWith('.xlsx')) {
    errors.push('模板文件必须是 templates 文件夹中的 .xlsx 文件');
  }

  const pageSize = Number(source.pageSize);
  if (!Number.isInteger(pageSize) || pageSize < 10 || pageSize > 100) errors.push('单页数量必须是 10 到 100 的整数');

  const rawSettings = source.channelSettings && typeof source.channelSettings === 'object' && !Array.isArray(source.channelSettings)
    ? source.channelSettings
    : {};
  const entries = Object.entries(rawSettings);
  if (entries.length > 160) errors.push('渠道配置不能超过 160 项');

  const channelSettings = {};
  for (const [name, rawValue] of entries) {
    const channelName = cleanText(name, 80, '渠道名称', errors);
    if (!channelName) {
      errors.push('渠道名称不能为空');
      continue;
    }
    const value = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};
    channelSettings[channelName] = {
      rechargeNames: cleanText(value.rechargeNames, 500, `渠道“${channelName}”代收名称`, errors, channelName),
      withdrawNames: cleanText(value.withdrawNames, 500, `渠道“${channelName}”代付名称`, errors, channelName),
      rechargeRate: cleanAmount(value.rechargeRate, `渠道“${channelName}”代收费率`, errors),
      rechargeFixed: cleanAmount(value.rechargeFixed, `渠道“${channelName}”代收固定手续费`, errors),
      withdrawRate: cleanAmount(value.withdrawRate, `渠道“${channelName}”代付费率`, errors),
      withdrawFixed: cleanAmount(value.withdrawFixed, `渠道“${channelName}”代付固定手续费`, errors),
      note: cleanText(value.note, 300, `渠道“${channelName}”备注`, errors),
    };
  }

  return {
    errors,
    config: {
      version: 2,
      templateFile,
      pageSize: Number.isInteger(pageSize) ? pageSize : 100,
      channelSettings,
    },
  };
}

async function loadConfig(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'report-config.json');
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    const result = validateConfig(parsed);
    if (result.errors.length) throw new Error(result.errors.join('；'));
    return result.config;
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultConfig();
    throw new Error(`报表配置文件无效: ${error.message}`);
  }
}

async function saveConfig(dataDir, input) {
  const result = validateConfig(input);
  if (result.errors.length) {
    const error = new Error(result.errors.join('；'));
    error.statusCode = 400;
    throw error;
  }
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'report-config.json');
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(result.config, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
  return result.config;
}

module.exports = { DEFAULT_TEMPLATE, defaultChannelSetting, loadConfig, saveConfig, validateConfig };
