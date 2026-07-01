const db = require('./db');
const u = require('./utils');
const p = require('./parser');
const r = require('./reminder');

// ── 常驻提示文本 ──

const USAGE_TEXT = `📖 <b>使用说明</b>

<b>基本格式</b>
  /remind 名称 规则 [重复] [@用户]

<b>⏱️ 时间规则</b>
  <code>2026-09-25</code>           绝对日期，当天 00:00 触发
  <code>2026-09-25@09:00</code>     绝对日期，指定时间触发
  <code>M-5</code>                  每月 5 号 00:00 触发
  <code>M-5@09:00</code>            每月 5 号 09:00 触发
  <code>12-25</code>                每年 12 月 25 日 00:00 触发
  <code>12-25@08:00</code>          每年 12 月 25 日 08:00 触发
  <code>20:00</code>                每天 20:00 触发
  <code>W-3</code>                  每周三 00:00 触发（1=周一…7=周日）
  <code>W-3@14:30</code>            每周三 14:30 触发

<b>🔁 重复提醒</b>（可选，仅触发当天有效）
  <code>every 30m</code>  或  <code>every30m</code>

<b>👤 提醒对象</b>（可选，支持多人）
  放在命令末尾，多个用户用 <code>-</code> 分隔
  示例：<code>@张三-@李四</code>

<b>📋 示例</b>
  /remind 中秋 2026-09-25
  /remind 交房租 M-5
  /remind 周报 W-5@17:00 @张三
  /remind 吃药 20:00 every 30m @d1j88
  /remind 开会 09:00 every 1m @张三-@李四

<b>📦 批量创建</b>：使用 /batch 命令（一行一个事件）
<b>✏️ 修改事件</b>：使用 /edit 命令
<b>📋 查看列表</b>：使用 /list 命令
<b>🔍 调试事件</b>：使用 /debug 命令`;

const REMIND_HELP = `❌ 格式错误，请检查后重试。

📝 <b>用法</b>：/remind 名称 时间规则 [重复] [@用户]

<b>⏱️ 时间规则类型</b>
  <code>2026-09-25</code>            绝对日期（仅一次，到期自动删除）
  <code>2026-09-25@09:00</code>      绝对日期 + 指定时间
  <code>M-5</code>                   每月 5 号（默认 00:00）
  <code>M-5@09:00</code>             每月 5 号 09:00
  <code>12-25</code>                 每年 12 月 25 日（默认 00:00）
  <code>12-25@08:00</code>           每年 12 月 25 日 08:00
  <code>20:00</code>                 每天 20:00
  <code>W-3</code>                   每周三（默认 00:00, 1=周一…7=周日）
  <code>W-3@14:30</code>             每周三 14:30

<b>🔁 重复提醒</b>（可选，仅当天有效）
  <code>every 30m</code>  或  <code>every30m</code>
  例：/remind 喝水 09:00 every 60m  →  9:00 起每小时提醒一次

<b>👤 提醒对象</b>（可选）
  放在末尾：<code>@用户名</code>
  多人：<code>@用户1-@用户2</code>

<b>📖 示例</b>
  /remind 中秋 2026-09-25
  /remind 交房租 M-5@09:00
  /remind 周报 W-5@17:00 @张三
  /remind 吃药 20:00 every 30m @d1j88
  /remind 开会 09:00 every 1m @张三-@李四

💡 注意：事件名称不能包含空格`;

const BATCH_HELP = `❌ 格式错误。

📝 <b>用法</b>：/batch 后换行，每行一个事件，格式与 /remind 相同（不含 /remind 前缀）

<b>📖 示例</b>
  /batch
  吃药 21:00
  周报 W-4@16:00 every 60m @张三
  中秋 2026-09-25@09:00
  开会 09:00 every 1m @张三-@李四
  交房租 M-5`;

const EDIT_HELP = `❌ 格式错误。

📝 <b>用法</b>：/edit 名称或#ID 新时间规则 [重复]

只修改规则和时间，名称和提醒对象保持不变，已触发状态会被重置。

<b>📖 示例</b>
  /edit 吃药 21:00
  /edit 周报 W-4@16:00 every 60m
  /edit 中秋 2026-10-01@09:00
  /edit #123 W-4@16:00`;

