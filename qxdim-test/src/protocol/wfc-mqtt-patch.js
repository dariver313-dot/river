/**
 * WildFireChat MQTT 协议补丁 — 运行时辅助模块
 * 
 * 核心补丁已直接修改 node_modules/mqtt/dist/mqtt.esm.js:
 *   1. _parseConfirmation: 提取 PUBACK 剩余字节为 packet.payload, 设置 reasonCode=10
 *   2. _parseConnack: 提取 CONNACK 剩余字节为 packet.payload
 *   3. _handleAck: reasonCode=10 不再被当作错误
 * 
 * 本模块提供运行时的响应解密等辅助功能
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { aesDecrypt } from '../crypto/aes.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let _patchVerified = false;

/**
 * 确认补丁已应用 — 运行时真正验证补丁标记是否存在
 * 如果补丁未应用，打印醒目警告并抛出错误
 */
export function ensureMqttPatched() {
  if (_patchVerified) return; // 只检查一次

  const checks = [
    { file: 'mqtt-packet/constants.js', marker: 'removed by WFC-Patch', name: 'SUBACK header flag 旁路' },
    { file: 'mqtt-packet/parser.js', marker: 'WFC-Patch 1', name: 'PUBACK payload 提取' },
    { file: 'mqtt-packet/parser.js', marker: 'WFC-Patch 2', name: 'CONNACK payload 提取' },
    { file: 'mqtt/build/lib/handlers/ack.js', marker: 'WFC-Patch 3a', name: 'puback reasonCode=10 旁路' },
    { file: 'mqtt/build/lib/handlers/ack.js', marker: 'WFC-Patch 4', name: 'PUBACK packet 传递给 callback' },
  ];

  const missing = [];
  for (const { file, marker, name } of checks) {
    const filePath = resolveModuleFile(file);
    if (!filePath) {
      missing.push(`${name} (文件未找到: ${file})`);
      continue;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (!content.includes(marker)) {
        missing.push(`${name} (标记 "${marker}" 未找到)`);
      }
    } catch (e) {
      missing.push(`${name} (读取失败: ${e.message})`);
    }
  }

  if (missing.length > 0) {
    logger.error('');
    logger.error('╔══════════════════════════════════════════════════════════════╗');
    logger.error('║  ❌ WFC MQTT 补丁未生效！以下补丁缺失:                        ║');
    logger.error('╠══════════════════════════════════════════════════════════════╣');
    for (const m of missing) {
      logger.error(`║  • ${m.padEnd(56)}║`);
    }
    logger.error('╠══════════════════════════════════════════════════════════════╣');
    logger.error('║  请运行: node scripts/patch-mqtt.js                          ║');
    logger.error('║  或:    npx qxdim-patch                                      ║');
    logger.error('╚══════════════════════════════════════════════════════════════╝');
    logger.error('');
    throw new Error(`WFC MQTT 补丁未应用 (${missing.length} 个缺失)，请先运行 node scripts/patch-mqtt.js`);
  }

  _patchVerified = true;
  logger.debug('[WFC-Patch] ✅ 补丁验证通过 (5 个关键补丁已应用)');
}

/**
 * 解析模块文件路径（兼容 npm/pnpm/yarn）
 */
function resolveModuleFile(relativePath) {
  // 兼容 Windows (\) 和 Unix (/) 路径分隔符
  const parts = relativePath.split(/[\\/]/);
  const pkgName = parts[0];
  const subPath = parts.slice(1).join('/');

  // 1. require.resolve 找包根目录
  try {
    const resolved = require.resolve(pkgName);
    let dir = path.dirname(resolved);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
          if (pkg.name === pkgName) {
            const p = path.join(dir, subPath);
            if (fs.existsSync(p)) return p;
          }
        } catch (e) { /* ignore */ }
      }
      dir = path.dirname(dir);
    }
  } catch (e) { /* ignore */ }

  // 2. pnpm .pnpm 目录扫描
  const pnpmDir = path.join(__dirname, '..', '..', 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    try {
      for (const d of fs.readdirSync(pnpmDir)) {
        if (d.startsWith(pkgName + '@')) {
          const p = path.join(pnpmDir, d, 'node_modules', pkgName, subPath);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 3. 顶层 node_modules
  const candidates = [
    path.join(__dirname, '..', '..', 'node_modules', relativePath),
    path.join(process.cwd(), 'node_modules', relativePath),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 解密 WildFireChat MQTT 响应 payload
 * 
 * 格式: [status_byte][AES加密的protobuf数据]
 * - status_byte: 0=成功, 5=成功(特殊), 255=成功+zlib压缩, 其他=错误码
 * - 加密数据: AES-128-CBC(privateSecret), 解密后去掉4字节时间戳前缀
 * 
 * @param {Buffer} payload - PUBACK 中的 payload
 * @param {string} privateSecret - 会话密钥
 * @returns {{status: number, data: Buffer|null, compressed: boolean}}
 */
export function decryptMqttResponse(payload, privateSecret) {
  if (!payload || payload.length < 1) {
    return { status: -1, data: null, compressed: false };
  }

  const statusByte = payload[0];
  
  const isSuccess = (statusByte === 0 || statusByte === 5 || statusByte === 255);
  const isCompressed = (statusByte === 255);

  if (!isSuccess) {
    logger.debug('[WFC-Response] 服务器返回错误码:', statusByte);
    return { status: statusByte, data: null, compressed: false };
  }

  if (payload.length < 2) {
    return { status: statusByte, data: null, compressed: isCompressed };
  }

  // 解密: 跳过第一个字节(status)，AES 解密剩余数据
  const encryptedBase64 = payload.slice(1).toString('base64');
  const decrypted = aesDecrypt(encryptedBase64, privateSecret, true);
  
  if (!decrypted) {
    logger.warn('[WFC-Response] AES 解密失败');
    return { status: statusByte, data: null, compressed: isCompressed };
  }

  return { status: statusByte, data: decrypted, compressed: isCompressed };
}

export default { ensureMqttPatched, decryptMqttResponse };
