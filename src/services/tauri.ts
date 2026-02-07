import {
  cancelDictationWeb,
  getDictationModelStatusWeb,
  requestDictationPermissionWeb,
  startDictationWeb,
  stopDictationWeb,
} from "../platform/dictation";
import { openFileDialog } from "../platform/dialog";
import { callRpc } from "../platform/rpcClient";
import type {
  AppSettings,
  CodexDoctorResult,
  DictationModelStatus,
  DictationSessionState,
  LocalUsageSnapshot,
  WorkspaceInfo,
  WorkspaceSettings,
} from "../types";
import type {
  GitCommitDiff,
  GitFileDiff,
  GitFileStatus,
  GitHubIssuesResponse,
  GitHubPullRequestComment,
  GitHubPullRequestDiff,
  GitHubPullRequestsResponse,
  GitLogResponse,
  ReviewTarget,
} from "../types";

async function rpcCall<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  return callRpc<T>(method, params ?? {});
}

function isRpcUnavailable(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  return /websocket|rpc|failed|disconnected/i.test(error.message);
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read image"));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read image"));
    };
    reader.readAsDataURL(file);
  });
}

async function pickFilesFromBrowser(filters?: { name: string; extensions: string[] }[]) {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    const accepts = filters
      ?.flatMap((filter) => filter.extensions)
      .map((ext) => ext.trim().replace(/^\./, ""))
      .filter(Boolean)
      .map((ext) => `.${ext}`)
      .join(",");
    if (accepts) {
      input.accept = accepts;
    }
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.addEventListener(
      "change",
      () => {
        const files = Array.from(input.files ?? []);
        input.remove();
        resolve(files);
      },
      { once: true },
    );
    input.click();
  });
}

export async function pickWorkspacePath(): Promise<string | null> {
  const lastValue =
    typeof window !== "undefined"
      ? window.localStorage.getItem("codex_monitor_last_workspace_path") ?? ""
      : "";
  const value = window.prompt("Enter local workspace path", lastValue);
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (typeof window !== "undefined") {
    window.localStorage.setItem("codex_monitor_last_workspace_path", trimmed);
  }
  return trimmed;
}

export async function pickImageFiles(): Promise<string[]> {
  const files = await pickFilesFromBrowser([
    {
      name: "Images",
      extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"],
    },
  ]);
  if (files.length === 0) {
    return [];
  }
  const encoded = await Promise.all(files.map((file) => readFileAsDataUrl(file)));
  return encoded.filter(Boolean);
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  try {
    return await rpcCall<WorkspaceInfo[]>("list_workspaces");
  } catch (error) {
    if (isRpcUnavailable(error)) {
      console.warn("RPC unavailable; returning empty workspaces list.");
      return [];
    }
    throw error;
  }
}

export async function getCodexConfigPath(): Promise<string> {
  return rpcCall<string>("get_codex_config_path");
}

export type TextFileResponse = {
  exists: boolean;
  content: string;
  truncated: boolean;
};

export type GlobalAgentsResponse = TextFileResponse;
export type GlobalCodexConfigResponse = TextFileResponse;
export type AgentMdResponse = TextFileResponse;

type FileScope = "workspace" | "global";
type FileKind = "agents" | "config";

async function fileRead(
  scope: FileScope,
  kind: FileKind,
  workspaceId?: string,
): Promise<TextFileResponse> {
  return rpcCall<TextFileResponse>("file_read", { scope, kind, workspaceId });
}

async function fileWrite(
  scope: FileScope,
  kind: FileKind,
  content: string,
  workspaceId?: string,
): Promise<void> {
  await rpcCall("file_write", { scope, kind, workspaceId, content });
}

export async function readGlobalAgentsMd(): Promise<GlobalAgentsResponse> {
  return fileRead("global", "agents");
}

export async function writeGlobalAgentsMd(content: string): Promise<void> {
  await fileWrite("global", "agents", content);
}

export async function readGlobalCodexConfigToml(): Promise<GlobalCodexConfigResponse> {
  return fileRead("global", "config");
}

export async function writeGlobalCodexConfigToml(content: string): Promise<void> {
  await fileWrite("global", "config", content);
}

