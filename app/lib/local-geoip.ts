import { resolve } from "node:path";
import maxmind, { type CityResponse, type Reader } from "maxmind";
import { requestClientIp } from "./request-ip";

export type LoginLocation = {
  countryCode: string | null;
  available: boolean;
};

let openedPath: string | null = null;
let readerPromise: Promise<Reader<CityResponse>> | null = null;

function configuredDatabasePath() {
  const value = process.env.DJMIMA_GEOIP_DATABASE_PATH?.trim();
  return value ? resolve(value) : null;
}

async function cityReader() {
  const path = configuredDatabasePath();
  if (!path) return null;
  if (path !== openedPath) {
    openedPath = path;
    readerPromise = maxmind.open<CityResponse>(path);
  }
  try {
    return await readerPromise;
  } catch {
    readerPromise = null;
    return null;
  }
}

/**
 * Country/region data is intentionally read from a local MMDB file.  Login
 * requests must never be forwarded to a third-party GeoIP service merely to
 * decide whether a user can access their password vault.
 */
export async function locateLoginRequest(request: Request): Promise<LoginLocation> {
  const ip = requestClientIp(request);
  if (!ip) return { countryCode: null, available: false };
  const reader = await cityReader();
  if (!reader) return { countryCode: null, available: false };
  try {
    const result = reader.get(ip);
    const countryCode = result?.country?.iso_code?.toUpperCase() ?? null;
    return { countryCode, available: true };
  } catch {
    return { countryCode: null, available: false };
  }
}

export function geoIpConfigured() {
  return Boolean(configuredDatabasePath());
}

/** Opens the configured local database so readiness cannot be fooled by a missing or corrupt file. */
export async function geoIpReady() {
  return Boolean(await cityReader());
}
