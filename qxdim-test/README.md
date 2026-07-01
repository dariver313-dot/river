# 企讯达 (QXDIM) 协议测试工具

基于逆向工程的企讯达 IM 协议 Node.js 实现。完整支持 `/login_pwd → /route → MQTT over WSS → 收发消息` 全链路。

## 协议底座

WildFireChat (野火IM) 定制版，企讯达额外加了**企业 ID 解析层**和**预会话 token**机制。完整登录流程：

```
用户输入: 企业ID + 手机号 + 密码

1. DNS TXT 解析 (DoH)
   GET https://223.5.5.5/resolve?name=<companyCode>.qxdim.top&type=txt
   → 5 个候选 appServer URL

2. /query_company_server (任一候选)
   POST body: { companyCode: "your_company_code" }
   → { appServerHost, imServerHost, proxyServerHost, companyName, ... }

3. /pc_session (到 appServerHost)
   POST body: { flag:1, device_name:"pc", clientId, platform:5, userId:null }
   headers: authToken: "0"
   → { token: "<pc_session_token>", expired: 300000 }  ← 预会话 token (5分钟)
   ← Set-Cookie: JSESSIONID=...

4. /session_login/<pc_session_token> (到 appServerHost)  ★ 新增
   POST body: (空)
   headers: authToken: "0", Cookie: JSESSIONID=...
   → { code: 0, message: "success", result: null }  ← 激活预会话

5. /login_pwd (到 appServerHost)
   POST body: { mobile, password, clientId, platform:5 }
   headers: authToken: <pc_session_token>   ← 必带
   → { userId, token (加密), userName, portrait, register }

6. /route (到 appServerHost)
   POST 加密 body
   headers: appId, appKey, cid, uid, p
   → { host, longPort, shortPort, wssPort, node, commercial }

7. MQTT WSS 连接
   wss://<host>:<wssPort>
   username: userId, password: AES(tokenPart1, tokenKey)
   protocolVersion: 4 (MQTT 3.1.1)
   → CONNACK returnCode=0 + ConnectAckPayload protobuf
```

主要协议特征：
- **AES-128-CBC**，IV = Key，明文前 4 字节是小时级时间戳（从 2018-01-01 起算）
- **MQTT v3.1.1 over WSS**，protocolVersion=4（不是 WFC 原生的 6）
- **PUBACK 后追加 payload**：服务器响应数据挂在 PUBACK 报文末尾
- **CONNACK 后追加 ConnectAckPayload protobuf**：连接成功后的版本号信息
- **SUBACK flag bits 非零**：违反 MQTT 规范，需要旁路 mqtt-packet 的严格检查
- **reasonCode=10 是自定义成功码**：标准 mqtt.js 会当错误，需要旁路

## 目录结构

