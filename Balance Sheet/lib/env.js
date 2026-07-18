'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function positiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function getSettings(rootDir) {
  loadEnv(path.join(rootDir, '.env'));
  return {
    host: process.env.HOST || '127.0.0.1',
    port: positiveInt(process.env.PORT, 3210, 65535),
    authServiceUrl: (process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:3100/api/platform-b').replace(/\/+$/, ''),
    authApiKey: process.env.AUTH_API_KEY || '',
    maxUploadBytes: positiveInt(process.env.MAX_UPLOAD_MB, 12, 50) * 1024 * 1024,
  };
}

module.exports = { getSettings };
