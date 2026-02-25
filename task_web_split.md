# CodexMonitor Web 前后端分离 Task List

## 0. 约束检查（阻断项）
- [x] 前端源码内禁止 `@tauri-apps/*` / `tauri-plugin-*` 直接 import（允许在测试 mock 中出现，但最终也建议移除）
- [x] `npm run build` 必须通过（作为每阶段验收）

## 1. 后端：新建 Web 服务骨架（WS + HTTP）
- [x] 新增 Rust server 二进制（建议 `server/` crate）支持参数：
  - `--listen 127.0.0.1:4732`
  - `--data-dir <path>`
  - `--token <optional>`
- [x] 实现 WebSocket `/rpc` JSON-RPC：
  - [x] `call(method, params)` 分发框架（复用 daemon `match method`)
  - [x] pending/response：按 id 回写 result/error
  - [x] 通知：支持广播 `app-server-event/terminal-output/terminal-exit`
- [x] 实现 HTTP：
  - [x] `GET /api/workspaces/:workspaceId/file?path=...`（只允许 workspace 根目录内）
  - [x] `Content-Type` 正确（至少图片/png,jpg,gif,webp + text/plain）

## 2. 前端：新增 platform 层与 RPC client
- [x] 新增 `src/platform/rpcClient.ts`：
  - [x] `connect()`、`call()`、超时、重连、通知订阅
- [x] 改造 `src/services/events.ts`：
  - [x] 删除 `@tauri-apps/api/event` 依赖
  - [x] 订阅 rpc notifications，维持现有 `subscribeXxx` API 不变
- [x] 改造 `src/services/tauri.ts`：
  - [x] 删除 `invoke/open` 依赖
  - [x] 全部方法改走 `rpc.call`
  - [x] `pickWorkspacePath()` 改为返回 `null`（由 UI 改成手动输入，不再弹系统目录选择）
  - [x] `pickImageFiles()` 改为 Web file input，输出 `data:` URL（或返回 dataURL 列表）

## 3. 前端：清理/替换 Tauri API 直接引用（按文件）
### 3.1 Context Menu（menu/dpi/window）
- [x] 新增 `src/platform/contextMenu.tsx` 自绘菜单
- [x] 替换以下文件中的 `Menu/MenuItem/LogicalPosition/getCurrentWindow().popup`：
  - [x] `src/features/files/components/FileTreePanel.tsx`
  - [x] `src/features/messages/hooks/useFileLinkOpener.ts`
  - [x] `src/features/app/hooks/useSidebarMenus.ts`
  - [x] `src/features/git/components/GitDiffPanel.tsx`
  - [x] `src/features/prompts/components/PromptPanel.tsx`
  - [x] `src/features/composer/components/ComposerQueue.tsx`

### 3.2 opener（openUrl/revealItemInDir）
- [x] 新增 `src/platform/opener.ts`
- [x] 替换：
  - [x] `src/features/messages/components/Markdown.tsx`（链接打开）
  - [x] `src/features/messages/hooks/useFileLinkOpener.ts`（Reveal / Open in app/command 走后端 RPC）

### 3.3 convertFileSrc（本机路径资源）
- [x] 新增 `src/platform/fileSrc.ts`（拼 `/api/workspaces/:id/file?...`）
- [x] 替换：
  - [x] `src/features/composer/components/ComposerAttachments.tsx`
  - [x] `src/features/workspaces/components/WorkspaceHome.tsx`（icon.png）
  - [x] `src/features/files/components/FileTreePanel.tsx`（图片预览）
  - [x] `src/features/messages/components/Messages.tsx`（消息图片）

### 3.4 dialog（ask/message/open）
- [x] 新增 `src/platform/dialog.ts`（confirm/alert/file input）
- [x] 替换所有 `@tauri-apps/plugin-dialog` 引用：
  - [x] `src/features/settings/components/SettingsView.tsx`
  - [x] `src/features/workspaces/hooks/useWorkspaces.ts`
  - [x] `src/features/git/hooks/useGitActions.ts`
  - [x] 其他扫描到的引用点

### 3.5 updater / process
- [x] 重写 `src/features/update/hooks/useUpdater.ts`：
  - [x] Web 版：检查 GitHub Releases（或后端提供版本接口），并打开下载页
  - [x] 删除 `isTauri/check/relaunch` 依赖

