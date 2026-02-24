/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitLogEntry } from "../../../types";
import { GitDiffPanel } from "./GitDiffPanel";
import { fileManagerName } from "../../../utils/platformPaths";
import type { ContextMenuItem } from "../../../platform/contextMenu";

const clipboardWriteText = vi.hoisted(() => vi.fn());

const showContextMenuFromEventMock = vi.hoisted(() =>
  vi.fn(async (_event: unknown, _items: ContextMenuItem[]) => {}),
);

vi.mock("../../../platform/contextMenu", () => ({
  showContextMenuFromEvent: showContextMenuFromEventMock,
}));

vi.mock("../../../platform/dialog", () => ({
  confirmDialog: vi.fn(async () => true),
}));

vi.mock("../../../platform/opener", () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock("../../../services/tauri", () => ({
  revealItemInDir: vi.fn(),
}));

vi.mock("../../../services/toasts", () => ({
  pushErrorToast: vi.fn(),
}));

Object.defineProperty(navigator, "clipboard", {
  value: { writeText: (...args: unknown[]) => clipboardWriteText(...args) },
  configurable: true,
});

const logEntries: GitLogEntry[] = [];

const baseProps = {
  mode: "diff" as const,
  onModeChange: vi.fn(),
  filePanelMode: "git" as const,
  onFilePanelModeChange: vi.fn(),
  branchName: "main",
  totalAdditions: 0,
  totalDeletions: 0,
  fileStatus: "1 file changed",
  logEntries,
  stagedFiles: [],
  unstagedFiles: [],
};

describe("GitDiffPanel", () => {
  it("enables commit when message exists and only unstaged changes", () => {
    const onCommit = vi.fn();
    render(
      <GitDiffPanel
        {...baseProps}
        commitMessage="feat: add thing"
        onCommit={onCommit}
        onGenerateCommitMessage={vi.fn()}
        unstagedFiles={[
          { path: "file.txt", status: "M", additions: 1, deletions: 0 },
        ]}
      />,
    );

    const commitButton = screen.getByRole("button", { name: "Commit" });
    expect((commitButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(commitButton);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("adds a show in file manager option for file context menus", async () => {
    clipboardWriteText.mockClear();
    const { container } = render(
      <GitDiffPanel
        {...baseProps}
        workspacePath="/tmp/repo"
        gitRoot="/tmp/repo/"
        unstagedFiles={[
          { path: "src/sample.ts", status: "M", additions: 1, deletions: 0 },
        ]}
      />,
    );

    const row = container.querySelector(".diff-row");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row as Element);

    await waitFor(() => expect(showContextMenuFromEventMock).toHaveBeenCalled());
    const call = showContextMenuFromEventMock.mock.calls[0];
    if (!call) {
      throw new Error("Context menu was not shown");
    }
    const revealItem = call[1].find(
      (item) => item.label === `Show in ${fileManagerName()}`,
    );

    expect(revealItem).toBeDefined();
    await revealItem?.onSelect?.();
    const { revealItemInDir } = await import("../../../services/tauri");
    expect(vi.mocked(revealItemInDir)).toHaveBeenCalledWith("/tmp/repo/src/sample.ts");
  });

  it("copies file name and path from the context menu", async () => {
    clipboardWriteText.mockClear();
    showContextMenuFromEventMock.mockClear();
    const { container } = render(
      <GitDiffPanel
        {...baseProps}
        workspacePath="/tmp/repo"
        gitRoot="/tmp/repo"
        unstagedFiles={[
          { path: "src/sample.ts", status: "M", additions: 1, deletions: 0 },
        ]}
      />,
    );

    const row = container.querySelector(".diff-row");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row as Element);

    await waitFor(() => expect(showContextMenuFromEventMock).toHaveBeenCalled());
    const lastCall =
      showContextMenuFromEventMock.mock.calls[showContextMenuFromEventMock.mock.calls.length - 1];
    if (!lastCall) {
      throw new Error("Context menu was not shown");
    }
    const copyNameItem = lastCall[1].find((item) => item.label === "Copy file name");
    const copyPathItem = lastCall[1].find((item) => item.label === "Copy file path");

    expect(copyNameItem).toBeDefined();
    expect(copyPathItem).toBeDefined();

    await copyNameItem?.onSelect?.();
    await copyPathItem?.onSelect?.();

    expect(clipboardWriteText).toHaveBeenCalledWith("sample.ts");
    expect(clipboardWriteText).toHaveBeenCalledWith("src/sample.ts");
  });

  it("resolves relative git roots against the workspace path", async () => {
    showContextMenuFromEventMock.mockClear();
    const { container } = render(
      <GitDiffPanel
        {...baseProps}
        workspacePath="/tmp/repo"
        gitRoot="apps"
        unstagedFiles={[
          { path: "src/sample.ts", status: "M", additions: 1, deletions: 0 },
        ]}
      />,
    );

    const row = container.querySelector(".diff-row");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row as Element);

    await waitFor(() => expect(showContextMenuFromEventMock).toHaveBeenCalled());
    const lastCall =
      showContextMenuFromEventMock.mock.calls[showContextMenuFromEventMock.mock.calls.length - 1];
    if (!lastCall) {
      throw new Error("Context menu was not shown");
    }
    const revealItem = lastCall[1].find(
      (item) => item.label === `Show in ${fileManagerName()}`,
    );

    expect(revealItem).toBeDefined();
    await revealItem?.onSelect?.();
    const { revealItemInDir } = await import("../../../services/tauri");
    expect(vi.mocked(revealItemInDir)).toHaveBeenCalledWith("/tmp/repo/apps/src/sample.ts");
  });

  it("copies file path relative to the workspace root", async () => {
    clipboardWriteText.mockClear();
    showContextMenuFromEventMock.mockClear();
    const { container } = render(
      <GitDiffPanel
        {...baseProps}
        workspacePath="/tmp/repo"
        gitRoot="apps"
        unstagedFiles={[
          { path: "src/sample.ts", status: "M", additions: 1, deletions: 0 },
        ]}
      />,
    );

    const row = container.querySelector(".diff-row");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row as Element);

    await waitFor(() => expect(showContextMenuFromEventMock).toHaveBeenCalled());
    const lastCall =
      showContextMenuFromEventMock.mock.calls[showContextMenuFromEventMock.mock.calls.length - 1];
    if (!lastCall) {
      throw new Error("Context menu was not shown");
    }
    const copyPathItem = lastCall[1].find((item) => item.label === "Copy file path");

    expect(copyPathItem).toBeDefined();
    await copyPathItem?.onSelect?.();

    expect(clipboardWriteText).toHaveBeenCalledWith("apps/src/sample.ts");
  });

  it("does not trim paths when the git root only shares a prefix", async () => {
    clipboardWriteText.mockClear();
    showContextMenuFromEventMock.mockClear();
    const { container } = render(
      <GitDiffPanel
        {...baseProps}
        workspacePath="/tmp/repo"
        gitRoot="/tmp/repo-tools"
        unstagedFiles={[
          { path: "src/sample.ts", status: "M", additions: 1, deletions: 0 },
        ]}
      />,
    );

    const row = container.querySelector(".diff-row");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row as Element);

    await waitFor(() => expect(showContextMenuFromEventMock).toHaveBeenCalled());
    const lastCall =
      showContextMenuFromEventMock.mock.calls[showContextMenuFromEventMock.mock.calls.length - 1];
    if (!lastCall) {
      throw new Error("Context menu was not shown");
    }
    const copyPathItem = lastCall[1].find((item) => item.label === "Copy file path");

    expect(copyPathItem).toBeDefined();
    await copyPathItem?.onSelect?.();

    expect(clipboardWriteText).toHaveBeenCalledWith("src/sample.ts");
  });
});
