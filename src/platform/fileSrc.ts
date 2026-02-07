import { appendToken, getBackendConfig } from "./backendConfig";

function isRemoteSrc(path: string) {
  return path.startsWith("http://") || path.startsWith("https://") || path.startsWith("data:");
}

export function workspaceFileSrc(workspaceId: string | null | undefined, path: string) {
  if (!path) {
    return "";
  }
  if (isRemoteSrc(path)) {
    return path;
  }
  if (!workspaceId) {
    return path;
  }

  const { apiBase, token } = getBackendConfig();
  const url = new URL(`${apiBase}/api/workspaces/${encodeURIComponent(workspaceId)}/file`);
  url.searchParams.set("path", path);
  appendToken(url, token);
  return url.toString();
}
