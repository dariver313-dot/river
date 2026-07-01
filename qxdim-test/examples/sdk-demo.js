/**
 * 示例：QXDim 高级 SDK 演示
 *
 * 展示 QXDim 简洁 API：
 *   const qxd = new QXDim();
 *   await qxd.login('your_company_code', '+86 xxx', 'xxx');
 *   qxd.onMessage((msg) => console.log('收到:', msg.text));
 *   await qxd.sendText('88dv45ixr', 'Hello!');
 *   await qxd.disconnect();
 *
 * 用法:
 *   # 单账号演示：登录、拉历史、发消息
 *   QXDIM_COMPANY_CODE=your_company_code \
 *   QXDIM_MOBILE="+86 xxx" QXDIM_PASSWORD="xxx" \
 *   QXDIM_TARGET=88dv45ixr \
 *   node examples/sdk-demo.js
 *
 *   # 双账号实时聊天：A 发给 B，B 实时收到
 *   QXDIM_COMPANY_CODE=your_company_code \
 *   QXDIM_MOBILE_A="+86 xxx" QXDIM_PASSWORD_A="xxx" \
 *   QXDIM_MOBILE_B="+86 xxx" QXDIM_PASSWORD_B="xxx" \
 *   node examples/sdk-demo.js --two-accounts
 */

import { QXDim, ConnectionStatus } from '../src/index.js';

const TWO_ACCOUNTS = process.argv.includes('--two-accounts');

function ts() { return new Date().toLocaleTimeString(); }

async function singleAccountDemo() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   QXDim SDK 单账号演示                        ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const companyCode = process.env.QXDIM_COMPANY_CODE;
  const mobile = process.env.QXDIM_MOBILE;
  const password = process.env.QXDIM_PASSWORD;
  const target = process.env.QXDIM_TARGET || '';
  if (!companyCode || !mobile || !password) {
    console.error('❌ 缺少环境变量: QXDIM_COMPANY_CODE, QXDIM_MOBILE, QXDIM_PASSWORD');
    console.error('  请参考 .env.example 配置');
    process.exit(1);
  }

  // 1. 创建 SDK 实例
  const qxd = new QXDim();

  // 2. 注册回调（在 login 前注册，确保不漏消息）
  qxd.onMessage((msg) => {
    console.log(`\n[${ts()}] 📩 收到消息:`);
    console.log(`  文本: ${msg.text}`);
    console.log(`  来自: ${msg.fromUserId} (${msg.fromUserId === qxd.getUserInfo().userId ? '自己' : '对方'})`);
    console.log(`  时间: ${new Date(Number(msg.serverTimestamp)).toLocaleString()}`);
  });

  qxd.onStatusChange((s) => {
    const names = ['未连接', '连接中', '已连接', '接收中', '', '', '', '被踢下线'];
    console.log(`[${ts()}] [状态] ${names[s] || s}`);
  });

  qxd.onReconnect((n) => {
    console.log(`[${ts()}] 🔄 重连第 ${n} 次`);
  });

  qxd.onKickedOff((reason) => {
    console.log(`[${ts()}] 👋 被踢下线: ${reason}`);
  });

  // 3. 登录（一行搞定 DNS→query_company_server→pc_session→session_login→login_pwd→route→MQTT）
  console.log(`[${ts()}] 登录中... companyCode=${companyCode} mobile=${mobile.replace(/(\+86 )?(\d{3})\d{4}(\d{4})/, '$1$2****$3')}`);
  const user = await qxd.login(companyCode, mobile, password);
  console.log(`[${ts()}] ✅ 登录成功!`);
  console.log(`  userId    : ${user.userId}`);
  console.log(`  userName  : ${user.userName}`);
  console.log(`  companyName: ${user.companyName}`);

  // 4. 发送文本消息（一行）
  const text = `Hello from QXDim SDK @ ${ts()}`;
  console.log(`\n[${ts()}] 发送消息给 ${target}: "${text}"`);
  const result = await qxd.sendText(target, text);
  console.log(`[${ts()}] ✅ 发送成功!`);
  console.log(`  messageUid: ${result.messageUid.toString()}`);
  console.log(`  timestamp : ${result.timestampDate.toISOString()}`);

  // 5. 等 8 秒收推送（多端同步会收到自己发的消息 echo）
  console.log(`\n[${ts()}] 等 8 秒收消息...`);
  await new Promise(r => setTimeout(r, 8000));

  // 6. 主动拉一次消息
  console.log(`\n[${ts()}] 主动拉取历史消息...`);
  await qxd.pullMessages(0, 0);

  console.log(`\n[${ts()}] 等 5 秒...`);
  await new Promise(r => setTimeout(r, 5000));

  // 7. 断开
  console.log(`\n[${ts()}] 断开连接`);
  await qxd.disconnect();
  process.exit(0);
}