```
qxdim-test/
├── package.json              # ★ npm 发布配置 (name=qxdim)
├── README.md
├── LICENSE                   # ★ MIT + 逆向工程免责声明
├── CHANGELOG.md              # ★ 版本变更记录
├── tsconfig.json             # TypeScript 配置（用于 typecheck）
├── .ts-node.json             # ★ ts-node 配置（用于集成测试）
├── proto/qxdim.proto           # 协议定义（129 种消息类型）
├── types/
│   └── index.d.ts              # ★ 完整 TypeScript 类型定义
├── config/
│   ├── example.js              # 配置示例（复制为 config.js 使用）
│   └── sessions/               # ★ session 持久化目录（自动生成，已 .gitignore）
├── src/                        # 核心库（不含可执行入口）
│   ├── index.js                # 统一导出所有公开 API
│   ├── index.d.ts              # ★ 类型代理（重导出 types/index.d.ts）
│   ├── qxdim.js                # ★ 高级 SDK (class QXDim)
│   ├── crypto/aes.js           # AES-128-CBC + XOR + Will Topic
│   ├── proto/index.js          # protobufjs 动态加载器
│   ├── protocol/
│   │   ├── auto-login.js       # ★ 完整登录流程 (企业ID→DNS→query→pc_session→session_login→login_pwd→route)
│   │   ├── company-resolve.js  # ★ DoH DNS TXT 解析 <companyCode>.qxdim.top
│   │   ├── company-server.js   # ★ /query_company_server 用企业ID换实际服务地址
│   │   ├── pc-session.js       # ★ /pc_session 获取预会话 token (5分钟)
│   │   ├── session-login.js    # ★ /session_login/<token> 激活预会话
│   │   ├── route.js            # /route 请求
│   │   ├── direct-connect.js   # 绕过 /route 直连
│   │   ├── mqtt-client.js      # MQTT WSS 客户端（含断线重连 + lastMsgHead 拉取逻辑）
│   │   ├── session-store.js    # ★ session 文件持久化
│   │   └── wfc-mqtt-patch.js   # PUBACK/CONNACK 响应解密
│   └── utils/message-parser.js # 消息内容解析（文本/图片/语音/视频等）
├── tests/                      # 单元测试 + 集成测试
│   ├── all.test.js             # 综合测试入口（单元测试）
│   ├── crypto.test.js          # AES 加解密 18 项
│   ├── proto.test.js           # Protobuf 编解码 11 项
│   ├── route.test.js           # /route 请求（需凭据）
│   └── integration/            # ★ 集成测试 (TypeScript)
│       ├── _helpers.ts         # 共享工具（断言、runTest、createAndLogin）
│       ├── 01-sdk-login.test.ts        # QXDim SDK 基本功能 (6 项)
│       ├── 02-session-cache.test.ts    # Session 缓存复用 (5 项)
│       ├── 03-reconnect.test.ts        # 断线重连 + 消息不丢 (4 项)
│       ├── 05-auto-relogin.test.ts     # 自动重登 (3 项)
│       └── run-all.ts          # 总入口（跑全部 4 套件）
├── examples/                   # 可运行示例
│   ├── sdk-demo.js             # ★ QXDim 高级 SDK 演示（单账号 + 双账号模式）
│   ├── ts-usage-example.ts     # ★ TypeScript 使用示例（验证类型推断）
│   ├── e2e-test.js             # 单账号端到端：登录 → 拉历史
│   ├── send-message.js         # 单账号发消息 + 验证落库
│   ├── realtime-chat.js        # 单账号双端 (同 userId 双 clientId) 实时
│   ├── realtime-chat-2accounts.js  # 真双账号双向实时测试（企业 ID 模式）
│   ├── reconnect-test.js       # 断线重连测试
│   └── login-and-listen.js     # 用现有 token 连接并监听
├── tools/                      # 逆向工程 / 诊断 / 运维工具
│   ├── save-session.js         # ★ 登录并保存 session（支持企业 ID 模式）
│   ├── diagnose-mqtt.js        # MQTT 认证逐步诊断
│   ├── diagnose-key-encoding.js# AES 密钥编码链追踪
│   ├── route-diagnostic.js     # /route 系统性穷举测试
│   ├── brute-route-decrypt.js  # /route 响应解密穷举
│   ├── verify-password.js      # MQTT password 精确构建验证
│   ├── decode-token.js         # token 解码工具
│   ├── extract-params.js       # 浏览器控制台参数提取
│   └── extract-params-console.js
└── scripts/                    # 运维脚本
    └── patch-mqtt.js           # 应用 7 个 WildFireChat MQTT 补丁
```

## 快速开始

### 1. 安装

```bash
cd qxdim-test
pnpm install
pnpm run patch   # 手动执行 scripts/patch-mqtt.js 应用 7 个补丁
```

### 2. 启动自动回复机器人（开发模式）

```bash
# 复制环境变量模板并填入你的凭据
cp .env.example .env
# 编辑 .env，填入 QXDIM_MOBILE / QXDIM_PASSWORD / DEEPSEEK_API_KEY

pnpm dev
# 等价于: node examples/auto-reply-bot.js
# predev 钩子会自动确保 MQTT 补丁已应用（幂等，已应用会快速跳过）
```

启动后会自动登录企讯达、连接 MQTT、监听消息，收到消息时调用 DeepSeek 生成回复。

### 3. 跑单元测试（无需凭据）

```bash
pnpm test
# 或单独跑
pnpm run test:crypto
pnpm run test:proto
```

