/**
 * 集成测试共享工具
 *
 * - 测试断言
 * - 环境变量读取
 * - 日志格式化
 * - sleep / 等待条件
 */

// ★ 使用 dynamic import 避免静态 import 在 ts-node ESM 下的 ERR_REQUIRE_CYCLE_MODULE 问题
const sdk = await import('../../src/index.js');
const { QXDim, ConnectionStatus } = sdk;

// ==================== 配置 ====================

export const TEST_CONFIG = {
  companyCode: process.env.QXDIM_COMPANY_CODE || '',
  mobileA: process.env.QXDIM_MOBILE_A || process.env.QXDIM_MOBILE || '',
  passwordA: process.env.QXDIM_PASSWORD_A || process.env.QXDIM_PASSWORD || '',
  mobileB: process.env.QXDIM_MOBILE_B || '',
  passwordB: process.env.QXDIM_PASSWORD_B || '',
};

export function ts(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

// ==================== 简易断言 ====================

export class AssertionError extends Error {
  constructor(message: string, public expected?: unknown, public actual?: unknown) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AssertionError(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new AssertionError(message, expected, actual);
  }
}

export function assertNotEmpty<T>(value: T | null | undefined, message: string): asserts value is T {
  if (value === null || value === undefined || value === '') {
    throw new AssertionError(message);
  }
}

// ==================== 测试运行器 ====================

export type TestResult = {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
};

export async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  console.log(`\n[${ts()}] ━━━ 测试: ${name} ━━━`);
  try {
    await fn();
    const duration = Date.now() - start;
    console.log(`[${ts()}] ✅ PASS (${duration}ms)`);
    return { name, passed: true, duration };
  } catch (e: any) {
    const duration = Date.now() - start;
    const error = e?.message || String(e);
    console.error(`[${ts()}] ❌ FAIL (${duration}ms): ${error}`);
    if (e?.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    return { name, passed: false, duration, error };
  }
}

export function printSummary(results: TestResult[]): void {
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  const total = results.length;
  const totalMs = results.reduce((s, r) => s + r.duration, 0);

  console.log('\n' + '═'.repeat(60));
  console.log(`测试结果: ${passed}/${total} 通过, ${failed} 失败 (总计 ${totalMs}ms)`);
  console.log('═'.repeat(60));
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`  ${icon} ${r.name} (${r.duration}ms)${r.error ? ' — ' + r.error : ''}`);
  }
  console.log('═'.repeat(60));

  if (failed > 0) process.exit(1);
}

// ==================== 辅助 ====================

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 等待条件成立，超时抛异常 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number = 15000,
  intervalMs: number = 100,
  label: string = '条件'
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`等待${label}超时 (${timeoutMs}ms)`);
}

/** 创建 QXDim 实例并完成登录 */
export async function createAndLogin(
  mobile: string,
  password: string,
  companyCode: string = TEST_CONFIG.companyCode,
  options: { relogin?: boolean } = {}
): Promise<{ qxd: QXDim; userId: string; userName: string }> {
  const qxd = new QXDim();
  const user = await qxd.login(companyCode, mobile, password, {
    useCache: true,
    relogin: options.relogin ?? false,
    autoReconnect: true,
    reconnectPeriod: 5000,
  });
  return { qxd, userId: user.userId, userName: user.userName };
}

/** 等到 QXDim 状态变为 CONNECTED */
export async function waitForConnected(qxd: QXDim, timeoutMs: number = 15000): Promise<void> {
  await waitFor(
    () => qxd.getStatus() === ConnectionStatus.CONNECTED,
    timeoutMs,
    100,
    'MQTT 连接'
  );
}
