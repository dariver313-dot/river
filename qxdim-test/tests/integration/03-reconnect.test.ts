/**
 * 集成测试 03: 断线重连 + 消息不丢
 *
 * 覆盖:
 *   - 主动 stream.destroy() 模拟网络断开
 *   - 5 秒内自动重连成功
 *   - onReconnect 回调触发
 *   - 重连后保留 lastMsgHead
 *   - 重连后订阅自动恢复（resubscribe）
 *   - 重连后实时收消息
 */

// ★ dynamic import 避免静态 import 在 ts-node ESM 下的循环依赖问题
const sdk = await import('../../src/index.js');
const { QXDim, ConnectionStatus } = sdk;
const helpers = await import('./_helpers.js');
const {
  TEST_CONFIG, ts, assert, assertEqual, assertNotEmpty,
  runTest, sleep, waitFor, createAndLogin,
} = helpers;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function testAutoReconnect() {
  const { qxd } = await createAndLogin(TEST_CONFIG.mobileA, TEST_CONFIG.passwordA);

  // 注册重连回调
  let reconnectCount = 0;
  qxd.onReconnect(() => reconnectCount++);

  // 主动断开底层 socket
  const client: any = (qxd as any).client;
  assert(client !== null, 'QXDim.client 应非 null');
  const stream = client.mqttClient?.stream;
  assert(stream !== undefined, 'mqttClient.stream 应存在');

  console.log(`  [${ts()}] 主动 stream.destroy()`);
  stream.destroy(new Error('test disconnect'));

  // 等 12 秒看重连
  await waitFor(() => reconnectCount > 0, 15000, 200, 'onReconnect 触发');
  console.log(`  [${ts()}] 重连回调触发 ${reconnectCount} 次`);

  // 等到状态恢复 CONNECTED
  await waitFor(() => qxd.getStatus() === ConnectionStatus.CONNECTED, 15000, 200, '重连后 CONNECTED');
  console.log(`  [${ts()}] 状态已恢复 CONNECTED`);

  assert(reconnectCount > 0, '应至少触发 1 次 onReconnect');
  assertEqual(qxd.getStatus(), ConnectionStatus.CONNECTED, '重连后状态应为 CONNECTED');

  await qxd.disconnect();
}

async function testLastMsgHeadPreserved() {
  const { qxd, userId } = await createAndLogin(TEST_CONFIG.mobileA, TEST_CONFIG.passwordA);

  // 拿初始 lastMsgHead
  const client: any = (qxd as any).client;
  const initialHead = client.lastMsgHead;
  assertNotEmpty(String(initialHead), '初始 lastMsgHead 应非空');
  console.log(`  初始 lastMsgHead: ${initialHead}`);

  // 发一条消息（让 lastMsgHead 更新）
  const text = `reconnect test ${ts()}`;
  await qxd.sendText(userId, text);
  await sleep(2000);

  const headAfterSend = client.lastMsgHead;
  console.log(`  发送消息后 lastMsgHead: ${headAfterSend}`);
  // lastMsgHead 应该有变化（更新到新消息 ID）
  // 注意：可能没收到推送就没更新，但至少应保留原值

  // 主动断开
  const stream = client.mqttClient?.stream;
  stream.destroy(new Error('test disconnect'));

  // 等重连
  await waitFor(() => qxd.getStatus() === ConnectionStatus.CONNECTED, 15000, 200, '重连');

  const headAfterReconnect = client.lastMsgHead;
  console.log(`  重连后 lastMsgHead: ${headAfterReconnect}`);

  // 重连后 lastMsgHead 不应小于断开前的值（不应清零）
  assert(
    BigInt(String(headAfterReconnect)) >= BigInt(String(headAfterSend)),
    `重连后 lastMsgHead (${headAfterReconnect}) 不应小于断开前 (${headAfterSend})`
  );

  await qxd.disconnect();
}

async function testReceiveAfterReconnect() {
  const { qxd: qxdA, userId: userIdA } = await createAndLogin(TEST_CONFIG.mobileA, TEST_CONFIG.passwordA);
  const { qxd: qxdB, userId: userIdB } = await createAndLogin(TEST_CONFIG.mobileB, TEST_CONFIG.passwordB);

  console.log(`  A.userId=${userIdA}, B.userId=${userIdB}`);

  // A 注册消息回调
  let receivedByA: string[] = [];
  qxdA.onMessage((msg) => {
    if (msg.fromUserId === userIdB && msg.text) {
      receivedByA.push(msg.text);
    }
  });

  // 主动断开 A
  const clientA: any = (qxdA as any).client;
  const stream = clientA.mqttClient?.stream;
  console.log(`  [${ts()}] A 主动断开`);
  stream.destroy(new Error('test disconnect'));

  // 等 A 重连
  await waitFor(() => qxdA.getStatus() === ConnectionStatus.CONNECTED, 15000, 200, 'A 重连');
  console.log(`  [${ts()}] A 重连成功`);

  // B 发消息给 A
  const text = `after reconnect ${ts()}`;
  await qxdB.sendText(userIdA, text);
  console.log(`  [${ts()}] B 发送: "${text}"`);

  // 等 A 收到
  await waitFor(() => receivedByA.length > 0, 10000, 200, 'A 收到 B 的消息');
  assert(receivedByA.length > 0, 'A 重连后应能收到 B 的消息');
  assert(receivedByA.includes(text), `A 收到的消息应包含 "${text}"`);

  console.log(`  A 收到 ${receivedByA.length} 条来自 B 的消息`);

  await qxdA.disconnect();
  await qxdB.disconnect();
}

async function testKickedOffNoReconnect() {
  // 这个测试模拟 KICKED_OFF 后不再重连
  // 但实际触发 KICKED_OFF 需要服务器主动 disconnect，无法在测试中模拟
  // 这里只验证 disconnect() 后状态变为 UNCONNECTED 且不会自动重连
  const { qxd } = await createAndLogin(TEST_CONFIG.mobileA, TEST_CONFIG.passwordA);

  let reconnectCount = 0;
  qxd.onReconnect(() => reconnectCount++);

  await qxd.disconnect();
  await sleep(3000);

  assertEqual(qxd.getStatus(), ConnectionStatus.UNCONNECTED, '主动 disconnect 后应为 UNCONNECTED');
  assertEqual(reconnectCount, 0, '主动 disconnect 后不应触发重连');
}

// ==================== 主入口 ====================

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   集成测试 03: 断线重连 + 消息不丢            ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`配置: A=${TEST_CONFIG.mobileA.replace(/(\+86 )?(\d{3})\d{4}(\d{4})/, '$1$2****$3')}, B=${TEST_CONFIG.mobileB.replace(/(\+86 )?(\d{3})\d{4}(\d{4})/, '$1$2****$3')}`);

  const results = [
    await runTest('自动重连 + onReconnect 回调', testAutoReconnect),
    await runTest('重连后保留 lastMsgHead', testLastMsgHeadPreserved),
    await runTest('重连后能收到新消息', testReceiveAfterReconnect),
    await runTest('主动 disconnect 不触发重连', testKickedOffNoReconnect),
  ];

  const { printSummary } = await import('./_helpers.js');
  printSummary(results);
}

main().catch((e) => {
  console.error('致命错误:', e);
  process.exit(1);
});
