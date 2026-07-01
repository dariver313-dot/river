/**
 * 输入校验工具 — 所有协议模块共用的参数验证
 */

/**
 * 断言值非空（非 null、非 undefined、非空字符串）
 * @param {*} value
 * @param {string} name - 参数名（用于错误消息）
 * @throws {Error}
 */
export function assertNonEmpty(value, name) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    throw new Error(`[Validate] ${name} 不能为空`);
  }
}

/**
 * 断言值为字符串类型
 * @param {*} value
 * @param {string} name
 * @throws {Error}
 */
export function assertString(value, name) {
  if (typeof value !== 'string') {
    throw new Error(`[Validate] ${name} 必须是字符串，收到 ${typeof value}`);
  }
}

/**
 * 断言值为有效 URL（http/https）
 * @param {string} url
 * @param {string} name
 * @throws {Error}
 */
export function assertValidUrl(url, name) {
  assertNonEmpty(url, name);
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`协议必须是 http 或 https`);
    }
  } catch (e) {
    throw new Error(`[Validate] ${name} 不是有效的 URL: ${url} (${e.message})`);
  }
}

/**
 * 断言值为数字且在指定范围内
 * @param {*} value
 * @param {string} name
 * @param {number} [min]
 * @param {number} [max]
 * @throws {Error}
 */
export function assertNumber(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`[Validate] ${name} 必须是有效数字，收到 ${value}`);
  }
  if (min != null && value < min) {
    throw new Error(`[Validate] ${name} 不能小于 ${min}，收到 ${value}`);
  }
  if (max != null && value > max) {
    throw new Error(`[Validate] ${name} 不能大于 ${max}，收到 ${value}`);
  }
}

/**
 * 断言值为整数且在指定范围内
 * @param {*} value
 * @param {string} name
 * @param {number} [min]
 * @param {number} [max]
 * @throws {Error}
 */
export function assertInt(value, name, min, max) {
  assertNumber(value, name, min, max);
  if (!Number.isInteger(value)) {
    throw new Error(`[Validate] ${name} 必须是整数，收到 ${value}`);
  }
}

/**
 * 断言值为 Buffer 或 Uint8Array
 * @param {*} value
 * @param {string} name
 * @throws {Error}
 */
export function assertBufferLike(value, name) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`[Validate] ${name} 必须是 Buffer 或 Uint8Array，收到 ${typeof value}`);
  }
}

/**
 * 断言对象包含指定必需字段
 * @param {object} obj
 * @param {string[]} fields
 * @param {string} [objName='options']
 * @throws {Error}
 */
export function assertRequiredFields(obj, fields, objName = 'options') {
  if (!obj || typeof obj !== 'object') {
    throw new Error(`[Validate] ${objName} 必须是对象`);
  }
  for (const field of fields) {
    if (obj[field] == null || (typeof obj[field] === 'string' && obj[field].trim() === '')) {
      throw new Error(`[Validate] ${objName}.${field} 不能为空`);
    }
  }
}

export default {
  assertNonEmpty,
  assertString,
  assertValidUrl,
  assertNumber,
  assertInt,
  assertBufferLike,
  assertRequiredFields,
};
