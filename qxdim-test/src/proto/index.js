/**
 * Protobuf 消息类型加载与编解码
 * 使用 protobufjs 动态加载 .proto 文件
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let root = null;
let types = {};
/** 并发保护：initProto 进行中的 Promise，避免重复加载 .proto 文件 */
let initPromise = null;

/**
 * 初始化 Protobuf 类型系统
 * 加载 .proto 文件并缓存所有消息类型
 * 并发安全：多次调用返回同一个 Promise
 */
export async function initProto() {
  // 已初始化完成
  if (root) return root;
  // 正在初始化中，复用同一个 Promise
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // ★ 延迟加载 protobufjs（~1MB），首次 initProto 时才加载，减少冷启动开销
    const protobuf = (await import('protobufjs')).default;
    // proto 文件位于项目根 proto/qxdim.proto
    // src/proto/index.js → ../../proto/qxdim.proto
    const protoPath = path.join(__dirname, '..', '..', 'proto', 'qxdim.proto');
    logger.debug('[Proto] 加载协议定义:', protoPath);

    root = await protobuf.load(protoPath);

    // 预加载常用消息类型
    const typeNames = [
      'qxdim.IMHttpWrapper',
      'qxdim.RouteRequest',
      'qxdim.RouteResponse',
      'qxdim.AddressTriple',
      'qxdim.ConnectAckPayload',
      'qxdim.Conversation',
      'qxdim.MessageContent',
      'qxdim.Message',
      'qxdim.NotifyMessage',
      'qxdim.NotifyGroupMessage',
      'qxdim.PullMessageRequest',
      'qxdim.PullMessageResult',
      'qxdim.GeneralResult',
    ];

    for (const name of typeNames) {
      // lookupType 找不到类型时会抛错，无需 null 检查
      types[name] = root.lookupType(name);
    }

    logger.debug(`[Proto] 已加载 ${Object.keys(types).filter(k => types[k]).length} 个消息类型`);
    return root;
  })();

  try {
    return await initPromise;
  } catch (e) {
    // 初始化失败，重置以便重试
    initPromise = null;
    root = null;
    throw e;
  }
}

/**
 * 获取消息类型
 * @param {string} typeName - 完整类型名 (如 "qxdim.Message")
 * @returns {protobuf.Type}
 */
export function getType(typeName) {
  if (!types[typeName] && root) {
    types[typeName] = root.lookupType(typeName);
  }
  if (!types[typeName]) {
    throw new Error(`[Proto] 未找到消息类型: ${typeName}`);
  }
  return types[typeName];
}

/**
 * 编码消息为 Uint8Array
 * @param {string} typeName - 消息类型名
 * @param {object} payload - 消息数据
 * @returns {Uint8Array}
 */
export function encode(typeName, payload) {
  const Type = getType(typeName);
  const errMsg = Type.verify(payload);
  if (errMsg) {
    throw new Error(`[Proto] 编码验证失败 (${typeName}): ${errMsg}`);
  }
  const message = Type.create(payload);
  return Type.encode(message).finish();
}

/**
 * 解码 Uint8Array 为消息对象
 * @param {string} typeName - 消息类型名
 * @param {Uint8Array|Buffer} buffer - 编码数据
 * @returns {object}
 */
export function decode(typeName, buffer) {
  const Type = getType(typeName);
  return Type.decode(buffer);
}

/**
 * 将 Protobuf 消息转为纯 JSON 对象（含 Long 转 String）
 * @param {object} message - Protobuf 解码后的消息
 * @returns {object}
 */
/**
 * 将 Protobuf 消息转为纯 JSON 对象（含 Long 转 String）
 * @param {object} message - Protobuf 解码后的消息
 * @param {object} [options]
 * @param {boolean} [options.defaults=true] - 是否包含默认值字段（设为 false 可减少 50%+ 对象大小）
 * @returns {object}
 */
export function toJSON(message, options = {}) {
  if (!message) return null;
  const { defaults = true } = options;
  // protobufjs v7: use Type.toObject on the message's constructor
  const Type = message.constructor;
  if (Type && Type.toObject) {
    return Type.toObject(message, {
      longs: String,
      enums: String,
      bytes: String,
      defaults,
    });
  }
  // Fallback: manual conversion
  return JSON.parse(JSON.stringify(message, (key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value && value.type === 'Buffer') return Buffer.from(value.data).toString('base64');
    return value;
  }));
}

export default { initProto, getType, encode, decode, toJSON };
