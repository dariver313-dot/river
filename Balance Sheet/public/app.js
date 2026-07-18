'use strict';

const state = { config: null, templates: [], template: null, report: null, reportId: null, adjustments: [] };
const $ = selector => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(number) : String(value || '0');
}

function defaultSetting(name) {
  return { rechargeNames: name, withdrawNames: name, rechargeRate: '0', rechargeFixed: '0', withdrawRate: '0', withdrawFixed: '0', note: '' };
}

function currentBeijingDate() {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) throw new Error(payload.error || '请求失败');
  return payload.data;
}

function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), 4200);
}

function switchView(name) {
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('active', button.dataset.view === name);
  $('#reportView').classList.toggle('hidden', name !== 'report');
  $('#settingsView').classList.toggle('hidden', name !== 'settings');
}

function adoptConfig(data) {
  state.config = data.config;
  state.templates = data.templates;
  state.template = data.template;
  $('#connectionState').textContent = `模板已识别 · ${state.template.channels.length} 个渠道`;
  $('#templateName').textContent = `${state.template.displayName} · ${state.template.channels.length} 个渠道`;
  $('#templateFile').innerHTML = state.templates.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  $('#templateFile').value = state.config.templateFile;
  $('#pageSize').value = String(state.config.pageSize);
  renderChannelSettings();
  renderAdjustments();
}

function renderChannelSettings() {
  const settings = state.config.channelSettings || {};
  $('#channelSettings').innerHTML = state.template.channels.map(channel => {
    const setting = { ...defaultSetting(channel.name), ...(settings[channel.name] || {}) };
    return `<tr data-channel="${escapeHtml(channel.name)}">
      <td><strong>${escapeHtml(channel.name)}</strong></td>
      <td><input data-field="rechargeNames" value="${escapeHtml(setting.rechargeNames)}" maxlength="500"></td>
      <td><input data-field="rechargeRate" value="${escapeHtml(setting.rechargeRate)}" inputmode="decimal"></td>
      <td><input data-field="rechargeFixed" value="${escapeHtml(setting.rechargeFixed)}" inputmode="decimal"></td>
      <td><input data-field="withdrawNames" value="${escapeHtml(setting.withdrawNames)}" maxlength="500"></td>
      <td><input data-field="withdrawRate" value="${escapeHtml(setting.withdrawRate)}" inputmode="decimal"></td>
      <td><input data-field="withdrawFixed" value="${escapeHtml(setting.withdrawFixed)}" inputmode="decimal"></td>
      <td><input data-field="note" value="${escapeHtml(setting.note)}" maxlength="300"></td>
    </tr>`;
  }).join('');
}

function channelSettingsFromTable() {
  const channelSettings = {};
  for (const row of $('#channelSettings').querySelectorAll('tr[data-channel]')) {
    const name = row.dataset.channel;
    const values = Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value.trim()]));
    channelSettings[name] = values;
  }
  return channelSettings;
}

async function saveSettings(message) {
  const next = {
    ...state.config,
    templateFile: $('#templateFile').value,
    pageSize: Number($('#pageSize').value),
    channelSettings: channelSettingsFromTable(),
  };
  adoptConfig(await api('/api/config', { method: 'PUT', body: JSON.stringify(next) }));
  if (message) toast(message);
}

function renderAdjustments() {
  const select = $('#adjustmentChannel');
  select.innerHTML = state.template ? state.template.channels.map(channel => `<option value="${escapeHtml(channel.id)}">${escapeHtml(channel.name)}</option>`).join('') : '';
  const byId = new Map((state.template?.channels || []).map(channel => [channel.id, channel.name]));
  $('#adjustmentEntries').innerHTML = state.adjustments.length ? state.adjustments.map((entry, index) => `<div class="adjustment-entry"><span>${escapeHtml(byId.get(entry.channelId) || entry.channelId)}：未提交 ${money(entry.pendingAmount)}，人工充值 ${money(entry.manualRechargeAmount)}，资金转出 ${money(entry.transferOutAmount)}${entry.note ? `，${escapeHtml(entry.note)}` : ''}</span><button type="button" data-adjustment-index="${index}">删除</button></div>`).join('') : '<p>本次报表尚无补录。</p>';
  for (const button of $('#adjustmentEntries').querySelectorAll('[data-adjustment-index]')) button.addEventListener('click', () => {
    state.adjustments.splice(Number(button.dataset.adjustmentIndex), 1);
    renderAdjustments();
  });
}