export async function getConfigModel(workspaceId: string): Promise<string | null> {
  const response = await rpcCall<{ model?: string | null }>("get_config_model", {
    workspaceId,
  });
  const model = response?.model;
  if (typeof model !== "string") {
    return null;
  }
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function addWorkspace(
  path: string,
  codex_bin: string | null,
): Promise<WorkspaceInfo> {
  return rpcCall<WorkspaceInfo>("add_workspace", { path, codex_bin });
}

export async function isWorkspacePathDir(path: string): Promise<boolean> {
  return rpcCall<boolean>("is_workspace_path_dir", { path });
}

export async function addClone(
  sourceWorkspaceId: string,
  copiesFolder: string,
  copyName: string,
): Promise<WorkspaceInfo> {
  return rpcCall<WorkspaceInfo>("add_clone", {
    sourceWorkspaceId,
    copiesFolder,
    copyName,
  });
}

export async function addWorktree(
  parentId: string,
  branch: string,
  name: string | null,
  copyAgentsMd = true,
): Promise<WorkspaceInfo> {
  return rpcCall<WorkspaceInfo>("add_worktree", { parentId, branch, name, copyAgentsMd });
}

export type WorktreeSetupStatus = {
  shouldRun: boolean;
  script: string | null;
};

export async function getWorktreeSetupStatus(
  workspaceId: string,
): Promise<WorktreeSetupStatus> {
  return rpcCall<WorktreeSetupStatus>("worktree_setup_status", { workspaceId });
}

export async function markWorktreeSetupRan(workspaceId: string): Promise<void> {
  await rpcCall("worktree_setup_mark_ran", { workspaceId });
}

export async function updateWorkspaceSettings(
  id: string,
  settings: WorkspaceSettings,
): Promise<WorkspaceInfo> {
  return rpcCall<WorkspaceInfo>("update_workspace_settings", { id, settings });
}

export async function updateWorkspaceCodexBin(
  id: string,
  codex_bin: string | null,
): Promise<WorkspaceInfo> {
  return rpcCall<WorkspaceInfo>("update_workspace_codex_bin", { id, codex_bin });
}

export async function removeWorkspace(id: string): Promise<void> {
  await rpcCall("remove_workspace", { id });
}

export async function removeWorktree(id: string): Promise<void> {
  await rpcCall("remove_worktree", { id });
}

export async function renameWorktree(
  id: string,
  branch: string,
): Promise<WorkspaceInfo> {
  return rpcCall<WorkspaceInfo>("rename_worktree", { id, branch });
}

export async function renameWorktreeUpstream(
  id: string,
  oldBranch: string,
  newBranch: string,
): Promise<void> {
  await rpcCall("rename_worktree_upstream", { id, oldBranch, newBranch });
}

export async function applyWorktreeChanges(workspaceId: string): Promise<void> {
  await rpcCall("apply_worktree_changes", { workspaceId });
}

export async function openWorkspaceIn(
  path: string,
  options: {
    appName?: string | null;
    command?: string | null;
    args?: string[];
  },
): Promise<void> {
  await rpcCall("open_workspace_in", {
    path,
    app: options.appName ?? null,
    command: options.command ?? null,
    args: options.args ?? [],
  });
}

export async function revealItemInDir(path: string): Promise<void> {
  await rpcCall("reveal_item_in_dir", { path });
}

export async function getOpenAppIcon(appName: string): Promise<string | null> {
  return rpcCall<string | null>("get_open_app_icon", { appName });
}

export async function connectWorkspace(id: string): Promise<void> {
  await rpcCall("connect_workspace", { id });
}

export async function startThread(workspaceId: string) {
  return rpcCall<any>("start_thread", { workspaceId });
}

export async function forkThread(workspaceId: string, threadId: string) {
  return rpcCall<any>("fork_thread", { workspaceId, threadId });
}

export async function compactThread(workspaceId: string, threadId: string) {
  return rpcCall<any>("compact_thread", { workspaceId, threadId });
}

export async function sendUserMessage(
  workspaceId: string,
  threadId: string,
  text: string,
  options?: {
    model?: string | null;
    effort?: string | null;
    accessMode?: "read-only" | "current" | "full-access";
    images?: string[];
    collaborationMode?: Record<string, unknown> | null;
  },
) {
  const payload: Record<string, unknown> = {
    workspaceId,
    threadId,
    text,
    model: options?.model ?? null,
    effort: options?.effort ?? null,
    accessMode: options?.accessMode ?? null,
    images: options?.images ?? null,
  };
  if (options?.collaborationMode) {
    payload.collaborationMode = options.collaborationMode;
  }
  return rpcCall("send_user_message", payload);
}

export async function interruptTurn(
  workspaceId: string,
  threadId: string,
  turnId: string,
) {
  return rpcCall("turn_interrupt", { workspaceId, threadId, turnId });
}

export async function startReview(
  workspaceId: string,
  threadId: string,
  target: ReviewTarget,
  delivery?: "inline" | "detached",
) {
  const payload: Record<string, unknown> = { workspaceId, threadId, target };
  if (delivery) {
    payload.delivery = delivery;
  }
  return rpcCall("start_review", payload);
}

export async function respondToServerRequest(
  workspaceId: string,
  requestId: number | string,
  decision: "accept" | "decline",
) {
  return rpcCall("respond_to_server_request", {
    workspaceId,
    requestId,
    result: { decision },
  });
}

export async function respondToUserInputRequest(
  workspaceId: string,
  requestId: number | string,
  answers: Record<string, { answers: string[] }>,
) {
  return rpcCall("respond_to_server_request", {
    workspaceId,
    requestId,
    result: { answers },
  });
}

export async function rememberApprovalRule(
  workspaceId: string,
  command: string[],
) {
  return rpcCall("remember_approval_rule", { workspaceId, command });
}

export async function getGitStatus(workspace_id: string): Promise<{
  branchName: string;
  files: GitFileStatus[];
  stagedFiles: GitFileStatus[];
  unstagedFiles: GitFileStatus[];
  totalAdditions: number;
  totalDeletions: number;
}> {
  return rpcCall("get_git_status", { workspaceId: workspace_id });
}

export async function listGitRoots(
  workspace_id: string,
  depth: number,
): Promise<string[]> {
  return rpcCall("list_git_roots", { workspaceId: workspace_id, depth });
}

export async function getGitDiffs(
  workspace_id: string,
): Promise<GitFileDiff[]> {
  return rpcCall("get_git_diffs", { workspaceId: workspace_id });
}

export async function getGitLog(
  workspace_id: string,
  limit = 40,
): Promise<GitLogResponse> {
  return rpcCall("get_git_log", { workspaceId: workspace_id, limit });
}

export async function getGitCommitDiff(
  workspace_id: string,
  sha: string,
): Promise<GitCommitDiff[]> {
  return rpcCall("get_git_commit_diff", { workspaceId: workspace_id, sha });
}

export async function getGitRemote(workspace_id: string): Promise<string | null> {
  return rpcCall("get_git_remote", { workspaceId: workspace_id });
}

export async function stageGitFile(workspaceId: string, path: string) {
  return rpcCall("stage_git_file", { workspaceId, path });
}

export async function stageGitAll(workspaceId: string): Promise<void> {
  await rpcCall("stage_git_all", { workspaceId });
}

export async function unstageGitFile(workspaceId: string, path: string) {
  return rpcCall("unstage_git_file", { workspaceId, path });
}

export async function revertGitFile(workspaceId: string, path: string) {
  return rpcCall("revert_git_file", { workspaceId, path });
}

export async function revertGitAll(workspaceId: string) {
  return rpcCall("revert_git_all", { workspaceId });
}

export async function commitGit(
  workspaceId: string,
  message: string,
): Promise<void> {
  await rpcCall("commit_git", { workspaceId, message });
}

export async function pushGit(workspaceId: string): Promise<void> {
  await rpcCall("push_git", { workspaceId });
}

export async function pullGit(workspaceId: string): Promise<void> {
  await rpcCall("pull_git", { workspaceId });
}

export async function fetchGit(workspaceId: string): Promise<void> {
  await rpcCall("fetch_git", { workspaceId });
}

export async function syncGit(workspaceId: string): Promise<void> {
  await rpcCall("sync_git", { workspaceId });
}

export async function getGitHubIssues(
  workspace_id: string,
): Promise<GitHubIssuesResponse> {
  return rpcCall("get_github_issues", { workspaceId: workspace_id });
}

export async function getGitHubPullRequests(
  workspace_id: string,
): Promise<GitHubPullRequestsResponse> {
  return rpcCall("get_github_pull_requests", { workspaceId: workspace_id });
}

export async function getGitHubPullRequestDiff(
  workspace_id: string,
  prNumber: number,
): Promise<GitHubPullRequestDiff[]> {
  return rpcCall("get_github_pull_request_diff", {
    workspaceId: workspace_id,
    prNumber,
  });
}

export async function getGitHubPullRequestComments(
  workspace_id: string,
  prNumber: number,
): Promise<GitHubPullRequestComment[]> {
  return rpcCall("get_github_pull_request_comments", {
    workspaceId: workspace_id,
    prNumber,
  });
}

export async function localUsageSnapshot(
  days?: number,
  workspacePath?: string | null,
): Promise<LocalUsageSnapshot> {
  const payload: { days: number; workspacePath?: string } = { days: days ?? 30 };
  if (workspacePath) {
    payload.workspacePath = workspacePath;
  }
  return rpcCall("local_usage_snapshot", payload);
}

export async function getModelList(workspaceId: string) {
  return rpcCall<any>("model_list", { workspaceId });
}

export async function generateRunMetadata(workspaceId: string, prompt: string) {
  return rpcCall<{ title: string; worktreeName: string }>("generate_run_metadata", {
    workspaceId,
    prompt,
  });
}

export async function getCollaborationModes(workspaceId: string) {
  return rpcCall<any>("collaboration_mode_list", { workspaceId });
}

export async function getAccountRateLimits(workspaceId: string) {
  return rpcCall<any>("account_rate_limits", { workspaceId });
}

export async function getAccountInfo(workspaceId: string) {
  return rpcCall<any>("account_read", { workspaceId });
}

export async function runCodexLogin(workspaceId: string) {
  return rpcCall<{ loginId: string; authUrl: string; raw?: unknown }>("codex_login", {
    workspaceId,
  });
}

export async function cancelCodexLogin(workspaceId: string) {
  return rpcCall<{ canceled: boolean; status?: string; raw?: unknown }>(
    "codex_login_cancel",
    { workspaceId },
  );
}

export async function getSkillsList(workspaceId: string) {
  return rpcCall<any>("skills_list", { workspaceId });
}

export async function getAppsList(
  workspaceId: string,
  cursor?: string | null,
  limit?: number | null,
) {
  return rpcCall<any>("apps_list", { workspaceId, cursor, limit });
}

export async function getPromptsList(workspaceId: string) {
  return rpcCall<any>("prompts_list", { workspaceId });
}

export async function getWorkspacePromptsDir(workspaceId: string) {
  return rpcCall<string>("prompts_workspace_dir", { workspaceId });
}

export async function getGlobalPromptsDir(workspaceId: string) {
  return rpcCall<string>("prompts_global_dir", { workspaceId });
}

export async function createPrompt(
  workspaceId: string,
  data: {
    scope: "workspace" | "global";
    name: string;
    description?: string | null;
    argumentHint?: string | null;
    content: string;
  },
) {
  return rpcCall<any>("prompts_create", {
    workspaceId,
    scope: data.scope,
    name: data.name,
    description: data.description ?? null,
    argumentHint: data.argumentHint ?? null,
    content: data.content,
  });
}

export async function updatePrompt(
  workspaceId: string,
  data: {
    path: string;
    name: string;
    description?: string | null;
    argumentHint?: string | null;
    content: string;
  },
) {
  return rpcCall<any>("prompts_update", {
    workspaceId,
    path: data.path,
    name: data.name,
    description: data.description ?? null,
    argumentHint: data.argumentHint ?? null,
    content: data.content,
  });
}

export async function deletePrompt(workspaceId: string, path: string) {
  return rpcCall<any>("prompts_delete", { workspaceId, path });
}

export async function movePrompt(
  workspaceId: string,
  data: { path: string; scope: "workspace" | "global" },
) {
  return rpcCall<any>("prompts_move", {
    workspaceId,
    path: data.path,
    scope: data.scope,
  });
}

export async function getAppSettings(): Promise<AppSettings> {
  return rpcCall<AppSettings>("get_app_settings");
}

export async function updateAppSettings(settings: AppSettings): Promise<AppSettings> {
  return rpcCall<AppSettings>("update_app_settings", { settings });
}

export async function setMenuAccelerators(
  updates: Array<{ id: string; accelerator: string | null }>,
): Promise<void> {
  try {
    await rpcCall("menu_set_accelerators", { updates });
  } catch (error) {
    console.warn("menu_set_accelerators failed", error);
  }
}

export async function runCodexDoctor(
  codexBin?: string | null,
  codexArgs?: string | null,
): Promise<CodexDoctorResult> {
  return rpcCall<CodexDoctorResult>("codex_doctor", {
    codexBin: codexBin ?? null,
    codexArgs: codexArgs ?? null,
  });
}

export async function getWorkspaceFiles(workspaceId: string) {
  return rpcCall<string[]>("list_workspace_files", { workspaceId });
}

export async function readWorkspaceFile(
  workspaceId: string,
  path: string,
): Promise<{ content: string; truncated: boolean }> {
  return rpcCall("read_workspace_file", { workspaceId, path });
}

export async function readAgentMd(workspaceId: string): Promise<AgentMdResponse> {
  return fileRead("workspace", "agents", workspaceId);
}

export async function writeAgentMd(workspaceId: string, content: string): Promise<void> {
  await fileWrite("workspace", "agents", content, workspaceId);
}

export async function listGitBranches(workspaceId: string) {
  return rpcCall<any>("list_git_branches", { workspaceId });
}

export async function checkoutGitBranch(workspaceId: string, name: string) {
  return rpcCall("checkout_git_branch", { workspaceId, name });
}

export async function createGitBranch(workspaceId: string, name: string) {
  return rpcCall("create_git_branch", { workspaceId, name });
}

function withModelId(modelId?: string | null) {
  return modelId ? { modelId } : {};
}

export async function getDictationModelStatus(
  modelId?: string | null,
): Promise<DictationModelStatus> {
  const resolvedModelId = modelId ?? "web-speech";
  return getDictationModelStatusWeb(resolvedModelId);
}

export async function downloadDictationModel(
  modelId?: string | null,
): Promise<DictationModelStatus> {
  return getDictationModelStatus(modelId);
}

export async function cancelDictationDownload(
  modelId?: string | null,
): Promise<DictationModelStatus> {
  return getDictationModelStatus(modelId);
}

export async function removeDictationModel(
  modelId?: string | null,
): Promise<DictationModelStatus> {
  return getDictationModelStatus(modelId);
}

export async function startDictation(
  preferredLanguage: string | null,
): Promise<DictationSessionState> {
  return startDictationWeb(preferredLanguage);
}

export async function requestDictationPermission(): Promise<boolean> {
  return requestDictationPermissionWeb();
}

export async function stopDictation(): Promise<DictationSessionState> {
  return stopDictationWeb();
}

export async function cancelDictation(): Promise<DictationSessionState> {
  return cancelDictationWeb();
}

export async function openTerminalSession(
  workspaceId: string,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<{ id: string }> {
  return rpcCall("terminal_open", { workspaceId, terminalId, cols, rows });
}

export async function writeTerminalSession(
  workspaceId: string,
  terminalId: string,
  data: string,
): Promise<void> {
  await rpcCall("terminal_write", { workspaceId, terminalId, data });
}

export async function resizeTerminalSession(
  workspaceId: string,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await rpcCall("terminal_resize", { workspaceId, terminalId, cols, rows });
}

export async function closeTerminalSession(
  workspaceId: string,
  terminalId: string,
): Promise<void> {
  await rpcCall("terminal_close", { workspaceId, terminalId });
}

export async function listThreads(
  workspaceId: string,
  cursor?: string | null,
  limit?: number | null,
  sortKey?: "created_at" | "updated_at" | null,
) {
  return rpcCall<any>("list_threads", { workspaceId, cursor, limit, sortKey });
}

export async function listMcpServerStatus(
  workspaceId: string,
  cursor?: string | null,
  limit?: number | null,
) {
  return rpcCall<any>("list_mcp_server_status", { workspaceId, cursor, limit });
}

export async function resumeThread(workspaceId: string, threadId: string) {
  return rpcCall<any>("resume_thread", { workspaceId, threadId });
}

export async function archiveThread(workspaceId: string, threadId: string) {
  return rpcCall<any>("archive_thread", { workspaceId, threadId });
}

export async function setThreadName(
  workspaceId: string,
  threadId: string,
  name: string,
) {
  return rpcCall<any>("set_thread_name", { workspaceId, threadId, name });
}

export async function getCommitMessagePrompt(
  workspaceId: string,
): Promise<string> {
  return rpcCall("get_commit_message_prompt", { workspaceId });
}

export async function generateCommitMessage(
  workspaceId: string,
): Promise<string> {
  return rpcCall("generate_commit_message", { workspaceId });
}

export async function sendNotification(
  title: string,
  body: string,
  options?: {
    id?: number;
    group?: string;
    actionTypeId?: string;
    sound?: string;
    autoCancel?: boolean;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const fallback = async () => {
    try {
      await rpcCall("send_notification_fallback", { title, body, options });
    } catch {
      // no-op fallback
    }
  };

  if (typeof window === "undefined" || !("Notification" in window)) {
    await fallback();
    return;
  }

  try {
    let permission = Notification.permission;
    if (permission !== "granted") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") {
      await fallback();
      return;
    }
    new Notification(title, {
      body,
    });
  } catch {
    await fallback();
  }
}

export async function openFilePicker(options?: {
  multiple?: boolean;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | string[] | null> {
  return openFileDialog(options);
}

export { withModelId };
