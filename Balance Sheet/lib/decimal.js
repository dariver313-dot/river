'use strict';

function parseDecimal(value, field = '金额') {
  const text = String(value ?? '').trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`${field}必须是十进制数字`);
  const [, sign, integerText, fraction = ''] = match;
  const integer = integerText.replace(/^0+(?=\d)/, '') || '0';
  return { sign: sign === '-' ? -1n : 1n, integer, fraction };
}

function isNonNegativeDecimal(value) {
  try {
    return parseDecimal(value).sign >= 0n;
  } catch {
    return false;
  }
}

function toScaled(value, scale, field) {
  const parsed = parseDecimal(value, field);
  const digits = `${parsed.integer}${(parsed.fraction + '0'.repeat(scale)).slice(0, scale)}`;
  return parsed.sign * BigInt(digits || '0');
}

function formatScaled(value, scale) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const integer = (absolute / divisor).toString();
  const fraction = (absolute % divisor).toString().padStart(scale, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

function sumDecimals(values) {
  if (!values.length) return '0';
  const parsed = values.map(value => parseDecimal(value));
  const scale = Math.max(0, ...parsed.map(value => value.fraction.length));
  const total = parsed.reduce((sum, value) => {
    const scaled = BigInt(`${value.integer}${(value.fraction + '0'.repeat(scale)).slice(0, scale)}`);
    return sum + value.sign * scaled;
  }, 0n);
  return formatScaled(total, scale);
}

function calculateFee(amount, rule) {
  const safeRule = rule || { mode: 'none', fixed: '0', percent: '0' };
  if (safeRule.mode === 'none' || safeRule.mode === 'manual') return '0';
  const fixed = safeRule.mode === 'fixed' || safeRule.mode === 'fixed_plus_percent'
    ? String(safeRule.fixed || '0')
    : '0';
  const percent = safeRule.mode === 'percent' || safeRule.mode === 'fixed_plus_percent'
    ? String(safeRule.percent || '0')
    : '0';
  if (!isNonNegativeDecimal(fixed) || !isNonNegativeDecimal(percent)) throw new Error('手续费规则必须为非负数字');
  if (percent === '0' || percent === '0.0') return fixed;

  const a = parseDecimal(amount, '订单金额');
  const b = parseDecimal(percent, '手续费比例');
  if (a.sign < 0n || b.sign < 0n) throw new Error('手续费规则不能为负数');
  const numerator = BigInt(`${a.integer}${a.fraction}`) * BigInt(`${b.integer}${b.fraction}`);
  const denominator = 10n ** BigInt(a.fraction.length + b.fraction.length) * 100n;
  // 手续费统一按分四舍五入；固定费用再精确相加。
  const cents = (numerator * 100n + denominator / 2n) / denominator;
  return sumDecimals([fixed, formatScaled(cents, 2)]);
}

module.exports = { calculateFee, isNonNegativeDecimal, parseDecimal, sumDecimals };
