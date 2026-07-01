const express = require("express");
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const Database = require("better-sqlite3");

const app = express();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const BASE_URL = process.env.API_BASE_URL;

// ================= 配置区域 =================
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const GROUP_A_ID = process.env.GROUP_A_ID;
const GROUP_B_ID = process.env.GROUP_B_ID;

const CHECK_HOURS = 12;
const AMOUNT_CONFIRM = 799;
const AMOUNT_MAX = 8000;
const SAFE_REMARKS = ["周卡"];
const CONCURRENCY_LIMIT = 3;
const ACTION_EXPIRE_MS = 5 * 60 * 1000;

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
// ===========================================

// ================= 数据库配置 =================
const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS system_config ( key TEXT PRIMARY KEY, value TEXT );
  CREATE TABLE IF NOT EXISTS transaction_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_name TEXT,
    remark TEXT,
    amount REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_member_remark_time ON transaction_logs(member_name, remark, created_at);
`);

const tokenRow = db.prepare('SELECT value FROM system_config WHERE key = ?').get('global_token');
let GLOBAL_TOKEN = tokenRow ? tokenRow.value : null;

if (GLOBAL_TOKEN) console.log("✅ Token 已加载");
else console.log("⚠️ 等待输入 Token...");

const pendingActions = new Map();
// ===========================================

// ================= AI 数据清洗模块 =================

const SYSTEM_PROMPT = `
你是一个高智能的数据清洗与审核专家。你的任务是处理用户输入的"脏数据"，输出标准格式："用户名 备注 金额"。

### 🚫 核心底线
1. **金额神圣不可侵犯**：必须原样保留用户输入的数字，绝对禁止修改、四舍五入或编造金额。
2. **用户名保留**：原样保留用户名（允许英文、数字）。

### 🧠 智能清洗逻辑

**1. 备注处理:**
- 若备注缺失、无法推断、或是无效内容，统一修改为 "神秘"。

**2. 智能推断:**
- 如果遇到 "用户名 金额" (缺备注)，请查看上下文补全，否则统一补全为 "神秘"。
- 如果遇到 "用户名 备注" (缺金额)，直接丢弃该行。

**3. 格式整理:**
- 清洗后的数据格式严格为：用户名 备注 金额 (中间用一个空格分隔)。
- 去除多余空格。

### 📤 输出格式要求
- 直接输出结果，每行一条。若无有效数据，返回空字符串。
- **绝对禁止**使用 Markdown 代码块标记（如 \`\`\`）。
`;

