#!/usr/bin/env node

/**
 * WildFireChat MQTT 协议补丁 — 自动应用到 node_modules
 *
 * ★★★ 重要: Node.js 加载链 ★★★
 *   import mqtt from 'mqtt'
 *     → mqtt/build/index.js (CommonJS 主入口)
 *     → mqtt/build/lib/client.js
 *     → mqtt-packet (parser + constants + generate)
 *
 *   dist/mqtt.esm.js 是浏览器/React Native 用的，Node.js 不加载它！
 *   早期版本的 patch-mqtt.js 错误地打在 dist/mqtt.esm.js 上，导致补丁不生效。
 *
 * 当前补丁目标:
 *   - mqtt-packet/constants.js: SUBACK header flag 旁路
 *   - mqtt-packet/parser.js: PUBACK/CONNACK payload 提取（后续）
 *   - mqtt/build/lib/client.js: reasonCode=10 旁路 + PUBACK packet callback（后续）
 *
 * 运行: node scripts/patch-mqtt.js
 * 或在 npm install 后自动运行 (postinstall)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ★ 查找目标文件：兼容 npm / pnpm / yarn 的 node_modules 结构
// pnpm 用 .pnpm 软链接结构: node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/
// npm/yarn 用平铺结构: node_modules/<pkg>/
function findTargetFile(relativePath) {
  // 兼容 Windows (\) 和 Unix (/) 路径分隔符
  const parts = relativePath.split(/[\\/]/);
  const pkgName = parts[0];           // e.g. 'mqtt-packet' 或 'mqtt'
  const subPath = parts.slice(1).join('/');  // e.g. 'constants.js'

  // 1. require.resolve (最可靠，自动处理所有包管理器的模块解析)
  const pkgRoot = findPackageRoot(pkgName);
  if (pkgRoot) {
    const p = path.join(pkgRoot, subPath);
    if (fs.existsSync(p)) return p;
  }

  // 2. pnpm .pnpm 目录扫描
  const pnpmDir = path.join(__dirname, '..', 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    try {
      for (const d of fs.readdirSync(pnpmDir)) {
        // 目录名形如 'mqtt-packet@9.0.2' 或 'mqtt@5.15.1'
        if (d.startsWith(pkgName + '@')) {
          const p = path.join(pnpmDir, d, 'node_modules', pkgName, subPath);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 3. 顶层 node_modules (npm/yarn 平铺，或 pnpm 的 junction)
  const candidates = [
    path.join(__dirname, '..', 'node_modules', relativePath),
    path.join(process.cwd(), 'node_modules', relativePath),
    ...findUpNodeModules(__dirname, relativePath),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 通过 require.resolve 找到包根目录（包含 package.json 的目录）
function findPackageRoot(pkgName) {
  try {
    const resolved = require.resolve(pkgName);
    let dir = path.dirname(resolved);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
          if (pkg.name === pkgName) return dir;
        } catch (e) { /* ignore */ }
      }
      dir = path.dirname(dir);
    }
  } catch (e) { /* 包不可解析，跳过 */ }
  return null;
}

function findUpNodeModules(startDir, relativePath) {
  const results = [];
  let dir = startDir;
  // ★ 深度 50 支持深层 monorepo（pnpm hoist 等），到达根目录自动停止
  for (let i = 0; i < 50; i++) {
    dir = path.dirname(dir);
    if (dir === path.dirname(dir)) break; // 到达根目录
    results.push(path.join(dir, 'node_modules', relativePath));
  }
  return results;
}

const MQTT_PACKET_CONSTANTS = findTargetFile(path.join('mqtt-packet', 'constants.js'));
const MQTT_PACKET_PARSER = findTargetFile(path.join('mqtt-packet', 'parser.js'));
const MQTT_ACK = findTargetFile(path.join('mqtt', 'build', 'lib', 'handlers', 'ack.js'));
const MQTT_CLIENT = findTargetFile(path.join('mqtt', 'build', 'lib', 'client.js'));

// --quiet 模式：只输出错误和最终摘要
const quiet = process.argv.includes('--quiet');
const log = quiet ? () => {} : (...args) => console.log('[patch-mqtt]', ...args);
const err = (...args) => console.error('[patch-mqtt]', ...args);

