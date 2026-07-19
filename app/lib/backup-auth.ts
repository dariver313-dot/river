import { backupSignaturePayload, verifyBackupSignature } from "./backup-signature";

const backupRequestMaxAgeMs = 5 * 60_000;

/**
 * 仅允许持有备份签名私钥的服务器计划任务读取密文快照。请求不依赖用户 Cookie，
 * 因此不会把普通管理员权限扩大为数据库备份权限。
 */
export async function isVerifiedBackupRequest(request: Request) {
  const publicKey = process.env.BACKUP_WORKER_PUBLIC_KEY;
  const timestamp = request.headers.get("x-djmima-backup-timestamp");
  const signature = request.headers.get("x-djmima-backup-signature");
  if (!publicKey || !timestamp || !signature || !/^\d{13}$/.test(timestamp)) return false;

  const requestTime = Number(timestamp);
  if (!Number.isSafeInteger(requestTime) || Math.abs(Date.now() - requestTime) > backupRequestMaxAgeMs) return false;

  try {
    const url = new URL(request.url);
    return await verifyBackupSignature(
      publicKey,
      signature,
      backupSignaturePayload(request.method, url.pathname, timestamp),
    );
  } catch {
    return false;
  }
}
