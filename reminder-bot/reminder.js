const db = require('./db');
const u = require('./utils');

// ── 内存状态 ──

/** 延后映射: reminderId → 延后截止时间戳(秒) */
const snoozeMap = new Map();

/** 用户名缓存: userId → {name, ts} */
const userDisplayNameCache = new Map();
const USER_CACHE_TTL = 3600000; // 1 小时

/** 是否正在执行检查（防止并发检查） */
let isChecking = false;

/** 是否已有重试排队（防止多个 setTimeout 堆积） */
let retryScheduled = false;

/** 是否正在关闭 */
let isShuttingDown = false;

/** 检查定时器句柄 */
let checkTimer = null;

function setShuttingDown(val) {
  isShuttingDown = val;
}

function getShuttingDown() {
  return isShuttingDown;
}

function clearCheckTimer() {
  if (checkTimer) {
    clearTimeout(checkTimer);
    checkTimer = null;
  }
}

// ── 延后判断 ──

function isSnoozed(reminderId, now) {
  const snoozeUntil = snoozeMap.get(reminderId);
  if (!snoozeUntil) return false;
  if (now.timestamp >= snoozeUntil) {
    snoozeMap.delete(reminderId);
    return false;
  }
  return true;
}

// ── 日期匹配 ──

function isDateMatch(reminder, now) {
  const { month, day, todayStr, weekday } = now;
  switch (reminder.rule_type) {
    case 'absolute':
      return todayStr === reminder.rule_value;

    case 'monthly': {
      const targetDay = parseInt(reminder.rule_value);
      return day === Math.min(targetDay, now.daysInMonth);
    }

    case 'yearly': {
      const [tm, td] = reminder.rule_value.split('-').map(Number);
      const daysThisMonth = new Date(now.year, tm, 0).getDate();
      const actualDay = Math.min(td, daysThisMonth);
      // 注意：02-29 在非闰年会降级匹配 02-28
      return month === tm && day === actualDay;
    }

    case 'daily':
      return true;

    case 'weekly': {
      const w = parseInt(reminder.rule_value);
      return w >= 1 && w <= 7 && weekday === w;
    }

    default:
      return false;
  }
}

// ── 触发判断 ──

function shouldRemind(reminder, now) {
  if (isSnoozed(reminder.id, now)) return false;

  const { hour, minute, timestamp, todayStr, todayStartTs } = now;

  // 今天已完成
  if (reminder.last_completed_date === todayStr) return false;

  // 日期不匹配
  if (!isDateMatch(reminder, now)) return false;

  // 时间未到
  const triggerTime = u.getTriggerTime(reminder);
  const [th, tm] = triggerTime.split(':').map(Number);
  if (hour < th || (hour === th && minute < tm)) return false;

  // 重复间隔判断
  if (reminder.repeat_interval_minutes === 0) {
    // 不重复：今天已提醒过就不再提醒
    if (reminder.last_remind_time && reminder.last_remind_time >= todayStartTs) return false;
    return true;
  } else {
    // 有重复间隔：首次或超过间隔时间
    if (!reminder.last_remind_time) return true;
    if (reminder.last_remind_time < todayStartTs) return true;
    const secondsSince = timestamp - reminder.last_remind_time;
    return secondsSince >= reminder.repeat_interval_minutes * 60;
  }
}

// ── Telegram 用户信息 ──

async function getUserDisplayName(bot, userId) {
  const now = Date.now();
  const cached = userDisplayNameCache.get(userId);
  if (cached && now - cached.ts < USER_CACHE_TTL) return cached.name;

  try {
    const chat = await bot.telegram.getChat(userId);
    let name;
    if (chat.username) name = `@${chat.username}`;
    else if (chat.first_name) name = chat.first_name;
    else name = `用户${userId}`;
    userDisplayNameCache.set(userId, { name, ts: now });
    return name;
  } catch {
    const name = `用户${userId}`;
    userDisplayNameCache.set(userId, { name, ts: now });
    return name;
  }
}

// ── 内联键盘 ──

function buildReminderKeyboard(reminder) {
  const buttons = [[
    { text: '✅ 知道了', callback_data: `done:${reminder.id}` },
  ]];
  if (reminder.repeat_interval_minutes > 0) {
    buttons[0].push({
      text: `🕐 延后 ${reminder.repeat_interval_minutes} 分钟`,
      callback_data: `snooze:${reminder.id}:${reminder.repeat_interval_minutes}`,
    });
  }
  return { inline_keyboard: buttons };
}

// ── 发送提醒 ──

