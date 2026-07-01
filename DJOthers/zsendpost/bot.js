const express = require("express");
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
require("dotenv").config();
const { Markup } = require("telegraf");

const app = express();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const SERVER_PORT = process.env.PORT || 3700;
let server = null;
// 静态数据
let staticData = null;
let newCurrentDraw = null;
// 加载本地数据
async function loadZodiacData() {
  try {
    const dataPath = path.join(__dirname, "data", "zodiac.json");
    const data = await fs.readFile(dataPath, "utf8");
    staticData = JSON.parse(data);
    return true;
  } catch (error) {
    console.error(`❌ 加载数据失败: ${error.message}`);
    staticData = {};
    return false;
  }
}
// 获取最新开奖结果
async function getCurrentDraw() {
  try {
    const url = "https://macaumarksix.com/api/macaujc2.com";
    const response = await axios.get(url);
    return response.data; // ✅ 直接返回数据
  } catch (error) {
    console.error(`❌ 获取最新开奖数据失败: ${error.message}`);
    throw error; // ✅ 将错误向上抛出，由调用者处理
  }
}

// 开启机器人指令 - 补上这个命令！
bot.command("start", (ctx) => {
  ctx.reply("Welcome", Markup.keyboard([["⚙️ 预览", "📝 更新"]]).resize());
});

bot.hears("⚙️ 预览", (ctx) => {
  ctx.reply("Welcome2222");
});

bot.hears("📝 更新", async (ctx) => {
  newCurrentDraw = await getCurrentDraw();
  console.log(newCurrentDraw);
  ctx.reply("Welcome1111");
});

// 健康检查
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get("/", (req, res) => {
  res.json({ message: "Telegram Bot Server", status: "running" });
});

// 优雅关闭
async function gracefulShutdown() {
  console.log("\n🛑 收到关闭信号，开始优雅关闭...");

  try {
    // 停止 Bot
    bot.stop();
    console.log("✅ Bot 已停止");

    // 停止 Express 服务器
    if (server) {
      await new Promise((resolve) => {
        server.close(() => {
          console.log("✅ Express 服务器已停止");
          resolve();
        });
      });
    }

    console.log("🎉 所有服务已关闭");
    process.exit(0);
  } catch (error) {
    console.error("❌ 关闭过程中出错:", error);
    process.exit(1);
  }
}

// 信号处理
process.on("SIGINT", gracefulShutdown); // Ctrl+C
process.on("SIGTERM", gracefulShutdown); // 容器关闭信号

// 全局错误处理
process.on("unhandledRejection", (reason, promise) => {
  console.error("未处理的 Promise 拒绝:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("未捕获的异常:", error);
  process.exit(1);
});

// Bot 错误处理
bot.catch((err, ctx) => {
  console.error(`Bot 错误 [${ctx?.updateType || "unknown"}]:`, err.message);
  if (ctx?.reply) {
    ctx.reply(`未知错误......`);
  }
});

// 启动服务
async function startServer() {
  try {
    await loadZodiacData(); // 加载本地数据
    console.log("🚀 启动服务...");
    // 启动 Express 服务器
    server = app.listen(SERVER_PORT, () => {
      console.log(`🌐 Express 服务器运行在端口 ${SERVER_PORT}`);
      console.log(`🔗 健康检查: http://localhost:${SERVER_PORT}/health`);
    });

    // 启动 Telegram 机器人
    await bot.launch({
      dropPendingUpdates: true, // 忽略历史消息
      allowedUpdates: ["message", "callback_query"],
    });
    console.log("🤖 Bot 启动成功");
    console.log("🎉 所有服务启动完成");
    console.log("⏰ 启动时间:", new Date().toLocaleString());
  } catch (error) {
    console.error("❌ 启动失败:", error.message);
    process.exit(1);
  }
}

// 启动
startServer();