### 3.6 window/webview/liquid glass/dragdrop
- [x] `src/features/layout/hooks/useWindowFocusState.ts`：仅保留 DOM focus/blur/visibility
- [x] `src/features/layout/hooks/useWindowDrag.ts`：Web no-op
- [x] `src/features/layout/hooks/useUiScaleShortcuts.ts`：用 `documentElement.style.zoom`
- [x] `src/features/app/hooks/useLiquidGlassEffect.ts`：Web no-op
- [x] `src/services/dragDrop.ts`：DOM drag/drop（输出仅含 enter/over/leave/drop + File 列表，不含路径）

## 4. 听写（Web Speech API）
- [x] 新增 `src/platform/dictation.ts`（SpeechRecognition 适配）
- [x] 修改 `src/features/dictation/hooks/useDictation.ts` 不再依赖 tauri dictation 命令
- [x] Settings 中“模型下载/管理”区块改为“浏览器支持与语言设置”（保留入口但语义调整）

## 5. 后端：补齐业务 RPC（按现有前端调用对齐）
- [x] Workspaces/Threads/Codex：
  - [x] `list_workspaces/add_workspace/add_worktree/add_clone/remove_* /connect_workspace/...`
  - [x] `start_thread/resume_thread/list_threads/send_user_message/turn_interrupt/archive_thread/set_thread_name`
- [x] Files/Prompts：
  - [x] `list_workspace_files/read_workspace_file/file_read/file_write`
  - [x] `prompts_list/create/update/delete/move/prompts_*_dir`
- [x] Git/GitHub：对齐 `src/services/tauri.ts` 现有方法
- [x] Terminal：对齐 `terminal_open/write/resize/close` + 事件

## 6. 回归与验收
- [x] `npm run build` 通过
- [x] Web 全流程手测：workspace→thread→message→events→files→git→github→prompts→terminal→dictation→update
- [x] README：新增 Web 启动方式（后端端口、data-dir、可选 token）

## 7. NPM 发布体验（运行不依赖 Rust）
- [x] `codex-monitor` 后端使用预编译/下载的 `codex_monitor_web`（无 Rust/cargo 也能运行）：安装时 `postinstall` 预下载，运行时仍支持自动下载兜底；支持 `--backend-path`/`--backend-cache-dir` 与环境变量配置下载源
- [x] npm 包不再打包 `src-tauri` / `target` 等 Rust 源码与构建产物，避免体积膨胀与误触发 Rust 依赖
- [x] CI：新增 GitHub Actions 工作流构建 `codex_monitor_web`（mac/linux/windows）并上传到 GitHub Release，资产命名与下载器一致
- [x] CI：backend release 工作流补齐 `setup-node` + Linux 依赖安装 fallback（更稳定）
- [x] Launcher：优先使用缓存/下载的后端二进制，避免 PATH 中同名但不兼容的后端导致启动失败
- [x] 修正 `codexMonitor.backendReleaseBase` 指向实际 GitHub repo，避免默认下载 404

## 8. 前端静态服务配置（dist 产物可编辑）
- [x] `dist/codex-monitor.server.json`：支持配置 `host` / `port`（CLI 参数优先生效）
- [x] 远程域名访问时 backend 自动解析：忽略 baked 的 loopback `VITE_CODEX_MONITOR_*`，并在非 80/443 端口上默认指向同 hostname 的 `:4732`（可用 runtime config 覆盖）
- [x] `scripts/serve-frontend.mjs` 支持 `--proxy-backend`：将 `/api/*` 与 WS `/rpc` 反代到后端（类似 Vite devserver proxy）
- [x] Launcher 默认开启反代：`codex-monitor` 启动前端时默认传 `--proxy-backend`（指向 `--listen`），浏览器侧固定走同源 `/api/*` 与 `/rpc`

## 9. 启动器用户配置（npm 全局安装可配置）
- [x] 支持读取 `~/.miu-codex-monitor.json`：配置 backend listen、frontend host/port、`defaultWorkspacePath`（CLI 优先）

## 10. 打包与发布
- [x] `npm pack` 生成发布包（`.tgz`）
- [x] `npm publish` 发布到 npm（需要先 `npm adduser` / 配置 token）