// ★ 如果找不到目标文件，说明是全新安装（依赖还没装好），静默跳过
const allFound = MQTT_PACKET_CONSTANTS && MQTT_PACKET_PARSER && MQTT_ACK && MQTT_CLIENT;
if (!allFound) {
  log('[WFC-Patch] ⏭️ 未找到 mqtt-packet/mqtt 模块，跳过补丁（可能在安装依赖中）');
  log('[WFC-Patch] 如果依赖已安装但仍报错，手动运行: npx qxdim-patch 或 node node_modules/qxdim/scripts/patch-mqtt.js');
  process.exit(0);
}

log('[WFC-Patch] 正在应用 WildFireChat MQTT 协议补丁...');
log('[WFC-Patch] 目标文件:');
log('  -', MQTT_PACKET_CONSTANTS);
log('  -', MQTT_PACKET_PARSER);
log('  -', MQTT_ACK);
log('  -', MQTT_CLIENT);

let patchCount = 0;
const filesMissing = [];

for (const f of [MQTT_PACKET_CONSTANTS, MQTT_PACKET_PARSER, MQTT_ACK, MQTT_CLIENT]) {
  if (!fs.existsSync(f)) {
    filesMissing.push(f);
    err('[WFC-Patch] ❌ 未找到:', f);
  }
}
if (filesMissing.length > 0) {
  err('[WFC-Patch] 请先运行 npm install');
  process.exit(1);
}

// ===== Patch 5: SUBACK header flag 旁路 (mqtt-packet/constants.js) =====
// WildFireChat SUBACK 的 flag bits 非零（违反 MQTT 规范）
// 标准 mqtt-packet 严格检查 requiredHeaderFlags[9]=0，触发
//   "Invalid header flag bits, must be 0x0 for suback packet"
// 修复: 从 requiredHeaderFlags 删除 suback (key=9) 的条目
//   parser.js 中 requiredHeaderFlags != null 检查会跳过 suback
let constantsSrc = fs.readFileSync(MQTT_PACKET_CONSTANTS, 'utf8');
const patch5_old = `  9: 0, // 'suback'`;
const patch5_new = `  // 9: 0, // 'suback' — removed by WFC-Patch (WildFireChat SUBACK flag bits 非零)`;

if (constantsSrc.includes(patch5_old)) {
  constantsSrc = constantsSrc.replace(patch5_old, patch5_new);
  fs.writeFileSync(MQTT_PACKET_CONSTANTS, constantsSrc);
  log('[WFC-Patch] ✅ Patch 5: SUBACK header flag 旁路 (mqtt-packet/constants.js)');
  patchCount++;
} else if (constantsSrc.includes('removed by WFC-Patch')) {
  log('[WFC-Patch] ⏭️ Patch 5: 已应用过');
} else {
  err('[WFC-Patch] ❌ Patch 5: 未找到目标代码');
}

// ===== Patch 1: PUBACK payload 提取 (mqtt-packet/parser.js) =====
// WildFireChat 在 PUBACK 后追加服务器响应数据
// 标准 _parseConfirmation 在 protocolVersion=4 时只读 messageId，忽略后续字节
// 修复: 在 return true 之前提取剩余字节为 packet.payload，并设置 reasonCode=10
let parserSrc = fs.readFileSync(MQTT_PACKET_PARSER, 'utf8');

const patch1_old = `  _parseConfirmation () {
    debug('_parseConfirmation: packet.cmd: \`%s\`', this.packet.cmd)
    const packet = this.packet

    this._parseMessageId()

    if (this.settings.protocolVersion === 5) {`;
const patch1_new = `  _parseConfirmation () {
    debug('_parseConfirmation: packet.cmd: \`%s\`', this.packet.cmd)
    const packet = this.packet

    this._parseMessageId()

    // WFC-Patch 1: WildFireChat PUBACK 后追加 payload (在 MQTT 5 分支之前提取)
    if (this._list.length > this._pos) {
      packet.payload = this._list.slice(this._pos, this._list.length)
      packet.reasonCode = 10
    }

    if (this.settings.protocolVersion === 5) {`;

if (parserSrc.includes(patch1_old) && !parserSrc.includes('WFC-Patch 1')) {
  parserSrc = parserSrc.replace(patch1_old, patch1_new);
  log('[WFC-Patch] ✅ Patch 1: PUBACK payload 提取 (mqtt-packet/parser.js)');
  patchCount++;
} else if (parserSrc.includes('WFC-Patch 1')) {
  log('[WFC-Patch] ⏭️ Patch 1: 已应用过');
} else {
  err('[WFC-Patch] ❌ Patch 1: 未找到 _parseConfirmation 目标代码');
}

