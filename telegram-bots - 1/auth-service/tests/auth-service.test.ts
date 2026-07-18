import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager } from '../src/token-manager';
import { getDateRangeForTimezone, timestampToPlatformDateTime } from '../src/utils';
import {
  sanitizeMemberDetails,
  sanitizeMemberSearchResult,
  sanitizeReportRechargeOrder,
  sanitizeReportWithdrawOrder,
} from '../src/platforms/platform-b';
import { createMultipartForm, sanitizePlatformAMemberRecords } from '../src/platforms/platform-a';

test('token refresh is single-flight even when no token cache entry exists', async () => {
  const manager = new TokenManager();
  let calls = 0;
  (manager as any)._doRefresh = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return 'fresh-token';
  };

  const config = {
    baseUrl: 'https://example.invalid',
    account: 'test',
    password: 'test',
    totpSecret: 'test',
    rsaPublicKey: 'test',
  };
  const results = await Promise.all([
    manager.refreshToken('platform_a', config),
    manager.refreshToken('platform_a', config),
    manager.refreshToken('platform_a', config),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(results, ['fresh-token', 'fresh-token', 'fresh-token']);
});

test('platform datetime uses configured timezone instead of forwarding epoch text', () => {
  const timestamp = Date.parse('2026-07-11T16:30:45.000Z');
  assert.equal(timestampToPlatformDateTime(timestamp, 8), '2026-07-12 00:30:45');
  assert.equal(timestampToPlatformDateTime(timestamp, Number.NaN), '2026-07-12 00:30:45');
});

test('explicit Beijing report date uses the whole Beijing natural day', () => {
  const range = getDateRangeForTimezone('2026-07-15', 8);
  assert.equal(range.start, Date.parse('2026-07-14T16:00:00.000Z'));
  assert.equal(range.end, Date.parse('2026-07-15T15:59:59.999Z'));
  assert.throws(() => getDateRangeForTimezone('2026-02-30', 8), RangeError);
});

test('platform B member data keeps required fields and removes payment secrets', () => {
  const search = sanitizeMemberSearchResult({
    success: true,
    items: [{
      memberId: 'member-1', memberName: 'demo', balance: '12.5', agencyMemberName: 'agent',
      latestLoginIp: '127.0.0.1', phone: '13800000000', realname: 'private', avatar: 'https://example.invalid/a.png',
    }],
  });
  assert.deepEqual(search.items[0], {
    memberId: 'member-1', memberName: 'demo', balance: '12.5', agencyMemberName: 'agent', latestLoginIp: '127.0.0.1',
  });

  const detail = sanitizeMemberDetails({
    sumRecharge: '100', sumPromotion: '10', latestLoginDevice: 'device-1',
    latestRechargeOrder: [{ md5Key: 'secret', publicKey: 'public', privateKey: 'private', paywayName: 'bank' }],
    latestWithdrawOrder: [{ receivingCardNo: 'card' }], bankList: [{ cardNo: 'card' }], phone: '13800000000', realName: 'private',
  });
  assert.deepEqual(detail, { sumRecharge: '100', sumPromotion: '10', latestLoginDevice: 'device-1' });
  assert.equal('latestRechargeOrder' in detail, false);
  assert.equal('latestWithdrawOrder' in detail, false);
  assert.equal('bankList' in detail, false);
});

test('platform B report orders only expose reconciliation fields', () => {
  const recharge = sanitizeReportRechargeOrder({
    orderNo: 'R-1', memberName: 'demo', amount: '88.5', status: '0000',
    payPlatformCode: 'wallet-a', payPlatformName: '钱包A', paywayId: 'p-1', paywayName: '钱包',
    createTime: 1, updateTime: 2,
    privateKey: 'secret', md5Key: 'secret', callbackUrl: 'https://private.invalid', realName: 'private',
  });
  assert.deepEqual(recharge, {
    orderNo: 'R-1', memberName: 'demo', amount: '88.5', status: '0000',
    payPlatformCode: 'wallet-a', payPlatformName: '钱包A', paywayId: 'p-1', paywayName: '钱包',
    createTime: 1, updateTime: 2,
  });

  const withdraw = sanitizeReportWithdrawOrder({
    orderNo: 'W-1', memberName: 'demo', amount: '30', status: 8,
    paymentAgentId: 'agent-1', receivingBank: '钱包A', createTime: 1, updateTime: 2,
    receivingCardNo: 'private', receivingName: 'private', loginIp: '127.0.0.1',
  });
  assert.deepEqual(withdraw, {
    orderNo: 'W-1', memberName: 'demo', amount: '30', status: 8,
    paymentAgentId: 'agent-1', receivingBank: '钱包A', createTime: 1, updateTime: 2,
  });
});

test('platform A member list uses multipart form data and removes personal contacts', () => {
  const form = createMultipartForm({ flag: 0, account: 'demo', empty: undefined });
  assert.match(form.contentType, /^multipart\/form-data; boundary=----AuthService/);
  assert.match(form.data, /name="flag"\r\n\r\n0/);
  assert.match(form.data, /name="account"\r\n\r\ndemo/);
  assert.doesNotMatch(form.data, /name="empty"/);

  const response = sanitizePlatformAMemberRecords({
    code: 0,
    data: {
      records: [{
        id: 1, account: 'demo', balance: 12, parentName: 'agent', lastLoginDeviceClientId: 'device-1',
        phone: '13800000000', email: 'private@example.invalid', bankCard: 'card', taxNum: 'tax',
      }],
    },
    succeed: true,
  });
  assert.deepEqual(response.data.records[0], {
    id: 1, account: 'demo', balance: 12, parentName: 'agent', lastLoginDeviceClientId: 'device-1',
  });
});
