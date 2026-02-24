/** @vitest-environment jsdom */
import type { MouseEvent as ReactMouseEvent } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceInfo } from "../../../types";
import { useSidebarMenus } from "./useSidebarMenus";
import { fileManagerName } from "../../../utils/platformPaths";
import type { ContextMenuItem } from "../../../platform/contextMenu";

const showContextMenuFromEventMock = vi.hoisted(() =>
  vi.fn(async (_event: unknown, _items: ContextMenuItem[]) => {}),
);

vi.mock("../../../platform/contextMenu", () => ({
  showContextMenuFromEvent: showContextMenuFromEventMock,
}));

vi.mock("../../../services/tauri", () => ({
  revealItemInDir: vi.fn(),
}));

vi.mock("../../../services/toasts", () => ({
  pushErrorToast: vi.fn(),
}));

describe("useSidebarMenus", () => {
  it("adds a show in file manager option for worktrees", async () => {
    const onDeleteThread = vi.fn();
    const onSyncThread = vi.fn();
    const onPinThread = vi.fn();
    const onUnpinThread = vi.fn();
    const isThreadPinned = vi.fn(() => false);
    const onRenameThread = vi.fn();
    const onReloadWorkspaceThreads = vi.fn();
    const onDeleteWorkspace = vi.fn();
    const onDeleteWorktree = vi.fn();

    const { result } = renderHook(() =>
      useSidebarMenus({
        onDeleteThread,
        onSyncThread,
        onPinThread,
        onUnpinThread,
        isThreadPinned,
        onRenameThread,
        onReloadWorkspaceThreads,
        onDeleteWorkspace,
        onDeleteWorktree,
      }),
    );

    const worktree: WorkspaceInfo = {
      id: "worktree-1",
      name: "feature/test",
      path: "/tmp/worktree-1",
      kind: "worktree",
      connected: true,
      settings: {
        sidebarCollapsed: false,
        worktreeSetupScript: "",
      },
      worktree: { branch: "feature/test" },
    };

    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clientX: 12,
      clientY: 34,
    } as unknown as ReactMouseEvent;

    await result.current.showWorktreeMenu(event, worktree);

    const call = showContextMenuFromEventMock.mock.calls[0];
    if (!call) {
      throw new Error("Context menu was not shown");
    }
    const menuItems = call[1];
    const revealItem = menuItems.find(
      (item) => item.label === `Show in ${fileManagerName()}`,
    );

    expect(revealItem).toBeDefined();
    await revealItem?.onSelect?.();
    const { revealItemInDir } = await import("../../../services/tauri");
    expect(vi.mocked(revealItemInDir)).toHaveBeenCalledWith("/tmp/worktree-1");
  });
});
