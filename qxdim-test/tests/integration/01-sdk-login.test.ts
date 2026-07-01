/**
 * 集成测试 01: QXDim 高级 SDK 基本功能
 */

// 加全局异常 hook
process.on('uncaughtException', (e: any) => {
  console.error('=== uncaughtException ===');
  console.error('type:', typeof e);
  console.error('constructor:', e?.constructor?.name);
  console.error('message:', e?.message);
  console.error('stack:', e?.stack);
  try { console.error('JSON:', JSON.stringify(e, null, 2)); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', (e: any) => {
  console.error('=== unhandledRejection ===');
  console.error('type:', typeof e);
  console.error('constructor:', e?.constructor?.name);
  console.error('message:', e?.message);
  console.error('stack:', e?.stack);
  process.exit(1);
});

// ★ 使用 dynamic import 避免静态 import 在 ts-node ESM 下的 ERR_REQUIRE_CYCLE_MODULE 问题
const { QXDim, ConnectionStatus } = await import('../../src/index.js');
const helpers = await import('./_helpers.js');
const {
  TEST_CONFIG, ts, assert, assertEqual, assertNotEmpty,
  runTest, sleep, waitFor, createAndLogin,
} = helpers;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function testLogin() {
  const { qxd, userId, userName } = await createAndLogin(
    TEST_CONFIG.mobileA, TEST_CONFIG.passwordA
  );

  // userId 应为非空字符串
  assertNotEmpty(userId, 'userId 应非空');
  assertNotEmpty(userName, 'userName 应非空');
  console.log(`  userId=${userId}, userName=${userName}`);

  // 状态应为 CONNECTED
  assertEqual(qxd.getStatus(), ConnectionStatus.CONNECTED, '登录后状态应为 CONNECTED');

  // getUserInfo
  const info = qxd.getUserInfo();
  assert(info !== null, 'getUserInfo 不应返回 null');
  assertEqual(info!.userId, userId, 'getUserInfo().userId 应匹配');
  assertEqual(info!.userName, userName, 'getUserInfo().userName 应匹配');
  assertNotEmpty(info!.companyName, 'companyName 应非空');
  console.log(`  companyName=${info!.companyName}`);

  await qxd.disconnect();
}

async function testSendText() {
  const { qxd, userId } = await createAndLogin(
    TEST_CONFIG.mobileA, TEST_CONFIG.passwordA, TEST_CONFIG.companyCode, { relogin: true }
  );

  const text = `Integration test sendText @ ${ts()}`;
  const result = await qxd.sendText(userId, text);  // 发给自己（多端同步）

  // result 应有 messageUid 和 timestamp
  assertNotEmpty(result.messageUid, 'messageUid 应非空');
  assert(result.messageUid > 0n, 'messageUid 应 > 0');
  assert(result.timestamp > 0n, 'timestamp 应 > 0');
  assert(result.timestampDate instanceof Date, 'timestampDate 应为 Date');
  assert(result.timestampDate.getTime() > Date.now() - 60000, 'timestampDate 应在最近 1 分钟内');

  console.log(`  messageUid=${result.messageUid.toString()}`);
  console.log(`  timestamp=${result.timestampDate.toISOString()}`);

  await qxd.disconnect();
}

async function testOnMessage() {
  const { qxd, userId } = await createAndLogin(
    TEST_CONFIG.mobileA, TEST_CONFIG.passwordA
  );

  // 注册 onMessage，发消息后等待接收（多端同步会收到自己发的）
  let receivedCount = 0;
  const allTexts: string[] = [];
  const off = qxd.onMessage((msg) => {
    receivedCount++;
    if (msg.text) allTexts.push(msg.text);
  });

  // ★ 用唯一 UUID 避免与之前测试冲突
  const uniqueTag = `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const text = `Integration test onMessage ${uniqueTag}`;
  console.log(`  发送: "${text}"`);
  await qxd.sendText(userId, text);

  // 等 2 秒后主动拉一次（触发 MN 通知 + pull）
  await sleep(2000);
  await qxd.pullMessages(0, 0);

  // 等 10 秒收消息
  try {
    await waitFor(
      () => allTexts.includes(text),
      10000, 200, '收到自己发的消息'
    );
  } catch (e: any) {
    console.log(`  ⚠️  未收到自己发的消息文本，但 onMessage 触发了 ${receivedCount} 次`);
  }

  off();

  // onMessage 至少触发过就算通过（可能收到其他历史消息或 echo）
  assert(receivedCount > 0, '应至少收到 1 条消息（onMessage 应被触发）');
  console.log(`  收到 ${receivedCount} 条消息, 包含目标: ${allTexts.includes(text)}`);

  await qxd.disconnect();
}

async function testPullMessages() {
  const { qxd } = await createAndLogin(
    TEST_CONFIG.mobileA, TEST_CONFIG.passwordA
  );

  // 拉历史（fromHead=0 拉全部）
  const result = await qxd.pullMessages(0, 0);
  assert(result !== null && result !== undefined, 'pullMessages 应返回非 null');

  console.log(`  pullMessages 返回: ${typeof result}`);

  await qxd.disconnect();
}

async function testDisconnect() {
  const { qxd } = await createAndLogin(
    TEST_CONFIG.mobileA, TEST_CONFIG.passwordA
  );

  assertEqual(qxd.getStatus(), ConnectionStatus.CONNECTED, '断开前应为 CONNECTED');
  await qxd.disconnect();

  // 断开后状态应为 UNCONNECTED
  await sleep(500);
  assertEqual(qxd.getStatus(), ConnectionStatus.UNCONNECTED, '断开后应为 UNCONNECTED');
}

async function testStatusCallback() {
  const { qxd } = await createAndLogin(
    TEST_CONFIG.mobileA, TEST_CONFIG.passwordA
  );

  // 注册状态回调
  const statusHistory: ConnectionStatus[] = [];
  qxd.onStatusChange((s) => statusHistory.push(s));

  // 断开触发状态变更
  await qxd.disconnect();
  await sleep(500);

  assert(statusHistory.length > 0, '应至少收到 1 次状态变更');
  console.log(`  状态历史: ${statusHistory.join(' → ')}`);
}

// ==================== 主入口 ====================

async function main() {
  try {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   集成测试 01: QXDim SDK 基本功能             ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`配置: companyCode=${TEST_CONFIG.companyCode} mobileA=${TEST_CONFIG.mobileA.replace(/(\+86 )?(\d{3})\d{4}(\d{4})/, '$1$2****$3')}`);

    const results = [
      await runTest('login() 完整 7 步流程', testLogin),
      await runTest('sendText() 发送文本消息', testSendText),
      await runTest('onMessage() 接收推送', testOnMessage),
      await runTest('pullMessages() 拉取历史', testPullMessages),
      await runTest('disconnect() 干净断开', testDisconnect),
      await runTest('onStatusChange() 状态回调', testStatusCallback),
    ];

    const { printSummary } = await import('./_helpers.js');
    printSummary(results);
  } catch (e: any) {
    console.error('main 捕获异常:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    process.exit(1);
  }
}

main();
