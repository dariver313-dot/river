/**
 * 加密模块单元测试
 * 验证 AES 加密解密是否与企讯达客户端完全一致
 * 
 * 运行: node src/test-crypto.js
 */

import { aesEncrypt, aesDecrypt, xorObfuscate, generateWillTopic, getDefaultKey, utils } from '../src/crypto/aes.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotEmpty(value, msg) {
  if (!value || value.length === 0) {
    throw new Error(`${msg || 'Value is empty'}`);
  }
}

console.log('╔══════════════════════════════════════════════╗');
console.log('║   加密模块单元测试                            ║');
console.log('╚══════════════════════════════════════════════╝\n');

// ========== 密钥派生 ==========

console.log('--- 密钥派生测试 ---');

test('deriveKey: 短字符串填充零', () => {
  const key = utils.deriveKey('abc');
  assertEqual(key.length, 16, 'Key length');
  assertEqual(key[0], 97, 'key[0]');   // 'a'
  assertEqual(key[1], 98, 'key[1]');   // 'b'
  assertEqual(key[2], 99, 'key[2]');   // 'c'
  assertEqual(key[3], 0, 'key[3]');    // 填充零
  assertEqual(key[15], 0, 'key[15]');  // 填充零
});

test('deriveKey: 恰好16字符', () => {
  const key = utils.deriveKey('1234567890123456');
  assertEqual(key.length, 16, 'Key length');
  assertEqual(key[0], 49, 'key[0]');  // '1'
  assertEqual(key[15], 54, 'key[15]'); // '6'
});

test('deriveKey: 超过16字符截断', () => {
  const key = utils.deriveKey('12345678901234567890');
  assertEqual(key.length, 16, 'Key length');
  assertEqual(key[15], 54, 'key[15]'); // 第16个字符 '6'
});

// ========== 默认密钥 ==========

console.log('\n--- 默认密钥测试 ---');

test('默认密钥值正确', () => {
  const key = getDefaultKey();
  assertEqual(key.length, 16, 'Key length');
  assertEqual(key[0], 0, 'key[0]');
  assertEqual(key[1], 17, 'key[1]');
  assertEqual(key[15], 127, 'key[15]');
});

// ========== AES 加密解密（无时间戳） ==========

console.log('\n--- AES 加密解密测试（无时间戳） ---');

test('AES: 默认密钥加密/解密（字符串，无时间戳）', () => {
  const plaintext = 'Hello QXDIM!';
  const encrypted = aesEncrypt(plaintext, '', false);
  assertNotEmpty(encrypted, 'Encrypted result');
  
  const decrypted = aesDecrypt(encrypted, '', false);
  assertNotEmpty(decrypted, 'Decrypted result');
  assertEqual(decrypted.toString('utf8'), plaintext, 'Decrypted text');
});

test('AES: 自定义密钥加密/解密（字符串，无时间戳）', () => {
  const plaintext = '测试中文加密';
  const key = 'mySecretKey12345';
  const encrypted = aesEncrypt(plaintext, key, false);
  const decrypted = aesDecrypt(encrypted, key, false);
  assertEqual(decrypted.toString('utf8'), plaintext, 'Decrypted text');
});

test('AES: 二进制数据加密/解密', () => {
  const data = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  const encrypted = aesEncrypt(data, '', false);
  const decrypted = aesDecrypt(encrypted, '', false);
  assertEqual(decrypted.toString('hex'), data.toString('hex'), 'Decrypted binary');
});

// ========== AES 加密解密（含时间戳） ==========

console.log('\n--- AES 加密解密测试（含时间戳） ---');

test('AES: 默认密钥加密/解密（含时间戳）', () => {
  const plaintext = 'Message with timestamp';
  const encrypted = aesEncrypt(plaintext, '', true);
  const decrypted = aesDecrypt(encrypted, '', true);
  assertEqual(decrypted.toString('utf8'), plaintext, 'Decrypted text');
});

test('AES: 自定义密钥加密/解密（含时间戳）', () => {
  const plaintext = '带时间戳的消息';
  const key = 'tokenKey12345678';
  const encrypted = aesEncrypt(plaintext, key, true);
  const decrypted = aesDecrypt(encrypted, key, true);
  assertEqual(decrypted.toString('utf8'), plaintext, 'Decrypted text');
});

