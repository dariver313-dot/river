const Database = require('better-sqlite3');

let db;
let stmts;

function initDatabase(dbPath = 'reminders.sqlite') {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      target_user_id INTEGER,
      target_user_name TEXT,
      rule_type TEXT NOT NULL,
      rule_value TEXT NOT NULL,
      rule_time TEXT,
      repeat_interval_minutes INTEGER DEFAULT 0,
      last_remind_time INTEGER,
      last_completed_date TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

  // 自动迁移：检测并添加缺失的列
  const columns = db.pragma('table_info(reminders)').map(c => c.name);
  if (!columns.includes('target_user_name')) {
    db.exec('ALTER TABLE reminders ADD COLUMN target_user_name TEXT');
  }
  if (!columns.includes('rule_time')) {
    db.exec('ALTER TABLE reminders ADD COLUMN rule_time TEXT');
  }

  // 索引
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_id ON reminders(chat_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_name_chat ON reminders(name, chat_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_last_completed ON reminders(last_completed_date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_active_check ON reminders(rule_type, rule_value, last_completed_date)');

  stmts = {
    addReminder: db.prepare(`
      INSERT INTO reminders (name, chat_id, target_user_id, target_user_name, rule_type, rule_value, rule_time, repeat_interval_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteById: db.prepare('DELETE FROM reminders WHERE id = ?'),
    deleteAllByChatId: db.prepare('DELETE FROM reminders WHERE chat_id = ?'),
    getById: db.prepare('SELECT * FROM reminders WHERE id = ?'),
    getByNameAndChat: db.prepare('SELECT * FROM reminders WHERE name = ? AND chat_id = ?'),
    getActiveReminders: db.prepare(`
      SELECT * FROM reminders
      WHERE (rule_type != 'absolute' OR rule_value >= ?)
        AND (last_completed_date IS NULL OR last_completed_date != ?)
      ORDER BY chat_id, rule_time, id
    `),
    getByChatIdPaged: db.prepare('SELECT * FROM reminders WHERE chat_id = ? ORDER BY id LIMIT ? OFFSET ?'),
    countByChatId: db.prepare('SELECT COUNT(*) as count FROM reminders WHERE chat_id = ?'),
    checkNameExists: db.prepare('SELECT id FROM reminders WHERE name = ? AND chat_id = ?'),
    updateLastRemindTime: db.prepare('UPDATE reminders SET last_remind_time = ? WHERE id = ?'),
    markCompletedToday: db.prepare('UPDATE reminders SET last_completed_date = ? WHERE id = ?'),
    updateRule: db.prepare(`
      UPDATE reminders SET rule_type = ?, rule_value = ?, rule_time = ?, repeat_interval_minutes = ? WHERE id = ?
    `),
    countActiveReminders: db.prepare(`
      SELECT COUNT(*) as count FROM reminders
      WHERE (rule_type != 'absolute' OR rule_value >= ?)
        AND (last_completed_date IS NULL OR last_completed_date != ?)
    `),
    resetReminderState: db.prepare(`
      UPDATE reminders SET last_completed_date = NULL, last_remind_time = NULL WHERE id = ?
    `),
  };

  console.log('✅ 数据库初始化完成');
  return { db, stmts };
}

function getDb() {
  if (!db) throw new Error('数据库未初始化，请先调用 initDatabase()');
  return db;
}

function getStmts() {
  if (!stmts) throw new Error('数据库未初始化，请先调用 initDatabase()');
  return stmts;
}

function closeDb() {
  if (db) {
    try {
      db.close();
      console.log('✅ 数据库连接已关闭');
    } catch (err) {
      console.error('⚠️ 关闭数据库失败:', err.message);
    }
  }
}

// ── 便捷 CRUD 函数 ──

function addReminder(name, chatId, targetUserId, targetUserName, ruleType, ruleValue, ruleTime, repeatIntervalMinutes) {
  const result = stmts.addReminder.run(name, chatId, targetUserId, targetUserName, ruleType, ruleValue, ruleTime, repeatIntervalMinutes);
  return result.lastInsertRowid;
}

function deleteReminderById(id) {
  stmts.deleteById.run(id);
}

function deleteAllByChatId(chatId) {
  const result = stmts.deleteAllByChatId.run(chatId);
  return result.changes;
}

function getReminderById(id) {
  return stmts.getById.get(id);
}

function getReminderByNameAndChat(name, chatId) {
  return stmts.getByNameAndChat.get(name, chatId);
}

/**
 * 根据参数查找提醒：支持 #ID 或事件名称
 */
function findReminder(arg, chatId) {
  if (arg.startsWith('#')) {
    const id = parseInt(arg.slice(1));
    if (isNaN(id)) return null;
    const r = stmts.getById.get(id);
    return r && r.chat_id === chatId ? r : null;
  }
  return stmts.getByNameAndChat.get(arg, chatId) || null;
}

function updateReminderRule(id, ruleType, ruleValue, ruleTime, repeatIntervalMinutes) {
  stmts.updateRule.run(ruleType, ruleValue, ruleTime, repeatIntervalMinutes, id);
}

function getActiveReminders(todayStr) {
  return stmts.getActiveReminders.all(todayStr, todayStr);
}

function updateLastRemindTime(id, timestamp) {
  stmts.updateLastRemindTime.run(timestamp, id);
}

function markCompletedToday(id, todayStr) {
  stmts.markCompletedToday.run(todayStr, id);
}

function resetReminderState(id) {
  stmts.resetReminderState.run(id);
}

function checkNameExists(name, chatId) {
  const row = stmts.checkNameExists.get(name, chatId);
  return row ? row.id : null;
}

function getRemindersByChatPaged(chatId, limit, offset) {
  return stmts.getByChatIdPaged.all(chatId, limit, offset);
}

function countRemindersByChat(chatId) {
  return stmts.countByChatId.get(chatId).count;
}

function countActiveReminders(todayStr) {
  return stmts.countActiveReminders.get(todayStr, todayStr).count;
}

/**
 * 在事务中执行回调，用于批量操作
 */
function transaction(fn) {
  return db.transaction(fn);
}

module.exports = {
  initDatabase,
  getDb,
  getStmts,
  closeDb,
  addReminder,
  deleteReminderById,
  deleteAllByChatId,
  getReminderById,
  getReminderByNameAndChat,
  findReminder,
  updateReminderRule,
  getActiveReminders,
  updateLastRemindTime,
  markCompletedToday,
  resetReminderState,
  checkNameExists,
  getRemindersByChatPaged,
  countRemindersByChat,
  countActiveReminders,
  transaction,
};
