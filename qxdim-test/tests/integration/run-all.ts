/**
 * 集成测试总入口: 跑全部 4 个测试套件
 *
 * 用法:
 *   npm run test:integration
 *   node --loader ts-node/esm tests/integration/run-all.ts
 */

import { ts } from './_helpers.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function runAll() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   QXDim 集成测试 - 全部套件                   ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`[${ts()}] 开始时间: ${new Date().toISOString()}\n`);

  const suites = [
    { name: '01-sdk-login', file: './01-sdk-login.test.ts' },
    { name: '02-session-cache', file: './02-session-cache.test.ts' },
    { name: '03-reconnect', file: './03-reconnect.test.ts' },
    { name: '05-auto-relogin', file: './05-auto-relogin.test.ts' },
  ];

  const { execSync } = await import('child_process');
  const { default: path } = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  let passed = 0;
  let failed = 0;

  for (const suite of suites) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[${ts()}] >>> 跑套件: ${suite.name}`);
    console.log('═'.repeat(60));

    try {
      execSync(
        `node --loader ts-node/esm ${path.join(__dirname, suite.file)}`,
        { stdio: 'inherit', env: process.env }
      );
      passed++;
      console.log(`\n[${ts()}] ✅ 套件通过: ${suite.name}`);
    } catch (e: any) {
      failed++;
      console.error(`\n[${ts()}] ❌ 套件失败: ${suite.name}`);
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`[${ts()}] 总结果: ${passed}/${suites.length} 套件通过, ${failed} 失败`);
  console.log('═'.repeat(60));

  if (failed > 0) process.exit(1);
}

runAll().catch((e) => {
  console.error('致命错误:', e);
  process.exit(1);
});
