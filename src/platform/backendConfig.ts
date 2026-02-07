const DEFAULT_API_BASE = "http://127.0.0.1:4732";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function resolveApiBase() {
  const configured = (import.meta.env.VITE_CODEX_MONITOR_API_BASE ?? "").trim();
  if (configured) {
    return trimTrailingSlash(configured);
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    const isLocalPreview =
      window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    if (!isLocalPreview) {
      return trimTrailingSlash(window.location.origin);
    }
  }
  return DEFAULT_API_BASE;
}

function resolveRpcUrl(apiBase: string) {
  const configured = (import.meta.env.VITE_CODEX_MONITOR_RPC_URL ?? "").trim();
  if (configured) {
    return configured;
  }
  const wsBase = apiBase.replace(/^http/i, "ws");
  return `${wsBase}/rpc`;
}

function resolveToken() {
  const envToken = (import.meta.env.VITE_CODEX_MONITOR_TOKEN ?? "").trim();
  if (envToken) {
    return envToken;
  }
  if (typeof window === "undefined") {
    return null;
  }
  const runtimeToken = window.localStorage.getItem("codex_monitor_token");
  return runtimeToken && runtimeToken.trim() ? runtimeToken.trim() : null;
}

export type BackendConfig = {
  apiBase: string;
  rpcUrl: string;
  token: string | null;
};

export function getBackendConfig(): BackendConfig {
  const apiBase = resolveApiBase();
  return {
    apiBase,
    rpcUrl: resolveRpcUrl(apiBase),
    token: resolveToken(),
  };
}

export function appendToken(url: URL, token: string | null) {
  if (!token) {
    return;
  }
  url.searchParams.set("token", token);
}
