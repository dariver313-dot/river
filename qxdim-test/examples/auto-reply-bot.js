#!/usr/bin/env node
/**
 * 企讯达自动回复机器人
 *
 * 用 DeepSeek API 自动回复收到的消息。
 *
 * 用法:
 *   DEEPSEEK_API_KEY=sk-xxx \
 *   QXDIM_COMPANY_CODE=your_company_code \
 *   QXDIM_MOBILE="+86 xxx" QXDIM_PASSWORD="xxx" \
 *   node examples/auto-reply-bot.js
 *
 * 可选环境变量:
 *   DEEPSEEK_MODEL=deepseek-chat           (或 deepseek-reasoner)
 *   DEEPSEEK_MAX_TOKENS=1000
 *   DEEPSEEK_TEMPERATURE=0.7
 *   BOT_SYSTEM_PROMPT="你是企讯达客服，回答用户问题"
 *   BOT_RATE_LIMIT_MS=3000                 (同一用户回复间隔)
 *   BOT_PERSIST_HISTORY=true               (对话历史持久化到文件)
 *   BOT_MAX_HISTORY=20                     (每用户最大历史轮数)
 *   BOT_VERBOSE=true                       (打印详细调试信息：每条消息类型、跳过原因样本等)
 */

import { QXDim, ConnectionStatus, loadEnv } from '../src/index.js';
import { AutoReplyBot } from '../src/ai/auto-reply.js';

// ★ 自动加载 .env 文件（如果存在）
loadEnv();

function ts() { return new Date().toLocaleTimeString(); }

