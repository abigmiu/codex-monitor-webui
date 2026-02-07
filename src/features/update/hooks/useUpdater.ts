import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl } from "../../../platform/opener";
import type { DebugEntry } from "../../../types";

type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "restarting"
  | "latest"
  | "error";

type UpdateProgress = {
  totalBytes?: number;
  downloadedBytes: number;
};

export type UpdateState = {
  stage: UpdateStage;
  version?: string;
  progress?: UpdateProgress;
  error?: string;
};

type UseUpdaterOptions = {
  enabled?: boolean;
  onDebug?: (entry: DebugEntry) => void;
};

type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
};

const DEFAULT_RELEASES_API =
  "https://api.github.com/repos/Dimillian/CodexMonitor/releases/latest";
const DEFAULT_DOWNLOAD_URL = "https://github.com/Dimillian/CodexMonitor/releases/latest";

function normalizeVersion(value: string | null | undefined) {
  if (!value) {
    return "";
  }
  return value.trim().replace(/^v/i, "");
}

function parseVersionParts(value: string) {
  const normalized = normalizeVersion(value);
  const core = normalized.split("-")[0] ?? normalized;
  return core
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isNewerVersion(candidate: string, current: string) {
  const left = parseVersionParts(candidate);
  const right = parseVersionParts(current);
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart > rightPart) {
      return true;
    }
    if (leftPart < rightPart) {
      return false;
    }
  }
  return false;
}

function releaseApiUrl() {
  return (import.meta.env.VITE_CODEX_MONITOR_RELEASES_API ?? DEFAULT_RELEASES_API).trim();
}

function releaseDownloadUrl(fallback?: string | null) {
  const configured = (import.meta.env.VITE_CODEX_MONITOR_RELEASES_URL ?? "").trim();
  if (configured) {
    return configured;
  }
  if (fallback && fallback.trim()) {
    return fallback.trim();
  }
  return DEFAULT_DOWNLOAD_URL;
}

export function useUpdater({ enabled = true, onDebug }: UseUpdaterOptions) {
  const [state, setState] = useState<UpdateState>({ stage: "idle" });
  const latestTimeoutRef = useRef<number | null>(null);
  const pendingDownloadUrlRef = useRef<string | null>(null);
  const latestToastDurationMs = 2000;

  const clearLatestTimeout = useCallback(() => {
    if (latestTimeoutRef.current !== null) {
      window.clearTimeout(latestTimeoutRef.current);
      latestTimeoutRef.current = null;
    }
  }, []);

  const resetToIdle = useCallback(async () => {
    clearLatestTimeout();
    pendingDownloadUrlRef.current = null;
    setState({ stage: "idle" });
  }, [clearLatestTimeout]);

  const checkForUpdates = useCallback(
    async (options?: { announceNoUpdate?: boolean }) => {
      try {
        clearLatestTimeout();
        setState({ stage: "checking" });

        const response = await fetch(releaseApiUrl(), {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!response.ok) {
          throw new Error(`Release check failed (${response.status}).`);
        }

        const payload = (await response.json()) as GitHubRelease;
        const nextVersion = normalizeVersion(payload.tag_name ?? "");
        const currentVersion = normalizeVersion(__APP_VERSION__);
        const hasUpdate =
          Boolean(nextVersion) && Boolean(currentVersion)
            ? isNewerVersion(nextVersion, currentVersion)
            : Boolean(nextVersion && nextVersion !== currentVersion);

        if (!hasUpdate) {
          if (options?.announceNoUpdate) {
            setState({ stage: "latest" });
            latestTimeoutRef.current = window.setTimeout(() => {
              latestTimeoutRef.current = null;
              setState({ stage: "idle" });
            }, latestToastDurationMs);
          } else {
            setState({ stage: "idle" });
          }
          return;
        }

        pendingDownloadUrlRef.current = releaseDownloadUrl(payload.html_url ?? null);
        setState({
          stage: "available",
          version: nextVersion || undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        onDebug?.({
          id: `${Date.now()}-client-updater-error`,
          timestamp: Date.now(),
          source: "error",
          label: "updater/error",
          payload: message,
        });
        setState({ stage: "error", error: message });
      }
    },
    [clearLatestTimeout, onDebug],
  );

  const startUpdate = useCallback(async () => {
    if (!pendingDownloadUrlRef.current) {
      await checkForUpdates();
      return;
    }

    try {
      setState((prev) => ({ ...prev, stage: "restarting" }));
      await openExternalUrl(pendingDownloadUrlRef.current);
      window.setTimeout(() => {
        setState({ stage: "idle" });
      }, 1200);
    } catch (error) {
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      onDebug?.({
        id: `${Date.now()}-client-updater-error`,
        timestamp: Date.now(),
        source: "error",
        label: "updater/error",
        payload: message,
      });
      setState((prev) => ({
        ...prev,
        stage: "error",
        error: message,
      }));
    }
  }, [checkForUpdates, onDebug]);

  useEffect(() => {
    if (!enabled || import.meta.env.DEV) {
      return;
    }
    void checkForUpdates();
  }, [checkForUpdates, enabled]);

  useEffect(() => {
    return () => {
      clearLatestTimeout();
    };
  }, [clearLatestTimeout]);

  return {
    state,
    startUpdate,
    checkForUpdates,
    dismiss: resetToIdle,
  };
}
