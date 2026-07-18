'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');
const { calculateFee, sumDecimals } = require('../lib/decimal');
const { buildReport } = require('../lib/report');
const { buildOutputWorkbook, getExportIssues, getTemplateSchema } = require('../lib/xlsx-template');

function inline(reference, value) {
  return `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`;
}

function number(reference, value = '') {
  return `<c r="${reference}" s="1">${value === '' ? '' : `<v>${value}</v>`}</c>`;
}

async function workbookBuffer({ closing = '0', formulaInInput = false } = {}) {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="总汇" sheetId="1" r:id="rId1"/><sheet name="后台" sheetId="2" r:id="rId2"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/><Relationship Id="rId2" Target="worksheets/sheet2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>`);
  zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="5">${inline('C5', '测试钱包')}<c r="E5" s="1"><f>后台!B4</f><v>0</v></c></row></sheetData></worksheet>`);
  const input = formulaInInput ? '<c r="B7" s="1"><f>1+1</f><v>2</v></c>' : number('B7');
  zip.file('xl/worksheets/sheet2.xml', `<worksheet><sheetData>
    <row r="4"><c r="B4" s="1"><f>SUM(B7:B9)</f><v>0</v></c>${number('C4', '0')}${number('D4', '0')}${number('E4', '0')}<c r="F4" s="1"><f>SUM(F7:F9)</f><v>0</v></c><c r="G4" s="1"><f>SUM(G7:G9)</f><v>0</v></c><c r="H4" s="1"><f>H6-G4-F4-E4+D4+C4+B4</f><v>${closing}</v></c></row>
    <row r="5">${inline('B5', '会员充值')}${inline('C5', '未提交')}${inline('D5', '人工充值')}${inline('E5', '资金转出')}${inline('F5', '会员取款')}${inline('G5', '手续费')}${inline('H5', '余额')}${inline('I5', '备注')}</row>
    <row r="6">${number('H6', '0')}</row>
    <row r="7">${input}${number('C7')}${number('D7')}${number('E7')}${number('F7')}${number('G7')}<c r="H7" s="1"><f>H6+B7+C7+D7-E7-F7-G7</f><v>0</v></c>${number('I7')}</row>
    <row r="8">${number('B8')}${number('C8')}${number('D8')}${number('E8')}${number('F8')}${number('G8')}${number('H8')}${number('I8')}</row>
    <row r="9">${number('B9')}${number('C9')}${number('D9')}${number('E9')}${number('F9')}${number('G9')}${number('H9')}${number('I9')}</row>
  </sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function config() {
  return {
    channelSettings: {
      测试钱包: {
        rechargeNames: '平台钱包', withdrawNames: '代付银行', rechargeRate: '1.5', rechargeFixed: '0', withdrawRate: '0', withdrawFixed: '2', note: '日报自动生成',
      },
    },
  };
}

test('decimal calculations remain exact', () => {
  assert.equal(sumDecimals(['0.1', '0.2', '1.005']), '1.305');
  assert.equal(calculateFee('10.01', { mode: 'fixed_plus_percent', fixed: '2', percent: '1' }), '2.1');
});

test('name matching uses only configured business names and blocks unknown sources', async () => {
  const schema = await getTemplateSchema(await workbookBuffer());
  assert.equal(schema.channels.length, 1);
  assert.equal(schema.channels[0].name, '测试钱包');
  const report = buildReport(schema, config(), {
    recharge: { date: '2026-07-15', items: [{ amount: '100', payPlatformName: '平台钱包' }], totalNum: 1, sumAmount: '100' },
    withdraw: { items: [{ amount: '40', receivingBank: '代付银行' }, { amount: '5', receivingBank: '未知渠道' }], totalNum: 2, sumAmount: '45' },
  }, [{ channelId: 'backend:B', pendingAmount: '1', manualRechargeAmount: '2', transferOutAmount: '3', note: '补录' }]);
  assert.equal(report.channels[0].rechargeAmount, '100');
  assert.equal(report.channels[0].withdrawAmount, '40');
  assert.equal(report.channels[0].feeAmount, '3.5');
  assert.equal(report.channels[0].pendingAmount, '1');
  assert.equal(report.unresolved.length, 1);
  assert.equal(report.unresolved[0].name, '未知渠道');
  assert.equal(report.canExport, false);
});

test('template adapter writes the ledger input row and rolls only prior closing balances', async () => {
  const template = await workbookBuffer();
  const previous = await workbookBuffer({ closing: '66.5' });
  const schema = await getTemplateSchema(template);
  const report = buildReport(schema, config(), {
    recharge: { date: '2026-07-15', items: [{ amount: '100', payPlatformName: '平台钱包' }], totalNum: 1, sumAmount: '100' },
    withdraw: { items: [{ amount: '40', receivingBank: '代付银行' }], totalNum: 1, sumAmount: '40' },
  }, [{ channelId: 'backend:B', pendingAmount: '1', manualRechargeAmount: '2', transferOutAmount: '3', note: '补录' }]);
  assert.deepEqual(await getExportIssues(template, report, previous), []);
  const output = await buildOutputWorkbook(template, report, previous);
  const zip = await JSZip.loadAsync(output);
  const xml = await zip.file('xl/worksheets/sheet2.xml').async('string');
  assert.match(xml, /<c r="B4" s="1"><f>SUM\(B7:B9\)<\/f><v>0<\/v><\/c>/);
  assert.match(xml, /<c r="B7" s="1"><v>100<\/v><\/c>/);
  assert.match(xml, /<c r="C7" s="1"><v>1<\/v><\/c>/);
  assert.match(xml, /<c r="D7" s="1"><v>2<\/v><\/c>/);
  assert.match(xml, /<c r="E7" s="1"><v>3<\/v><\/c>/);
  assert.match(xml, /<c r="F7" s="1"><v>40<\/v><\/c>/);
  assert.match(xml, /<c r="G7" s="1"><v>3\.5<\/v><\/c>/);
  assert.match(xml, /<c r="H6" s="1"><v>66\.5<\/v><\/c>/);
  assert.match(xml, /<c r="I7" s="1" t="inlineStr"><is><t>日报自动生成；补录<\/t><\/is><\/c>/);
});

test('template adapter refuses a formula in a required ledger input cell', async () => {
  const template = await workbookBuffer({ formulaInInput: true });
  const schema = await getTemplateSchema(template);
  const report = buildReport(schema, config(), {
    recharge: { date: '2026-07-15', items: [{ amount: '1', payPlatformName: '平台钱包' }], totalNum: 1, sumAmount: '1' },
    withdraw: { items: [], totalNum: 0, sumAmount: '0' },
  });
  const issues = await getExportIssues(template, report);
  assert.match(issues.join('；'), /含公式/);
});

test('the supplied 澳门娱乐城 template is recognized and accepts a simple channel entry', async testContext => {
  const filename = path.join(__dirname, '..', 'templates', '2026澳门娱乐城.xlsx');
  try {
    await fs.access(filename);
  } catch {
    testContext.skip('未提供本地模板文件');
    return;
  }
  const template = await fs.readFile(filename);
  const schema = await getTemplateSchema(template);
  assert.equal(schema.channels.length, 31);
  assert.ok(schema.channels.some(channel => channel.name === '冠天支付'));
  const report = buildReport(schema, { channelSettings: {} }, {
    recharge: { date: '2026-07-15', items: [{ amount: '100', payPlatformName: 'AB钱包' }, { amount: '9', payPlatformName: '冠天支付' }], totalNum: 2, sumAmount: '109' },
    withdraw: { items: [], totalNum: 0, sumAmount: '0' },
  });
  assert.deepEqual(await getExportIssues(template, report), []);
  const output = await buildOutputWorkbook(template, report);
  assert.ok(output.length > 50000);
  const zip = await JSZip.loadAsync(output);
  const backend = await zip.file('xl/worksheets/sheet2.xml').async('string');
  assert.match(backend, /<c r="CX4"[^>]*><f>SUM\(CX7:CX888\)<\/f><v>0<\/v><\/c>/);
  assert.match(backend, /<c r="CX7"[^>]*><v>9<\/v><\/c>/);
});