期望：crypto 18 项 + proto 11 项全过。

### 4. 跑集成测试（需要凭据，TypeScript）

```bash
# 跑全部 4 套集成测试 (ts-node ESM)
QXDIM_COMPANY_CODE=your_company_code \
QXDIM_MOBILE_A="+86 13800000000" QXDIM_PASSWORD_A="your_password" \
QXDIM_MOBILE_B="+86 13900000001" QXDIM_PASSWORD_B='your_password' \
npm run test:integration

# 或单独跑某个套件
npm run test:integration:sdk           # QXDim SDK 基本功能 (6 项)
npm run test:integration:session       # Session 缓存复用 (5 项)
npm run test:integration:reconnect     # 断线重连 (4 项)
npm run test:integration:auto-relogin # 自动重登 (3 项)
```

集成测试覆盖:
- **01-sdk-login**: login/sendText/onMessage/pullMessages/disconnect/onStatusChange
- **02-session-cache**: saveSession/loadSession/clearSession/listSessions/normalizeMobile/缓存复用
- **03-reconnect**: 自动重连/保留 lastMsgHead/重连后收消息/主动 disconnect 不重连
- **05-auto-relogin**: 自动重登/token 失效后恢复/重登次数限制

### 4. 端到端测试（需要凭据）

★ 推荐方式（企业 ID 模式，完整还原浏览器抓包流程）:
```bash
node tools/save-session.js \
  --company-code your_company_code \
  --mobile "+86 13800000000" \
  --password your_password

# 之后 examples/* 自动复用缓存，无需再传凭据
node examples/e2e-test.js
node examples/send-message.js
```

兼容方式（直接传 appServer，跳过企业 ID 解析）:
```bash
QXDIM_MOBILE="+86 13800000000" QXDIM_PASSWORD=your_password \
node examples/e2e-test.js
```

⚠️ **手机号格式必须是 `+86 <11位号码>`（带空格）**，裸 11 位号码会被服务器拒为"无效的电话号码"。

### 4. 双账号双向实时消息测试

```bash
QXDIM_COMPANY_CODE=your_company_code \
QXDIM_MOBILE_A="+86 13800000000" QXDIM_PASSWORD_A="your_password" \
QXDIM_MOBILE_B="+86 13900000001" QXDIM_PASSWORD_B="your_password" \
node examples/realtime-chat-2accounts.js
```

期望输出：
- A 端发送 2 条 → B 端 onMessage 实时触发 2 次
- B 端回复 1 条 → A 端 onMessage 实时触发 3 次（含自己 2 条 echo + B 回复 1 条）
- 时延 < 1 秒

## 7 个 MQTT 补丁

`scripts/patch-mqtt.js` 需手动执行（`npm run patch`），修补 3 个文件：

| # | 文件 | 作用 |
|---|---|---|
| 1 | `mqtt-packet/parser.js` | `_parseConfirmation` 提取 PUBACK 后续字节为 `packet.payload`，设 `reasonCode=10` |
| 2 | `mqtt-packet/parser.js` | `_parseConnack` 提取 CONNACK 后续字节为 `packet.payload` (ConnectAckPayload) |
| 3a | `mqtt/build/lib/handlers/ack.js` | puback `reasonCode=10` 不当错误 |
| 3b | `mqtt/build/lib/handlers/ack.js` | pubrec `reasonCode=10` 不当错误 |
| 4 | `mqtt/build/lib/handlers/ack.js` | puback 成功分支传 PUBACK packet 给 cb（而非 outgoingStore 的 PUBLISH）|
| 5 | `mqtt-packet/constants.js` | 删除 `requiredHeaderFlags[9]=0`，旁路 SUBACK flag bits 检查 |
| 6 | `mqtt/build/lib/client.js` | SUBACK granted 越界保护（WildFireChat SUBACK granted 可能比订阅数多）|

幂等：重复运行不会重复打补丁。手动重打：`npm run patch`。

## 主要 API

### TypeScript 类型支持

完整类型定义见 `types/index.d.ts`，外部使用方有完整类型提示：

