'use strict';

const path = require('node:path');
const JSZip = require('jszip');
const { isNonNegativeDecimal } = require('./decimal');

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attributes(tag) {
  return Object.fromEntries([...String(tag).matchAll(/([A-Za-z_][\w:.-]*)="([^"]*)"/g)].map(([, key, value]) => [key, decodeXml(value)]));
}

function columnToNumber(column) {
  return [...column].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0);
}

function numberToColumn(number) {
  let value = number;
  let column = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }
  return column;
}

function cellRef(column, row) {
  return `${column}${row}`;
}

function parseCellRef(reference) {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(reference);
  if (!match) throw new Error(`无效单元格：${reference}`);
  return { column: match[1], row: Number(match[2]) };
}

async function readText(zip, filename) {
  const file = zip.file(filename);
  if (!file) throw new Error(`Excel 文件缺少 ${filename}`);
  return file.async('string');
}

async function loadWorkbook(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
  } catch {
    throw new Error('文件不是有效的 .xlsx 工作簿');
  }
  const workbookXml = await readText(zip, 'xl/workbook.xml');
  const relsXml = await readText(zip, 'xl/_rels/workbook.xml.rels');
  const relationships = new Map();
  for (const tag of relsXml.match(/<Relationship\b[^>]*\/?>(?:<\/Relationship>)?/g) || []) {
    const relation = attributes(tag);
    if (!relation.Id || !relation.Target) continue;
    const target = relation.Target.startsWith('/') ? relation.Target.slice(1) : path.posix.join('xl', relation.Target);
    relationships.set(relation.Id, path.posix.normalize(target));
  }
  const sharedStrings = [];
  const sharedFile = zip.file('xl/sharedStrings.xml');
  if (sharedFile) {
    const sharedXml = await sharedFile.async('string');
    for (const item of sharedXml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) || []) {
      sharedStrings.push([...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join(''));
    }
  }
  const sheets = new Map();
  for (const tag of workbookXml.match(/<sheet\b[^>]*\/?>(?:<\/sheet>)?/g) || []) {
    const sheet = attributes(tag);
    const filename = relationships.get(sheet['r:id']);
    if (!sheet.name || !filename) continue;
    sheets.set(sheet.name, { filename, xml: await readText(zip, filename) });
  }
  if (!sheets.size) throw new Error('Excel 文件中没有可读取的工作表');
  return { zip, workbookXml, sheets, sharedStrings };
}

function readCellNode(node, sharedStrings) {
  const opening = /^<c\b[^>]*>/.exec(node);
  const attrs = attributes(opening ? opening[0] : node);
  const inlineText = [...node.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join('');
  const value = /<v>([\s\S]*?)<\/v>/.exec(node)?.[1] ?? '';
  return {
    value: attrs.t === 's' ? (sharedStrings[Number(value)] ?? '') : (attrs.t === 'inlineStr' ? inlineText : decodeXml(value)),
    formula: decodeXml(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(node)?.[1] ?? ''),
    attrs,
  };
}

function indexRows(xml) {
  const rows = new Map();
  const matcher = /<row\b[^>]*>[\s\S]*?<\/row>/g;
  let match;
  while ((match = matcher.exec(xml))) {
    const row = Number(attributes(/^<row\b[^>]*>/.exec(match[0])?.[0] || '').r);
    if (Number.isInteger(row) && row > 0) rows.set(row, match[0]);
  }
  return rows;
}

function parseRowCells(xml, sharedStrings) {
  const cells = new Map();
  if (!xml) return cells;
  const matcher = /<c(?=\s)[^>]*\/>|<c(?=\s)[^>]*>[\s\S]*?<\/c>/g;
  let match;
  while ((match = matcher.exec(xml))) {
    const item = readCellNode(match[0], sharedStrings);
    if (item.attrs.r) cells.set(item.attrs.r, { ...item, node: match[0], index: match.index, length: match[0].length });
  }
  return cells;
}

function createSheetReader(sheet, sharedStrings) {
  const rows = indexRows(sheet.xml);
  const parsedRows = new Map();
  return {
    cell(reference) {
      const parsed = parseCellRef(reference);
      if (!parsedRows.has(parsed.row)) parsedRows.set(parsed.row, parseRowCells(rows.get(parsed.row), sharedStrings));
      return parsedRows.get(parsed.row).get(reference);
    },
    cellsAt(row) {
      if (!parsedRows.has(row)) parsedRows.set(row, parseRowCells(rows.get(row), sharedStrings));
      return parsedRows.get(row);
    },
    cellsBetween(start, end) {
      const cells = new Map();
      for (let row = start; row <= end; row += 1) {
        for (const [reference, value] of this.cellsAt(row)) cells.set(reference, value);
      }
      return cells;
    },
  };
}

function label(value) {
  return String(value || '').replace(/[\s\r\n]+/g, '').trim();
}

function directBackendReference(formula, backendSheet) {
  const escaped = backendSheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`(?:'${escaped}'|${escaped})!\\$?([A-Z]+)\\$?4`, 'i');
  return matcher.exec(formula)?.[1] || null;
}

