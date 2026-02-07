import { useCallback } from "react";
import type { MouseEvent } from "react";
import { openWorkspaceIn, revealItemInDir } from "../../../services/tauri";
import { pushErrorToast } from "../../../services/toasts";
import type { OpenAppTarget } from "../../../types";
import {
  isAbsolutePath,
  joinWorkspacePath,
  revealInFileManagerLabel,
} from "../../../utils/platformPaths";
import { showContextMenuFromEvent } from "../../../platform/contextMenu";

type OpenTarget = {
  id: string;
  label: string;
  appName?: string | null;
  kind: OpenAppTarget["kind"];
  command?: string | null;
  args: string[];
};

const DEFAULT_OPEN_TARGET: OpenTarget = {
  id: "vscode",
  label: "VS Code",
  appName: "Visual Studio Code",
  kind: "app",
  command: null,
  args: [],
};

const resolveAppName = (target: OpenTarget) => (target.appName ?? "").trim();
const resolveCommand = (target: OpenTarget) => (target.command ?? "").trim();
const canOpenTarget = (target: OpenTarget) => {
  if (target.kind === "finder") {
    return true;
  }
  if (target.kind === "command") {
    return Boolean(resolveCommand(target));
  }
  return Boolean(resolveAppName(target));
};

function resolveFilePath(path: string, workspacePath?: string | null) {
  const trimmed = path.trim();
  if (!workspacePath) {
    return trimmed;
  }
  if (isAbsolutePath(trimmed)) {
    return trimmed;
  }
  return joinWorkspacePath(workspacePath, trimmed);
}

function stripLineSuffix(path: string) {
  const match = path.match(/^(.*?)(?::\d+(?::\d+)?)?$/);
  return match ? match[1] : path;
}

export function useFileLinkOpener(
  workspacePath: string | null,
  openTargets: OpenAppTarget[],
  selectedOpenAppId: string,
) {
  const reportOpenError = useCallback(
    (error: unknown, context: Record<string, string | null>) => {
      const message = error instanceof Error ? error.message : String(error);
      pushErrorToast({
        title: "Couldn’t open file",
        message,
      });
      console.warn("Failed to open file link", { message, ...context });
    },
    [],
  );

  const openFileLink = useCallback(
    async (rawPath: string) => {
      const target = {
        ...DEFAULT_OPEN_TARGET,
        ...(openTargets.find((entry) => entry.id === selectedOpenAppId) ??
          openTargets[0]),
      };
      const resolvedPath = resolveFilePath(stripLineSuffix(rawPath), workspacePath);

      try {
        if (!canOpenTarget(target)) {
          return;
        }
        if (target.kind === "finder") {
          await revealItemInDir(resolvedPath);
          return;
        }

        if (target.kind === "command") {
          const command = resolveCommand(target);
          if (!command) {
            return;
          }
          await openWorkspaceIn(resolvedPath, {
            command,
            args: target.args,
          });
          return;
        }

        const appName = resolveAppName(target);
        if (!appName) {
          return;
        }
        await openWorkspaceIn(resolvedPath, {
          appName,
          args: target.args,
        });
      } catch (error) {
        reportOpenError(error, {
          rawPath,
          resolvedPath,
          workspacePath,
          targetId: target.id,
          targetKind: target.kind,
          targetAppName: target.appName ?? null,
          targetCommand: target.command ?? null,
        });
      }
    },
    [openTargets, reportOpenError, selectedOpenAppId, workspacePath],
  );

  const showFileLinkMenu = useCallback(
    async (event: MouseEvent, rawPath: string) => {
      const target = {
        ...DEFAULT_OPEN_TARGET,
        ...(openTargets.find((entry) => entry.id === selectedOpenAppId) ??
          openTargets[0]),
      };
      const resolvedPath = resolveFilePath(stripLineSuffix(rawPath), workspacePath);
      const appName = resolveAppName(target);
      const command = resolveCommand(target);
      const canOpen = canOpenTarget(target);
      const openLabel =
        target.kind === "finder"
          ? revealInFileManagerLabel()
          : target.kind === "command"
            ? command
              ? `Open in ${target.label}`
              : "Set command in Settings"
            : appName
              ? `Open in ${appName}`
              : "Set app name in Settings";

      await showContextMenuFromEvent(event, [
        {
          label: openLabel,
          enabled: canOpen,
          onSelect: async () => {
            await openFileLink(rawPath);
          },
        },
        ...(target.kind === "finder"
          ? []
          : [
              {
                label: revealInFileManagerLabel(),
                onSelect: async () => {
                  try {
                    await revealItemInDir(resolvedPath);
                  } catch (error) {
                    reportOpenError(error, {
                      rawPath,
                      resolvedPath,
                      workspacePath,
                      targetId: target.id,
                      targetKind: "finder",
                      targetAppName: null,
                      targetCommand: null,
                    });
                  }
                },
              },
            ]),
        {
          label: "Download Linked File",
          enabled: false,
        },
        {
          label: "Copy Link",
          onSelect: async () => {
            const link =
              resolvedPath.startsWith("/") ? `file://${resolvedPath}` : resolvedPath;
            try {
              await navigator.clipboard.writeText(link);
            } catch {
              // Clipboard failures are non-fatal here.
            }
          },
        },
        { separator: true },
        {
          label: "Services",
          enabled: false,
        },
      ]);
    },
    [openFileLink, openTargets, reportOpenError, selectedOpenAppId, workspacePath],
  );

  return { openFileLink, showFileLinkMenu };
}