```typescript
// TypeScript 项目
import { QXDim, ConnectionStatus, type ReceivedMessage } from 'qxdim';

const qxd = new QXDim();
qxd.onMessage((msg: ReceivedMessage) => {
  console.log(msg.text);           // string
  console.log(msg.fromUserId);     // string
  console.log(msg.conversation.target);  // string
});

const user = await qxd.login('your_company_code', '+86 13800000000', 'your_password');
//    ^? { userId: string; userName: string; companyName: string }
```

```javascript
// JavaScript 项目（VSCode 自动识别 types 字段，提供智能提示）
import { QXDim } from 'qxdim';
const qxd = new QXDim();
// 鼠标悬停 qxd.login 即可看到参数和返回值类型
```

类型检查命令：
```bash
npm run typecheck    # tsc --noEmit
```

### ★ 推荐用法：QXDim 高级 SDK

```javascript
import { QXDim } from './src/index.js';

const qxd = new QXDim();

// 注册回调（在 login 前注册）
qxd.onMessage((msg) => {
  console.log('收到:', msg.text, '来自:', msg.fromUserId);
});
qxd.onStatusChange((s) => console.log('状态:', s));
qxd.onReconnect((n) => console.log('重连第', n, '次'));
qxd.onKickedOff((reason) => console.log('被踢:', reason));

// 一行登录（自动跑完整 6 步流程 + MQTT 连接 + 订阅）
const user = await qxd.login('your_company_code', '+86 13800000000', 'your_password');
console.log(user);
// { userId: 'your_user_id', userName: '4ATM92', companyName: '湖北省泰渝星科技有限公司' }

// 一行发消息
const r = await qxd.sendText('88dv45ixr', 'Hello!');
console.log(r);
// { messageUid: 559742044791111809n, timestamp: 1781641639888n, timestampDate: Date }

// 主动拉取历史消息
await qxd.pullMessages(0, 0);

// 断开
await qxd.disconnect();
```

### 底层 API（高级用户）

```javascript
import {
  autoLogin,           // 手机号+密码 → 完整 6 步流程 → 连接参数
  QXDimClient,         // MQTT WSS 客户端（手动管理连接生命周期）
  ConnectionStatus,
  parseMessageContent,
  formatMessageContent,
  ContentType,
  loadSession, saveSession, clearSession, listSessions,
  // 完整登录流程各阶段（可单独调用）
  resolveCompanyAppServers,  // DNS TXT 解析
  queryCompanyServer,        // /query_company_server
  getPcSession,              // /pc_session
  sessionLogin,              // /session_login/<token>
  loginWithPassword,         // /login_pwd
  requestRoute,              // /route
} from './src/index.js';

// 手动控制每一步
const candidates = await resolveCompanyAppServers('your_company_code');
const info = await queryCompanyServer('your_company_code', candidates);
const ps = await getPcSession({ appServerHost: info.appServerHost, clientId });
await sessionLogin({ appServerHost: info.appServerHost, pcSessionToken: ps.token, cookie: ps.cookie });
// ...
```

## Session 持久化

每次 `autoLogin` 默认会把 token + clientId + 连接参数保存到 `config/sessions/<mobile>.json`。下次启动时自动复用，跳过 `/login_pwd`，避免：
- 旧 token 失效（每次登录会让之前的 token 失效）
- 多端互踢（同 clientId 反复登录会被服务器踢）
- 浪费请求（/login_pwd + /route 完整流程）

### CLI 工具

```bash
# ★ 企业 ID 模式（推荐，完整还原浏览器抓包流程）
node tools/save-session.js \
  --company-code your_company_code \
  --mobile "+86 13800000000" \
  --password your_password

# 兼容旧模式（直接传 appServer，跳过企业 ID 解析）
node tools/save-session.js \
  --app-server "https://120.24.20.128:10443" \
  --mobile "+86 13800000000" \
  --password your_password

# 列出所有已保存的 session
node tools/save-session.js --list

# 清除指定手机号的 session
node tools/save-session.js --clear "+86 13800000000"

# 强制重新登录（忽略缓存）
node tools/save-session.js --company-code your_company_code --mobile "+86 xxx" --password xxx --relogin

# 跳过 /pc_session 步骤（兼容测试用）
node tools/save-session.js --company-code your_company_code --mobile "+86 xxx" --password xxx --no-pc-session
```

