const DEFAULT_API_BASE = "http://127.0.0.1:4732";

type RuntimeBackendConfig = {
  apiBase?: string | null;
  rpcUrl?: string | null;
  token?: string | null;
  defaultWorkspacePath?: string | null;
  disableDefaultWorkspace?: boolean | null;
};

declare global {
  interface Window {
    __CODEX_MONITOR_RUNTIME_CONFIG__?: RuntimeBackendConfig;
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getRuntimeConfig(): RuntimeBackendConfig | null {
  if (typeof window === "undefined") {
    return null;
  }
  const config = window.__CODEX_MONITOR_RUNTIME_CONFIG__;
  if (!config || typeof config !== "object") {
    return null;
  }
  return config;
}

function resolveApiBase() {
  const runtimeApiBase = normalizeOptionalString(getRuntimeConfig()?.apiBase);
  if (runtimeApiBase) {
    return trimTrailingSlash(runtimeApiBase);
  }

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
  const runtimeRpcUrl = normalizeOptionalString(getRuntimeConfig()?.rpcUrl);
  if (runtimeRpcUrl) {
    return runtimeRpcUrl;
  }

  const configured = (import.meta.env.VITE_CODEX_MONITOR_RPC_URL ?? "").trim();
  if (configured) {
    return configured;
  }

  const wsBase = apiBase.replace(/^http/i, "ws");
  return `${wsBase}/rpc`;
}

function resolveToken() {
  const runtimeToken = normalizeOptionalString(getRuntimeConfig()?.token);
  if (runtimeToken) {
    return runtimeToken;
  }

  const envToken = (import.meta.env.VITE_CODEX_MONITOR_TOKEN ?? "").trim();
  if (envToken) {
    return envToken;
  }

  if (typeof window === "undefined") {
    return null;
  }

  const storedToken = window.localStorage.getItem("codex_monitor_token");
  return storedToken && storedToken.trim() ? storedToken.trim() : null;
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

export function getDefaultWorkspacePath(): string | null {
  return normalizeOptionalString(getRuntimeConfig()?.defaultWorkspacePath);
}

export function isDefaultWorkspaceDisabled(): boolean {
  return Boolean(getRuntimeConfig()?.disableDefaultWorkspace);
}

export function getResolvedDefaultWorkspacePath(fallback: string | null = null): string | null {
  if (isDefaultWorkspaceDisabled()) {
    return null;
  }
  return getDefaultWorkspacePath() ?? fallback;
}