function fileToDataUri(file) {
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function renderReport(report) {
  state.report = report;
  state.reportId = report.reportId;
  $('#emptyState').classList.add('hidden');
  $('#reportResult').classList.remove('hidden');
  $('#rechargeTotal').textContent = money(report.totals.rechargeAmount);
  $('#rechargeCount').textContent = `${report.sourceTotals.recharge.totalNum} 笔`;
  $('#withdrawTotal').textContent = money(report.totals.withdrawAmount);
  $('#withdrawCount').textContent = `${report.sourceTotals.withdraw.totalNum} 笔`;
  $('#feeTotal').textContent = money(report.totals.feeAmount);
  $('#channelCount').textContent = `${report.channels.length} 个渠道`;
  const issueCount = report.unresolved.length + report.ambiguous.length + report.exportIssues.length;
  $('#reportStatus').textContent = report.canExport ? '可导出' : '待处理';
  $('#reportStatusDetail').textContent = report.canExport ? '订单与模板均已核对' : `${issueCount} 项需要处理`;
  $('#exportButton').disabled = !report.canExport;
  $('#reportChannels').innerHTML = report.channels.map(channel => {
    const manual = [channel.pendingAmount !== '0' ? `未提交 ${money(channel.pendingAmount)}` : '', channel.manualRechargeAmount !== '0' ? `人工充值 ${money(channel.manualRechargeAmount)}` : '', channel.transferOutAmount !== '0' ? `资金转出 ${money(channel.transferOutAmount)}` : ''].filter(Boolean).join(' / ');
    return `<tr><td><strong>${escapeHtml(channel.name)}</strong></td><td>${money(channel.rechargeAmount)} <small>${channel.rechargeCount} 笔</small></td><td>${money(channel.withdrawAmount)} <small>${channel.withdrawCount} 笔</small></td><td>${money(channel.feeAmount)}</td><td>${escapeHtml(manual || '—')}</td><td>${escapeHtml(channel.note || '—')}</td></tr>`;
  }).join('');
  const issues = [];
  for (const entry of report.unresolved) issues.push(`<div class="issue-line error">未匹配${entry.direction === 'recharge' ? '代收' : '代付'}渠道：${escapeHtml(entry.name)}，${entry.count} 笔，金额 ${money(entry.amount)}</div>`);
  for (const entry of report.ambiguous) issues.push(`<div class="issue-line conflict">重复匹配${entry.direction === 'recharge' ? '代收' : '代付'}渠道：${escapeHtml(entry.name)}，${entry.count} 笔，金额 ${money(entry.amount)}</div>`);
  for (const issue of report.exportIssues) issues.push(`<div class="issue-line error">模板写入校验：${escapeHtml(issue)}</div>`);
  $('#issuesSection').classList.toggle('hidden', !issues.length);
  $('#issuesList').innerHTML = issues.join('');
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) switchView(button.dataset.view);
});

$('#templateForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const file = $('#templateUpload').files[0];
    if (file) {
      await api('/api/templates', { method: 'POST', body: JSON.stringify({ filename: file.name, file: await fileToDataUri(file) }) });
      $('#templateUpload').value = '';
      adoptConfig(await api('/api/config'));
      toast('模板已导入并完成结构识别');
      return;
    }
    await saveSettings('模板设置已保存');
  } catch (error) { toast(error.message, true); }
});

$('#saveChannels').addEventListener('click', async () => {
  try { await saveSettings('渠道与费率已保存'); } catch (error) { toast(error.message, true); }
});

$('#manageAdjustments').addEventListener('click', () => { renderAdjustments(); $('#adjustmentDialog').showModal(); });
$('#closeAdjustmentDialog').addEventListener('click', () => $('#adjustmentDialog').close());
$('#finishAdjustments').addEventListener('click', () => $('#adjustmentDialog').close());
$('#addAdjustment').addEventListener('click', () => {
  state.adjustments.push({
    channelId: $('#adjustmentChannel').value,
    pendingAmount: $('#pendingAmount').value.trim(),
    manualRechargeAmount: $('#manualRechargeAmount').value.trim(),
    transferOutAmount: $('#transferOutAmount').value.trim(),
    note: $('#adjustmentNote').value.trim(),
  });
  $('#pendingAmount').value = '0';
  $('#manualRechargeAmount').value = '0';
  $('#transferOutAmount').value = '0';
  $('#adjustmentNote').value = '';
  renderAdjustments();
});

$('#reportForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    $('#previewButton').disabled = true;
    $('#previewButton').textContent = '正在查询';
    $('#exportButton').disabled = true;
    const report = await api('/api/report/preview', {
      method: 'POST',
      body: JSON.stringify({ date: $('#reportDate').value, previousWorkbook: await fileToDataUri($('#previousWorkbook').files[0]), adjustments: state.adjustments }),
    });
    renderReport(report);
    toast(report.canExport ? '订单与模板已核对，可导出' : '发现待处理问题，请先核对渠道设置');
  } catch (error) { toast(error.message, true); } finally {
    $('#previewButton').disabled = false;
    $('#previewButton').textContent = '查询并生成';
  }
});

$('#exportButton').addEventListener('click', async () => {
  try {
    $('#exportButton').disabled = true;
    const response = await fetch('/api/report/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reportId: state.reportId }) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || '导出失败');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const encoded = response.headers.get('content-disposition')?.match(/filename\*=UTF-8''(.+)/)?.[1];
    link.href = url;
    link.download = encoded ? decodeURIComponent(encoded) : `报表${$('#reportDate').value}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
    toast('Excel 已导出');
  } catch (error) { toast(error.message, true); } finally { $('#exportButton').disabled = !(state.report?.canExport); }
});

(async () => {
  try {
    $('#reportDate').value = currentBeijingDate();
    adoptConfig(await api('/api/config'));
  } catch (error) {
    $('#connectionState').textContent = '服务连接失败';
    toast(error.message, true);
  }
})();
