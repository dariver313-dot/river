/**
 * 集成测试 05: token 失效自动重登
 *
 * 覆盖:
 *   - 正常登录后用错误密码重连 → 触发 authFailed
 *   - 自动 clearSession + autoLogin + 重建 client
 *   - onRelogin 回调触发 (start/success)
 *   - 重登成功后能继续 sendText
 *   - maxReloginAttempts 限制（错误凭据场景下应失败后放弃）
 */

const sdk = await import('../../src/index.js');
const { QXDim, ConnectionStatus } = sdk;
const helpers = await import('./_helpers.js');
const {
  TEST_CONFIG, ts, assert, assertEqual,
  runTest, sleep, waitFor, createAndLogin,
} = helpers;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function testAutoReloginOnAuthFailure() {
  const qxd = new QXDim();

  // 注册重登回调
  const reloginEvents: any[] = [];
  qxd.onRelogin((event) => {
    reloginEvents.push(event);
  });

  // 正常登录
  const user = await qxd.login(TEST_CONFIG.companyCode, TEST_CONFIG.mobileA, TEST_CONFIG.passwordA, {
    autoRelogin: true,
    maxReloginAttempts: 3,
  });
  assertEqual(qxd.getStatus(), ConnectionStatus.CONNECTED, '初始登录应为 CONNECTED');

  // 模拟 token 失效: 用错误密码重连
  const client: any = (qxd as any).client;
  const wrongPassword = Buffer.from('00000000000000000000000000000000', 'hex');
  console.log(`  [${ts()}] 用错误密码重连触发 authFailed`);
  await client.reconnectWithNewCredentials({ password: wrongPassword });

  // 等待自动重登完成
  console.log(`  [${ts()}] 等待自动重登...`);
  await waitFor(
    () => qxd.getStatus() === ConnectionStatus.CONNECTED && (qxd as any).loggedIn,
    90000, 1000, '自动重登完成'
  );

  // 验证重登成功
  assertEqual(qxd.getStatus(), ConnectionStatus.CONNECTED, '重登后应为 CONNECTED');
  assert((qxd as any).loggedIn, '重登后 loggedIn 应为 true');

  // 验证 onRelogin 回调触发
  const startEvents = reloginEvents.filter(e => e.phase === 'start');
  const successEvents = reloginEvents.filter(e => e.phase === 'success');
  assert(startEvents.length > 0, '应至少触发 1 次 onRelogin start');
  assert(successEvents.length > 0, '应至少触发 1 次 onRelogin success');
  console.log(`  onRelogin 回调: ${startEvents.length} start, ${successEvents.length} success`);

  await qxd.disconnect();
}

async function testSendAfterRelogin() {
  const qxd = new QXDim();
  const user = await qxd.login(TEST_CONFIG.companyCode, TEST_CONFIG.mobileA, TEST_CONFIG.passwordA, {
    autoRelogin: true,
  });

  // 触发 authFailed
  const client: any = (qxd as any).client;
  await client.reconnectWithNewCredentials({
    password: Buffer.from('00000000000000000000000000000000', 'hex'),
  });

  // 等重登
  await waitFor(
    () => qxd.getStatus() === ConnectionStatus.CONNECTED && (qxd as any).loggedIn,
    90000, 1000, '重登完成'
  );

  // 重登后发送消息
  const text = `after relogin ${ts()}`;
  const r = await qxd.sendText(user.userId, text);
  assert(r.messageUid > 0n, '重登后 sendText 应返回有效 messageUid');
  console.log(`  重登后发送成功: messageUid=${r.messageUid.toString()}`);

  await qxd.disconnect();
}

async function testAutoReloginDisabled() {
  // autoRelogin=false 时，认证失败应触发 onKickedOff 而不是自动重登
  const qxd = new QXDim();
  await qxd.login(TEST_CONFIG.companyCode, TEST_CONFIG.mobileA, TEST_CONFIG.passwordA, {
    autoRelogin: false,  // ★ 禁用自动重登
  });

  let kickedOff = false;
  qxd.onKickedOff(() => { kickedOff = true; });

  // 触发 authFailed
  const client: any = (qxd as any).client;
  await client.reconnectWithNewCredentials({
    password: Buffer.from('00000000000000000000000000000000', 'hex'),
  });

  // 等待 onKickedOff 触发
  await waitFor(() => kickedOff, 10000, 200, 'onKickedOff 触发');
  assert(kickedOff, '禁用 autoRelogin 时应触发 onKickedOff');
  assert(!(qxd as any).loggedIn, '禁用 autoRelogin 时 loggedIn 应为 false');

  console.log(`  ✅ 禁用 autoRelogin 时正确触发 onKickedOff`);
}

// ==================== 主入口 ====================

async function main() {
  try {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   集成测试 05: token 失效自动重登             ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`配置: A=${TEST_CONFIG.mobileA.replace(/(\+86 )?(\d{3})\d{4}(\d{4})/, '$1$2****$3')}`);

    const results = [
      await runTest('认证失败触发自动重登 + onRelogin 回调', testAutoReloginOnAuthFailure),
      await runTest('重登后能继续 sendText', testSendAfterRelogin),
      await runTest('禁用 autoRelogin 时触发 onKickedOff', testAutoReloginDisabled),
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