function ledgerRange(formula, column) {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`SUM\\(\\$?${escaped}\\$?(\\d+):\\$?${escaped}\\$?(\\d+)\\)`, 'i');
  const match = matcher.exec(formula || '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start < end ? { start, end } : null;
}

function deriveMacauSchema(workbook) {
  const summary = workbook.sheets.get('总汇');
  const backend = workbook.sheets.get('后台');
  if (!summary || !backend) throw new Error('当前模板不符合“澳门娱乐城”模板结构（缺少“总汇”或“后台”工作表）');
  const summaryReader = createSheetReader(summary, workbook.sharedStrings);
  const backendReader = createSheetReader(backend, workbook.sharedStrings);
  const summaryCells = summaryReader.cellsBetween(1, 120);
  const backendCells = backendReader.cellsBetween(4, 5);
  const channels = [];
  const seenColumns = new Set();
  const defaultLedgerRange = [...backendCells.entries()]
    .map(([reference, entry]) => ledgerRange(entry.formula, parseCellRef(reference).column))
    .find(Boolean);

  for (const [reference, entry] of summaryCells) {
    const parsed = parseCellRef(reference);
    if (parsed.column !== 'C' || parsed.row < 5) continue;
    const name = String(entry.value || '').trim();
    if (!name || /^\d+(?:\.\d+)?$/.test(name)) continue;

    let baseColumn = null;
    for (let offset = 0; offset < 10; offset += 1) {
      const candidate = summaryCells.get(cellRef(numberToColumn(columnToNumber('D') + offset), parsed.row));
      const sourceColumn = candidate ? directBackendReference(candidate.formula, '后台') : null;
      if (sourceColumn && label(backendCells.get(cellRef(sourceColumn, 5))?.value) === '会员充值') {
        baseColumn = sourceColumn;
        break;
      }
    }
    if (!baseColumn || seenColumns.has(baseColumn)) continue;
    const base = columnToNumber(baseColumn);
    const headers = ['会员充值', '未提交', '人工充值', '资金转出', '会员取款', '手续费', '余额'];
    if (!headers.every((expected, offset) => label(backendCells.get(cellRef(numberToColumn(base + offset), 5))?.value) === expected)) continue;
    const range = ledgerRange(backendCells.get(cellRef(baseColumn, 4))?.formula, baseColumn) || defaultLedgerRange;
    if (!range) continue;
    seenColumns.add(baseColumn);
    channels.push({
      id: `backend:${baseColumn}`,
      name,
      sheet: '后台',
      ledgerStart: range.start,
      ledgerEnd: range.end,
      needsFormulaRepair: !ledgerRange(backendCells.get(cellRef(baseColumn, 4))?.formula, baseColumn),
      columns: {
        recharge: baseColumn,
        pending: numberToColumn(base + 1),
        manualRecharge: numberToColumn(base + 2),
        transferOut: numberToColumn(base + 3),
        withdraw: numberToColumn(base + 4),
        fee: numberToColumn(base + 5),
        balance: numberToColumn(base + 6),
        note: numberToColumn(base + 7),
      },
    });
  }
  if (!channels.length) throw new Error('当前模板未识别到渠道汇总公式，不能安全自动填写');
  return { adapter: 'macau-channel-ledger-v1', displayName: '渠道日结账本', channels };
}

function getTemplateSchemaFromWorkbook(workbook) {
  return deriveMacauSchema(workbook);
}

async function getTemplateSchema(buffer) {
  return getTemplateSchemaFromWorkbook(await loadWorkbook(buffer));
}

function isEmptyInput(cell) {
  if (!cell || cell.formula) return true;
  return String(cell.value || '').trim() === '' || String(cell.value || '').trim() === '0';
}

function hasReportData(channel) {
  return [
    channel.rechargeAmount,
    channel.pendingAmount,
    channel.manualRechargeAmount,
    channel.transferOutAmount,
    channel.withdrawAmount,
    channel.feeAmount,
  ].some(value => value !== '0') || Boolean(channel.note);
}

function findWritableRow(reader, channel) {
  const inputs = [channel.adapter.columns.recharge, channel.adapter.columns.pending, channel.adapter.columns.manualRecharge,
    channel.adapter.columns.transferOut, channel.adapter.columns.withdraw, channel.adapter.columns.fee, channel.adapter.columns.note];
  for (let row = channel.adapter.ledgerStart; row <= channel.adapter.ledgerEnd; row += 1) {
    const cells = reader.cellsAt(row);
    if (inputs.every(column => isEmptyInput(cells.get(cellRef(column, row))))) return row;
  }
  return null;
}

