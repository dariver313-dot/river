/**
 * 综合测试脚本
 * 运行所有测试: 加密 → Protobuf → 路由请求
 *
 * 运行: node tests/all.test.js
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('╔══════════════════════════════════════════════╗');
console.log('║   企讯达协议测试工具 - 综合测试                ║');
console.log('╚══════════════════════════════════════════════╝\n');

const tests = [
  { name: '加密模块测试', file: 'crypto.test.js' },
  { name: 'Protobuf 编解码测试', file: 'proto.test.js' },
];

let allPassed = true;

for (const test of tests) {
  console.log(`\n━━━ ${test.name} ━━━\n`);
  try {
    execSync(`node ${path.join(__dirname, test.file)}`, {
      stdio: 'inherit',
      timeout: 30000,
    });
    console.log(`\n✅ ${test.name} 通过`);
  } catch (e) {
    console.log(`\n❌ ${test.name} 失败`);
    allPassed = false;
  }
}

console.log('\n━━━ 路由请求测试 ━━━');
console.log('(需要有效账号，请手动运行: node tests/route.test.js)');

console.log('\n════════════════════════════════════════');
if (allPassed) {
  console.log('🎉 所有自动测试通过!');
  console.log('');
  console.log('下一步:');
  console.log('  1. 复制 config/example.js 为 config.js');
  console.log('  2. 填入你的 userId 和 token');
  console.log('  3. 运行: node examples/login-and-listen.js');
} else {
  console.log('⚠️  部分测试失败，请检查错误信息。');
}
console.log('════════════════════════════════════════');
