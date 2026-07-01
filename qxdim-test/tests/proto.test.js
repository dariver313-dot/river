/**
 * Protobuf 编解码测试
 * 验证所有消息类型能否正确编码和解码
 * 
 * 运行: node src/test-proto.js
 */

import { initProto, encode, decode, toJSON } from '../src/proto/index.js';

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
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotEmpty(value, msg) {
  if (!value || (typeof value === 'string' && value.length === 0)) {
    throw new Error(`${msg}: value is empty`);
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Protobuf 编解码测试                         ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  await initProto();

  // ===== 基础消息类型 =====
  console.log('--- 基础消息类型 ---');

  test('Conversation 编解码', () => {
    const data = { type: 0, target: 'user123', line: 0 };
    const encoded = encode('qxdim.Conversation', data);
    const decoded = decode('qxdim.Conversation', encoded);
    const json = toJSON(decoded);
    assertEqual(json.type, 0, 'type');
    assertEqual(json.target, 'user123', 'target');
    assertEqual(json.line, 0, 'line');
  });

  test('MessageContent 编解码', () => {
    const data = {
      type: 1,
      searchableContent: 'Hello World',
      content: '{"text":"test"}',
      mediaType: 0,
      persistFlag: 3,
    };
    const encoded = encode('qxdim.MessageContent', data);
    const decoded = decode('qxdim.MessageContent', encoded);
    const json = toJSON(decoded);
    assertEqual(json.type, 1, 'type');
    assertEqual(json.searchableContent, 'Hello World', 'searchableContent');
  });

  test('Message 编解码', () => {
    const data = {
      conversation: { type: 0, target: 'user456', line: 0 },
      fromUser: 'sender789',
      content: {
        type: 1,
        searchableContent: 'Test message',
      },
    };
    const encoded = encode('qxdim.Message', data);
    const decoded = decode('qxdim.Message', encoded);
    const json = toJSON(decoded);
    assertEqual(json.fromUser, 'sender789', 'fromUser');
    assertEqual(json.conversation.target, 'user456', 'conversation.target');
  });

  // ===== 路由相关 =====
  console.log('\n--- 路由相关消息 ---');

  test('IMHttpWrapper 编解码', () => {
    const routeData = { type: 0, target: 'test', line: 0 };
    const routeBytes = encode('qxdim.Conversation', routeData);

    const data = {
      token: 'testToken',
      clientId: 'client123',
      request: 'ROUTE',
      data: routeBytes,
    };
    const encoded = encode('qxdim.IMHttpWrapper', data);
    const decoded = decode('qxdim.IMHttpWrapper', encoded);
    const json = toJSON(decoded);
    assertEqual(json.token, 'testToken', 'token');
    assertEqual(json.request, 'ROUTE', 'request');
  });

  test('RouteRequest 编解码', () => {
    const data = {
      app: 'qxdim',
      platform: 5,
      appVersion: '1.14.28',
      webAppId: 'web_12345678',
      webAppKey: '7ed686780102b0617ae8506d4fe15224db87e5b0',
    };
    const encoded = encode('qxdim.RouteRequest', data);
    const decoded = decode('qxdim.RouteRequest', encoded);
    const json = toJSON(decoded);
    assertEqual(json.app, 'qxdim', 'app');
    assertEqual(json.platform, 5, 'platform');
  });

  test('RouteResponse 编解码', () => {
    const data = {
      host: 'mq.qixunda.tech',
      longPort: 8085,
      shortPort: 8086,
      wssPort: 443,
      node: 'node1',
    };
    const encoded = encode('qxdim.RouteResponse', data);
    const decoded = decode('qxdim.RouteResponse', encoded);
    const json = toJSON(decoded);
    assertEqual(json.host, 'mq.qixunda.tech', 'host');
    assertEqual(json.wssPort, 443, 'wssPort');
  });

  test('ConnectAckPayload 编解码', () => {
    const data = {
      msgHead: 100,          // ★ 用数字而非字符串（int64字段）
      serverTime: 1700000000000,
      nodeId: 'node-abc',
    };
    const encoded = encode('qxdim.ConnectAckPayload', data);
    const decoded = decode('qxdim.ConnectAckPayload', encoded);
    const json = toJSON(decoded);
    assertEqual(json.nodeId, 'node-abc', 'nodeId');
  });

  // ===== 通知消息 =====
  console.log('\n--- 通知消息 ---');

  test('NotifyMessage 编解码', () => {
    const data = { type: 1, head: 200 };  // ★ 用数字而非字符串（int64字段）
    const encoded = encode('qxdim.NotifyMessage', data);
    const decoded = decode('qxdim.NotifyMessage', encoded);
    assertNotEmpty(encoded, 'Encoded data');
  });

  test('NotifyGroupMessage 编解码', () => {
    const data = { head: 300, target: 'group123', line: 0, type: 1 };  // ★ 用数字
    const encoded = encode('qxdim.NotifyGroupMessage', data);
    const decoded = decode('qxdim.NotifyGroupMessage', encoded);
    assertNotEmpty(encoded, 'Encoded data');
  });

  // ===== 用户/群组 =====
  console.log('\n--- 用户/群组消息 ---');

  test('User 编解码', () => {
    const data = {
      uid: 'user001',
      name: '张三',
      displayName: '三哥',
      gender: 1,
      mobile: '13800138000',
    };
    const encoded = encode('qxdim.User', data);
    const decoded = decode('qxdim.User', encoded);
    const json = toJSON(decoded);
    assertEqual(json.uid, 'user001', 'uid');
    assertEqual(json.name, '张三', 'name');
  });

  test('GroupInfo 编解码', () => {
    const data = {
      targetId: 'group001',
      name: '测试群',
      owner: 'user001',
      memberCount: 10,
    };
    const encoded = encode('qxdim.GroupInfo', data);
    const decoded = decode('qxdim.GroupInfo', encoded);
    const json = toJSON(decoded);
    assertEqual(json.targetId, 'group001', 'targetId');
  });

  // ===== 结果 =====
  console.log('\n════════════════════════════════════════');
  console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`);
  console.log('════════════════════════════════════════');

  if (failed > 0) process.exit(1);
  else console.log('\n🎉 所有 Protobuf 编解码测试通过!');
}

main().catch(console.error);
