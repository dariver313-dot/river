/**
 * 集成测试 02: Session 缓存复用
 *
 * 覆盖:
 *   - 首次登录后 saveSession 自动写文件
 *   - loadSession 读取缓存
 *   - 第二次 autoLogin 命中缓存（跳过 /pc_session + /login_pwd）
 *   - clearSession 后缓存失效
 *   - listSessions 列出所有 session
 *   - 缓存的 token 与新登录的 token 不同（不同会话），但 userId 相同
 */

// ★ dynamic import 避免静态 import 在 ts-node ESM 下的循环依赖问题
const sdk = await import('../../src/index.js');
const {
  autoLogin, loadSession, saveSession, clearSession, listSessions, isSessionValid,
  normalizeMobile,
} = sdk;
const { initProto } = await import('../../src/proto/index.js');
const helpers = await import('./_helpers.js');
const {
  TEST_CONFIG, ts, assert, assertEqual, assertNotEmpty,
  runTest, sleep,
} = helpers;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function testSaveAndLoad() {
  await initProto();

  // 强制重登，确保 session 被写入
  const params = await autoLogin({
    companyCode: TEST_CONFIG.companyCode,
    mobile: TEST_CONFIG.mobileA,
    password: TEST_CONFIG.passwordA,
    useCache: false,
    relogin: true,
    saveCache: true,
  });

  assertNotEmpty(params.userId, '登录后 userId 应非空');
  assertNotEmpty(params.encryptedToken, 'encryptedToken 应非空');
  assertNotEmpty(params.tokenKey, 'tokenKey 应非空');

  // 读取刚保存的 session
  const session = await loadSession(TEST_CONFIG.mobileA);
  assert(session !== null, 'loadSession 应返回非 null');
  assertEqual(session!.userId, params.userId, 'session.userId 应匹配');
  assertEqual(session!.mobile, TEST_CONFIG.mobileA, 'session.mobile 应匹配');
  assertNotEmpty(session!.companyCode || '', 'session.companyCode 应非空');
  assertNotEmpty(session!.appServer || '', 'session.appServer 应非空');
  assert(isSessionValid(session), 'isSessionValid 应返回 true');

  console.log(`  缓存命中: userId=${session!.userId}, companyCode=${session!.companyCode}, appServer=${session!.appServer}`);
}

async function testCacheReuse() {
  await initProto();

  // 第一次登录（强制重登，写缓存）
  const params1 = await autoLogin({
    companyCode: TEST_CONFIG.companyCode,
    mobile: TEST_CONFIG.mobileA,
    password: TEST_CONFIG.passwordA,
    relogin: true,
  });
  console.log(`  第一次: clientId=${params1.clientId}`);

  // 第二次登录（应命中缓存，复用同一个 clientId）
  const params2 = await autoLogin({
    companyCode: TEST_CONFIG.companyCode,
    mobile: TEST_CONFIG.mobileA,
    password: TEST_CONFIG.passwordA,
    useCache: true,
  });
  console.log(`  第二次: clientId=${params2.clientId}`);

  assertEqual(params2.clientId, params1.clientId, '缓存命中时 clientId 应相同');
  assertEqual(params2.userId, params1.userId, 'userId 应相同');
  assertEqual(params2.encryptedToken, params1.encryptedToken, 'encryptedToken 应相同（同一个会话）');
}

async function testCacheInvalidation() {
  await initProto();

  // 确保有缓存
  await autoLogin({
    companyCode: TEST_CONFIG.companyCode,
    mobile: TEST_CONFIG.mobileA,
    password: TEST_CONFIG.passwordA,
    relogin: true,
  });

  // 验证缓存存在
  let session = await loadSession(TEST_CONFIG.mobileA);
  assert(session !== null, '清除前 session 应存在');

  // 清除
  const cleared = await clearSession(TEST_CONFIG.mobileA);
  assertEqual(cleared, true, 'clearSession 应返回 true');

  // 验证已清除
  session = await loadSession(TEST_CONFIG.mobileA);
  assertEqual(session, null, '清除后 loadSession 应返回 null');
}

async function testListSessions() {
  await initProto();

  // 重新保存 session
  await autoLogin({
    companyCode: TEST_CONFIG.companyCode,
    mobile: TEST_CONFIG.mobileA,
    password: TEST_CONFIG.passwordA,
    relogin: true,
  });

  const sessions = await listSessions();
  assert(sessions.length > 0, 'listSessions 应返回至少 1 个 session');

  const found = sessions.find(s => s.mobile === TEST_CONFIG.mobileA);
  assert(found !== undefined, `应找到 mobile=${TEST_CONFIG.mobileA} 的 session`);
  assertNotEmpty(found!.userId, 'session.userId 应非空');
  assertNotEmpty(found!.companyCode || '', 'session.companyCode 应非空');

  console.log(`  找到 ${sessions.length} 个 session`);
  for (const s of sessions) {
    console.log(`    - ${s.mobile} → ${s.userId} (${s.userName}, ${s.companyName})`);
  }
}

async function testNormalizeMobile() {
  const cases: Array<[string, string]> = [
    ['+86 13800000000', '8613800000000'],
    ['+8613800000000', '8613800000000'],
    ['13800000000', '13800000000'],
    ['+86 139-000-00001', '8613900000001'],
  ];

  for (const [input, expected] of cases) {
    const actual = normalizeMobile(input);
    assertEqual(actual, expected, `normalizeMobile("${input}") 应返回 "${expected}"`);
  }
  console.log(`  ${cases.length} 个用例全部通过`);
}

// ==================== 主入口 ====================

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   集成测试 02: Session 缓存复用               ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`配置: companyCode=${TEST_CONFIG.companyCode} mobileA=${TEST_CONFIG.mobileA.replace(/(\+86 )?(\d{3})\d{4}(\d{4})/, '$1$2****$3')}`);

  const results = [
    await runTest('saveSession + loadSession', testSaveAndLoad),
    await runTest('缓存命中时复用 clientId/token', testCacheReuse),
    await runTest('clearSession 后缓存失效', testCacheInvalidation),
    await runTest('listSessions 列出所有', testListSessions),
    await runTest('normalizeMobile 手机号规范化', testNormalizeMobile),
  ];

  const { printSummary } = await import('./_helpers.js');
  printSummary(results);
}

main().catch((e) => {
  console.error('致命错误:', e);
  process.exit(1);
});
