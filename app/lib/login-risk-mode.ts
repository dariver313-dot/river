export type LoginRiskMode = "observe" | "enforce";

/** Local preview has no trusted proxy/GeoIP data; production always enforces it. */
export function resolveLoginRiskMode(environment = process.env.NODE_ENV): LoginRiskMode {
  return environment === "production" ? "enforce" : "observe";
}

export function loginRiskMode(): LoginRiskMode {
  return resolveLoginRiskMode();
}
