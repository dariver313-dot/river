// ── 常量 ──
const CHECK_INTERVAL_SECONDS = 30;
const TG_MSG_MAX_LENGTH = 4096;
const WEEKDAY_MAP = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' };
const WEEKDAY_EN_TO_ISO = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const PAGE_SIZE = 5;
const RATE_LIMIT_MS = 1000;

// ── 格式化器（模块级，由 initUtils 初始化）──
let formatters;
let TIMEZONE;

function initUtils(timezone) {
  TIMEZONE = timezone;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch (e) {
    console.error(`❌ 无效的时区: ${timezone}，请设置正确的 TIMEZONE 环境变量`);
    process.exit(1);
  }
  formatters = {
    datetime: new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, hourCycle: 'h23',
    }),
    weekday: new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    }),
  };
}

function getTimezone() {
  return TIMEZONE;
}

// ── 日期/时间工具 ──

function getNow() {
  const now = new Date();
  const parts = formatters.datetime.formatToParts(now);
  let year, month, day, hour, minute, second;
  for (const p of parts) {
    if (p.type === 'year') year = parseInt(p.value);
    if (p.type === 'month') month = parseInt(p.value);
    if (p.type === 'day') day = parseInt(p.value);
    if (p.type === 'hour') hour = parseInt(p.value) % 24; // 处理 24:00 → 00:00
    if (p.type === 'minute') minute = parseInt(p.value);
    if (p.type === 'second') second = parseInt(p.value);
  }
  const todayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const weekdayStr = formatters.weekday.format(now);
  const weekday = WEEKDAY_EN_TO_ISO[weekdayStr] || 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const timestamp = Math.floor(now.getTime() / 1000);
  const todayStartTs = timestamp - (hour * 3600 + minute * 60 + second);
  return { year, month, day, hour, minute, second, timestamp, todayStr, weekday, daysInMonth, todayStartTs };
}

// ── 文本处理 ──

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;',
  })[m]);
}

function normalizeTimeStr(timeStr) {
  if (!timeStr) return '00:00';
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '00:00';
  let h = parseInt(match[1]);
  const m = parseInt(match[2]);
  if (h === 24 && m === 0) h = 0;
  if (h > 23 || m > 59) return '00:00';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function validateTimeStr(timeStr) {
  if (!timeStr) return null;
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return `无效的时间格式：${timeStr}`;
  const h = parseInt(match[1]);
  const m = parseInt(match[2]);
  if (h === 24 && m === 0) return null; // 24:00 视为有效，等同于 00:00
  if (h > 23) return `小时必须在 0-23 之间（${h} 超出范围）`;
  if (m > 59) return `分钟必须在 0-59 之间（${m} 超出范围）`;
  return null;
}

function parseTargetUserNameField(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [value];
}

function parseTargetUsersFromText(text) {
  if (!text || !text.startsWith('@')) return [];
  return text.match(/@[a-zA-Z0-9_]+/g) || [];
}

// ── 规则描述 ──

function getTriggerTime(reminder) {
  if (reminder.rule_type === 'daily') {
    return reminder.rule_value;
  }
  return reminder.rule_time || '00:00';
}

function getRuleDescription(ruleType, ruleValue, ruleTime) {
  const timeStr = ruleType === 'daily' ? ruleValue : (ruleTime || '00:00');
  switch (ruleType) {
    case 'absolute': return `📅 ${ruleValue} ${timeStr}`;
    case 'monthly':  return `📆 每月 ${ruleValue} 号 ${timeStr}`;
    case 'yearly':   return `🎂 每年 ${ruleValue} ${timeStr}`;
    case 'daily':    return `⏰ 每天 ${ruleValue}`;
    case 'weekly':   return `📌 每周${WEEKDAY_MAP[ruleValue] || ruleValue} ${timeStr}`;
    default:         return `${ruleType} ${ruleValue}`;
  }
}

function getNextTriggerTime(ruleType, ruleValue, ruleTime) {
  const { year, month, day, hour, minute, weekday } = getNow();
  const triggerTime = ruleType === 'daily' ? ruleValue : (ruleTime || '00:00');
  const [th, tm] = triggerTime.split(':').map(Number);

  if (ruleType === 'absolute') {
    const displayTime = ruleTime && ruleTime !== '00:00' ? ' ' + ruleTime : '';
    return `${ruleValue}${displayTime}`;
  }

  if (ruleType === 'daily') {
    if (hour < th || (hour === th && minute < tm)) {
      return `今天 ${ruleValue}`;
    }
    return `明天 ${ruleValue}`;
  }

  if (ruleType === 'weekly') {
    const targetWeekday = parseInt(ruleValue);
    let daysAhead;
    if (weekday === targetWeekday && (hour < th || (hour === th && minute < tm))) {
      daysAhead = 0;
    } else {
      daysAhead = ((targetWeekday - weekday + 7) % 7) || 7;
    }
    const target = new Date(year, month - 1, day + daysAhead);
    const targetStr = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    const displayTime = ruleTime && ruleTime !== '00:00' ? ' ' + ruleTime : '';
    return `${targetStr} 星期${WEEKDAY_MAP[ruleValue] || ruleValue}${displayTime}`;
  }

  if (ruleType === 'monthly') {
    const targetDay = parseInt(ruleValue);
    let targetMonth = month;
    let targetYear = year;
    const daysInCurrent = new Date(year, month, 0).getDate();
    const actualDay = Math.min(targetDay, daysInCurrent);
    if (day > actualDay || (day === actualDay && (hour > th || (hour === th && minute >= tm)))) {
      targetMonth++;
      if (targetMonth > 12) { targetMonth = 1; targetYear++; }
    }
    const daysInTarget = new Date(targetYear, targetMonth, 0).getDate();
    const finalDay = Math.min(targetDay, daysInTarget);
    const displayTime = ruleTime && ruleTime !== '00:00' ? ' ' + ruleTime : '';
    return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(finalDay).padStart(2, '0')}${displayTime}`;
  }

  if (ruleType === 'yearly') {
    const [targetMonth, targetDay] = ruleValue.split('-').map(Number);
    let targetYear = year;
    const daysInMonth = new Date(year, targetMonth, 0).getDate();
    const actualTargetDay = Math.min(targetDay, daysInMonth);
    if (month > targetMonth ||
        (month === targetMonth && day > actualTargetDay) ||
        (month === targetMonth && day === actualTargetDay && (hour > th || (hour === th && minute >= tm)))) {
      targetYear++;
    }
    const targetDaysInMonth = new Date(targetYear, targetMonth, 0).getDate();
    const finalDay = Math.min(targetDay, targetDaysInMonth);
    const displayTime = ruleTime && ruleTime !== '00:00' ? ' ' + ruleTime : '';
    return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(finalDay).padStart(2, '0')}${displayTime}`;
  }

  return '未知';
}

