import { isVerifiedBackupRequest } from "../../../../lib/backup-auth";
import { createEncryptedBackupSnapshot } from "../../../../lib/backup-snapshot";
import { secureHeaders, secureJson } from "../../../../lib/response-security";

export const dynamic = "force-dynamic";

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function GET(request: Request) {
  if (!(await isVerifiedBackupRequest(request))) {
    // 与普通不存在路由保持相同的外部信息量，避免暴露备份入口。
    return secureJson({ error: "未找到请求的资源。" }, { status: 404 });
  }

  try {
    const snapshot = await createEncryptedBackupSnapshot();
    const body = JSON.stringify(snapshot);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const headers = secureHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "X-Djmima-Backup-Format": snapshot.format,
      "X-Djmima-Backup-Sha256": toBase64(new Uint8Array(digest)),
    }, { noStore: true });
    return new Response(body, { headers });
  } catch (error) {
    // 不向 Worker 返回数据库结构、密钥或具体 SQL 错误。
    console.error("djmima_backup_snapshot_failed", { message: error instanceof Error ? error.message : String(error) });
    return secureJson({ error: "备份快照暂时不可用。" }, { status: 503 });
  }
}
