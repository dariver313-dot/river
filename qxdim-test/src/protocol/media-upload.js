/**
 * 媒体文件上传到 OSS (MinIO/S3 兼容)
 *
 * 企讯达用 MinIO 作为对象存储，凭据来自 companyInfo:
 *   - proxyServerAccount: accessKey (如 "<your_oss_access_key>")
 *   - proxyServerPass: secretKey (如 "<your_oss_secret_key>")
 *   - OSS endpoint: 从 portrait URL 提取 (如 https://47.119.150.45:9443)
 *   - bucket: qxd-<companyCode> (如 "qxd-<your_company_code>")
 *
 * 上传路径模式: <userId>-<mediaType>-<timestamp>-<random>.<ext>
 *   mediaType: 1=图片, 2=语音, 3=视频, 4=文件, 5=头像
 *
 * 用 AWS Signature V4 签名（MinIO 强制要求）
 */

import crypto from 'crypto';
import https from 'https';
import { URL } from 'url';
import zlib from 'zlib';
import { insecureHttpsAgent } from '../utils/http.js';
import { logger } from '../utils/logger.js';

/** 媒体类型编号 */
export const MediaType = {
  General: 0,
  Image: 1,
  Voice: 2,
  Video: 3,
  File: 4,
  Portrait: 5,
};

/** 扩展名 → mediaType 映射 */
const EXT_TO_MEDIA_TYPE = {
  '.jpg': MediaType.Image, '.jpeg': MediaType.Image, '.png': MediaType.Image,
  '.gif': MediaType.Image, '.webp': MediaType.Image, '.bmp': MediaType.Image,
  '.mp4': MediaType.Video, '.mov': MediaType.Video, '.avi': MediaType.Video,
  '.mkv': MediaType.Video, '.webm': MediaType.Video,
  '.mp3': MediaType.Voice, '.aac': MediaType.Voice, '.wav': MediaType.Voice,
  '.m4a': MediaType.Voice, '.amr': MediaType.Voice,
  '.pdf': MediaType.File, '.doc': MediaType.File, '.docx': MediaType.File,
  '.xls': MediaType.File, '.xlsx': MediaType.File, '.ppt': MediaType.File, '.pptx': MediaType.File,
  '.zip': MediaType.File, '.rar': MediaType.File, '.7z': MediaType.File,
  '.txt': MediaType.File, '.csv': MediaType.File,
};

/**
 * 从 portrait URL 提取 OSS endpoint
 * portrait 形如: https://47.119.150.45:9443/qxd-<your_company_code>/xxx.jpg
 * @returns {string|null} endpoint 如 "https://47.119.150.45:9443"
 */
export function extractOssEndpoint(portraitUrl) {
  if (!portraitUrl) return null;
  try {
    const u = new URL(portraitUrl);
    return `${u.protocol}//${u.host}`;
  } catch (e) { return null; }
}

/**
 * 从 portrait URL 提取 OSS bucket
 * portrait 形如: https://47.119.150.45:9443/qxd-<your_company_code>/xxx.jpg
 * @returns {string|null} bucket 如 "qxd-<your_company_code>"
 */
export function extractOssBucket(portraitUrl, companyCode) {
  // 默认 bucket 名: qxd-<companyCode>
  if (companyCode) return `qxd-${companyCode}`;
  if (!portraitUrl) return null;
  try {
    const u = new URL(portraitUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] || null;
  } catch (e) { return null; }
}

/**
 * 根据文件扩展名推断 mediaType
 */