async function callDeepSeekAPI(inputData) {
  if (!inputData || typeof inputData !== 'string') return "";
  console.log(">>> 正在调用 DeepSeek API..."); // 日志
  try {
    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `请清洗以下数据：\n${inputData}` }
        ],
        temperature: 0, 
        max_tokens: 4096,
      },
      {
        headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
        timeout: 60000,
      }
    );
    
    let content = response.data?.choices?.[0]?.message?.content || "";
    console.log("<<< DeepSeek 原始返回:\n" + content); // 日志

    // 去除 Markdown 代码块标记
    content = content.replace(/```(text|plaintext|json)?\n?/g, '').trim();
    if (content.startsWith('`') && content.endsWith('`')) {
        content = content.substring(1, content.length - 1).trim();
    }
    return content;
  } catch (error) {
    console.error("❌ DeepSeek API 报错:", error.response?.data || error.message);
    return null;
  }
}

// ================= 核心业务逻辑 =================

async function processWithConcurrency(tasks, handler, limit) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = Promise.resolve().then(() => handler(task)).then(res => {
      executing.splice(executing.indexOf(p), 1);
      return res;
    });
    results.push(p);
    executing.push(p);
    if (executing.length >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}

function generateHeaders(token) {
  const timestamp = Date.now().toString();
  return {
    accept: "application/json, text/plain, */*",
    cookie: `X-AUTH-TOKEN=${token}; sidebarStatus=0`,
    lang: "zh-CN",
    "request-encrypt": "true", 
    "x-auth-token": token,
    "x-tenant-code": "AMYLC",
    "x-timestamp": timestamp,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  };
}

async function updateBalance(memberName, remark, amount, token) {
  const url = `${BASE_URL}/livepro/memberAccount/updateBalance`;
  const requestData = {
    totalNum: 1, transDetail: "礼金", transType: 174, effecRolling: 1, rollingRate: "1",
    remark: "礼金", operatorRemark: remark,
    list: [{ memberName: memberName, amount: amount }],
  };
  try {
    const response = await axios.post(url, requestData, { headers: generateHeaders(token), timeout: 8000 });
    return { success: true, data: response.data };
  } catch (error) {
    const errorMsg = error.response?.data?.msg || error.message || "接口异常";
    return { success: false, error: errorMsg };
  }
}

function checkIsDuplicate(memberName, remark) {
  const sql = `SELECT id FROM transaction_logs WHERE member_name = ? AND remark = ? AND created_at > datetime('now', '-${CHECK_HOURS} hours')`;
  return !!db.prepare(sql).get(memberName, remark);
}

function logTransactionsBatch(tasks) {
  const insert = db.prepare('INSERT INTO transaction_logs (member_name, remark, amount) VALUES (@username, @remark, @amount)');
  const insertMany = db.transaction((items) => {
    for (const item of items) insert.run(item);
  });
  insertMany(tasks);
}

const TOKEN_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[!@#$%^&*()_+\-=[\]{}|;':",.<>/?])[a-zA-Z\d!@#$%^&*()_+\-=[\]{}|;':",.<>/?]+$/;
const STANDARD_PATTERN = /^\s*([\w.]+)\s+([\u4e00-\u9fa5a-zA-Z0-9]+)\s+([1-9]\d*)\s*$/gm;

// ===========================================

// --- 机器人监听逻辑 ---

// 1. Token 设置
bot.hears(TOKEN_PATTERN, (ctx) => {
  if (ADMIN_ID && ctx.from.id !== ADMIN_ID) return;
  GLOBAL_TOKEN = ctx.message.text;
  db.prepare('REPLACE INTO system_config (key, value) VALUES (?, ?)').run('global_token', GLOBAL_TOKEN);
  const msg = `✅ 密钥已更新！`;
  if (ctx.chat.id.toString() === GROUP_B_ID) ctx.reply(msg);
  else bot.telegram.sendMessage(GROUP_B_ID, msg);
});

bot.command('status', (ctx) => {
  if (ctx.chat.id.toString() === GROUP_B_ID) {
    ctx.reply(GLOBAL_TOKEN ? "🟢 正常" : "🔴 未初始化");
  }
});

// 2. A 群消息监听 (只转发)
bot.on('text', async (ctx) => {
  if (ctx.chat.id.toString() !== GROUP_A_ID) return;
  if (ctx.message.text.startsWith('/')) return;

  const userInput = ctx.message.text;
  
  // 转发原文
  try { await ctx.forwardMessage(GROUP_B_ID); } catch (e) {}

  // 发送指令
  const commandMsg = `#TASK ${ctx.chat.id} ${ctx.message.message_id} ${userInput}`;
  await bot.telegram.sendMessage(GROUP_B_ID, commandMsg);
});

// 3. B 群消息监听
bot.on('text', async (ctx) => {
  if (ctx.chat.id.toString() !== GROUP_B_ID) return;

  const text = ctx.message.text;

  if (text.startsWith('#TASK')) {
    // 【新增】立即反馈，确认收到指令
    const processingMsg = await ctx.reply("⏳ 收到指令，正在调用 AI 清洗...");

    const parts = text.match(/#TASK (-?\d+) (\d+) ([\s\S]*)/);
    if (!parts) {
        await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, null, "❌ 指令格式解析错误。");
        return;
    }

    const sourceChatId = parts[1];
    const sourceMessageId = parts[2];
    const content = parts[3];

    if (!/\d+/.test(content)) {
        await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, null, "❌ 内容中无数字，忽略。");
        return;
    }

    // 调用 AI
    const cleanedData = await callDeepSeekAPI(content);

    if (cleanedData === null) {
      await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, null, "❌ AI 服务异常/超时，请检查控制台日志。");
      return;
    }

    if (!cleanedData) {
      await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, null, "❌ AI 返回空数据，未解析出有效信息。");
      return;
    }

    // 更新状态
    await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, null, `✅ 清洗完成，正在执行逻辑...`);
    
    // 打印清洗结果供查看
    await ctx.reply(`📄 清洗结果:\n<pre>${cleanedData}</pre>`, { parse_mode: "HTML" });

    // 执行业务
    await handleProcessLogic(cleanedData, sourceChatId, sourceMessageId);
  }
});