// ── 分页列表 ──

async function sendListPage(ctx, page, isCallback = false) {
  const chatId = isCallback ? (ctx.callbackQuery?.message?.chat?.id) : ctx.chat.id;
  if (!chatId) {
    try { await ctx.answerCbQuery('消息已失效'); } catch {}
    return;
  }

  const total = db.countRemindersByChat(chatId);
  if (total === 0) {
    if (isCallback) {
      try { await ctx.editMessageText('📭 暂无提醒事件'); } catch {}
    } else {
      await ctx.reply('📭 暂无提醒事件');
    }
    return;
  }

  const totalPages = Math.ceil(total / u.PAGE_SIZE);
  const safePage = Math.min(page, totalPages - 1);
  const offset = safePage * u.PAGE_SIZE;
  const reminders = db.getRemindersByChatPaged(chatId, u.PAGE_SIZE, offset);
  const now = u.getNow();

  let msg = `📋 <b>提醒列表</b>（第 ${safePage + 1}/${totalPages} 页，共 ${total} 个）\n\n`;
  for (const rem of reminders) {
    let item = `🔸 <b>#${rem.id} ${u.escapeHtml(rem.name)}</b>\n`;
    item += `   ${u.getRuleDescription(rem.rule_type, rem.rule_value, rem.rule_time)}\n`;
    if (rem.repeat_interval_minutes > 0) {
      item += `   🔁 每 ${rem.repeat_interval_minutes} 分钟重复（仅当天）\n`;
    } else {
      item += `   🔁 仅提醒一次\n`;
    }
    if (rem.last_completed_date === now.todayStr) {
      item += `   ⚠️ 今天已完成\n`;
    }
    const targetUsers = u.parseTargetUserNameField(rem.target_user_name);
    if (targetUsers.length > 0) {
      item += `   👤 ${targetUsers.map(n => u.escapeHtml(n)).join(' ')}\n`;
    } else if (rem.target_user_id) {
      item += `   👤 用户ID ${rem.target_user_id}\n`;
    }
    item += '\n';
    msg += item;
  }

  const buttons = [];
  for (const rem of reminders) {
    buttons.push([
      { text: `🗑️ 删除 #${rem.id} ${rem.name}`, callback_data: `del_confirm_list:${safePage}:${rem.id}` }
    ]);
  }

  const navRow = [];
  if (safePage > 0) navRow.push({ text: '◀ 上一页', callback_data: `list:${safePage - 1}` });
  if (safePage < totalPages - 1) navRow.push({ text: '下一页 ▶', callback_data: `list:${safePage + 1}` });
  if (navRow.length) buttons.push(navRow);

  const replyMarkup = { inline_keyboard: buttons };

  if (isCallback) {
    try {
      await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: replyMarkup });
    } catch {
      await ctx.answerCbQuery('列表已是最新');
    }
  } else {
    await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: replyMarkup });
  }
}

// ── 命令注册 ──

