require('dotenv').config();
const { Telegraf } = require('telegraf');

const db = require('./db');
const u = require('./utils');
const p = require('./parser');
const r = require('./reminder');
const h = require('./handlers');

// ── 配置校验 ──

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ 请设置 BOT_TOKEN 环境变量');
  process.exit(1);
}

const TIMEZONE = process.env.TIMEZONE || 'Asia/Shanghai';
u.initUtils(TIMEZONE);
console.log(`✅ 时区：${TIMEZONE}`);

// ── 初始化数据库 ──

db.initDatabase('reminders.sqlite');

// ── 频控 ──

const rateLimitMap = new Map();

// ── 清理定时器 ──

let cleanupTimer = null;

function startCleanupTimer() {
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    // 清理频控记录（60s 未活跃）
    for (const [key, value] of rateLimitMap) {
      if (now - value > 60000) rateLimitMap.delete(key);
    }
    // 清理用户缓存和延后记录
    r.cleanupCaches();
  }, 60000);
}

// ── 优雅关闭 ──

async function gracefulShutdown(bot, signal) {
  if (r.getShuttingDown()) return;
  r.setShuttingDown(true);
  console.log(`\n🛑 收到 ${signal}，正在优雅关闭...`);

  // 停止检查定时器
  r.clearCheckTimer();
  console.log('   ⏱️ 检查定时器已取消');

  // 停止清理定时器
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.log('   🧹 清理定时器已取消');
  }

  // 停止 Telegram 轮询
  try {
    console.log('   🔄 正在停止 Telegram 轮询...');
    await bot.stop(signal);
    console.log('   ✅ Telegram 轮询已停止');
  } catch (err) {
    console.error('   ⚠️ 停止 Telegram 时出错:', err.message);
  }

  // 关闭数据库
  db.closeDb();

  console.log('👋 已退出');
  // 延迟退出，确保日志输出
  setTimeout(() => process.exit(0), 500);
}

// ── 入口 ──

async function main() {
  const bot = new Telegraf(BOT_TOKEN);

  // 获取 Bot 用户名
  try {
    const me = await bot.telegram.getMe();
    p.setBotUsername(me.username);
    console.log(`🤖 @${me.username} 已连接`);
  } catch (err) {
    console.error('⚠️ 获取 Bot 信息失败，@用户名匹配可能不可用:', err.message);
  }

  // 全局错误捕获
  bot.catch((err, ctx) => {
    console.error(`[Bot 错误] updateType=${ctx?.updateType}:`, err.message || err);
  });

  // 频控 & 错误处理中间件
  bot.use(async (ctx, next) => {
    // 关闭中不处理新请求
    if (r.getShuttingDown()) return;

    // 回调查询不受频控限制
    if (!ctx.callbackQuery) {
      const userId = ctx.from?.id;
      if (userId) {
        const now = Date.now();
        const last = rateLimitMap.get(userId) || 0;
        if (now - last < u.RATE_LIMIT_MS) {
          // 频控触发时给用户反馈（仅对命令）
          if (ctx.message?.text?.startsWith('/')) {
            try {
              await ctx.reply('⚠️ 操作太频繁，请稍候再试').catch(() => {});
            } catch {}
          }
          return;
        }
        rateLimitMap.set(userId, now);
      }
    }

    try {
      await next();
    } catch (err) {
      console.error('[命令错误]', err.message || err);
      try {
        await ctx.reply('❌ 内部错误，请稍后重试').catch(() => {});
      } catch {}
    }
  });

  // 注册命令和回调
  h.setupCommands(bot);
  h.setupCallbacks(bot);

  // 启动清理定时器
  startCleanupTimer();

  // 启动定时检查
  r.scheduleCheck(bot);
  console.log(`✅ 定时检查已启动（每 ${u.CHECK_INTERVAL_SECONDS} 秒）`);

  // 启动 Telegram 轮询
  try {
    await bot.launch();
    console.log('✅ Telegram 轮询已启动');
  } catch (err) {
    console.error('❌ 启动失败:', err.message);
    db.closeDb();
    process.exit(1);
  }

  console.log('🚀 机器人已就绪');

  // 注册退出信号
  process.once('SIGINT', () => gracefulShutdown(bot, 'SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown(bot, 'SIGTERM'));
}

main().catch(err => {
  console.error('❌ 启动失败:', err);
  try { db.closeDb(); } catch {}
  process.exit(1);
});