// ── Telegram 消息工具 ──

async function sendLongMessage(ctx, text, parseMode = null) {
  const opts = parseMode ? { parse_mode: parseMode } : {};
  if (text.length <= TG_MSG_MAX_LENGTH) {
    await ctx.reply(text, opts);
    return;
  }
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    // 单行超长：先拆纯文本再逐段发送
    if (line.length > TG_MSG_MAX_LENGTH) {
      if (chunk.trim()) {
        await ctx.reply(chunk.trim(), opts);
        chunk = '';
      }
      const safeLine = parseMode ? line.replace(/<[^>]*>/g, '') : line;
      for (let i = 0; i < safeLine.length; i += TG_MSG_MAX_LENGTH) {
        await ctx.reply(safeLine.slice(i, i + TG_MSG_MAX_LENGTH), parseMode ? {} : opts);
      }
      continue;
    }
    if (chunk.length + line.length + 1 > TG_MSG_MAX_LENGTH) {
      await ctx.reply(chunk.trim(), opts);
      chunk = line + '\n';
    } else {
      chunk += line + '\n';
    }
  }
  if (chunk.trim()) {
    await ctx.reply(chunk.trim(), opts);
  }
}

function getMentionedUserInfo(ctx) {
  const result = { targetUserId: null, targetUserName: null };
  if (!ctx.message || !ctx.message.entities) return result;
  const text = ctx.message.text || ctx.message.caption || '';
  for (const e of ctx.message.entities) {
    if (e.type === 'text_mention' && !result.targetUserId) {
      result.targetUserId = e.user.id;
      if (e.user.username) result.targetUserName = `@${e.user.username}`;
      else if (e.user.first_name) result.targetUserName = e.user.first_name;
    } else if (e.type === 'mention' && !result.targetUserName) {
      result.targetUserName = text.substring(e.offset, e.offset + e.length);
    }
  }
  return result;
}

module.exports = {
  CHECK_INTERVAL_SECONDS,
  TG_MSG_MAX_LENGTH,
  WEEKDAY_MAP,
  WEEKDAY_EN_TO_ISO,
  PAGE_SIZE,
  RATE_LIMIT_MS,
  initUtils,
  getTimezone,
  getNow,
  escapeHtml,
  normalizeTimeStr,
  validateTimeStr,
  parseTargetUserNameField,
  parseTargetUsersFromText,
  getTriggerTime,
  getRuleDescription,
  getNextTriggerTime,
  sendLongMessage,
  getMentionedUserInfo,
};
