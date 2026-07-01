# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

网络连通性监控 (Network Connectivity Monitor) — 通过 BOCE 全国节点对网站发起 HTTP 请求，检测各省份是否可正常访问。Telegram Bot 是唯一入口。

## Commands

```bash
npm run dev    # 启动 Telegram Bot（长驻进程）
```

无测试、lint、构建步骤。

## Architecture

### 两个文件

- **`monitor.js`** — 纯库。导出配置加载、BOCE HTTP 检测、报告生成、日志等函数。不含 Telegram 依赖。
- **`bot.js`** — 唯一入口。导入 monitor.js，注册 Telegram 命令和定时任务。

### 检测流程（`runCurlCheck` in `monitor.js`）

1. `getNodeIds()` — 获取全国 BOCE 节点 ID 列表（缓存 30 分钟）
2. 对每个 URL 调用 `/v3/task/create/curl?key=xxx&host=domain&node_ids=xxx`
3. 每 10 秒轮询 `/v3/task/curl/:id?key=xxx`，最多 2 分钟
4. `parseCurlResults()` — 解析结果：`{ node, http_code, time_total, ok }`
5. 节点 ok = `error_code === 0`（BOCE 成功完成 HTTP 请求即为可达）

### 报告格式（`formatReport` in `monitor.js`）

按分类分组，每站点显示：
- 全通：`✅ domain (94省全通)`
- 异常：`⚠️ domain (90正常/4异常/94省 | 均速1.2s)` + 异常节点详情
- 失败：`❌ domain 检测失败: 原因`

异常节点 ≤10 个列出全名，>10 个只列前 10。

### 配置（`.env` + `dotenv`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `TG_BOT_TOKEN` | (必填) | Telegram bot token |
| `TG_CHAT_ID` | (必填) | 通知目标 chat ID |
| `BOCE_API_KEY` | — | BOCE API 密钥 |
| `ALLOWED_USERS` | 允许所有人 | 逗号分隔 Telegram 用户 ID |
| `AUTO_CHECK_INTERVAL_MIN` | 0=禁用 | 自动检测间隔（分钟） |
| `AUTO_CHECK_GROUP_COUNT` | 4 | 分组数，每轮只检测 1/N 站点 |
| `DAILY_REPORT_HOUR` | -1=禁用 | 每日日报北京时间整点 |

### 定时任务（bot.js）

| 任务 | 触发 | 检测 | 通知 |
|------|------|------|------|
| 自动巡检 | 每 N 分钟，分组轮转 | BOCE 全国 HTTP | 状态变化时 |
| 每日日报 | 每天指定整点 (北京时间) | BOCE 全国 HTTP | 必发 |
| `/checkall` `/check` `/category` | Telegram 指令 | BOCE 全国 HTTP | 必发 |

自动检测的状态对比基于异常节点数：同一站点异常节点数变化时触发通知。

### 北京时间工具（`beijing` in `monitor.js`）

- `beijing.iso()` → `2026-06-08 14:49:06`
- `beijing.full()` → `2026/6/8 14:49:06`
- `beijing.date()` → `2026-06-08`

所有时间输出强制 `Asia/Shanghai`，日报调度基于 UTC+8 计算（不依赖服务器时区）。

### 报告持久化

所有检测报告通过 `writeReportLog()` 追加写入 `reports.log`。

## Dependencies

- **`node-fetch` v2** (CJS)
- **`node-telegram-bot-api`**
- **`dotenv`**