function setupCommands(bot) {
  // /start
  bot.command('start', async (ctx) => {
    await ctx.reply('👋 你好！我是提醒机器人。\n发送 /help 查看完整使用说明，或直接使用 /remind 创建提醒。');
  });

  // /help
  bot.command('help', async (ctx) => {
    await ctx.reply(USAGE_TEXT, { parse_mode: 'HTML' });
  });

  // /remind
  bot.command('remind', async (ctx) => {
    const chatId = ctx.chat.id;
    const mentionedInfo = u.getMentionedUserInfo(ctx);
    const parsed = p.parseRemindCommand(ctx.message.text, mentionedInfo);

    if (!parsed) {
      await u.sendLongMessage(ctx, REMIND_HELP, 'HTML');
      return;
    }

    if (parsed.error) {
      await ctx.reply(`❌ ${parsed.error}`);
      return;
    }

    const existing = db.checkNameExists(parsed.name, chatId);
    if (existing) {
      await ctx.reply(`❌ 事件「${parsed.name}」已存在，请更换名称或先用 /del 删除旧事件`);
      return;
    }

    let newId;
    try {
      newId = db.addReminder(
        parsed.name, chatId, parsed.targetUserId, parsed.targetUserName,
        parsed.ruleType, parsed.ruleValue, parsed.ruleTime, parsed.repeatMinutes
      );
    } catch {
      await ctx.reply('❌ 添加失败，请稍后重试');
      return;
    }

    const nextTrigger = u.getNextTriggerTime(parsed.ruleType, parsed.ruleValue, parsed.ruleTime);
    let msg = `✅ 已添加「${parsed.name}」（#${newId}）\n`;
    msg += `${u.getRuleDescription(parsed.ruleType, parsed.ruleValue, parsed.ruleTime)}\n`;
    msg += `⏳ 下次触发：${nextTrigger}`;
    if (parsed.repeatMinutes > 0) {
      msg += `\n🔁 触发当天每 ${parsed.repeatMinutes} 分钟重复提醒`;
    } else {
      msg += `\n🔁 仅提醒一次`;
    }
    if (parsed.targetUserName) {
      const users = u.parseTargetUserNameField(parsed.targetUserName);
      msg += `\n👤 提醒对象：${users.join(' ')}`;
    }

    await ctx.reply(msg);
  });

  // /edit
  bot.command('edit', async (ctx) => {
    const chatId = ctx.chat.id;
    const parsed = p.parseEditCommand(ctx.message.text);

    if (!parsed) {
      await u.sendLongMessage(ctx, EDIT_HELP, 'HTML');
      return;
    }

    if (parsed.error) {
      await ctx.reply(`❌ ${parsed.error}`);
      return;
    }

    const reminder = db.findReminder(parsed.nameOrId, chatId);
    if (!reminder) {
      await ctx.reply(`❌ 未找到事件「${parsed.nameOrId}」`);
      return;
    }

    try {
      db.updateReminderRule(reminder.id, parsed.ruleType, parsed.ruleValue, parsed.ruleTime, parsed.repeatMinutes);
    } catch {
      await ctx.reply('❌ 更新失败，请稍后重试');
      return;
    }

    const nextTrigger = u.getNextTriggerTime(parsed.ruleType, parsed.ruleValue, parsed.ruleTime);
    let msg = `✏️ 已更新「${reminder.name}」（#${reminder.id}）\n`;
    msg += `旧规则：${u.getRuleDescription(reminder.rule_type, reminder.rule_value, reminder.rule_time)}\n`;
    msg += `新规则：${u.getRuleDescription(parsed.ruleType, parsed.ruleValue, parsed.ruleTime)}\n`;
    msg += `⏳ 下次触发：${nextTrigger}`;
    if (parsed.repeatMinutes > 0) {
      msg += `\n🔁 触发当天每 ${parsed.repeatMinutes} 分钟重复提醒`;
    } else {
      msg += `\n🔁 仅提醒一次`;
    }

    db.resetReminderState(reminder.id);
    msg += `\n⚠️ 状态已重置，将按新规则重新计算`;

    await ctx.reply(msg);
  });

  // /batch
  bot.command('batch', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const lines = text.split('\n');

    if (lines.length < 2) {
      await u.sendLongMessage(ctx, BATCH_HELP, 'HTML');
      return;
    }

    const dataLines = lines.slice(1).filter(l => l.trim().length > 0);
    if (dataLines.length === 0) {
      await ctx.reply('❌ 没有检测到事件数据，请在 /batch 下方每行写一个事件');
      return;
    }

    const results = [];
    const addInTx = db.transaction((items) => {
      const txResults = [];
      for (const item of items) {
        const r = db.getStmts().addReminder.run(
          item.name, item.chatId, item.targetUserId, item.targetUserName,
          item.ruleType, item.ruleValue, item.ruleTime, item.repeatMinutes
        );
        txResults.push({ ...item, insertId: r.lastInsertRowid });
      }
      return txResults;
    });

    const batchNames = new Set();
    const validItems = [];
    for (const line of dataLines) {
      const parsed = p.parseBatchLine(line);
      if (!parsed) {
        results.push({ line, success: false, error: '格式错误，请检查名称和规则' });
        continue;
      }
      if (parsed.error) {
        results.push({ line, success: false, error: parsed.error });
        continue;
      }
      if (batchNames.has(parsed.name)) {
        results.push({ line, success: false, error: `事件「${parsed.name}」在本批次内重复` });
        continue;
      }
      if (db.checkNameExists(parsed.name, chatId)) {
        results.push({ line, success: false, error: `事件「${parsed.name}」已存在` });
        continue;
      }
      batchNames.add(parsed.name);
      validItems.push({
        line, parsed,
        name: parsed.name, chatId, targetUserId: parsed.targetUserId,
        targetUserName: parsed.targetUserName, ruleType: parsed.ruleType,
        ruleValue: parsed.ruleValue, ruleTime: parsed.ruleTime,
        repeatMinutes: parsed.repeatMinutes,
      });
    }

    if (validItems.length > 0) {
      try {
        const txResults = addInTx(validItems);
        for (const tr of txResults) {
          const nextTrigger = u.getNextTriggerTime(tr.ruleType, tr.ruleValue, tr.ruleTime);
          results.push({
            line: tr.line, success: true, name: tr.name, id: tr.insertId,
            desc: u.getRuleDescription(tr.ruleType, tr.ruleValue, tr.ruleTime),
            nextTrigger, repeatMinutes: tr.repeatMinutes,
            targetUserName: tr.targetUserName,
          });
        }
      } catch {
        for (const item of validItems) {
          results.push({ line: item.line, success: false, error: '批量添加失败' });
        }
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    let msg = `📋 <b>批量创建结果</b>（成功 ${successCount} / 失败 ${failCount}）\n\n`;

    for (const r of results) {
      if (r.success) {
        msg += `✅ <b>${u.escapeHtml(r.name)}</b>（#${r.id}）\n`;
        msg += `   ${r.desc} | ⏳ ${r.nextTrigger}\n`;
        if (r.repeatMinutes > 0) msg += `   🔁 每 ${r.repeatMinutes} 分钟重复提醒\n`;
        if (r.targetUserName) {
          const users = u.parseTargetUserNameField(r.targetUserName);
          msg += `   👤 ${users.join(' ')}\n`;
        }
      } else {
        msg += `❌ ${u.escapeHtml(r.line.trim())}\n   原因：${r.error}\n`;
      }
    }

    await u.sendLongMessage(ctx, msg, 'HTML');
  });

  // /done
  bot.command('done', async (ctx) => {
    const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
    if (!arg) {
      return ctx.reply('📝 <b>用法</b>：/done 事件名称 或 /done #ID\n将事件标记为今日完成，当天不再提醒。', { parse_mode: 'HTML' });
    }
    const reminder = db.findReminder(arg, ctx.chat.id);
    if (!reminder) {
      return ctx.reply(`❌ 未找到事件「${arg}」`);
    }

    if (reminder.rule_type === 'absolute' && reminder.repeat_interval_minutes === 0) {
      db.deleteReminderById(reminder.id);
      r.snoozeMap.delete(reminder.id);
      await ctx.reply(`🗑️ 已删除一次性事件「${reminder.name}」`);
    } else {
      const now = u.getNow();
      db.markCompletedToday(reminder.id, now.todayStr);
      r.snoozeMap.delete(reminder.id);
      await ctx.reply(`✅ 「${reminder.name}」已标记为今日完成，下个周期自动恢复`);
    }
  });

  // /del
  bot.command('del', async (ctx) => {
    const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
    if (!arg) {
      return ctx.reply('📝 <b>用法</b>：/del 事件名称 或 /del #ID\n永久删除事件，不可恢复。', { parse_mode: 'HTML' });
    }
    const reminder = db.findReminder(arg, ctx.chat.id);
    if (!reminder) {
      return ctx.reply(`❌ 未找到事件「${arg}」`);
    }
    db.deleteReminderById(reminder.id);
    r.snoozeMap.delete(reminder.id);
    await ctx.reply(`🗑️ 已永久删除「${reminder.name}」`);
  });

  // /list
  bot.command('list', async (ctx) => {
    await sendListPage(ctx, 0);
  });

  // /debug
  bot.command('debug', async (ctx) => {
    const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
    if (!arg) {
      return ctx.reply('📝 <b>用法</b>：/debug 事件名称 或 /debug #ID\n查看事件的触发判定详情。', { parse_mode: 'HTML' });
    }
    const reminder = db.findReminder(arg, ctx.chat.id);
    if (!reminder) {
      return ctx.reply(`❌ 未找到事件「${arg}」`);
    }

    const now = u.getNow();
    let msg = `🔍 <b>调试：${u.escapeHtml(reminder.name)}</b>（#${reminder.id}）\n\n`;
    msg += `📅 当前时间：${now.todayStr} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}  时区：${u.getTimezone()}\n\n`;
    msg += `📋 规则类型：${reminder.rule_type}\n`;
    msg += `📋 规则值：${reminder.rule_value}\n`;
    if (reminder.rule_time) msg += `📋 触发时间：${reminder.rule_time}\n`;

    const dateMatch = r.isDateMatch(reminder, now);
    msg += `\n📅 日期匹配：${dateMatch ? '✅ 是' : '❌ 否'}\n`;

    const triggerTime = u.getTriggerTime(reminder);
    const [th, tm] = triggerTime.split(':').map(Number);
    const timeReached = now.hour > th || (now.hour === th && now.minute >= tm);
    msg += `⏰ 时间判断：当前 ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')} vs 触发 ${triggerTime} → ${timeReached ? '✅ 已到' : '⏳ 未到'}\n`;

    if (r.isSnoozed(reminder.id, now)) {
      const snoozeUntil = r.snoozeMap.get(reminder.id);
      const remaining = Math.ceil((snoozeUntil - now.timestamp) / 60);
      msg += `🕐 延后状态：剩余 ${remaining} 分钟 → ❌ 暂停触发\n`;
    }

    if (reminder.last_completed_date === now.todayStr) {
      msg += `⚠️ 今天已标记完成 → ❌ 不再触发\n`;
    }

    if (reminder.repeat_interval_minutes > 0) {
      msg += `🔁 重复间隔：${reminder.repeat_interval_minutes} 分钟\n`;
      if (reminder.last_remind_time) {
        const elapsed = Math.floor((now.timestamp - reminder.last_remind_time) / 60);
        msg += `⏱️ 距上次提醒：${elapsed} 分钟（需 ≥ ${reminder.repeat_interval_minutes} 分钟）→ ${elapsed >= reminder.repeat_interval_minutes ? '✅ 间隔已到' : '⏳ 间隔未到'}\n`;
      } else {
        msg += `⏱️ 尚未触发过 → ✅ 可触发\n`;
      }
    } else {
      if (reminder.last_remind_time) {
        const sameDay = reminder.last_remind_time >= now.todayStartTs;
        msg += `🔁 无重复，上次触发：${sameDay ? '今天' : '非今天'} → ${sameDay ? '❌ 今天已触发' : '✅ 今天未触发'}\n`;
      } else {
        msg += `🔁 无重复，尚未触发过 → ✅ 可触发\n`;
      }
    }

    const should = r.shouldRemind(reminder, now);
    msg += `\n🎯 <b>最终判定：${should ? '✅ 触发' : '❌ 不触发'}</b>`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // /check
  bot.command('check', async (ctx) => {
    const now = u.getNow();
    const reminders = db.getActiveReminders(now.todayStr);
    let msg = `🔍 <b>手动检查</b>\n`;
    msg += `📅 ${now.todayStr} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}\n`;
    msg += `📊 活跃事件：${reminders.length}\n\n`;

    if (reminders.length === 0) {
      msg += '暂无活跃事件';
    } else {
      for (const rem of reminders) {
        const should = r.shouldRemind(rem, now);
        msg += `${should ? '✅' : '⏸️'} #${rem.id} ${rem.name}`;
        msg += ` | ${rem.rule_type} ${rem.rule_value}`;
        if (rem.rule_time) msg += ` ${rem.rule_time}`;
        msg += ` | 延后=${r.isSnoozed(rem.id, now)} 完成=${rem.last_completed_date === now.todayStr}\n`;
      }
    }

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // /time
  bot.command('time', async (ctx) => {
    const now = u.getNow();
    const count = db.countActiveReminders(now.todayStr);
    await ctx.reply(
      `🕐 <b>当前时间</b>（${u.getTimezone()}）\n` +
      `📅 ${now.todayStr} 星期${u.WEEKDAY_MAP[now.weekday] || now.weekday}\n` +
      `⏰ ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}:${String(now.second).padStart(2, '0')}\n\n` +
      `活跃事件数：${count}`,
      { parse_mode: 'HTML' }
    );
  });
}

// ── 回调注册 ──

function setupCallbacks(bot) {
  // ✅ 知道了 / 今日完成
  bot.action(/^done:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1]);
    const reminder = db.getReminderById(id);
    if (!reminder) return ctx.answerCbQuery('事件已不存在');
    if (reminder.chat_id !== ctx.callbackQuery.message.chat.id) return ctx.answerCbQuery('无权操作此事件');

    if (reminder.rule_type === 'absolute' && reminder.repeat_interval_minutes === 0) {
      db.deleteReminderById(id);
      r.snoozeMap.delete(id);
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
      await ctx.answerCbQuery('已删除一次性事件');
    } else {
      const now = u.getNow();
      db.markCompletedToday(id, now.todayStr);
      r.snoozeMap.delete(id);
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
      await ctx.answerCbQuery('已标记完成，下个周期自动恢复');
    }
  });

  // 🕐 延后
  bot.action(/^snooze:(\d+):(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1]);
    const minutes = parseInt(ctx.match[2]);
    const reminder = db.getReminderById(id);
    if (!reminder) {
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
      return ctx.answerCbQuery('事件已不存在');
    }
    if (reminder.chat_id !== ctx.callbackQuery.message.chat.id) return ctx.answerCbQuery('无权操作此事件');

    const now = u.getNow();
    r.snoozeMap.set(id, now.timestamp + minutes * 60);
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
    await ctx.answerCbQuery(`已延后 ${minutes} 分钟`);
  });

  // 🗑️ 列表中的删除确认
  bot.action(/^del_confirm_list:(\d+):(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    const id = parseInt(ctx.match[2]);
    const reminder = db.getReminderById(id);
    if (!reminder) return ctx.answerCbQuery('事件已不存在');
    if (reminder.chat_id !== ctx.callbackQuery.message.chat.id) return ctx.answerCbQuery('无权操作此事件');

    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[
          { text: '⚠️ 确认删除', callback_data: `del_exec_list:${page}:${id}` },
          { text: '取消', callback_data: `del_cancel_list:${page}:${id}` },
        ]],
      });
    } catch {}
    await ctx.answerCbQuery();
  });

  // 🗑️ 确认删除
  bot.action(/^del_exec_list:(\d+):(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    const id = parseInt(ctx.match[2]);
    const reminder = db.getReminderById(id);
    if (!reminder || reminder.chat_id !== ctx.callbackQuery.message.chat.id) {
      return ctx.answerCbQuery('无权操作此事件');
    }
    db.deleteReminderById(id);
    r.snoozeMap.delete(id);
    await sendListPage(ctx, page, true);
    await ctx.answerCbQuery('已永久删除');
  });

  // 🗑️ 取消删除
  bot.action(/^del_cancel_list:(\d+):(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    await sendListPage(ctx, page, true);
    await ctx.answerCbQuery('已取消');
  });

  // 📄 列表翻页
  bot.action(/^list:(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    await sendListPage(ctx, page, true);
    await ctx.answerCbQuery();
  });
}

module.exports = { setupCommands, setupCallbacks };
