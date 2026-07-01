# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-17

### Added

- 完整登录流程（按浏览器抓包还原）:
  - DNS TXT 解析（DoH `223.5.5.5`）`<companyCode>.qxdim.top`
  - `/query_company_server` 用企业 ID 换真实服务地址
  - `/pc_session` 获取预会话 token (5 分钟有效)
  - `/session_login/<token>` 激活预会话
  - `/login_pwd` 用户名密码登录
  - `/route` 获取 MQTT 服务器地址
- AES-128-CBC 加密（IV = Key，4 字节小时级时间戳前缀）
- MQTT v3.1.1 over WSS 客户端
  - 7 个 WildFireChat MQTT 协议补丁（自动应用）
  - PUBACK/CONNACK payload 提取
  - SUBACK flag bits 旁路
  - reasonCode=10 自定义成功码旁路
  - SUBACK granted 越界保护
- 消息收发
  - `sendMessage` 发送各类消息（文本/图片/语音/视频/文件等）
  - `pullMessages` 拉取历史消息
  - 自动处理 MN 通知 + 拉取增量消息
- 高级 SDK `class QXDim`
  - `login(companyCode, mobile, password)` 一行登录
  - `sendText(targetUserId, text)` 一行发文本
  - `onMessage(cb)` / `onStatusChange(cb)` / `onReconnect(cb)` / `onKickedOff(cb)`
  - `pullMessages()` / `disconnect()`
- 断线重连
  - 自动重连（5 秒间隔）
  - 保留 `lastMsgHead`，断线期间消息不丢
  - `resubscribe: true` 自动重订阅
  - 区分网络断开（重连）vs KICKED_OFF（不重连）
- Session 持久化
  - `saveSession` / `loadSession` / `clearSession` / `listSessions`
  - 避免每次 `autoLogin` 失效旧 token + 多端互踢
- TypeScript 类型定义（`types/index.d.ts`，~600 行）
- 7 个 patch 自动应用到 mqtt-packet 和 mqtt 包
- 完整文档 + 示例 + 诊断工具

### Verified

- 单元测试 29 项（AES + Protobuf）全过
- 端到端测试: 双账号双向实时消息（A→B, B→A）< 1 秒时延
- 断线重连测试: 主动断开后 5 秒自动重连，断线期间消息不丢
- TypeScript 严格模式类型检查通过

### Known Limitations

- 仅支持文本消息（图片/语音/视频/文件需要实现 OSS 上传）
- 没有强制 session TTL（依赖失败时上层主动清除）
- token 失效后不会自动重新登录（需要上层监听 onKickedOff）
- 仅在 Node.js 18+ 测试通过（依赖内置 fetch）
