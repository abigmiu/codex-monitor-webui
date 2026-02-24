import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRpc } from "../platform/rpcClient";
import {
  addWorkspace,
  getGitHubIssues,
  getGitLog,
  getGitStatus,
  listWorkspaces,
  readAgentMd,
  readGlobalAgentsMd,
  setThreadName,
  writeAgentMd,
  writeGlobalAgentsMd,
} from "./tauri";

vi.mock("../platform/rpcClient", () => ({
  callRpc: vi.fn(),
}));

describe("services/tauri rpc wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses codex_bin for addWorkspace", async () => {
    vi.mocked(callRpc).mockResolvedValueOnce({ id: "ws-1" });

    await addWorkspace("/tmp/project", null);

    expect(callRpc).toHaveBeenCalledWith("add_workspace", {
      path: "/tmp/project",
      codex_bin: null,
    });
  });

  it("maps workspaceId for git status", async () => {
    vi.mocked(callRpc).mockResolvedValueOnce({
      branchName: "main",
      files: [],
      stagedFiles: [],
      unstagedFiles: [],
      totalAdditions: 0,
      totalDeletions: 0,
    });

    await getGitStatus("ws-1");

    expect(callRpc).toHaveBeenCalledWith("get_git_status", { workspaceId: "ws-1" });
  });

  it("applies default limit for git log", async () => {
    vi.mocked(callRpc).mockResolvedValueOnce({
      total: 0,
      entries: [],
      ahead: 0,
      behind: 0,
      aheadEntries: [],
      behindEntries: [],
      upstream: null,
    });

    await getGitLog("ws-3");

    expect(callRpc).toHaveBeenCalledWith("get_git_log", {
      workspaceId: "ws-3",
      limit: 40,
    });
  });

  it("maps workspaceId to workspaceId for GitHub issues", async () => {
    vi.mocked(callRpc).mockResolvedValueOnce({ total: 0, issues: [] });

    await getGitHubIssues("ws-2");

    expect(callRpc).toHaveBeenCalledWith("get_github_issues", { workspaceId: "ws-2" });
  });

  it("returns an empty list when the RPC bridge is unavailable", async () => {
    vi.mocked(callRpc).mockRejectedValueOnce(new Error("websocket disconnected"));

    await expect(listWorkspaces()).resolves.toEqual([]);
    expect(callRpc).toHaveBeenCalledWith("list_workspaces", {});
  });

  it("reads/writes AGENTS.md and agent.md via file_read/file_write", async () => {
    vi.mocked(callRpc)
      .mockResolvedValueOnce({ exists: true, content: "# Global", truncated: false })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ exists: true, content: "# Agent", truncated: false })
      .mockResolvedValueOnce(undefined);

    await readGlobalAgentsMd();
    await writeGlobalAgentsMd("# Global");
    await readAgentMd("ws-agent");
    await writeAgentMd("ws-agent", "# Agent");

    expect(callRpc).toHaveBeenNthCalledWith(1, "file_read", {
      scope: "global",
      kind: "agents",
      workspaceId: undefined,
    });
    expect(callRpc).toHaveBeenNthCalledWith(2, "file_write", {
      scope: "global",
      kind: "agents",
      workspaceId: undefined,
      content: "# Global",
    });
    expect(callRpc).toHaveBeenNthCalledWith(3, "file_read", {
      scope: "workspace",
      kind: "agents",
      workspaceId: "ws-agent",
    });
    expect(callRpc).toHaveBeenNthCalledWith(4, "file_write", {
      scope: "workspace",
      kind: "agents",
      workspaceId: "ws-agent",
      content: "# Agent",
    });
  });

  it("maps workspaceId/threadId/name for set_thread_name", async () => {
    vi.mocked(callRpc).mockResolvedValueOnce(undefined);

    await setThreadName("ws-9", "thread-9", "New Name");

    expect(callRpc).toHaveBeenCalledWith("set_thread_name", {
      workspaceId: "ws-9",
      threadId: "thread-9",
      name: "New Name",
    });
  });
});

