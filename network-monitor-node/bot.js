/**
 * Telegram Bot 交互模式
 * 支持指令：/check /checkall /quick /category /help /status
 *
 * 自动检测（需在 .env 配置 AUTO_CHECK_INTERVAL_MIN > 0）：
 *   分组轮转，BOCE 全国 HTTP 检测
 * 每日日报（需在 .env 配置 DAILY_REPORT_HOUR）：
 *   指定北京时间整点发送全国 HTTP 检测报告
 */

const TelegramBot = require('node-telegram-bot-api');

const {
  loadConfig, loadSites, getAllUrls, extractDomain,
  splitMessage, logger,
  runCurlCheck, formatReport, writeReportLog, beijing,
} = require('./monitor');

function main() {
  const config = loadConfig();
  const bot = new TelegramBot(config.tg_bot_token, { polling: true });

  const ALLOWED_USERS = config.allowed_users || [];

  let isRunning = false;

  function isAllowed(msg) {
    if (ALLOWED_USERS.length === 0) return true;
    return ALLOWED_USERS.includes(msg.from.id);
  }

  let autoCheckTimer = null;
  let dailyReportTimer = null;

  function shutdown(signal) {
    logger.info(`收到 ${signal}，正在退出...`);
    if (autoCheckTimer) clearInterval(autoCheckTimer);
    if (dailyReportTimer) clearInterval(dailyReportTimer);
    bot.stopPolling();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ==================== 共享：加锁执行 ====================

  async function withLock(chatId, fn) {
    if (isRunning) {
      bot.sendMessage(chatId, '⏳ 有检测任务正在执行中，请稍后再试');
      return;
    }
    isRunning = true;
    try { await fn(); } catch (e) {
      bot.sendMessage(chatId, `❌ 检测失败: ${e.message}`);
    } finally {
      isRunning = false;
    }
  }

  // ==================== 共享：执行检测 → 报告 → 发送 ====================

  async function executeCheck(chatId, urls, opts = {}) {
    const { notifyChatId } = opts;
    const targetChatId = notifyChatId || chatId;

    const initMsg = await bot.sendMessage(targetChatId, '📡 网络检测中...');
    const statusMsgId = initMsg.message_id;

    const results = await runCurlCheck(urls, config.boce_api_key, (progress) => {
      try { bot.editMessageText(progress, { chat_id: targetChatId, message_id: statusMsgId }); } catch (_) {}
    });

    const report = formatReport(results, config.anomaly_threshold);
    writeReportLog(report);

    const messages = splitMessage(report, 4000);
    await bot.editMessageText(messages[0], { chat_id: targetChatId, message_id: statusMsgId });
    for (let i = 1; i < messages.length; i++) {
      await bot.sendMessage(targetChatId, messages[i]);
    }

    return { results, report };
  }

  // ==================== 命令处理 ====================

  bot.onText(/\/help/, (msg) => {
    if (!isAllowed(msg)) return;
    bot.sendMessage(msg.chat.id, `📡 网络监控机器人指令：

/check <网址> - 全国HTTP检测网站
  例: /check google.com baidu.com

/checkall - 检测所有网站

/category <分类> - 按分类检测
  例: /category 自有网站

/categories - 查看所有分类

/status - 查看机器人状态

💡 检测约需1-2分钟/网站`);
  });

  // /check <网址>
  bot.onText(/\/check(?:@\w+)?\s+([^]+)/, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    const sites = match[1].trim().split(/\s+/).filter(Boolean);

    if (sites.length === 0) {
      bot.sendMessage(chatId, '请输入要检测的网址\n例: /check google.com baidu.com');
      return;
    }

    await withLock(chatId, async () => {
      await executeCheck(chatId, sites.map(s => ({ url: s, category: '指定' })));
    });
  });

  // /checkall
  bot.onText(/\/checkall/, async (msg) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;

    const urls = getAllUrls(loadSites());
    if (!urls.length) { bot.sendMessage(chatId, '❌ sites.json 中没有网站'); return; }

    await withLock(chatId, async () => {
      await executeCheck(chatId, urls);
    });
  });

  // /category <分类>
  bot.onText(/\/category(?:@\w+)?\s*(.*)/, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    const category = match[1].trim();

    if (!category) { bot.sendMessage(chatId, '请输入分类名称\n例: /category 自有网站'); return; }

    const urls = getAllUrls(loadSites(category));
    if (!urls.length) { bot.sendMessage(chatId, `❌ 分类 '${category}' 不存在`); return; }

    await withLock(chatId, async () => {
      await executeCheck(chatId, urls);
    });
  });

  // /categories
  bot.onText(/\/categories/, (msg) => {
    if (!isAllowed(msg)) return;
    const sitesData = loadSites();
    const lines = ['📋 网站分类列表：\n'];
    for (const [cat, urlList] of Object.entries(sitesData)) {
      lines.push(`【${cat}】(${urlList.length}个)`);
      for (const url of urlList) lines.push(`  - ${extractDomain(url)}`);
      lines.push('');
    }
    bot.sendMessage(msg.chat.id, lines.join('\n'));
  });

  // /status
  bot.onText(/\/status/, (msg) => {
    if (!isAllowed(msg)) return;
    const sitesData = loadSites();
    const totalSites = Object.values(sitesData).reduce((sum, list) => sum + list.length, 0);
    const categories = Object.keys(sitesData);
    const interval = config.auto_check_interval_min || 0;
    const groupCount = config.auto_check_group_count || 1;
    const dailyHour = config.daily_report_hour;

    let autoInfo, dailyInfo;
    if (interval > 0) {
      autoInfo = `✅ 每${interval}分钟，${groupCount}组轮转（BOCE全国HTTP）`;
    } else {
      autoInfo = '❌ 未启用（设置 AUTO_CHECK_INTERVAL_MIN > 0 开启）';
    }
    if (dailyHour >= 0) {
      dailyInfo = `✅ 每天${dailyHour}:00 (北京时间)`;
    } else {
      dailyInfo = '❌ 未启用（设置 DAILY_REPORT_HOUR 开启）';
    }

    bot.sendMessage(msg.chat.id, `🟢 机器人运行中

📊 配置:
  网站: ${totalSites}个 (${categories.join('、')})
  定时巡检: ${autoInfo}
  每日日报: ${dailyInfo}
  BOCE API: ${config.boce_api_key ? '✅ 已配置' : '❌ 未配置'}`);
  });

  bot.on('polling_error', (error) => {
    logger.error(`Bot polling error: ${error.message}`);
  });

  // ==================== 定时自动检测（分组轮转） ====================

  let previousState = {};
  let groupIndex = 0;

  async function runAutoCheck() {
    const allUrls = getAllUrls(loadSites());
    if (!allUrls.length) return;

    const groupCount = config.auto_check_group_count || 1;
    const groups = [];
    for (let i = 0; i < allUrls.length; i += Math.ceil(allUrls.length / groupCount)) {
      groups.push(allUrls.slice(i, i + Math.ceil(allUrls.length / groupCount)));
    }
    const currentGroup = groups[groupIndex % groups.length];
    groupIndex++;

    const groupLabel = groupCount > 1
      ? `[第${(groupIndex - 1) % groups.length + 1}/${groups.length}组 ${currentGroup.length}个站]`
      : '';
    logger.info(`[自动检测] ${groupLabel} BOCE HTTP检测...`);

    try {
      const results = await runCurlCheck(currentGroup, config.boce_api_key);

      // 计算各站点异常节点数，对比上次状态
      const currentState = {};
      const changed = [];
      for (const r of results) {
        const badCount = r.nodes.filter(n => !n.ok).length;
        currentState[r.domain] = badCount;
        if (previousState.hasOwnProperty(r.domain) && previousState[r.domain] !== badCount) {
          changed.push(r);
        }
      }

      const isFirstRun = Object.keys(previousState).length === 0;
      if (isFirstRun) {
        previousState = currentState;
        logger.info(`[自动检测] 基线已建立`);
        return;
      }

      previousState = currentState;

      if (changed.length > 0) {
        const lines = changed.map(r => {
          const bad = r.nodes.filter(n => !n.ok).length;
          const total = r.nodes.length;
          if (bad === 0) return `🟢 ${r.domain} 全部恢复 (${total}省全通)`;
          return `⚠️ ${r.domain} ${bad}/${total}省异常`;
        });
        const msg = `⚠️ 状态变化 ${beijing.full()}\n\n${lines.join('\n')}`;
        writeReportLog(msg);

        const notifyChatId = config.tg_chat_id;
        if (notifyChatId) await bot.sendMessage(notifyChatId, msg);
        logger.info(`[自动检测] ${changed.length}个站点状态变化，已推送`);
      } else {
        logger.info(`[自动检测] ${groupLabel}无变化`);
      }
    } catch (e) {
      logger.error(`[自动检测] 异常: ${e.message}`);
    }
  }

  function startAutoCheck() {
    const interval = config.auto_check_interval_min;
    if (!interval || interval <= 0) {
      logger.info('自动检测未启用（AUTO_CHECK_INTERVAL_MIN 未配置或为0）');
      return;
    }
    const groupCount = config.auto_check_group_count || 1;
    logger.info(`自动检测已启用：每${interval}分钟，${groupCount}组轮转（BOCE全国HTTP）`);
    setTimeout(() => runAutoCheck(), 10000);
    autoCheckTimer = setInterval(() => runAutoCheck(), interval * 60 * 1000);
  }

  // ==================== 每日日报 ====================

  function scheduleDailyReport() {
    const hour = config.daily_report_hour;
    if (hour === undefined || hour === null || hour < 0 || isNaN(hour)) {
      logger.info('每日日报未启用（DAILY_REPORT_HOUR 未配置）');
      return;
    }

    const BJ_OFFSET = 8 * 60;
    const nowUtc = new Date();
    const bjNowMins = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes() + BJ_OFFSET;
    const bjMins = ((bjNowMins % 1440) + 1440) % 1440;
    const targetMins = hour * 60;
    let delayMins = targetMins - bjMins;
    if (delayMins <= 0) delayMins += 1440;
    const delay = delayMins * 60 * 1000;

    const execTime = new Date(Date.now() + delay);
    logger.info(`每日日报已启用：每天${hour}:00 (北京时间) — 下次: ${execTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);

    setTimeout(() => {
      runDailyReport();
      dailyReportTimer = setInterval(() => runDailyReport(), 24 * 60 * 60 * 1000);
    }, delay);
  }

  async function runDailyReport() {
    logger.info('[每日日报] 开始全国HTTP检测...');

    const urls = getAllUrls(loadSites());
    if (!urls.length) return;

    try {
      const results = await runCurlCheck(urls, config.boce_api_key);
      const report = formatReport(results, config.anomaly_threshold);
      writeReportLog(report);
      const fullReport = `📋 省份连通日报（${beijing.date()}）\n\n${report}`;

      const messages = splitMessage(fullReport, 4000);
      for (const m of messages) {
        await bot.sendMessage(config.tg_chat_id, m);
      }

      logger.info('[每日日报] 已发送');
    } catch (e) {
      logger.error(`[每日日报] 失败: ${e.message}`);
    }
  }

  logger.info('Telegram Bot 已启动，等待指令...');
  startAutoCheck();
  scheduleDailyReport();
}

main();