// ===== Patch 2: CONNACK payload 提取 (mqtt-packet/parser.js) =====
// WildFireChat 在 CONNACK 后追加 ConnectAckPayload protobuf
// 修复: 在 _parseConnack 末尾 'complete' debug 之前提取剩余字节
const patch2_old = `    if (packet.returnCode === -1 || packet.reasonCode === -1) return this._emitError(new Error('Cannot parse return code'))
    // mqtt 5 properties
    if (this.settings.protocolVersion === 5) {
      const properties = this._parseProperties()
      if (Object.getOwnPropertyNames(properties).length) {
        packet.properties = properties
      }
    }
    debug('_parseConnack: complete')
  }`;
const patch2_new = `    if (packet.returnCode === -1 || packet.reasonCode === -1) return this._emitError(new Error('Cannot parse return code'))
    // mqtt 5 properties
    if (this.settings.protocolVersion === 5) {
      const properties = this._parseProperties()
      if (Object.getOwnPropertyNames(properties).length) {
        packet.properties = properties
      }
    }
    // WFC-Patch 2: WildFireChat CONNACK 后追加 ConnectAckPayload protobuf
    if (this._list.length > this._pos) {
      packet.payload = this._list.slice(this._pos, this._list.length)
    }
    debug('_parseConnack: complete')
  }`;

if (parserSrc.includes(patch2_old) && !parserSrc.includes('WFC-Patch 2')) {
  parserSrc = parserSrc.replace(patch2_old, patch2_new);
  log('[WFC-Patch] ✅ Patch 2: CONNACK payload 提取 (mqtt-packet/parser.js)');
  patchCount++;
} else if (parserSrc.includes('WFC-Patch 2')) {
  log('[WFC-Patch] ⏭️ Patch 2: 已应用过');
} else {
  err('[WFC-Patch] ❌ Patch 2: 未找到 _parseConnack 目标代码');
}

// 写回 parser.js
fs.writeFileSync(MQTT_PACKET_PARSER, parserSrc);

// ===== Patch 3 + 4: mqtt/build/lib/handlers/ack.js 的 _handleAck =====
// 3a/3b: reasonCode=10 不当错误
// 4: puback 成功分支传递 PUBACK packet 给 callback (而不是 storeResult)
let ackSrc = fs.readFileSync(MQTT_ACK, 'utf8');

// Patch 3a: puback reasonCode=10 旁路
// 原: if (pubackRC && pubackRC > 0 && pubackRC !== 16) {
// 改: if (pubackRC && pubackRC > 0 && pubackRC !== 16 && pubackRC !== 10) {
const patch3a_old = `        case 'pubcomp':
        case 'puback': {
            const pubackRC = packet.reasonCode;
            if (pubackRC && pubackRC > 0 && pubackRC !== 16) {`;
const patch3a_new = `        case 'pubcomp':
        case 'puback': {
            const pubackRC = packet.reasonCode;
            // WFC-Patch 3a: reasonCode=10 是 WildFireChat 自定义成功码，不当错误
            if (pubackRC && pubackRC > 0 && pubackRC !== 16 && pubackRC !== 10) {`;

if (ackSrc.includes(patch3a_old)) {
  ackSrc = ackSrc.replace(patch3a_old, patch3a_new);
  log('[WFC-Patch] ✅ Patch 3a: puback reasonCode=10 旁路 (ack.js)');
  patchCount++;
} else if (ackSrc.includes('WFC-Patch 3a')) {
  log('[WFC-Patch] ⏭️ Patch 3a: 已应用过');
} else {
  err('[WFC-Patch] ❌ Patch 3a: 未找到目标代码');
}

// Patch 3b: pubrec reasonCode=10 旁路
const patch3b_old = `            const pubrecRC = packet.reasonCode;
            if (pubrecRC && pubrecRC > 0 && pubrecRC !== 16) {`;
const patch3b_new = `            const pubrecRC = packet.reasonCode;
            // WFC-Patch 3b: reasonCode=10 是 WildFireChat 自定义成功码，不当错误
            if (pubrecRC && pubrecRC > 0 && pubrecRC !== 16 && pubrecRC !== 10) {`;

if (ackSrc.includes(patch3b_old) && !ackSrc.includes('WFC-Patch 3b')) {
  ackSrc = ackSrc.replace(patch3b_old, patch3b_new);
  log('[WFC-Patch] ✅ Patch 3b: pubrec reasonCode=10 旁路 (ack.js)');
  patchCount++;
} else if (ackSrc.includes('WFC-Patch 3b')) {
  log('[WFC-Patch] ⏭️ Patch 3b: 已应用过');
} else {
  err('[WFC-Patch] ❌ Patch 3b: 未找到目标代码');
}