export function inferMediaType(fileName) {
  const ext = (fileName || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return EXT_TO_MEDIA_TYPE[ext] ?? MediaType.File;
}

/**
 * 生成 OSS object key
 * 格式: <userId>-<mediaType>-<timestamp>-<random>.<ext>
 * @param {string} userId
 * @param {number} mediaType
 * @param {string} fileName - 用于提取扩展名
 * @returns {string}
 */
export function generateObjectKey(userId, mediaType, fileName) {
  const ext = (fileName || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  const timestamp = Date.now();
  // ★ 用 crypto.randomBytes 替代 Math.random()，防止 object key 被枚举
  //   Math.random() 仅 27 位熵（1 亿种），userId/timestamp 可推测，攻击者可穷举他人文件
  const random = crypto.randomBytes(8).toString('hex');
  return `${userId}-${mediaType}-${timestamp}-${random}${ext}`;
}

// ==================== AWS Signature V4 ====================

/** 计算 SHA256 hex */
function sha256(data, encoding = 'hex') {
  return crypto.createHash('sha256').update(data).digest(encoding);
}

/** HMAC SHA256 */
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * 生成 AWS Signature V4 签名 (STREAMING-UNSIGNED-PAYLOAD-TRAILER 模式)
 *
 * ★ MinIO/S3 兼容服务器要求 chunked transfer + CRC32 trailer
 *   签名时 content-sha256 = "STREAMING-UNSIGNED-PAYLOAD-TRAILER"
 *   body 用 aws-chunked 编码: <hex_size>\r\n<data>\r\n0\r\n<trailer>\r\n
 *
 * @returns {{authorization: string, date: string, contentSha256: string, chunkedBody: Buffer, crc32Base64: string}}
 */
function signV4(method, url, bucket, objectKey, accessKey, secretKey, region, payload) {
  const host = new URL(url).host;
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = dateStamp + 'T' + now.toISOString().slice(11, 19).replace(/:/g, '') + 'Z';

  // CRC32 计算
  const crc32Val = crc32(payload);
  const crc32Base64 = Buffer.from([
    (crc32Val >>> 24) & 0xff,
    (crc32Val >>> 16) & 0xff,
    (crc32Val >>> 8) & 0xff,
    crc32Val & 0xff,
  ]).toString('base64');

  // aws-chunked body: <hex_size>\r\n<data>\r\n0\r\n<trailer>\r\n
  const chunkHeader = `${payload.length.toString(16)}\r\n`;
  const chunkFooter = '\r\n';
  const lastChunk = '0\r\n';
  const trailer = `x-amz-checksum-crc32:${crc32Base64}\r\n`;
  const finalCrlf = '\r\n';
  // ★ 不再构造完整 chunkedBody 副本，改为分段写入避免大文件内存翻倍
  //   chunkedBodyLength 用于 Content-Length，chunkParts 用于分段 req.write
  const chunkedBodyLength =
    Buffer.byteLength(chunkHeader) + payload.length + Buffer.byteLength(chunkFooter) +
    Buffer.byteLength(lastChunk) + Buffer.byteLength(trailer) + Buffer.byteLength(finalCrlf);
  const chunkParts = [
    Buffer.from(chunkHeader),
    Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
    Buffer.from(chunkFooter + lastChunk + trailer + finalCrlf),
  ];

  const contentSha256 = 'STREAMING-UNSIGNED-PAYLOAD-TRAILER';
  const decodedLength = payload.length;

  // Canonical request
  const canonicalUri = `/${bucket}/${objectKey}`;
  const canonicalHeaders =
    `content-encoding:aws-chunked\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${contentSha256}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-decoded-content-length:${decodedLength}\n` +
    `x-amz-sdk-checksum-algorithm:CRC32\n` +
    `x-amz-trailer:x-amz-checksum-crc32\n`;
  const signedHeaders = 'content-encoding;host;x-amz-content-sha256;x-amz-date;x-amz-decoded-content-length;x-amz-sdk-checksum-algorithm;x-amz-trailer';
  const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${contentSha256}`;

  // String to sign
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;

  // Signing key
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, date: amzDate, contentSha256, chunkedBodyLength, chunkParts, crc32Base64 };
}

/** CRC32 计算 (IEEE 802.3) */
function crc32(buf) {
  // 用 Node.js zlib 的 crc32 (Node 20+)
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }

  // 手动实现
  let crc = 0xffffffff;
  const table = crc32Table();
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let _crc32Table = null;
function crc32Table() {
  if (_crc32Table) return _crc32Table;
  _crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    _crc32Table[i] = c >>> 0;
  }
  return _crc32Table;
}

/**
 * 上传文件到 OSS
 *
 * @param {object} options
 * @param {string} options.endpoint - OSS endpoint (如 "https://47.119.150.45:9443")
 * @param {string} options.bucket - bucket 名 (如 "qxd-<your_company_code>")
 * @param {string} options.accessKey - accessKey (proxyServerAccount)
 * @param {string} options.secretKey - secretKey (proxyServerPass)
 * @param {string} options.userId - 用户 ID (用于 object key 前缀)
 * @param {number} options.mediaType - MediaType
 * @param {string} options.fileName - 文件名 (用于扩展名)
 * @param {Buffer|Uint8Array} options.data - 文件内容
 * @param {string} [options.region='us-east-1'] - S3 region
 * @returns {Promise<{url: string, objectKey: string, size: number}>}
 */
export async function uploadMedia(options) {
  const {
    endpoint, bucket, accessKey, secretKey,
    userId, mediaType, fileName, data,
    region = 'us-east-1',
  } = options;

  if (!endpoint || !bucket || !accessKey || !secretKey || !userId || !data) {
    throw new Error('[MediaUpload] 缺少必要参数');
  }

  const objectKey = generateObjectKey(userId, mediaType, fileName);
  const url = `${endpoint}/${bucket}/${objectKey}`;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);

  logger.debug(`[MediaUpload] 上传 ${fileName} (${payload.length} bytes) → ${bucket}/${objectKey}`);

  // 签名（STREAMING-UNSIGNED-PAYLOAD-TRAILER 模式，含 chunked body）
  const { authorization, date, contentSha256, chunkedBodyLength, chunkParts } = signV4(
    'PUT', url, bucket, objectKey, accessKey, secretKey, region, payload
  );

  // 发送 PUT 请求
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err) => { if (settled) return; settled = true; reject(err); };
    const safeResolve = (val) => { if (settled) return; settled = true; resolve(val); };

    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'PUT',
      headers: {
        'Host': u.host,
        'Authorization': authorization,
        'Content-Encoding': 'aws-chunked',
        'x-amz-content-sha256': contentSha256,
        'x-amz-date': date,
        'x-amz-decoded-content-length': String(payload.length),
        'x-amz-sdk-checksum-algorithm': 'CRC32',
        'X-Amz-Trailer': 'x-amz-checksum-crc32',
        'Content-Length': chunkedBodyLength,
      },
      agent: insecureHttpsAgent,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      // ★ 监听响应流 error，防止 Promise 挂起
      res.on('error', safeReject);
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode === 200) {
          const publicUrl = `${endpoint}/${bucket}/${objectKey}`;
          logger.debug(`[MediaUpload] ✅ 上传成功: ${publicUrl}`);
          safeResolve({ url: publicUrl, objectKey, size: payload.length });
        } else {
          safeReject(new Error(`[MediaUpload] 上传失败 HTTP ${res.statusCode}: ${body.substring(0, 300)}`));
        }
      });
    });
    req.on('error', safeReject);
    req.setTimeout(30000, () => {
      req.destroy();
      safeReject(new Error('[MediaUpload] 上传超时 (30s)'));
    });
    // ★ 分段写入，避免构造完整 chunkedBody 副本（大文件内存减半）
    for (const part of chunkParts) {
      req.write(part);
    }
    req.end();
  });
}

/**
 * ★ 一键上传 - 从 connectParams + companyInfo 自动提取所有参数
 *
 * @param {object} connectParams - autoLogin 返回的 connectParams
 * @param {Buffer|Uint8Array} data - 文件内容
 * @param {string} fileName - 文件名
 * @param {number} [mediaType] - 不传则从文件名推断
 * @returns {Promise<{url: string, objectKey: string, size: number, mediaType: number}>}
 */
export async function uploadFromConnectParams(connectParams, data, fileName, mediaType) {
  const companyInfo = connectParams.companyInfo;
  if (!companyInfo) {
    throw new Error('[MediaUpload] connectParams.companyInfo 为空，请用完整流程登录');
  }

  const endpoint = extractOssEndpoint(connectParams.loginResult?.portrait);
  if (!endpoint) {
    throw new Error('[MediaUpload] 无法从 portrait URL 提取 OSS endpoint');
  }

  const bucket = extractOssBucket(connectParams.loginResult?.portrait, connectParams.companyCode);
  if (!bucket) {
    throw new Error('[MediaUpload] 无法确定 bucket 名');
  }

  const finalMediaType = mediaType ?? inferMediaType(fileName);

  const result = await uploadMedia({
    endpoint,
    bucket,
    accessKey: companyInfo.proxyServerAccount,
    secretKey: companyInfo.proxyServerPass,
    userId: connectParams.userId,
    mediaType: finalMediaType,
    fileName,
    data,
  });

  return { ...result, mediaType: finalMediaType };
}

export default {
  MediaType,
  extractOssEndpoint,
  extractOssBucket,
  inferMediaType,
  generateObjectKey,
  uploadMedia,
  uploadFromConnectParams,
};