const MEDIA_ICONS = {
  image: '📷', voice: '🎤', video: '🎬', file: '📎',
  location: '📍', sticker: '😀',
};
function mediaLabel(msg) {
  const icon = MEDIA_ICONS[msg.mediaType] || '📁';
  return `${icon} ${msg.mediaType}`;
}

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('❌ 缺少 DEEPSEEK_API_KEY 环境变量');
    process.exit(1);
  }

  const companyCode = process.env.QXDIM_COMPANY_CODE;
  const mobile = process.env.QXDIM_MOBILE;
  const password = process.env.QXDIM_PASSWORD;
  if (!companyCode || !mobile || !password) {
    console.error('❌ 缺少环境变量: QXDIM_COMPANY_CODE, QXDIM_MOBILE, QXDIM_PASSWORD');
    console.error('  请参考 .env.example 配置');
    process.exit(1);
  }

  const verbose = process.env.BOT_VERBOSE === 'true';

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   企讯达 × DeepSeek 自动回复机器人            ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`企业 ID    : ${companyCode}`);
  console.log(`手机号     : ${mobile.replace(/(\+86 )?(\d{3})\d{4}(\d{4})/, '$1$2****$3')}`);
  console.log(`DeepSeek   : model=${process.env.DEEPSEEK_MODEL || 'deepseek-chat'}`);
  if (verbose) console.log(`调试模式   : 开启 (BOT_VERBOSE=true)`);
  console.log('');

  // 1. 登录 QXDim
  console.log(`[${ts()}] 登录中...`);
  const qxd = new QXDim();

  qxd.onStatusChange((s) => {
    const names = ['未连接', '连接中', '已连接', '', '', '', '', '被踢下线'];
    console.log(`[${ts()}] ${names[s] || `状态=${s}`}`);
  });

  qxd.onReconnect((n) => console.log(`[${ts()}] 🔄 重连第 ${n} 次`));
  qxd.onKickedOff((reason) => console.log(`[${ts()}] 👋 被踢: ${reason}`));
  qxd.onRelogin((e) => {
    if (e.phase === 'start') console.log(`[${ts()}] 🔁 重登中...`);
    else if (e.phase === 'success') console.log(`[${ts()}] ✅ 重登成功`);
    else if (e.phase === 'error') console.log(`[${ts()}] ❌ 重登失败: ${e.error}`);
  });

  const user = await qxd.login(companyCode, mobile, password, {
    autoRelogin: true,
    maxReloginAttempts: 3,
  });
  console.log(`[${ts()}] ✅ 登录成功: ${user.userName} (${user.userId})`);
  console.log(`[${ts()}] 企业: ${user.companyName}\n`);

  // 2. 创建自动回复机器人
  const bot = new AutoReplyBot({
    apiKey,
    myUserId: user.userId,
    systemPrompt: process.env.BOT_SYSTEM_PROMPT || '你是企讯达客服，回答用户问题',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    maxTokens: parseInt(process.env.DEEPSEEK_MAX_TOKENS || '1000'),
    temperature: parseFloat(process.env.DEEPSEEK_TEMPERATURE || '0.7'),
    rateLimitMs: parseInt(process.env.BOT_RATE_LIMIT_MS || '3000'),
    persistHistory: process.env.BOT_PERSIST_HISTORY === 'true',
    maxHistoryPerUser: parseInt(process.env.BOT_MAX_HISTORY || '20'),
  });

  // 3. 注册消息回调
  // ★ 追踪收到的消息 ID，诊断重复分发问题
  const _seenMsgIds = new Set();
  const _MAX_SEEN_MSG_IDS = 5000;
  qxd.onMessage((msg) => {
    const mid = msg.messageId || '(无)';
    const isDup = _seenMsgIds.has(mid) && mid !== '(无)';
    if (isDup) {
      console.log(`[${ts()}] 🔁 重复消息! messageId=${mid} from=${msg.fromUserId?.substring(0,10)} text="${(msg.text||'').substring(0,40)}"`);
    }
    _seenMsgIds.add(mid);
    // ★ 防止内存泄漏: 超过上限时淘汰最旧的 25%
    if (_seenMsgIds.size > _MAX_SEEN_MSG_IDS) {
      const it = _seenMsgIds.values();
      const toRemove = Math.floor(_MAX_SEEN_MSG_IDS / 4);
      for (let i = 0; i < toRemove; i++) {
        _seenMsgIds.delete(it.next().value);
      }
    }

    // 简洁输出：文本消息显示内容，媒体消息显示类型图标，typing 等通知静默跳过
    if (msg.text) {
      const dupMark = isDup ? ' [DUP]' : '';
      console.log(`[${ts()}] 📩 ${msg.fromUserId}  ${msg.text.substring(0, 100)}${dupMark}`);
    } else if (msg.mediaType) {
      console.log(`[${ts()}] ${mediaLabel(msg)}  ${msg.fromUserId}`);
    } else if (verbose) {
      console.log(`[${ts()}] 🔕 type=${msg.content?.type} from=${msg.fromUserId?.substring(0, 10)} mid=${mid}`);
    }

    // 交给机器人处理
    bot.handleMessage(msg, qxd).catch(e => {
      console.error(`[${ts()}] ❌ 处理异常:`, e.message);
    });
  });

  console.log(`[${ts()}] 🤖 机器人已启动，等待消息...`);
  console.log(`[${ts()}]   发消息给 ${mobile} 即可触发自动回复`);
  console.log(`[${ts()}]   Ctrl+C 退出\n`);

  // 4. 每 60 秒打印统计
  const statsTimer = setInterval(async () => {
    const stats = await bot.getStats();
    console.log(`[${ts()}] 📊 收到=${stats.received} 处理=${stats.processed} 回复=${stats.replied} 错误=${stats.errors} 跳过=${stats.skipped} 用户=${stats.activeUsers}`);
  }, 60000);

  // 5. 优雅退出
  let shuttingDown = false;
  process.on('SIGINT', async () => {
    if (shuttingDown) { process.exit(1); return; }
    shuttingDown = true;
    clearInterval(statsTimer);
    console.log(`\n[${ts()}] 正在退出...`);
    try {
      const stats = await bot.getStats();
      console.log(`[${ts()}] 最终: 收到=${stats.received} 处理=${stats.processed} 回复=${stats.replied} 错误=${stats.errors}`);
      if (verbose && stats.skipped > 0) {
        const sr = stats.skipReasons || {};
        console.log(`[${ts()}]   跳过: 非单聊=${sr.nonSingleChat} 自己=${sr.selfMessage} 系统=${sr.systemNotification} 非文本=${sr.nonText} 去重=${sr.duplicate} 限速=${sr.rateLimit} 并发=${sr.concurrent}`);
      }
      await qxd.disconnect();
    } catch (e) {
      console.error(`[${ts()}] 退出清理异常:`, e.message);
    }
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('致命错误:', e);
  process.exit(1);
});
