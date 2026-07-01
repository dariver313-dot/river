/**
 * TypeScript 使用示例（验证 .d.ts 类型推断）
 *
 * 用法:
 *   npx tsc --noEmit   # 检查类型
 *   npm run typecheck  # 同上
 *
 * 这个文件不会被实际执行，只用于类型检查。
 * 如果类型定义有错，tsc 会报错。
 */

import {
  QXDim,
  QXDimClient,
  ConnectionStatus,
  ConversationType,
  ContentType,
  PersistFlag,
  type ReceivedMessage,
  type SendTextResult,
  type QXDimLoginResult,
  type CompanyInfo,
  type SessionSummary,
  type AutoLoginOptions,
  type ConnectParams,
  type Conversation,
  type MessageContent,
  // 底层 API
  autoLogin,
  resolveCompanyAppServers,
  queryCompanyServer,
  getPcSession,
  sessionLogin,
  loginWithPassword,
  requestRoute,
  // session 持久化
  loadSession,
  saveSession,
  clearSession,
  listSessions,
} from '../src/index.js';

// ==================== 示例 1: QXDim 高级 SDK ====================

async function sdkExample() {
  const qxd: QXDim = new QXDim();

  // 注册回调（在 login 前）
  const offMessage = qxd.onMessage((msg: ReceivedMessage) => {
    console.log('收到:', msg.text);
    console.log('来自:', msg.fromUserId);
    console.log('消息ID:', msg.messageId);
    console.log('时间:', new Date(Number(msg.serverTimestamp)).toISOString());
    console.log('会话:', msg.conversation.type, msg.conversation.target);
    console.log('解析后:', msg.parsed?.typeName);
  });

  const offStatus = qxd.onStatusChange((s: ConnectionStatus) => {
    console.log('状态:', s);
    if (s === ConnectionStatus.KICKED_OFF) {
      console.log('被踢下线');
    }
  });

  const offReconnect = qxd.onReconnect((attempt: number) => {
    console.log(`第 ${attempt} 次重连`);
  });

  const offKicked = qxd.onKickedOff((reason: string, info: unknown) => {
    console.log('被踢:', reason, info);
  });

  // 登录
  const user: QXDimLoginResult = await qxd.login(
    'your_company_code',
    '+86 13800000000',
    'your_password',
    {
      useCache: true,
      relogin: false,
      autoReconnect: true,
      reconnectPeriod: 5000,
    }
  );
  console.log(`登录: userId=${user.userId}, userName=${user.userName}, company=${user.companyName}`);

  // 发送文本
  const result: SendTextResult = await qxd.sendText(
    '88dv45ixr',
    'Hello from TypeScript!',
    {
      conversationType: ConversationType.Single,
      line: 0,
    }
  );
  console.log(`发送: messageUid=${result.messageUid.toString()}`);
  console.log(`  timestamp=${result.timestampDate.toISOString()}`);

  // 拉历史
  await qxd.pullMessages(0, 0);

  // 查询状态
  const status: ConnectionStatus = qxd.getStatus();
  console.log('当前状态:', status);

  // 查询用户信息
  const info = qxd.getUserInfo();
  if (info) {
    console.log(`当前用户: ${info.userName} (${info.userId}), company: ${info.companyName}`);
  }

  // 注销回调
  offMessage();
  offStatus();
  offReconnect();
  offKicked();

  // 断开
  await qxd.disconnect();
}

// ==================== 示例 2: 底层 API ====================

async function lowLevelExample() {
  const opts: AutoLoginOptions = {
    companyCode: 'your_company_code',
    mobile: '+86 13800000000',
    password: 'your_password',
    useCache: true,
  };
  const params: ConnectParams = await autoLogin(opts);

  console.log('userId:', params.userId);
  console.log('MQTT:', `wss://${params.host}:${params.port}`);
  console.log('companyName:', params.companyInfo?.companyName);

  // 直接用 QXDimClient
  const client: QXDimClient = new QXDimClient();
  client.onMessage((msg) => {
    console.log('message:', msg.fromUser, msg.content?.type);
  });
  client.onStatusChange((s) => console.log('status:', s));

  client.connect({
    host: params.host,
    port: params.port,
    userId: params.userId,
    clientId: params.clientId,
    password: params.password,
    node: params.node,
    serviceHost: params.serviceHost,
    tokenKey: params.tokenKey,
    privateSecret: params.privateSecret,
    useWSS: true,
    autoReconnect: true,
    reconnectPeriod: 5000,
  });

  // 发消息（底层）
  const conversation: Conversation = {
    type: ConversationType.Single,
    target: '88dv45ixr',
    line: 0,
  };
  const content: MessageContent = {
    type: ContentType.Text,
    searchableContent: 'Hello',
    persistFlag: PersistFlag.Persist_And_Count,
  };
  const r = await client.sendMessage(conversation, content);
  if (r) {
    console.log('messageUid:', r.messageUidLong.toString());
  }

  client.disconnect();
}

// ==================== 示例 3: 完整登录流程手动调用 ====================

async function manualFlowExample() {
  // 1. DNS TXT 解析
  const candidates: string[] = await resolveCompanyAppServers('your_company_code');

  // 2. query_company_server
  const info: CompanyInfo = await queryCompanyServer('your_company_code', candidates);
  console.log('appServerHost:', info.appServerHost);

  // 3. /pc_session
  const ps = await getPcSession({
    appServerHost: info.appServerHost,
    clientId: 'my-client-id',
  });
  console.log('pc_session token:', ps.token, 'cookie:', ps.cookie);

  // 4. /session_login
  await sessionLogin({
    appServerHost: info.appServerHost,
    pcSessionToken: ps.token,
    cookie: ps.cookie,
  });

  // 5. /login_pwd
  const login = await loginWithPassword({
    mobile: '+86 13800000000',
    password: 'your_password',
    appServer: info.appServerHost,
    clientId: 'my-client-id',
    pcSessionToken: ps.token,
  });

  // 6. /route
  const route = await requestRoute({
    userId: login.userId,
    token: login.token,
    clientId: 'my-client-id',
    proxyServer: info.appServerHost,
    serviceHost: 'qim1.qixunda.tech',
  });
  console.log('MQTT:', route.host, route.wssPort, 'node:', route.node);
}

// ==================== 示例 4: Session 持久化 ====================

async function sessionExample() {
  // 列出
  const sessions: SessionSummary[] = await listSessions();
  for (const s of sessions) {
    console.log(`${s.mobile} → ${s.userId} (${s.userName}, ${s.companyName})`);
  }

  // 加载
  const sess = await loadSession('+86 13800000000');
  if (sess) {
    console.log('userId:', sess.userId, 'appServer:', sess.appServer);
  }

  // 清除
  await clearSession('+86 13800000000');

  // 保存（一般通过 autoLogin 自动调）
  if (sess) {
    await saveSession('+86 13800000000', sess);
  }
}

// 防止未使用警告
void sdkExample;
void lowLevelExample;
void manualFlowExample;
void sessionExample;
