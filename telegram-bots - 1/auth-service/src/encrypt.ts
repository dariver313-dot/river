/**
 * 加密命令行工具
 *
 * 用法：
 *   AUTH_SECRET_KEY=xxx npx ts-node src/encrypt.ts
 *
 * 交互式输入需要加密的值，输出加密后的密文
 */

import dotenv from 'dotenv';
dotenv.config();

import * as readline from 'readline';
import { encrypt, generateSecretKey } from './crypto-utils';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  console.log('=== Auth Service 加密工具 ===\n');

  // 检查 AUTH_SECRET_KEY
  if (!process.env.AUTH_SECRET_KEY) {
    const newKey = generateSecretKey();
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  ⚠️  未检测到 AUTH_SECRET_KEY，已为你生成一个：     ║');
    console.log('║                                                      ║');
    console.log(`║  AUTH_SECRET_KEY=${newKey}`);
    console.log('║                                                      ║');
    console.log('║  ⚠️  请立即保存此密钥！丢失后无法恢复！              ║');
    console.log('║  此密钥不会写入任何文件，请妥善保管在安全的地方       ║');
    console.log('║                                                      ║');
    console.log('║  启动 Auth Service 时需要设置：                      ║');
    console.log('║  $env:AUTH_SECRET_KEY="此密钥"; node dist/index.js    ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');
    // CLI 工具需要设置 process.env 以便后续 encrypt() 调用能读取密钥
    process.env.AUTH_SECRET_KEY = newKey;
  } else {
    console.log('已检测到 AUTH_SECRET_KEY\n');
  }

  // 交互式加密
  while (true) {
    const plaintext = await question('输入需要加密的值（留空退出）: ');
    if (!plaintext) break;

    try {
      const encrypted = encrypt(plaintext);
      console.log(`\n  加密结果: ${encrypted}\n`);
      console.log('  在 .env 中使用：');
      console.log(`  XXX_ENC=${encrypted}\n`);
    } catch (e: any) {
      console.error(`  加密失败: ${e.message}\n`);
    }
  }

  rl.close();
  console.log('\n再见！');
}

main().catch(console.error);