async function twoAccountsDemo() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   QXDim SDK 双账号实时聊天演示                ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const companyCode = process.env.QXDIM_COMPANY_CODE;
  const mobileA = process.env.QXDIM_MOBILE_A;
  const passwordA = process.env.QXDIM_PASSWORD_A;
  const mobileB = process.env.QXDIM_MOBILE_B;
  const passwordB = process.env.QXDIM_PASSWORD_B;
  if (!companyCode || !mobileA || !passwordA || !mobileB || !passwordB) {
    console.error('❌ 缺少环境变量: QXDIM_COMPANY_CODE, QXDIM_MOBILE_A/B, QXDIM_PASSWORD_A/B');
    console.error('  请参考 .env.example 配置');
    process.exit(1);
  }

  // 创建 A 和 B 两个 SDK 实例
  const A = new QXDim();
  const B = new QXDim();

  // B 注册消息回调
  B.onMessage((msg) => {
    if (msg.fromUserId === B.getUserInfo().userId) return;  // 忽略自己的 echo
    console.log(`\n[${ts()}] [B] 📩 收到来自 A: "${msg.text}"`);
  });

  // A 注册消息回调
  A.onMessage((msg) => {
    if (msg.fromUserId === A.getUserInfo().userId) return;  // 忽略自己的 echo
    console.log(`\n[${ts()}] [A] 📩 收到来自 B: "${msg.text}"`);
  });

  // 并行登录两个账号
  console.log(`[${ts()}] 并行登录 A 和 B...`);
  const [userA, userB] = await Promise.all([
    A.login(companyCode, mobileA, passwordA),
    B.login(companyCode, mobileB, passwordB),
  ]);
  console.log(`[${ts()}] ✅ A 登录: userId=${userA.userId} userName=${userA.userName}`);
  console.log(`[${ts()}] ✅ B 登录: userId=${userB.userId} userName=${userB.userName}`);

  // A 发 2 条给 B
  console.log(`\n[${ts()}] ━━━ A → B 发 2 条消息 ━━━`);
  for (let i = 1; i <= 2; i++) {
    const text = `A→B #${i} @ ${ts()}`;
    console.log(`[${ts()}] [A] 发送: "${text}"`);
    const r = await A.sendText(userB.userId, text);
    console.log(`[${ts()}] [A] ✅ messageUid=${r.messageUid.toString()}`);
    await new Promise(r => setTimeout(r, 1500));
  }

  // B 回 1 条给 A
  console.log(`\n[${ts()}] ━━━ B → A 回 1 条消息 ━━━`);
  const replyText = `B→A reply @ ${ts()}`;
  console.log(`[${ts()}] [B] 发送: "${replyText}"`);
  const r = await B.sendText(userA.userId, replyText);
  console.log(`[${ts()}] [B] ✅ messageUid=${r.messageUid.toString()}`);

  // 等收推送
  console.log(`\n[${ts()}] 等 8 秒收推送...`);
  await new Promise(r => setTimeout(r, 8000));

  console.log(`\n[${ts()}] ━━━ 测试完成，断开连接 ━━━`);
  await Promise.all([A.disconnect(), B.disconnect()]);
  process.exit(0);
}

const mode = TWO_ACCOUNTS ? 'two-accounts' : 'single';
console.log(`模式: ${mode}\n`);

if (TWO_ACCOUNTS) {
  twoAccountsDemo().catch(e => { console.error('致命错误:', e); process.exit(1); });
} else {
  singleAccountDemo().catch(e => { console.error('致命错误:', e); process.exit(1); });
}
