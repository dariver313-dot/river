const u = require('./utils');

// Bot 用户名（由 app.js 在 getMe() 后设置，用于匹配 /command@botname 格式）
let botUsername = '';

function setBotUsername(name) {
  botUsername = name || '';
}

// ── 规则校验 ──

function validateRuleValue(ruleType, ruleValue) {
  if (ruleType === 'absolute') {
    const date = new Date(ruleValue + 'T00:00:00');
    const [y, m, d] = ruleValue.split('-').map(Number);
    if (isNaN(date.getTime()) || date.getFullYear() !== y || (date.getMonth() + 1) !== m || date.getDate() !== d) {
      return '无效的日期格式，请检查年月日是否合法';
    }
    const { todayStr } = u.getNow();
    if (ruleValue < todayStr) {
      return '不能创建过去日期的提醒';
    }
  } else if (ruleType === 'monthly') {
    const day = parseInt(ruleValue);
    if (day < 1 || day > 31) {
      return '每月日期必须在 1-31 之间';
    }
  } else if (ruleType === 'weekly') {
    const w = parseInt(ruleValue);
    if (w < 1 || w > 7) {
      return '每周日期必须在 1-7 之间（1=周一…7=周日）';
    }
  } else if (ruleType === 'yearly') {
    const [m, d] = ruleValue.split('-').map(Number);
    if (m < 1 || m > 12) return '月份必须在 1-12 之间';
    if (d < 1 || d > 31) return '日期必须在 1-31 之间';
    // 注意：用闰年(2024)校验，因此 02-29 可以通过验证
    // 非闰年时，02-29 的实际触发日期会降级为 02-28（由 isDateMatch 中的 Math.min 处理）
    const daysInMonth = new Date(2024, m, 0).getDate();
    if (d > daysInMonth) {
      return `${m} 月最多只有 ${daysInMonth} 天，${d} 号无效`;
    }
  }
  return null;
}

// ── 规则解析 ──

/**
 * 将用户输入的规则字符串解析为 {ruleType, ruleValue, ruleTime}
 * 支持的格式：
 *   YYYY-MM-DD[@HH:MM]  → 绝对日期
 *   M-D[@HH:MM]          → 每月
 *   MM-DD[@HH:MM]        → 每年
 *   HH:MM                → 每天
 *   W-D[@HH:MM]          → 每周 (1=周一…7=周日)
 */
function parseRule(rule) {
  let ruleType = null, ruleValue = null, ruleTime = null;

  if (rule.match(/^\d{4}-\d{2}-\d{2}(@\d{1,2}:\d{2})?$/)) {
    ruleType = 'absolute';
    const parts = rule.split('@');
    ruleValue = parts[0];
    if (parts[1]) {
      const err = u.validateTimeStr(parts[1]);
      if (err) return { error: err };
      ruleTime = u.normalizeTimeStr(parts[1]);
    } else {
      ruleTime = '00:00';
    }
  } else if (rule.match(/^M-\d{1,2}(@\d{1,2}:\d{2})?$/)) {
    ruleType = 'monthly';
    const parts = rule.substring(2).split('@');
    ruleValue = parts[0];
    if (parts[1]) {
      const err = u.validateTimeStr(parts[1]);
      if (err) return { error: err };
      ruleTime = u.normalizeTimeStr(parts[1]);
    } else {
      ruleTime = '00:00';
    }
  } else if (rule.match(/^\d{2}-\d{2}(@\d{1,2}:\d{2})?$/)) {
    ruleType = 'yearly';
    const parts = rule.split('@');
    ruleValue = parts[0];
    if (parts[1]) {
      const err = u.validateTimeStr(parts[1]);
      if (err) return { error: err };
      ruleTime = u.normalizeTimeStr(parts[1]);
    } else {
      ruleTime = '00:00';
    }
  } else if (rule.match(/^\d{1,2}:\d{2}$/)) {
    ruleType = 'daily';
    const err = u.validateTimeStr(rule);
    if (err) return { error: err };
    ruleValue = u.normalizeTimeStr(rule);
    ruleTime = null;
  } else if (rule.match(/^W-[1-7](@\d{1,2}:\d{2})?$/)) {
    ruleType = 'weekly';
    const parts = rule.substring(2).split('@');
    ruleValue = parts[0];
    if (parts[1]) {
      const err = u.validateTimeStr(parts[1]);
      if (err) return { error: err };
      ruleTime = u.normalizeTimeStr(parts[1]);
    } else {
      ruleTime = '00:00';
    }
  }

  if (!ruleType) return null;

  const validationError = validateRuleValue(ruleType, ruleValue);
  if (validationError) return { error: validationError };

  return { ruleType, ruleValue, ruleTime };
}

// ── 重复参数解析 ──

