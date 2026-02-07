import { useCallback, type MouseEvent } from "react";

import type { WorkspaceInfo } from "../../../types";
import { revealItemInDir } from "../../../services/tauri";
import { pushErrorToast } from "../../../services/toasts";
import { fileManagerName } from "../../../utils/platformPaths";
import { showContextMenuFromEvent } from "../../../platform/contextMenu";

type SidebarMenuHandlers = {
  onDeleteThread: (workspaceId: string, threadId: string) => void;
  onSyncThread: (workspaceId: string, threadId: string) => void;
  onPinThread: (workspaceId: string, threadId: string) => void;
  onUnpinThread: (workspaceId: string, threadId: string) => void;
  isThreadPinned: (workspaceId: string, threadId: string) => boolean;
  onRenameThread: (workspaceId: string, threadId: string) => void;
  onReloadWorkspaceThreads: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onDeleteWorktree: (workspaceId: string) => void;
};

export function useSidebarMenus({
  onDeleteThread,
  onSyncThread,
  onPinThread,
  onUnpinThread,
  isThreadPinned,
  onRenameThread,
  onReloadWorkspaceThreads,
  onDeleteWorkspace,
  onDeleteWorktree,
}: SidebarMenuHandlers) {
  const showThreadMenu = useCallback(
    async (
      event: MouseEvent,
      workspaceId: string,
      threadId: string,
      canPin: boolean,
    ) => {
      const items: Array<{
        label: string;
        onSelect: () => void;
      }> = [
        {
          label: "Rename",
          onSelect: () => onRenameThread(workspaceId, threadId),
        },
        {
          label: "Sync from server",
          onSelect: () => onSyncThread(workspaceId, threadId),
        },
      ];
      if (canPin) {
        const isPinned = isThreadPinned(workspaceId, threadId);
        items.push({
          label: isPinned ? "Unpin" : "Pin",
          onSelect: () => {
            if (isPinned) {
              onUnpinThread(workspaceId, threadId);
            } else {
              onPinThread(workspaceId, threadId);
            }
          },
        });
      }
      items.push(
        {
          label: "Copy ID",
          onSelect: () => {
            void navigator.clipboard.writeText(threadId);
          },
        },
        {
          label: "Archive",
          onSelect: () => onDeleteThread(workspaceId, threadId),
        },
      );
      await showContextMenuFromEvent(event, items);
    },
    [
      isThreadPinned,
      onDeleteThread,
      onPinThread,
      onRenameThread,
      onSyncThread,
      onUnpinThread,
    ],
  );

  const showWorkspaceMenu = useCallback(
    async (event: MouseEvent, workspaceId: string) => {
      await showContextMenuFromEvent(event, [
        {
          label: "Reload threads",
          onSelect: () => onReloadWorkspaceThreads(workspaceId),
        },
        {
          label: "Delete",
          onSelect: () => onDeleteWorkspace(workspaceId),
        },
      ]);
    },
    [onReloadWorkspaceThreads, onDeleteWorkspace],
  );

  const showWorktreeMenu = useCallback(
    async (event: MouseEvent, worktree: WorkspaceInfo) => {
      const fileManagerLabel = fileManagerName();
      await showContextMenuFromEvent(event, [
        {
          label: "Reload threads",
          onSelect: () => onReloadWorkspaceThreads(worktree.id),
        },
        {
          label: `Show in ${fileManagerLabel}`,
          onSelect: async () => {
            if (!worktree.path) {
              return;
            }
            try {
              await revealItemInDir(worktree.path);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              pushErrorToast({
                title: `Couldn't show worktree in ${fileManagerLabel}`,
                message,
              });
              console.warn("Failed to reveal worktree", {
                message,
                workspaceId: worktree.id,
                path: worktree.path,
              });
            }
          },
        },
        {
          label: "Delete worktree",
          onSelect: () => onDeleteWorktree(worktree.id),
        },
      ]);
    },
    [onReloadWorkspaceThreads, onDeleteWorktree],
  );

  return { showThreadMenu, showWorkspaceMenu, showWorktreeMenu };
}