function activeWrites(channel, row) {
  const columns = channel.adapter.columns;
  const values = [
    [columns.recharge, channel.rechargeAmount, 'number', '会员充值'],
    [columns.pending, channel.pendingAmount, 'number', '未提交'],
    [columns.manualRecharge, channel.manualRechargeAmount, 'number', '人工充值'],
    [columns.transferOut, channel.transferOutAmount, 'number', '资金转出'],
    [columns.withdraw, channel.withdrawAmount, 'number', '会员取款'],
    [columns.fee, channel.feeAmount, 'number', '手续费'],
    [columns.note, channel.note, 'text', '备注'],
  ];
  return values
    .filter(([, value]) => String(value || '') !== '' && String(value || '') !== '0')
    .map(([column, value, type, name]) => ({ cell: cellRef(column, row), value, type, name }));
}

function buildWritePlan(workbook, report) {
  const schema = getTemplateSchemaFromWorkbook(workbook);
  const backend = workbook.sheets.get('后台');
  const reader = createSheetReader(backend, workbook.sharedStrings);
  const issues = [];
  const writes = [];
  const formulaWrites = [];
  for (const reportChannel of report.channels) {
    if (!hasReportData(reportChannel)) continue;
    const channel = schema.channels.find(item => item.id === reportChannel.id && item.name === reportChannel.name);
    if (!channel) {
      issues.push(`渠道“${reportChannel.name}”与当前模板不一致，请重新预览`);
      continue;
    }
    const attached = { ...reportChannel, adapter: channel };
    const row = findWritableRow(reader, attached);
    if (!row) {
      issues.push(`渠道“${attached.name}”没有可用的账本行`);
      continue;
    }
    for (const write of activeWrites(attached, row)) {
      if (reader.cell(write.cell)?.formula) issues.push(`渠道“${attached.name}”的${write.name}输入位置含公式，不能覆盖`);
      else writes.push({ sheet: '后台', ...write });
    }
    if (channel.needsFormulaRepair) formulaWrites.push(...formulaRepairs(channel));
  }
  return { schema, issues: [...new Set(issues)], writes, formulaWrites };
}

function formulaRepairs(channel) {
  const { columns, ledgerStart, ledgerEnd } = channel;
  const sumFormula = column => `SUM(${column}${ledgerStart}:${column}${ledgerEnd})`;
  return [
    { sheet: '后台', cell: cellRef(columns.recharge, 4), formula: sumFormula(columns.recharge), type: 'formula' },
    { sheet: '后台', cell: cellRef(columns.pending, 4), formula: sumFormula(columns.pending), type: 'formula' },
    { sheet: '后台', cell: cellRef(columns.manualRecharge, 4), formula: sumFormula(columns.manualRecharge), type: 'formula' },
    { sheet: '后台', cell: cellRef(columns.transferOut, 4), formula: sumFormula(columns.transferOut), type: 'formula' },
    { sheet: '后台', cell: cellRef(columns.withdraw, 4), formula: sumFormula(columns.withdraw), type: 'formula' },
    { sheet: '后台', cell: cellRef(columns.fee, 4), formula: sumFormula(columns.fee), type: 'formula' },
    {
      sheet: '后台',
      cell: cellRef(columns.balance, 4),
      formula: `${columns.balance}6-${columns.fee}4-${columns.withdraw}4-${columns.transferOut}4+${columns.manualRecharge}4+${columns.pending}4+${columns.recharge}4`,
      type: 'formula',
    },
  ];
}

function replacementCellNode(node, reference, value, type) {
  if (type !== 'formula' && /<f(?:\s|>)/.test(node)) throw new Error(`模板单元格 ${reference} 含有公式，不能覆盖`);
  const selfClosing = node.endsWith('/>');
  const opening = /^<c\b([^>]*)>/.exec(node);
  const rawAttributes = selfClosing ? node.slice(2, -2) : (opening ? opening[1] : '');
  const safeAttributes = rawAttributes.replace(/\s+t="[^"]*"/g, '');
  return type === 'text'
    ? `<c${safeAttributes} t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`
    : (type === 'formula'
      ? `<c${safeAttributes}><f>${escapeXml(value)}</f><v>0</v></c>`
      : `<c${safeAttributes}><v>${escapeXml(value)}</v></c>`);
}