// Patch 4: puback 成功分支传递 PUBACK packet 给 callback
// 原: else { client['_removeOutgoingAndStoreMessage'](messageId, cb); }
// 改: else { client['_removeOutgoingAndStoreMessage'](messageId, () => cb(null, packet)); }
//   这样 cb 收到的是 PUBACK packet (含 payload)，而不是 outgoingStore 里的 PUBLISH packet
const patch4_old = `            else {
                client['_removeOutgoingAndStoreMessage'](messageId, cb);
            }
            break;
        }
        case 'pubrec': {`;
const patch4_new = `            else {
                // WFC-Patch 4: 传 PUBACK packet (含 payload) 给 cb，而不是 outgoingStore 的 PUBLISH
                client['_removeOutgoingAndStoreMessage'](messageId, () => cb(null, packet));
            }
            break;
        }
        case 'pubrec': {`;

if (ackSrc.includes(patch4_old) && !ackSrc.includes('WFC-Patch 4')) {
  ackSrc = ackSrc.replace(patch4_old, patch4_new);
  log('[WFC-Patch] ✅ Patch 4: puback 成功分支传 PUBACK packet 给 callback (ack.js)');
  patchCount++;
} else if (ackSrc.includes('WFC-Patch 4')) {
  log('[WFC-Patch] ⏭️ Patch 4: 已应用过');
} else {
  err('[WFC-Patch] ❌ Patch 4: 未找到目标代码');
}

fs.writeFileSync(MQTT_ACK, ackSrc);

// ===== Patch 6: SUBACK granted 越界保护 (mqtt/build/lib/client.js) =====
let clientSrc = fs.readFileSync(MQTT_CLIENT, 'utf8');
const patch6_old = `                    cb(err, packet2) {
                        if (!err) {
                            const { granted } = packet2;
                            for (let grantedI = 0; grantedI < granted.length; grantedI += 1) {
                                chunkedSubs[grantedI].qos = granted[grantedI];
                            }
                        }`;
const patch6_new = `                    cb(err, packet2) {
                        if (!err) {
                            const { granted } = packet2;
                            // WFC-Patch 6: 越界保护 (WildFireChat SUBACK granted 可能比订阅数多)
                            const grantedLen = Math.min(granted.length, chunkedSubs.length);
                            for (let grantedI = 0; grantedI < grantedLen; grantedI += 1) {
                                chunkedSubs[grantedI].qos = granted[grantedI];
                            }
                        }`;

if (clientSrc.includes(patch6_old)) {
  clientSrc = clientSrc.replace(patch6_old, patch6_new);
  fs.writeFileSync(MQTT_CLIENT, clientSrc);
  log('[WFC-Patch] ✅ Patch 6: SUBACK granted 越界保护');
  patchCount++;
} else if (clientSrc.includes('WFC-Patch 6')) {
  log('[WFC-Patch] ⏭️ Patch 6: 已应用过');
} else {
  err('[WFC-Patch] ❌ Patch 6: 未找到目标代码');
}

log(`\n[WFC-Patch] 完成! 应用了 ${patchCount} 个新补丁`);

// ===== 验证 =====
log('\n[WFC-Patch] 验证补丁状态:');
const checks = [
  [MQTT_PACKET_CONSTANTS, 'removed by WFC-Patch', 'SUBACK header flag 旁路'],
  [MQTT_PACKET_PARSER, 'WFC-Patch 1', 'PUBACK payload 提取'],
  [MQTT_PACKET_PARSER, 'WFC-Patch 2', 'CONNACK payload 提取'],
  [MQTT_ACK, 'WFC-Patch 3a', 'puback reasonCode=10 旁路'],
  [MQTT_ACK, 'WFC-Patch 3b', 'pubrec reasonCode=10 旁路'],
  [MQTT_ACK, 'WFC-Patch 4', 'PUBACK packet 传递给 callback'],
  [MQTT_CLIENT, 'WFC-Patch 6', 'SUBACK granted 越界保护'],
];
let allOk = true;
for (const [file, marker, desc] of checks) {
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes(marker)) {
    log(`  ✅ ${desc}`);
  } else {
    log(`  ❌ ${desc} — 标记未找到`);
    allOk = false;
  }
}

if (allOk) {
  log('\n[WFC-Patch] ✅ 所有补丁验证通过');
} else {
  err('\n[WFC-Patch] ❌ 部分补丁缺失');
  process.exit(1);
}