### session 文件结构

```json
{
  "mobile": "+86 13800000000",
  "userId": "your_user_id",
  "userName": "4ATM92",
  "clientId": "web_xxx",
  "encryptedToken": "...",
  "tokenPart1": "...",
  "tokenKey": "uuid1",
  "privateSecret": "uuid2",
  "host": "120.24.20.128",
  "port": 18083,
  "appServer": "https://120.24.20.128:10443",
  "proxyServer": "https://120.24.20.128:10443",
  "serviceHost": "qim1.qixunda.tech",
  "companyCode": "your_company_code",
  "companyInfo": {
    "companyCode": "your_company_code",
    "companyName": "湖北省泰渝星科技有限公司",
    "appServerHost": "https://120.24.20.128:10443",
    "imServerHost": "https://qim1.qixunda.tech",
    "proxyServerHost": "120.24.20.228:30019",
    "pcProxyHost": "120.24.20.128:18433",
    "unifiedSocialCreditCode": "91420115MAG0TCH13L",
    ...
  },
  "loginAt": 1781642290000,
  "lastUsedAt": 1781642290000
}
```

⚠️ session 文件含敏感信息，已在 `config/sessions/.gitignore` 中排除，不会提交到 git。

### 失效策略

当前不强制过期（信任缓存直到失败）。当 `/route` 或 MQTT 连接失败时，上层应主动 `clearSession(mobile)` 后重试，会自动重新走完整流程（DNS → query_company_server → pc_session → login_pwd → route）。

## 已知陷阱

| 陷阱 | 解决方案 |
|---|---|
| 手机号格式错（裸 11 位） | 用 `+86 13800138000`（带空格） |
| `qim1.qixunda.tech` DNS 不可达 | 该域名解析到私网 IP，公网入口是 `120.24.20.128:10443` |
| 服务器返回的 token 已加密（不是明文 cred\|UUID） | `autoLogin()` 已自动判断，根据是否含 `\|` 切换路径 |
| 业务消息加密用 privateSecret 导致 status=2 | 业务消息必须用 `tokenKey` (UUID1)，privateSecret 只用于解密 push |
| `PullMessageResult` 字段编号 | message=1, current=2, head=3（不是 current=1, head=2, message=3） |
| 标准 mqtt.js 不支持 WildFireChat 协议 | 7 个补丁自动应用，见上文 |

## 凭据说明

本项目开发使用的测试账号：

- 企讯达 ID: `your_company_code`
- 手机号: `13800000000`
- 密码: `your_company_code`
- userId: `your_user_id`

仅用于协议逆向验证，请勿用于生产。

## npm 发布

包名 `qxdim`，已配置为可发布到 npm。

```bash
# 1. 预览包内容（不实际打包）
npm pack --dry-run

# 2. 发布前自动跑 typecheck + 单测
npm run prepublishOnly

# 3. 登录 npm（首次需要）
npm login

# 4. 发布
npm publish
# 或发布 pre-release
npm publish --tag next
```

发布包含的文件（25 个，~55KB）:
- `src/` - 核心库
- `proto/qxdim.proto` - 协议定义
- `types/index.d.ts` - TypeScript 类型
- `scripts/patch-mqtt.js` - 7 个补丁脚本（需手动 `npm run patch` 执行）
- `README.md` / `LICENSE` / `CHANGELOG.md`

**不包含**: `tests/` / `tools/` / `examples/` / `config/sessions/`（通过 `files` 白名单控制）

外部使用方安装后：
```bash
npm install qxdim
npm run patch   # 必须手动执行，应用 WildFireChat 协议补丁
```

```javascript
import { QXDim } from 'qxdim';
const qxd = new QXDim();
await qxd.login('your_company_code', '+86 13800000000', 'your_password');
```

⚠️ `npm run patch` 会 patch `node_modules/mqtt-packet` 和 `node_modules/mqtt`，应用 WildFireChat 协议补丁。这是必须的，否则无法解析 PUBACK/SUBACK。

## License

MIT