function applyCellWrites(xml, writes) {
  const pending = new Map();
  for (const write of writes) {
    if (pending.has(write.cell)) throw new Error(`模板单元格 ${write.cell} 被重复写入`);
    pending.set(write.cell, write);
  }
  const matcher = /<c(?=\s)[^>]*\/>|<c(?=\s)[^>]*>[\s\S]*?<\/c>/g;
  let match;
  let cursor = 0;
  let output = '';
  while ((match = matcher.exec(xml))) {
    const node = match[0];
    const opening = /^<c\b[^>]*>/.exec(node);
    const reference = attributes(opening ? opening[0] : node).r;
    const write = pending.get(reference);
    if (!write) continue;
    output += xml.slice(cursor, match.index);
    output += replacementCellNode(node, reference, write.value ?? write.formula, write.type);
    cursor = match.index + node.length;
    pending.delete(reference);
  }
  if (pending.size) throw new Error(`模板缺少可写入单元格 ${[...pending.keys()].join('、')}`);
  return `${output}${xml.slice(cursor)}`;
}

function setCalculationMode(workbookXml) {
  const calcTag = /<calcPr\b([^>]*?)(\/?)>/.exec(workbookXml);
  if (calcTag) {
    const attributesWithoutMode = calcTag[1].replace(/\s+(?:calcMode|fullCalcOnLoad|forceFullCalc)="[^"]*"/g, '').trim();
    const replacement = `<calcPr${attributesWithoutMode ? ` ${attributesWithoutMode}` : ''} calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>`;
    return `${workbookXml.slice(0, calcTag.index)}${replacement}${workbookXml.slice(calcTag.index + calcTag[0].length)}`;
  }
  return workbookXml.replace('</workbook>', '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
}

function openingBalanceWrites(currentWorkbook, previousWorkbook, schema) {
  const writes = [];
  const currentReader = createSheetReader(currentWorkbook.sheets.get('后台'), currentWorkbook.sharedStrings);
  const previousReader = createSheetReader(previousWorkbook.sheets.get('后台'), previousWorkbook.sharedStrings);
  for (const channel of schema.channels) {
    const closing = previousReader.cell(cellRef(channel.columns.balance, 4));
    const openingRef = cellRef(channel.columns.balance, 6);
    if (!closing || !isNonNegativeDecimal(closing.value)) throw new Error(`上一日报表的渠道“${channel.name}”期末余额无效`);
    if (currentReader.cell(openingRef)?.formula) throw new Error(`模板渠道“${channel.name}”期初余额位置含公式，不能覆盖`);
    writes.push({ sheet: '后台', cell: openingRef, value: closing.value, type: 'number' });
  }
  return writes;
}

async function readWorkbookInfo(buffer) {
  const workbook = await loadWorkbook(buffer);
  const schema = getTemplateSchemaFromWorkbook(workbook);
  return {
    sheets: [...workbook.sheets.keys()],
    adapter: schema.adapter,
    displayName: schema.displayName,
    channels: schema.channels.map(channel => ({ id: channel.id, name: channel.name })),
  };
}

async function getExportIssues(templateBuffer, report, previousWorkbookBuffer) {
  try {
    const workbook = await loadWorkbook(templateBuffer);
    const plan = buildWritePlan(workbook, report);
    const issues = [...plan.issues];
    if (previousWorkbookBuffer) {
      const previous = await loadWorkbook(previousWorkbookBuffer);
      const previousSchema = getTemplateSchemaFromWorkbook(previous);
      if (previousSchema.channels.length !== plan.schema.channels.length) issues.push('上一日报表的渠道结构与当前模板不一致');
      else openingBalanceWrites(workbook, previous, plan.schema);
    }
    return issues;
  } catch (error) {
    return [error.message];
  }
}

async function buildOutputWorkbook(templateBuffer, report, previousWorkbookBuffer) {
  const workbook = await loadWorkbook(templateBuffer);
  const plan = buildWritePlan(workbook, report);
  if (plan.issues.length) throw new Error(plan.issues.join('；'));
  const writes = [...plan.formulaWrites, ...plan.writes];
  if (previousWorkbookBuffer) writes.push(...openingBalanceWrites(workbook, await loadWorkbook(previousWorkbookBuffer), plan.schema));
  const bySheet = new Map();
  for (const write of writes) {
    if (!bySheet.has(write.sheet)) bySheet.set(write.sheet, []);
    bySheet.get(write.sheet).push(write);
  }
  for (const [sheetName, sheetWrites] of bySheet) {
    const sheet = workbook.sheets.get(sheetName);
    const xml = applyCellWrites(sheet.xml, sheetWrites);
    sheet.xml = xml;
    workbook.zip.file(sheet.filename, xml);
  }
  workbook.zip.file('xl/workbook.xml', setCalculationMode(workbook.workbookXml));
  return workbook.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } });
}

module.exports = { buildOutputWorkbook, getExportIssues, getTemplateSchema, readWorkbookInfo };