function parseRepeatParams(parts, startIdx) {
  for (let i = startIdx; i < parts.length; i++) {
    const token = parts[i];
    // every 30m 格式
    if (token.toLowerCase() === 'every' && i + 1 < parts.length && parts[i + 1].match(/^\d+m$/i)) {
      const numMatch = parts[i + 1].match(/^(\d+)m$/i);
      if (numMatch) {
        const minutes = parseInt(numMatch[1]);
        if (minutes <= 0) return { repeatMinutes: 0 };
        return { repeatMinutes: minutes };
      }
    }
    // every30m 格式
    if (token.match(/^every\d+m$/i)) {
      const match = token.match(/^every(\d+)m$/i);
      if (match) {
        const minutes = parseInt(match[1]);
        if (minutes <= 0) return { repeatMinutes: 0 };
        return { repeatMinutes: minutes };
      }
    }
  }
  return { repeatMinutes: 0 };
}

// ── 时间令牌解析 ──

function extractTimeToken(parts) {
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    if (token.match(/^@\d{1,2}:\d{2}$/)) {
      const err = u.validateTimeStr(token.substring(1));
      if (err) return { error: err };
      return { timeStr: u.normalizeTimeStr(token.substring(1)) };
    }
  }
  return { timeStr: null };
}

// ── 提醒命令解析 ──

function parseReminderParts(parts) {
  let frontUserName = null;
  let idx = 0;

  // 前导 @用户名
  if (parts[0] && parts[0].startsWith('@') && !parts[0].match(/^@\d{1,2}:\d{2}$/)) {
    frontUserName = parts[0];
    idx = 1;
  }
  if (parts.length < idx + 2) return null;

  const name = parts[idx];
  const rule = parts[idx + 1];

  // 末尾 @用户名（从 parts 中移除，以免干扰后续解析）
  let tailUserName = null;
  if (parts.length > idx + 2) {
    const lastPart = parts[parts.length - 1];
    if (lastPart.startsWith('@') && !lastPart.match(/^@\d{1,2}:\d{2}$/)) {
      tailUserName = lastPart;
      parts = parts.slice(0, -1);
    }
  }

  const { repeatMinutes } = parseRepeatParams(parts, idx + 2);
  const { timeStr: extractedTime, error } = extractTimeToken(parts);

  if (error) return { error };

  // 合并前导和末尾的 @用户名
  let allUserNames = [];
  if (frontUserName) {
    allUserNames.push(...u.parseTargetUsersFromText(frontUserName));
  }
  if (tailUserName) {
    allUserNames.push(...u.parseTargetUsersFromText(tailUserName));
  }

  const parsedRule = parseRule(rule);
  if (!parsedRule) return null;
  if (parsedRule.error) return { error: parsedRule.error };

  // 如果命令中通过 @HH:MM 令牌指定了时间，覆盖规则中的默认时间
  if (extractedTime && parsedRule.ruleType !== 'daily') {
    parsedRule.ruleTime = extractedTime;
  }

  const targetUserName = allUserNames.length > 0 ? JSON.stringify([...new Set(allUserNames)]) : null;

  return { name, targetUserName, ...parsedRule, repeatMinutes };
}

function parseRemindCommand(text, mentionedUserInfo) {
  let parts = text.split(/\s+/);
  if (parts[0] !== '/remind' && parts[0] !== `/remind@${botUsername}`) return null;
  parts = parts.slice(1);

  const parsed = parseReminderParts(parts);
  if (!parsed) return null;
  if (parsed.error) return { error: parsed.error };

  let result = { ...parsed, targetUserId: mentionedUserInfo.targetUserId };

  // 如果文本中没有 @用户 但消息实体中有 mention，使用实体的用户名
  if (!parsed.targetUserName && mentionedUserInfo.targetUserName) {
    result.targetUserName = JSON.stringify([mentionedUserInfo.targetUserName]);
  }

  return result;
}

function parseEditCommand(text) {
  let parts = text.split(/\s+/);
  if (parts[0] !== '/edit' && parts[0] !== `/edit@${botUsername}`) return null;
  parts = parts.slice(1);

  if (parts.length < 2) return null;

  const nameOrId = parts[0];
  const rule = parts[1];

  const parsedRule = parseRule(rule);
  if (!parsedRule) return null;
  if (parsedRule.error) return { error: parsedRule.error };

  const { repeatMinutes } = parseRepeatParams(parts, 2);
  const { timeStr: extractedTime, error } = extractTimeToken(parts);

  if (error) return { error };

  if (extractedTime && parsedRule.ruleType !== 'daily') {
    parsedRule.ruleTime = extractedTime;
  }

  return { nameOrId, ...parsedRule, repeatMinutes };
}

function parseBatchLine(line) {
  const parts = line.trim().split(/\s+/);
  const parsed = parseReminderParts(parts);
  if (!parsed) return null;
  if (parsed.error) return { error: parsed.error };
  // 批量模式下 Telegram mention 实体不可用
  return { ...parsed, targetUserId: null };
}

module.exports = {
  setBotUsername,
  validateRuleValue,
  parseRule,
  parseRepeatParams,
  extractTimeToken,
  parseReminderParts,
  parseRemindCommand,
  parseEditCommand,
  parseBatchLine,
};
