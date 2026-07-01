import crypto from 'crypto';

/**
 * DER 长度编码（ASN.1 definite form）
 * - 短格式（len < 0x80）：1 字节
 * - 长格式（len >= 0x80）：1 字节前缀 + N 字节长度值
 */
function derEncodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let remaining = len;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  if (bytes.length > 4) throw new Error(`DER 长度溢出: ${len}`);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/**
 * 登录密码加密：MD5 → RSA-2048 PKCS#1 v1.5 → Base64
 * 加密链路与前端 js-md5 + JSEncrypt 保持一致
 */
export function encryptPassword(password: string, publicKeyPem: string): string {
  const md5Hash = crypto.createHash('md5').update(password).digest('hex');

  let pem = publicKeyPem.trim();
  // 支持 PKCS#1 格式（-----BEGIN RSA PUBLIC KEY-----）→ 转换为 PKCS#8
  if (pem.includes('-----BEGIN RSA PUBLIC KEY-----')) {
    const b64 = pem.replace(/-----BEGIN RSA PUBLIC KEY-----/, '').replace(/-----END RSA PUBLIC KEY-----/, '').replace(/\s/g, '');
    const der = Buffer.from(b64, 'base64');
    // PKCS#1 → PKCS#8 包装：添加 SEQUENCE { algorithmIdentifier, BIT STRING }
    // algorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption) + NULL }
    const oid = Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
    const algoSeq = Buffer.concat([oid]);
    const algoLen = derEncodeLength(algoSeq.length);
    const algoFull = Buffer.concat([Buffer.from([0x30]), algoLen, algoSeq]);

    // BIT STRING: 0x00 (unused bits) + der
    const bitString = Buffer.concat([Buffer.from([0x00]), der]);
    const bitLen = derEncodeLength(bitString.length);
    const bitFull = Buffer.concat([Buffer.from([0x03]), bitLen, bitString]);

    const seqLen = derEncodeLength(algoFull.length + bitFull.length);
    const wrapped = Buffer.concat([Buffer.from([0x30]), seqLen, algoFull, bitFull]);
    pem = `-----BEGIN PUBLIC KEY-----\n${wrapped.toString('base64').match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
  } else if (!pem.includes('-----BEGIN PUBLIC KEY-----')) {
    // 裸 Base64 公钥，自动包装为 PKCS#8 格式
    pem = `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----`;
  }

  const encrypted = crypto.publicEncrypt(
    {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(md5Hash, 'utf-8'),
  );

  return encrypted.toString('base64');
}
