# CodexMonitor Web 前后端分离重构 Plan

## 目标
将 CodexMonitor 从 Tauri 桌面形态重构为 **Web 前后端分离**：
- 前端：纯浏览器运行（React/Vite），不再依赖任何 `@tauri-apps/*` / `tauri-plugin-*`
- 后端：本机 Rust 服务，提供 WebSocket JSON-RPC + HTTP（文件/图片）能力
- 功能范围：业务能力全保留；桌面壳能力用 Web 等价/降级实现

## 成功标准（验收）
1. 前端 `npm run build` 成功，且 `src/` 代码中无 `@tauri-apps/`、`tauri-plugin-` 直接 import。
2. Web 前端可通过 WS 连接后端，核心闭环可用：
   - 添加 workspace（手动输入路径）→ connect → start thread → send message → 收到 app-server 事件并渲染
3. 文件树与预览可用：
   - 文本预览：RPC `read_workspace_file`
   - 图片预览：HTTP `/api/workspaces/:id/file`
4. Git/GitHub/Prompts/Terminal/Remote backend 等业务能力可用。
5. 听写：Web Speech API（不支持则提示，不影响其他功能）。
6. 更新：Web 版实现“检查新版本并引导下载”（不做自动安装/重启）。

## 关键架构
### 前端
- 统一改造 `src/services/*`：
  - `src/services/tauri.ts` → 改为 `rpc.call(method, params)`（保留导出函数签名，减少上层改动）
  - `src/services/events.ts` → 不用 `listen`，改为订阅 `rpc` 通知事件（`app-server-event/terminal-output/terminal-exit`）
  - `src/services/dragDrop.ts` → 改为 DOM drag/drop（无系统路径，按 Web 限制处理）
- 新增 `src/platform/*` 作为 “Tauri 替代层”：
  - `rpcClient.ts`、`contextMenu.tsx`、`dialog.ts`、`opener.ts`、`fileSrc.ts`、`dictation.ts`、`window.ts`

### 后端
- 新增 Rust server（建议新 crate `server/`，或先在原仓库新增 bin）：
  - WS：`/rpc`（JSON-RPC）
  - HTTP：`/api/workspaces/:id/file`（替代 convertFileSrc）
- 最大复用现有 Rust 逻辑：
  - 以 `src-tauri/src/bin/codex_monitor_daemon.rs` 的方法分发为基底
  - 复用 `src-tauri/src/shared/*`、`backend/app_server.rs`、workspaces/git/files/prompts/terminal 相关逻辑
- 事件：后端内部 broadcast，WS 连接转发为通知。

## Tauri API 重写映射（必须清零）
> 目标：所有原 `@tauri-apps/*` / `tauri-plugin-*` 引用都替换为 platform 或后端 RPC。

- `@tauri-apps/api/core.invoke` → `rpc.call`
- `@tauri-apps/api/event.listen` → `rpc notifications` + 前端 event hub
- `@tauri-apps/plugin-dialog`（ask/message/open）→ `platform/dialog`（confirm/alert/file input + 手动路径输入）
- `@tauri-apps/plugin-opener`（openUrl/revealItemInDir）→
  - `openUrl`：`window.open`
  - `reveal`：后端 RPC `reveal_path`
- `@tauri-apps/api/menu` / `dpi` / `window`（popup 菜单）→ `platform/contextMenu`（自绘）
- `convertFileSrc(localPath)` → `platform/fileSrc`（HTTP file endpoint）
- `plugin-updater` / `plugin-process.relaunch` → Web 更新页（GitHub Releases）引导下载
- `getCurrentWebview().setZoom` → `document.documentElement.style.zoom`
- `startDragging / liquid-glass` → Web no-op（保留 UI 开关但不做系统效果）
- `onDragDropEvent` → DOM drag/drop（仅拿到 File，不拿路径）

## 实施顺序（最小代价、先跑通再补全）
1. 后端：WS JSON-RPC 骨架 + `ping` + 基础 state（settings/workspaces 读写）
2. 前端：`rpcClient` + 改 `services/tauri.ts` 的调用层，跑通 `list_workspaces`
3. 核心闭环：connect workspace + app-server session + threads + send_user_message + app-server-event 渲染
4. 资源：HTTP `/api/.../file` + 前端替换所有 `convertFileSrc`
5. Terminal：后端 pty + RPC + 事件输出，前端订阅渲染
6. Git/GitHub/Prompts：补齐 RPC（优先按现有前端调用路径）
7. Web-only：听写改 Web Speech；更新器改引导下载；移除残余 Tauri imports
8. 验收：build、回归、README（Web 运行方式）

## 风险与对策
- Web 无法获取本机文件路径（drag/drop、选择目录）：按你已选“手动输入路径”；拖入附件只支持 File→dataURL。
- 安全：HTTP file endpoint 必须限制在 workspace 根目录内。
- “全部功能”：桌面壳能力（玻璃、拖拽窗、自动更新）Web 只能降级；其余业务能力保持。

