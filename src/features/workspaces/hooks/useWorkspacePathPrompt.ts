import { useCallback, useState } from "react";
import { getResolvedDefaultWorkspacePath } from "../../../platform/backendConfig";

const STORAGE_KEY = "codex_monitor_last_workspace_path";

type WorkspacePathPromptState = {
  path: string;
  error: string | null;
  isSubmitting: boolean;
} | null;

type UseWorkspacePathPromptOptions = {
  onConfirmPath: (path: string) => Promise<void>;
  onError?: (message: string) => void;
};

function getStoredWorkspacePath() {
  if (typeof window === "undefined") {
    return "";
  }
  const stored = window.localStorage.getItem(STORAGE_KEY) ?? "";
  if (stored.trim()) {
    return stored;
  }
  return getResolvedDefaultWorkspacePath("") ?? "";
}

function storeWorkspacePath(path: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, path);
}

export function useWorkspacePathPrompt({
  onConfirmPath,
  onError,
}: UseWorkspacePathPromptOptions) {
  const [workspacePathPrompt, setWorkspacePathPrompt] =
    useState<WorkspacePathPromptState>(null);

  const openPrompt = useCallback(() => {
    setWorkspacePathPrompt({
      path: getStoredWorkspacePath(),
      error: null,
      isSubmitting: false,
    });
  }, []);

  const cancelPrompt = useCallback(() => {
    setWorkspacePathPrompt((prev) => (prev?.isSubmitting ? prev : null));
  }, []);

  const updatePath = useCallback((value: string) => {
    setWorkspacePathPrompt((prev) =>
      prev
        ? {
            ...prev,
            path: value,
            error: null,
          }
        : prev,
    );
  }, []);

  const confirmPrompt = useCallback(async () => {
    if (!workspacePathPrompt || workspacePathPrompt.isSubmitting) {
      return;
    }

    const trimmedPath = workspacePathPrompt.path.trim();
    if (!trimmedPath) {
      setWorkspacePathPrompt((prev) =>
        prev
          ? {
              ...prev,
              error: "Workspace path is required.",
            }
          : prev,
      );
      return;
    }

    setWorkspacePathPrompt((prev) =>
      prev
        ? {
            ...prev,
            isSubmitting: true,
            error: null,
          }
        : prev,
    );

    try {
      await onConfirmPath(trimmedPath);
      storeWorkspacePath(trimmedPath);
      setWorkspacePathPrompt(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWorkspacePathPrompt((prev) =>
        prev
          ? {
              ...prev,
              isSubmitting: false,
              error: message,
            }
          : prev,
      );
      onError?.(message);
    }
  }, [onConfirmPath, onError, workspacePathPrompt]);

  return {
    workspacePathPrompt,
    openPrompt,
    cancelPrompt,
    updatePath,
    confirmPrompt,
  };
}