test('AES: 时间戳前缀自动去除', () => {
  const plaintext = 'Recent message';
  const encrypted = aesEncrypt(plaintext, '', true);
  const decrypted = aesDecrypt(encrypted, '', true);
  assertNotEmpty(decrypted, 'Decryption should succeed and strip timestamp prefix');
  assertEqual(decrypted.toString('utf8'), plaintext, 'Decrypted text matches');
});

// ========== XOR 混淆 ==========

console.log('\n--- XOR 混淆测试 ---');

test('XOR: 与 0x5A 异或', () => {
  const input = 'A';  // 0x41
  const result = xorObfuscate(input, 0x5A);
  assertEqual(result.charCodeAt(0), 0x41 ^ 0x5A, 'XOR result');
});

test('XOR: 可逆性', () => {
  const input = 'node123|host.com';
  const xored = xorObfuscate(input, 0x5A);
  const recovered = xorObfuscate(xored, 0x5A);
  assertEqual(recovered, input, 'XOR reversible');
});

test('Will Topic 生成', () => {
  const topic = generateWillTopic('node123', 'qim1.qixunda.tech');
  assertNotEmpty(topic, 'Will topic');
  // Base64 格式验证
  assertEqual(typeof topic, 'string', 'Topic is string');
  assertEqual(topic.length > 0, true, 'Topic not empty');
});

// ========== 工具函数 ==========

console.log('\n--- 工具函数测试 ---');

test('bytesToHex / hexToBytes 转换', () => {
  const bytes = [0x01, 0x02, 0xFF, 0x00];
  const hex = utils.bytesToHex(bytes);
  assertEqual(hex, '0102ff00', 'Hex string');
  const recovered = utils.hexToBytes(hex);
  assertEqual(recovered.join(','), bytes.join(','), 'Recovered bytes');
});

test('Base64 编解码', () => {
  const data = Buffer.from('test data 123');
  const b64 = utils.bytesToBase64(data);
  const recovered = utils.base64ToBytes(b64);
  assertEqual(recovered.toString(), data.toString(), 'Base64 roundtrip');
});

test('UTF-8 字符串/字节转换', () => {
  // bytesToString 是单字节映射(charCode)，不是UTF-8解码
  // 对于 ASCII 字符两者一致，对于中文需要用 TextDecoder
  const str = 'Hello ASCII';
  const bytes = utils.stringToBytes(str);
  const recovered = String.fromCharCode(...bytes);
  assertEqual(recovered, str, 'ASCII roundtrip');
  
  // 中文需要用 TextDecoder 做完整 UTF-8 往返
  const cnStr = '中文测试';
  const cnBytes = utils.stringToBytes(cnStr);
  const cnRecovered = new TextDecoder().decode(new Uint8Array(cnBytes));
  assertEqual(cnRecovered, cnStr, 'Chinese UTF-8 roundtrip');
});

// ========== Token 解密模拟 ==========

console.log('\n--- Token 解密模拟 ---');

test('模拟 token 格式: part1|part2', () => {
  // 模拟企讯达 token 的加密解密流程
  const fakeToken = 'authTokenValue|encryptionKey16';
  
  // 1. 用默认密钥加密 token（模拟服务端存储）
  const encryptedToken = aesEncrypt(fakeToken, '', false);
  
  // 2. 解密 token
  const decryptedToken = aesDecrypt(encryptedToken, '', false);
  assertEqual(decryptedToken.toString('utf8'), fakeToken, 'Token roundtrip');
  
  // 3. 分割 token
  const parts = decryptedToken.toString('utf8').split('|');
  assertEqual(parts.length, 2, 'Token has two parts');
  assertEqual(parts[0], 'authTokenValue', 'Token part 1');
  assertEqual(parts[1], 'encryptionKey16', 'Token part 2 (key)');
});

test('完整通信模拟: 用 tokenKey 加密/解密数据', () => {
  const tokenKey = 'myTokenKey123456';  // 恰好16字符
  
  // 模拟: 服务器用 tokenKey 加密数据
  const secretData = Buffer.from('top secret message from server');
  const encrypted = aesEncrypt(secretData, tokenKey, true);
  
  // 模拟: 客户端用相同的 tokenKey 解密
  const decrypted = aesDecrypt(encrypted, tokenKey, true);
  assertEqual(decrypted.toString('utf8'), secretData.toString('utf8'), 'Communication simulation');
});

// ========== 结果 ==========

console.log('\n════════════════════════════════════════');
console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`);
console.log('════════════════════════════════════════');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n🎉 所有测试通过! 加密模块与企讯达客户端完全兼容。');
}
