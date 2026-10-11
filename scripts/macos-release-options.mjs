import { existsSync } from "node:fs";

function hasNotarizationApi(env, exists) {
  return env.APPLE_API_KEY && env.APPLE_API_ISSUER && env.APPLE_API_KEY_PATH && exists(env.APPLE_API_KEY_PATH);
}

export function missingReleaseConfiguration(env, identities, exists) {
  const missing = [];
  const identity = env.APPLE_SIGNING_IDENTITY?.trim();
  if (!identity || identity === "-" || !(/^[0-9A-Fa-f]{40}$/.test(identity) || identity.startsWith("Developer ID Application:"))) {
    missing.push("APPLE_SIGNING_IDENTITY (Developer ID Application)");
  }
  if (env.APPLE_CERTIFICATE) {
    if (!env.APPLE_CERTIFICATE_PASSWORD) missing.push("APPLE_CERTIFICATE_PASSWORD");
  } else if (!identities.includes("Developer ID Application:") || (identity && !identities.toLowerCase().includes(identity.toLowerCase()))) {
    missing.push("有效的 Developer ID Application 证书及私钥（钥匙串或 APPLE_CERTIFICATE）");
  }
  const api = hasNotarizationApi(env, exists);
  const account = env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID;
  if (!api && !account) missing.push("公证凭据：APPLE_API_KEY/ISSUER/KEY_PATH 或 APPLE_ID/PASSWORD/TEAM_ID");
  if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim()) missing.push("TAURI_SIGNING_PRIVATE_KEY（须匹配现有更新公钥）");
  return missing;
}

export function notarizationArguments(env, exists = existsSync) {
  if (hasNotarizationApi(env, exists)) {
    return ["--key", env.APPLE_API_KEY_PATH, "--key-id", env.APPLE_API_KEY, "--issuer", env.APPLE_API_ISSUER];
  }
  if (env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID) {
    return ["--apple-id", env.APPLE_ID, "--password", env.APPLE_PASSWORD, "--team-id", env.APPLE_TEAM_ID];
  }
  throw new Error("缺少公证凭据");
}