async function sendReminder(bot, reminder, now) {
  let message = `🔔 <b>提醒</b>：${u.escapeHtml(reminder.name)}\n`;

  const timeDesc = u.getRuleDescription(reminder.rule_type, reminder.rule_value, reminder.rule_time)
    .replace(/^[\p{Emoji_Presentation}\p{Emoji}\s]+/u, '').trim();
  message += `⏰ ${timeDesc}\n`;

  if (reminder.repeat_interval_minutes > 0) {
    message += `🔁 每 ${reminder.repeat_interval_minutes} 分钟重复提醒\n`;
  }

  const targetUsers = u.parseTargetUserNameField(reminder.target_user_name);
  if (targetUsers.length > 0) {
    message += `👤 ${targetUsers.map(n => u.escapeHtml(n)).join(' ')}`;
  } else if (reminder.target_user_id) {
    const name = await getUserDisplayName(bot, reminder.target_user_id);
    message += `👤 <a href="tg://user?id=${reminder.target_user_id}">${u.escapeHtml(name)}</a>`;
  }

  const keyboard = buildReminderKeyboard(reminder);

  try {
    await bot.telegram.sendMessage(reminder.chat_id, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
    console.log(`[提醒] #${reminder.id} "${reminder.name}" → chat ${reminder.chat_id}`);
    db.updateLastRemindTime(reminder.id, Math.floor(Date.now() / 1000));
    return { sent: true, forbidden: false };
  } catch (err) {
    const description = err.description || err.message || '';
    console.error(`[发送失败] #${reminder.id} "${reminder.name}" → chat ${reminder.chat_id}: ${description}`);

    // 403 Forbidden：机器人被移出群组或被用户屏蔽，清理该 chat 的所有提醒
    if (err.code === 403 || (err.response && err.response.statusCode === 403) || description.includes('Forbidden')) {
      const deleted = db.deleteAllByChatId(reminder.chat_id);
      if (deleted > 0) {
        console.log(`[清理] 检测到 403，已删除 chat ${reminder.chat_id} 的 ${deleted} 条提醒`);
      }
      return { sent: false, forbidden: true };
    }
    return { sent: false, forbidden: false };
  }
}

// ── 检查与调度 ──

async function checkAndRemind(bot) {
  if (isShuttingDown) return;

  if (isChecking) {
    // 已有检查在进行中，且未排队重试 → 排队一次 5 秒后重试
    if (!retryScheduled) {
      retryScheduled = true;
      setTimeout(() => {
        retryScheduled = false;
        if (!isShuttingDown && !isChecking) {
          scheduleCheck(bot);
        }
      }, 5000);
    }
    return;
  }

  isChecking = true;
  try {
    const now = u.getNow();
    const reminders = db.getActiveReminders(now.todayStr);
    console.log(`[检查] ${now.todayStr} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')} | 活跃: ${reminders.length}`);

    // 按 chat_id 分组，同群消息间加短暂延迟
    const chatGroups = new Map();
    for (const r of reminders) {
      if (isShuttingDown) break;
      if (shouldRemind(r, now)) {
        console.log(`[触发] #${r.id} "${r.name}" rule=${r.rule_type} repeat=${r.repeat_interval_minutes} time=${r.rule_time || '-'}`);
        if (!chatGroups.has(r.chat_id)) chatGroups.set(r.chat_id, []);
        chatGroups.get(r.chat_id).push(r);
      }
    }

    for (const group of chatGroups.values()) {
      if (isShuttingDown) break;
      for (const r of group) {
        if (isShuttingDown) break;
        try {
          const result = await sendReminder(bot, r, now);
          // 403 则跳过该群剩余提醒（已全部清理）
          if (result.forbidden) break;
          // 一次性绝对日期提醒：发送成功后自动删除
          if (result.sent && r.rule_type === 'absolute' && r.repeat_interval_minutes === 0 && !isShuttingDown) {
            db.deleteReminderById(r.id);
            snoozeMap.delete(r.id);
            console.log(`[自动删除] #${r.id} "${r.name}" 一次性提醒到期`);
          }
        } catch (err) {
          console.error(`[错误] 处理 #${r.id} "${r.name}" 时出错:`, err.message);
        }
      }
      // 同群消息间隔 1 秒，避免 Telegram 限频
      if (group.length > 0 && !isShuttingDown) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } finally {
    isChecking = false;
  }
}

function scheduleCheck(bot) {
  if (isShuttingDown) return;
  console.log('[调度] 开始检查周期...');

  checkAndRemind(bot).catch(err => {
    console.error('[调度] 检查出错:', err);
  }).finally(() => {
    if (isShuttingDown) return;
    const now = Date.now();
    const interval = u.CHECK_INTERVAL_SECONDS * 1000;
    const nextTick = Math.ceil(now / interval) * interval;
    const delay = Math.max(nextTick - now, 1000);
    console.log(`[调度] 下次检查: ${Math.ceil(delay / 1000)} 秒后`);
    checkTimer = setTimeout(() => scheduleCheck(bot), delay);
  });
}

// ── 缓存清理 ──

function cleanupCaches() {
  const now = Date.now();
  for (const [key, value] of userDisplayNameCache) {
    if (now - value.ts > USER_CACHE_TTL) userDisplayNameCache.delete(key);
  }
  const nowTs = Math.floor(now / 1000);
  for (const [key, value] of snoozeMap) {
    if (nowTs >= value) snoozeMap.delete(key);
  }
}

module.exports = {
  snoozeMap,
  setShuttingDown,
  getShuttingDown,
  clearCheckTimer,
  isSnoozed,
  isDateMatch,
  shouldRemind,
  getUserDisplayName,
  buildReminderKeyboard,
  sendReminder,
  checkAndRemind,
  scheduleCheck,
  cleanupCaches,
};