// 4. 业务处理逻辑
async function handleProcessLogic(text, sourceChatId, sourceMessageId) {
  if (!GLOBAL_TOKEN) {
    return bot.telegram.sendMessage(GROUP_B_ID, "❌ 系统未初始化，无法加款。");
  }

  STANDARD_PATTERN.lastIndex = 0;
  const matches = [...text.matchAll(STANDARD_PATTERN)];
  
  if (matches.length === 0) {
    return bot.telegram.sendMessage(GROUP_B_ID, `❌ 业务逻辑错误：清洗后的数据无法匹配正则。\n内容: \n${text}`);
  }

  const tasksToConfirm = []; 
  const tasksToProcess = []; 
  const tasksFailed = [];    

  for (const [_, username, remark, amountStr] of matches) {
    const amount = parseFloat(amountStr);
    
    if (amount > AMOUNT_MAX) {
      tasksFailed.push({ username, remark, amount, error: `金额超限` });
      continue; 
    }

    let reasons = [];
    if (checkIsDuplicate(username, remark)) reasons.push("重复");
    if (amount > AMOUNT_CONFIRM && !SAFE_REMARKS.includes(remark)) reasons.push(`金额>${AMOUNT_CONFIRM}`);
    
    if (reasons.length > 0) tasksToConfirm.push({ username, remark, amount, reasons });
    else tasksToProcess.push({ username, remark, amount });
  }

  if (tasksFailed.length > 0) {
    let failText = `🚫 拒绝处理 (超限):\n`;
    tasksFailed.forEach(u => failText += `${u.username} ${u.amount}\n`);
    await bot.telegram.sendMessage(GROUP_B_ID, failText);
  }

  if (tasksToProcess.length > 0) {
    const results = await processWithConcurrency(tasksToProcess, 
      async (task) => {
        const result = await updateBalance(task.username, task.remark, task.amount, GLOBAL_TOKEN);
        return { ...task, ...result };
      }, CONCURRENCY_LIMIT);

    const successList = results.filter(r => r.success);
    const failList = results.filter(r => !r.success);

    if (successList.length > 0) logTransactionsBatch(successList);

    let replyTextB = `📢 自动处理结果 (${tasksToProcess.length}笔):\n`;
    if (successList.length > 0) {
      replyTextB += `✅ 成功: ${successList.length}\n`;
      successList.forEach(u => replyTextB += `${u.username} ${u.remark} ${u.amount}\n`);
    }
    if (failList.length > 0) {
      replyTextB += `\n❌ 失败: ${failList.length}\n`;
      failList.forEach(u => replyTextB += `${u.username} (${u.error})\n`);
    }
    await bot.telegram.sendMessage(GROUP_B_ID, replyTextB);

    if (sourceChatId && sourceMessageId && successList.length > 0) {
      await bot.telegram.sendMessage(sourceChatId, `✅ 加款成功：${successList.length} 笔`, { reply_to_message_id: sourceMessageId });
    }
  }

  if (tasksToConfirm.length > 0) {
    const actionId = Math.random().toString(36).substring(2, 10);
    pendingActions.set(actionId, { 
      tasks: tasksToConfirm, 
      expire: Date.now() + ACTION_EXPIRE_MS,
      source: { chatId: sourceChatId, msgId: sourceMessageId } 
    });

    let listText = "";
    tasksToConfirm.forEach(t => listText += `• ${t.username} | ${t.remark} | ${t.amount} [${t.reasons.join(', ')}]\n`);

    const warningText = `⚠️ 需人工确认:\n${listText}`;

    await bot.telegram.sendMessage(GROUP_B_ID, warningText, {
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ 确定', `confirm_${actionId}`),
        Markup.button.callback('❌ 取消', `cancel_${actionId}`)
      ])
    });
  }
}

// 5. 按钮回调
bot.action(/confirm_(.+)/, async (ctx) => {
  const actionId = ctx.match[1];
  const cached = pendingActions.get(actionId);

  if (!cached) return ctx.answerCbQuery("过期").catch(e => {});
  if (Date.now() > cached.expire) {
    pendingActions.delete(actionId);
    return ctx.editMessageText("超时");
  }

  pendingActions.delete(actionId);
  await ctx.editMessageText("⏳ 执行中...");

  const results = await processWithConcurrency(cached.tasks, 
    async (task) => {
      const result = await updateBalance(task.username, task.remark, task.amount, GLOBAL_TOKEN);
      return { ...task, ...result };
    }, CONCURRENCY_LIMIT);

  const successList = results.filter(r => r.success);
  if (successList.length > 0) logTransactionsBatch(successList);

  let resultText = `🔔 结果:\n✅ 成功: ${successList.length}\n❌ 失败: ${results.length - successList.length}`;
  ctx.editMessageText(resultText);

  if (cached.source && cached.source.chatId && cached.source.msgId && successList.length > 0) {
      await bot.telegram.sendMessage(cached.source.chatId, `✅ 已确认加款成功：${successList.length} 笔`, { reply_to_message_id: cached.source.msgId });
  }
});

bot.action(/cancel_(.+)/, async (ctx) => {
  pendingActions.delete(ctx.match[1]);
  await ctx.editMessageText("🚫 已取消。");
});

// 启动
bot.launch({ dropPendingUpdates: true, allowedUpdates: ["message", "callback_query"] })
  .then(() => console.log(`🤖 机器人启动成功`))
  .catch((err) => console.error("启动失败:", err));

process.once("SIGINT", () => { bot.stop("SIGINT"); db.close(); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); db.close(); });