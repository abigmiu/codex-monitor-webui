# CodexMonitor Web 前后端分离 Task List

## 0. 约束检查（阻断项）
- [ ] 前端源码内禁止 `@tauri-apps/*` / `tauri-plugin-*` 直接 import（允许在测试 mock 中出现，但最终也建议移除）
- [ ] `npm run build` 必须通过（作为每阶段验收）

## 1. 后端：新建 Web 服务骨架（WS + HTTP）
- [ ] 新增 Rust server 二进制（建议 `server/` crate）支持参数：
  - `--listen 127.0.0.1:4732`
  - `--data-dir <path>`
  - `--token <optional>`
- [ ] 实现 WebSocket `/rpc` JSON-RPC：
  - [ ] `call(method, params)` 分发框架（复用 daemon `match method`)
  - [ ] pending/response：按 id 回写 result/error
  - [ ] 通知：支持广播 `app-server-event/terminal-output/terminal-exit`
- [ ] 实现 HTTP：
  - [ ] `GET /api/workspaces/:workspaceId/file?path=...`（只允许 workspace 根目录内）
  - [ ] `Content-Type` 正确（至少图片/png,jpg,gif,webp + text/plain）

## 2. 前端：新增 platform 层与 RPC client
- [ ] 新增 `src/platform/rpcClient.ts`：
  - [ ] `connect()`、`call()`、超时、重连、通知订阅
- [ ] 改造 `src/services/events.ts`：
  - [ ] 删除 `@tauri-apps/api/event` 依赖
  - [ ] 订阅 rpc notifications，维持现有 `subscribeXxx` API 不变
- [ ] 改造 `src/services/tauri.ts`：
  - [ ] 删除 `invoke/open` 依赖
  - [ ] 全部方法改走 `rpc.call`
  - [ ] `pickWorkspacePath()` 改为返回 `null`（由 UI 改成手动输入，不再弹系统目录选择）
  - [ ] `pickImageFiles()` 改为 Web file input，输出 `data:` URL（或返回 dataURL 列表）

## 3. 前端：清理/替换 Tauri API 直接引用（按文件）
### 3.1 Context Menu（menu/dpi/window）
- [ ] 新增 `src/platform/contextMenu.tsx` 自绘菜单
- [ ] 替换以下文件中的 `Menu/MenuItem/LogicalPosition/getCurrentWindow().popup`：
  - [ ] `src/features/files/components/FileTreePanel.tsx`
  - [ ] `src/features/messages/hooks/useFileLinkOpener.ts`
  - [ ] `src/features/app/hooks/useSidebarMenus.ts`
  - [ ] `src/features/git/components/GitDiffPanel.tsx`
  - [ ] `src/features/prompts/components/PromptPanel.tsx`
  - [ ] `src/features/composer/components/ComposerQueue.tsx`

### 3.2 opener（openUrl/revealItemInDir）
- [ ] 新增 `src/platform/opener.ts`
- [ ] 替换：
  - [ ] `src/features/messages/components/Markdown.tsx`（链接打开）
  - [ ] `src/features/messages/hooks/useFileLinkOpener.ts`（Reveal / Open in app/command 走后端 RPC）

### 3.3 convertFileSrc（本机路径资源）
- [ ] 新增 `src/platform/fileSrc.ts`（拼 `/api/workspaces/:id/file?...`）
- [ ] 替换：
  - [ ] `src/features/composer/components/ComposerAttachments.tsx`
  - [ ] `src/features/workspaces/components/WorkspaceHome.tsx`（icon.png）
  - [ ] `src/features/files/components/FileTreePanel.tsx`（图片预览）
  - [ ] `src/features/messages/components/Messages.tsx`（消息图片）

### 3.4 dialog（ask/message/open）
- [ ] 新增 `src/platform/dialog.ts`（confirm/alert/file input）
- [ ] 替换所有 `@tauri-apps/plugin-dialog` 引用：
  - [ ] `src/features/settings/components/SettingsView.tsx`
  - [ ] `src/features/workspaces/hooks/useWorkspaces.ts`
  - [ ] `src/features/git/hooks/useGitActions.ts`
  - [ ] 其他扫描到的引用点

### 3.5 updater / process
- [ ] 重写 `src/features/update/hooks/useUpdater.ts`：
  - [ ] Web 版：检查 GitHub Releases（或后端提供版本接口），并打开下载页
  - [ ] 删除 `isTauri/check/relaunch` 依赖

### 3.6 window/webview/liquid glass/dragdrop
- [ ] `src/features/layout/hooks/useWindowFocusState.ts`：仅保留 DOM focus/blur/visibility
- [ ] `src/features/layout/hooks/useWindowDrag.ts`：Web no-op
- [ ] `src/features/layout/hooks/useUiScaleShortcuts.ts`：用 `documentElement.style.zoom`
- [ ] `src/features/app/hooks/useLiquidGlassEffect.ts`：Web no-op
- [ ] `src/services/dragDrop.ts`：DOM drag/drop（输出仅含 enter/over/leave/drop + File 列表，不含路径）

## 4. 听写（Web Speech API）
- [ ] 新增 `src/platform/dictation.ts`（SpeechRecognition 适配）
- [ ] 修改 `src/features/dictation/hooks/useDictation.ts` 不再依赖 tauri dictation 命令
- [ ] Settings 中“模型下载/管理”区块改为“浏览器支持与语言设置”（保留入口但语义调整）

## 5. 后端：补齐业务 RPC（按现有前端调用对齐）
- [ ] Workspaces/Threads/Codex：
  - [ ] `list_workspaces/add_workspace/add_worktree/add_clone/remove_* /connect_workspace/...`
  - [ ] `start_thread/resume_thread/list_threads/send_user_message/turn_interrupt/archive_thread/set_thread_name`
- [ ] Files/Prompts：
  - [ ] `list_workspace_files/read_workspace_file/file_read/file_write`
  - [ ] `prompts_list/create/update/delete/move/prompts_*_dir`
- [ ] Git/GitHub：对齐 `src/services/tauri.ts` 现有方法
- [ ] Terminal：对齐 `terminal_open/write/resize/close` + 事件

## 6. 回归与验收
- [ ] `npm run build` 通过
- [ ] Web 全流程手测：workspace→thread→message→events→files→git→github→prompts→terminal→dictation→update
- [ ] README：新增 Web 启动方式（后端端口、data-dir、可选 token）

