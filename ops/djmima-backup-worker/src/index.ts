interface Env {
  BACKUP_BUCKET: R2Bucket;
  BACKUP_SOURCE_URL: string;
  BACKUP_SIGNING_PRIVATE_KEY: string;
  SITE_BYPASS_TOKEN: string;
}

const maxBackupBytes = 20 * 1024 * 1024;

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function chinaDateParts(now: Date) {
  // 中国不使用夏令时；以业务所在时区命名对象，避免 03:00 备份落入前一天。
  const shifted = new Date(now.getTime() + 8 * 60 * 60_000).toISOString();
  return { day: shifted.slice(0, 10), month: shifted.slice(0, 7), dayOfMonth: shifted.slice(8, 10) };
}

function dateDaysAgo(now: Date, days: number) {
  return chinaDateParts(new Date(now.getTime() - days * 24 * 60 * 60_000)).day;
}

function monthMonthsAgo(now: Date, months: number) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60_000);
  shifted.setUTCMonth(shifted.getUTCMonth() - months);
  return shifted.toISOString().slice(0, 7);
}

function signaturePayload(method: string, pathname: string, timestamp: string) {
  return new TextEncoder().encode(`${method.toUpperCase()}\n${pathname}\n${timestamp}`);
}

async function createRequestSignature(privateKeyBase64: string, payload: Uint8Array) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64(privateKeyBase64),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return toBase64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, payload)));
}

async function pruneBackups(bucket: R2Bucket, now: Date) {
  const dailyCutoff = `daily/${dateDaysAgo(now, 29)}.json`;
  const monthlyCutoff = `monthly/${monthMonthsAgo(now, 11)}.json`;
  const listed = await bucket.list({ limit: 1_000 });
  const expired = listed.objects
    .map((object) => object.key)
    .filter((key) => (key.startsWith("daily/") && key < dailyCutoff) || (key.startsWith("monthly/") && key < monthlyCutoff));
  if (expired.length) await bucket.delete(expired);
  return expired.length;
}

async function runBackup(env: Env) {
  const now = new Date();
  const source = new URL(env.BACKUP_SOURCE_URL);
  const timestamp = String(now.getTime());
  const signature = await createRequestSignature(
    env.BACKUP_SIGNING_PRIVATE_KEY,
    signaturePayload("GET", source.pathname, timestamp),
  );
  const response = await fetch(source, {
    headers: {
      "OAI-Sites-Authorization": `Bearer ${env.SITE_BYPASS_TOKEN}`,
      "X-Djmima-Backup-Timestamp": timestamp,
      "X-Djmima-Backup-Signature": signature,
    },
  });
  if (!response.ok) throw new Error(`backup source returned HTTP ${response.status}`);

  const data = await response.arrayBuffer();
  if (!data.byteLength || data.byteLength > maxBackupBytes) throw new Error("backup snapshot size is outside the allowed limit");

  const { day, month, dayOfMonth } = chinaDateParts(now);
  const hash = response.headers.get("X-Djmima-Backup-Sha256") ?? "unavailable";
  const putOptions = {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { format: "djmima-encrypted-logical-backup/v1", created_at: now.toISOString(), sha256: hash },
  };
  await env.BACKUP_BUCKET.put(`daily/${day}.json`, data, putOptions);
  if (dayOfMonth === "01") await env.BACKUP_BUCKET.put(`monthly/${month}.json`, data, putOptions);
  const pruned = await pruneBackups(env.BACKUP_BUCKET, now);
  console.log("djmima_backup_completed", { day, bytes: data.byteLength, pruned });
  return { day, bytes: data.byteLength, pruned };
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runBackup(env).catch((error) => console.error("djmima_backup_failed", { message: error instanceof Error ? error.message : String(error) })));
  },

  async fetch(request: Request, env: Env) {
    // 手动演练需要与 Site 网关绕过令牌相同的私有凭据；没有公开触发入口。
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run" || request.headers.get("Authorization") !== `Bearer ${env.SITE_BYPASS_TOKEN}`) {
      return new Response("Not found", { status: 404 });
    }
    try {
      return Response.json(await runBackup(env), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error("djmima_backup_failed", { message: error instanceof Error ? error.message : String(error) });
      return Response.json({ error: "Backup did not complete." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  },
} satisfies ExportedHandler<Env>;
