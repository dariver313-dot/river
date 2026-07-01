/**
 * 轻量 .env 文件加载器（不依赖 dotenv，纯 Node.js 内置 fs）
 *
 * 自动从项目根目录（或调用方目录）查找 .env 文件并加载到 process.env
 * 已存在的环境变量优先（不覆盖）
 *
 * 用法:
 *   import { loadEnv } from './src/env-loader.js';
 *   loadEnv();  // 自动加载 .env
 *
 *   // 或指定路径
 *   loadEnv('/path/to/.env');
 *
 *   // 或用 Node.js 内置方式（Node 20.6+）:
 *   node --env-file=.env your-script.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 加载 .env 文件到 process.env
 *
 * @param {string} [envPath] - .env 文件路径，不传则自动查找
 * @param {object} [options]
 * @param {boolean} [options.override=false] - 是否覆盖已存在的环境变量
 * @returns {{loaded: boolean, path: string|null, count: number}}
 */
export function loadEnv(envPath, options = {}) {
  const { override = false } = options;

  // 自动查找 .env 文件
  if (!envPath) {
    const candidates = [
      // 当前工作目录
      path.join(process.cwd(), '.env'),
      // SDK 包根目录（向上两级: src/ → qxdim/ → 项目根）
      path.join(__dirname, '..', '..', '.env'),
      path.join(__dirname, '..', '.env'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        envPath = p;
        break;
      }
    }
  }

  if (!envPath || !fs.existsSync(envPath)) {
    return { loaded: false, path: null, count: 0 };
  }

  // ★ try/catch 防护 existsSync→readFileSync 之间的 TOCTOU 竞态和权限错误
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (e) {
    // 文件在 existsSync 后被删除，或权限不足
    if (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'EPERM') {
      return { loaded: false, path: null, count: 0 };
    }
    throw e;
  }
  const lines = content.split('\n');
  let count = 0;

  for (let line of lines) {
    line = line.trim();

    // 跳过空行和注释
    if (!line || line.startsWith('#')) continue;

    // 解析 KEY=VALUE
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    // 去掉引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // 不覆盖已存在的环境变量（除非 override=true）
    if (!override && process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = value;
    count++;
  }

  return { loaded: true, path: envPath, count };
}

export default loadEnv;
