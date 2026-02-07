#[allow(dead_code)]
#[path = "../backend/mod.rs"]
mod backend;
#[path = "../codex/args.rs"]
mod codex_args;
#[path = "../codex/home.rs"]
mod codex_home;
#[path = "../codex/config.rs"]
mod codex_config;
#[path = "../files/io.rs"]
mod file_io;
#[path = "../files/ops.rs"]
mod file_ops;
#[path = "../files/policy.rs"]
mod file_policy;
#[path = "../rules.rs"]
mod rules;
#[path = "../storage.rs"]
mod storage;
#[path = "../shared/mod.rs"]
mod shared;
#[path = "../utils.rs"]
mod utils;
#[path = "../workspaces/settings.rs"]
mod workspace_settings;
#[path = "../git_utils.rs"]
mod git_utils;
#[path = "../git/mod.rs"]
mod git;
#[path = "../prompts.rs"]
mod prompts;
#[path = "../local_usage.rs"]
mod local_usage;
#[path = "../state.rs"]
mod state;
#[allow(dead_code)]
#[path = "../types.rs"]
mod types;

mod dictation {
    #[derive(Default)]
    pub(crate) struct DictationState;
}

mod remote_backend {
    #[derive(Clone)]
    pub(crate) struct RemoteBackend;
}

mod terminal {
    use std::io::Write;
    use tokio::sync::Mutex;

    pub(crate) struct TerminalSession {
        pub(crate) id: String,
        pub(crate) master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
        pub(crate) writer: Mutex<Box<dyn Write + Send>>,
        pub(crate) child: Mutex<Box<dyn portable_pty::Child + Send>>,
    }
}

mod codex {
    pub(crate) mod args {
        pub(crate) use crate::codex_args::*;
    }
    pub(crate) mod config {
        pub(crate) use crate::codex_config::*;
    }
    pub(crate) mod home {
        pub(crate) use crate::codex_home::*;
    }
    pub(crate) use crate::backend::app_server::WorkspaceSession;
}

mod files {
    pub(crate) mod io {
        pub(crate) use crate::file_io::*;
    }
    pub(crate) mod ops {
        pub(crate) use crate::file_ops::*;
    }
    pub(crate) mod policy {
        pub(crate) use crate::file_policy::*;
    }
}

use axum::extract::{ws::Message, ws::WebSocket, ws::WebSocketUpgrade, Path, Query, State as AxumState};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::sink::SinkExt;
use futures_util::stream::StreamExt;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use ignore::WalkBuilder;
use tokio::sync::{broadcast, mpsc, Mutex};
use tauri::State as TauriState;

use backend::app_server::{spawn_workspace_session, WorkspaceSession};
use backend::events::{AppServerEvent, EventSink, TerminalExit, TerminalOutput};
use shared::codex_core::CodexLoginCancelState;
use shared::{codex_core, files_core, git_core, settings_core, workspaces_core, worktree_core};
use state::AppState;
use storage::{read_settings, read_workspaces};
use types::{
    AppSettings, WorkspaceEntry, WorkspaceInfo, WorkspaceSettings, WorktreeSetupStatus,
};
use workspace_settings::apply_workspace_settings_update;

const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:4732";

fn spawn_with_client(
    event_sink: DaemonEventSink,
    client_version: String,
    entry: WorkspaceEntry,
    default_bin: Option<String>,
    codex_args: Option<String>,
    codex_home: Option<PathBuf>,
) -> impl std::future::Future<Output = Result<Arc<WorkspaceSession>, String>> {
    spawn_workspace_session(
        entry,
        default_bin,
        codex_args,
        codex_home,
        client_version,
        event_sink,
    )
}

#[derive(Clone)]
struct DaemonEventSink {
    tx: broadcast::Sender<DaemonEvent>,
}

#[derive(Clone)]
enum DaemonEvent {
    AppServer(AppServerEvent),
    #[allow(dead_code)]
    TerminalOutput(TerminalOutput),
    #[allow(dead_code)]
    TerminalExit(TerminalExit),
}

impl EventSink for DaemonEventSink {
    fn emit_app_server_event(&self, event: AppServerEvent) {
        let _ = self.tx.send(DaemonEvent::AppServer(event));
    }

    fn emit_terminal_output(&self, event: TerminalOutput) {
        let _ = self.tx.send(DaemonEvent::TerminalOutput(event));
    }

    fn emit_terminal_exit(&self, event: TerminalExit) {
        let _ = self.tx.send(DaemonEvent::TerminalExit(event));
    }
}

struct DaemonConfig {
    listen: SocketAddr,
    token: Option<String>,
    data_dir: PathBuf,
}

struct DaemonState {
    data_dir: PathBuf,
    workspaces: Mutex<HashMap<String, WorkspaceEntry>>,
    sessions: Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    terminal_sessions: Mutex<HashMap<String, Arc<terminal::TerminalSession>>>,
    storage_path: PathBuf,
    settings_path: PathBuf,
    app_settings: Mutex<AppSettings>,
    event_sink: DaemonEventSink,
    codex_login_cancels: Mutex<HashMap<String, CodexLoginCancelState>>,
}

#[derive(Serialize, Deserialize)]
struct WorkspaceFileResponse {
    content: String,
    truncated: bool,
}

impl DaemonState {
    fn load(config: &DaemonConfig, event_sink: DaemonEventSink) -> Self {
        let storage_path = config.data_dir.join("workspaces.json");
        let settings_path = config.data_dir.join("settings.json");
        let workspaces = read_workspaces(&storage_path).unwrap_or_default();
        let app_settings = read_settings(&settings_path).unwrap_or_default();
        Self {
            data_dir: config.data_dir.clone(),
            workspaces: Mutex::new(workspaces),
            sessions: Mutex::new(HashMap::new()),
            terminal_sessions: Mutex::new(HashMap::new()),
            storage_path,
            settings_path,
            app_settings: Mutex::new(app_settings),
            event_sink,
            codex_login_cancels: Mutex::new(HashMap::new()),
        }
    }

    fn as_tauri_state<'a, T: Send + Sync + 'static>(value: &'a T) -> TauriState<'a, T> {
        unsafe { std::mem::transmute::<&'a T, TauriState<'a, T>>(value) }
    }

    async fn snapshot_app_state(&self) -> AppState {
        let workspaces = self.workspaces.lock().await.clone();
        let sessions = self.sessions.lock().await.clone();
        let terminal_sessions = self.terminal_sessions.lock().await.clone();
        let app_settings = self.app_settings.lock().await.clone();
        AppState {
            workspaces: Mutex::new(workspaces),
            sessions: Mutex::new(sessions),
            terminal_sessions: Mutex::new(terminal_sessions),
            remote_backend: Mutex::new(None),
            storage_path: self.storage_path.clone(),
            settings_path: self.settings_path.clone(),
            app_settings: Mutex::new(app_settings),
            dictation: Mutex::new(dictation::DictationState::default()),
            codex_login_cancels: Mutex::new(HashMap::new()),
        }
    }

    async fn list_workspaces(&self) -> Vec<WorkspaceInfo> {
        workspaces_core::list_workspaces_core(&self.workspaces, &self.sessions).await
    }

    async fn is_workspace_path_dir(&self, path: String) -> bool {
        workspaces_core::is_workspace_path_dir_core(&path)
    }

    async fn add_workspace(
        &self,
        path: String,
        codex_bin: Option<String>,
        client_version: String,
    ) -> Result<WorkspaceInfo, String> {
        let client_version = client_version.clone();
        workspaces_core::add_workspace_core(
            path,
            codex_bin,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            &self.storage_path,
            move |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn add_clone(
        &self,
        source_workspace_id: String,
        copies_folder: String,
        copy_name: String,
        client_version: String,
    ) -> Result<WorkspaceInfo, String> {
        let trimmed_name = copy_name.trim();
        if trimmed_name.is_empty() {
            return Err("Copy name is required.".to_string());
        }
        let trimmed_folder = copies_folder.trim();
        if trimmed_folder.is_empty() {
            return Err("Copies folder is required.".to_string());
        }

        let source_entry = {
            let workspaces = self.workspaces.lock().await;
            workspaces
                .get(&source_workspace_id)
                .cloned()
                .ok_or("source workspace not found")?
        };

        let copies_folder_path = PathBuf::from(trimmed_folder);
        std::fs::create_dir_all(&copies_folder_path)
            .map_err(|err| format!("Failed to create copies folder: {err}"))?;
        if !copies_folder_path.is_dir() {
            return Err("Copies folder must be a directory.".to_string());
        }

        let destination_path =
            worktree_core::build_clone_destination_path(&copies_folder_path, trimmed_name);
        let destination_path_string = destination_path.to_string_lossy().to_string();

        git_core::run_git_command(
            &copies_folder_path,
            &["clone", &source_entry.path, &destination_path_string],
        )
        .await?;

        self.add_workspace(
            destination_path_string,
            source_entry.codex_bin.clone(),
            client_version,
        )
        .await
    }

    async fn add_worktree(
        &self,
        parent_id: String,
        branch: String,
        name: Option<String>,
        copy_agents_md: bool,
        client_version: String,
    ) -> Result<WorkspaceInfo, String> {
        let client_version = client_version.clone();
        workspaces_core::add_worktree_core(
            parent_id,
            branch,
            name,
            copy_agents_md,
            &self.data_dir,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            &self.storage_path,
            |value| worktree_core::sanitize_worktree_name(value),
            |root, name| worktree_core::unique_worktree_path_strict(root, name),
            |root, branch_name| {
                let root = root.clone();
                let branch_name = branch_name.to_string();
                async move { git_core::git_branch_exists(&root, &branch_name).await }
            },
            Some(|root: &PathBuf, branch_name: &str| {
                let root = root.clone();
                let branch_name = branch_name.to_string();
                async move { git_core::git_find_remote_tracking_branch_local(&root, &branch_name).await }
            }),
            |root, args| {
                workspaces_core::run_git_command_unit(root, args, git_core::run_git_command_owned)
            },
            move |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn worktree_setup_status(&self, workspace_id: String) -> Result<WorktreeSetupStatus, String> {
        workspaces_core::worktree_setup_status_core(&self.workspaces, &workspace_id, &self.data_dir)
            .await
    }

    async fn worktree_setup_mark_ran(&self, workspace_id: String) -> Result<(), String> {
        workspaces_core::worktree_setup_mark_ran_core(&self.workspaces, &workspace_id, &self.data_dir)
            .await
    }

    async fn remove_workspace(&self, id: String) -> Result<(), String> {
        workspaces_core::remove_workspace_core(
            id,
            &self.workspaces,
            &self.sessions,
            &self.storage_path,
            |root, args| {
                workspaces_core::run_git_command_unit(root, args, git_core::run_git_command_owned)
            },
            |error| git_core::is_missing_worktree_error(error),
            |path| {
                std::fs::remove_dir_all(path)
                    .map_err(|err| format!("Failed to remove worktree folder: {err}"))
            },
            true,
            true,
        )
        .await
    }

    async fn remove_worktree(&self, id: String) -> Result<(), String> {
        workspaces_core::remove_worktree_core(
            id,
            &self.workspaces,
            &self.sessions,
            &self.storage_path,
            |root, args| {
                workspaces_core::run_git_command_unit(root, args, git_core::run_git_command_owned)
            },
            |error| git_core::is_missing_worktree_error(error),
            |path| {
                std::fs::remove_dir_all(path)
                    .map_err(|err| format!("Failed to remove worktree folder: {err}"))
            },
        )
        .await
    }

    async fn rename_worktree(
        &self,
        id: String,
        branch: String,
        client_version: String,
    ) -> Result<WorkspaceInfo, String> {
        let client_version = client_version.clone();
        workspaces_core::rename_worktree_core(
            id,
            branch,
            &self.data_dir,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            &self.storage_path,
            |entry| Ok(PathBuf::from(entry.path.clone())),
            |root, name| {
                let root = root.clone();
                let name = name.to_string();
                async move {
                    git_core::unique_branch_name_live(&root, &name, None)
                        .await
                        .map(|(branch_name, _was_suffixed)| branch_name)
                }
            },
            |value| worktree_core::sanitize_worktree_name(value),
            |root, name, current| worktree_core::unique_worktree_path_for_rename(root, name, current),
            |root, args| {
                workspaces_core::run_git_command_unit(root, args, git_core::run_git_command_owned)
            },
            move |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn rename_worktree_upstream(
        &self,
        id: String,
        old_branch: String,
        new_branch: String,
    ) -> Result<(), String> {
        workspaces_core::rename_worktree_upstream_core(
            id,
            old_branch,
            new_branch,
            &self.workspaces,
            |entry| Ok(PathBuf::from(entry.path.clone())),
            |root, branch_name| {
                let root = root.clone();
                let branch_name = branch_name.to_string();
                async move { git_core::git_branch_exists(&root, &branch_name).await }
            },
            |root, branch_name| {
                let root = root.clone();
                let branch_name = branch_name.to_string();
                async move { git_core::git_find_remote_for_branch_live(&root, &branch_name).await }
            },
            |root, remote| {
                let root = root.clone();
                let remote = remote.to_string();
                async move { git_core::git_remote_exists(&root, &remote).await }
            },
            |root, remote, branch_name| {
                let root = root.clone();
                let remote = remote.to_string();
                let branch_name = branch_name.to_string();
                async move {
                    git_core::git_remote_branch_exists_live(&root, &remote, &branch_name).await
                }
            },
            |root, args| {
                workspaces_core::run_git_command_unit(root, args, git_core::run_git_command_owned)
            },
        )
        .await
    }

    async fn update_workspace_settings(
        &self,
        id: String,
        settings: WorkspaceSettings,
        client_version: String,
    ) -> Result<WorkspaceInfo, String> {
        let client_version = client_version.clone();
        workspaces_core::update_workspace_settings_core(
            id,
            settings,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            &self.storage_path,
            |workspaces, workspace_id, next_settings| {
                apply_workspace_settings_update(workspaces, workspace_id, next_settings)
            },
            move |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn update_workspace_codex_bin(
        &self,
        id: String,
        codex_bin: Option<String>,
    ) -> Result<WorkspaceInfo, String> {
        workspaces_core::update_workspace_codex_bin_core(
            id,
            codex_bin,
            &self.workspaces,
            &self.sessions,
            &self.storage_path,
        )
        .await
    }

    async fn connect_workspace(&self, id: String, client_version: String) -> Result<(), String> {
        {
            let sessions = self.sessions.lock().await;
            if sessions.contains_key(&id) {
                return Ok(());
            }
        }

        let client_version = client_version.clone();
        workspaces_core::connect_workspace_core(
            id,
            &self.workspaces,
            &self.sessions,
            &self.app_settings,
            move |entry, default_bin, codex_args, codex_home| {
                spawn_with_client(
                    self.event_sink.clone(),
                    client_version.clone(),
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                )
            },
        )
        .await
    }

    async fn get_app_settings(&self) -> AppSettings {
        settings_core::get_app_settings_core(&self.app_settings).await
    }

    async fn update_app_settings(&self, settings: AppSettings) -> Result<AppSettings, String> {
        settings_core::update_app_settings_core(settings, &self.app_settings, &self.settings_path)
            .await
    }

    async fn list_workspace_files(&self, workspace_id: String) -> Result<Vec<String>, String> {
        workspaces_core::list_workspace_files_core(&self.workspaces, &workspace_id, |root| {
            list_workspace_files_inner(root, 20000)
        })
        .await
    }

    async fn read_workspace_file(
        &self,
        workspace_id: String,
        path: String,
    ) -> Result<WorkspaceFileResponse, String> {
        workspaces_core::read_workspace_file_core(
            &self.workspaces,
            &workspace_id,
            &path,
            |root, rel_path| read_workspace_file_inner(root, rel_path),
        )
        .await
    }

    async fn file_read(
        &self,
        scope: file_policy::FileScope,
        kind: file_policy::FileKind,
        workspace_id: Option<String>,
    ) -> Result<file_io::TextFileResponse, String> {
        files_core::file_read_core(&self.workspaces, scope, kind, workspace_id).await
    }

    async fn file_write(
        &self,
        scope: file_policy::FileScope,
        kind: file_policy::FileKind,
        workspace_id: Option<String>,
        content: String,
    ) -> Result<(), String> {
        files_core::file_write_core(&self.workspaces, scope, kind, workspace_id, content).await
    }

    async fn start_thread(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::start_thread_core(&self.sessions, workspace_id).await
    }

    async fn resume_thread(&self, workspace_id: String, thread_id: String) -> Result<Value, String> {
        codex_core::resume_thread_core(&self.sessions, workspace_id, thread_id).await
    }

    async fn fork_thread(&self, workspace_id: String, thread_id: String) -> Result<Value, String> {
        codex_core::fork_thread_core(&self.sessions, workspace_id, thread_id).await
    }

    async fn list_threads(
        &self,
        workspace_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
        sort_key: Option<String>,
    ) -> Result<Value, String> {
        codex_core::list_threads_core(&self.sessions, workspace_id, cursor, limit, sort_key).await
    }

    async fn list_mcp_server_status(
        &self,
        workspace_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> Result<Value, String> {
        codex_core::list_mcp_server_status_core(&self.sessions, workspace_id, cursor, limit).await
    }

    async fn archive_thread(&self, workspace_id: String, thread_id: String) -> Result<Value, String> {
        codex_core::archive_thread_core(&self.sessions, workspace_id, thread_id).await
    }

    async fn compact_thread(&self, workspace_id: String, thread_id: String) -> Result<Value, String> {
        codex_core::compact_thread_core(&self.sessions, workspace_id, thread_id).await
    }

    async fn set_thread_name(
        &self,
        workspace_id: String,
        thread_id: String,
        name: String,
    ) -> Result<Value, String> {
        codex_core::set_thread_name_core(&self.sessions, workspace_id, thread_id, name).await
    }

    async fn send_user_message(
        &self,
        workspace_id: String,
        thread_id: String,
        text: String,
        model: Option<String>,
        effort: Option<String>,
        access_mode: Option<String>,
        images: Option<Vec<String>>,
        collaboration_mode: Option<Value>,
    ) -> Result<Value, String> {
        codex_core::send_user_message_core(
            &self.sessions,
            workspace_id,
            thread_id,
            text,
            model,
            effort,
            access_mode,
            images,
            collaboration_mode,
        )
        .await
    }

    async fn turn_interrupt(
        &self,
        workspace_id: String,
        thread_id: String,
        turn_id: String,
    ) -> Result<Value, String> {
        codex_core::turn_interrupt_core(&self.sessions, workspace_id, thread_id, turn_id).await
    }

    async fn start_review(
        &self,
        workspace_id: String,
        thread_id: String,
        target: Value,
        delivery: Option<String>,
    ) -> Result<Value, String> {
        codex_core::start_review_core(&self.sessions, workspace_id, thread_id, target, delivery)
            .await
    }

    async fn model_list(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::model_list_core(&self.sessions, workspace_id).await
    }

    async fn collaboration_mode_list(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::collaboration_mode_list_core(&self.sessions, workspace_id).await
    }

    async fn account_rate_limits(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::account_rate_limits_core(&self.sessions, workspace_id).await
    }

    async fn account_read(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::account_read_core(&self.sessions, &self.workspaces, workspace_id).await
    }

    async fn codex_login(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::codex_login_core(&self.sessions, &self.codex_login_cancels, workspace_id).await
    }

    async fn codex_login_cancel(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::codex_login_cancel_core(&self.sessions, &self.codex_login_cancels, workspace_id)
            .await
    }

    async fn skills_list(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::skills_list_core(&self.sessions, workspace_id).await
    }

    async fn apps_list(
        &self,
        workspace_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> Result<Value, String> {
        codex_core::apps_list_core(&self.sessions, workspace_id, cursor, limit).await
    }

    async fn respond_to_server_request(
        &self,
        workspace_id: String,
        request_id: Value,
        result: Value,
    ) -> Result<Value, String> {
        codex_core::respond_to_server_request_core(&self.sessions, workspace_id, request_id, result)
            .await?;
        Ok(json!({ "ok": true }))
    }

    async fn remember_approval_rule(
        &self,
        workspace_id: String,
        command: Vec<String>,
    ) -> Result<Value, String> {
        codex_core::remember_approval_rule_core(&self.workspaces, workspace_id, command).await
    }

    async fn get_config_model(&self, workspace_id: String) -> Result<Value, String> {
        codex_core::get_config_model_core(&self.workspaces, workspace_id).await
    }

    async fn workspace_path(&self, workspace_id: &str) -> Result<PathBuf, String> {
        let workspaces = self.workspaces.lock().await;
        let entry = workspaces
            .get(workspace_id)
            .ok_or_else(|| "Unknown workspace".to_string())?;
        Ok(PathBuf::from(&entry.path))
    }

    async fn reveal_item_in_dir(&self, path: String) -> Result<(), String> {
        reveal_path(&path).await
    }

    async fn terminal_open(
        &self,
        workspace_id: String,
        terminal_id: String,
        cols: u16,
        rows: u16,
    ) -> Result<Value, String> {
        if terminal_id.trim().is_empty() {
            return Err("Terminal id is required".to_string());
        }

        let key = terminal_key(&workspace_id, &terminal_id);
        {
            let sessions = self.terminal_sessions.lock().await;
            if sessions.contains_key(&key) {
                return Ok(json!({ "id": terminal_id }));
            }
        }

        let cwd = self.workspace_path(&workspace_id).await?;
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open pty: {e}"))?;

        let mut cmd = CommandBuilder::new(shell_path());
        cmd.cwd(cwd);
        cmd.arg("-i");
        cmd.env("TERM", "xterm-256color");
        let locale = resolve_locale();
        cmd.env("LANG", &locale);
        cmd.env("LC_ALL", &locale);
        cmd.env("LC_CTYPE", &locale);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to open pty reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to open pty writer: {e}"))?;

        let session = Arc::new(terminal::TerminalSession {
            id: terminal_id.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
        });

        {
            let mut sessions = self.terminal_sessions.lock().await;
            sessions.insert(key, Arc::clone(&session));
        }

        spawn_terminal_reader(
            self.event_sink.clone(),
            workspace_id,
            terminal_id.clone(),
            reader,
        );

        Ok(json!({ "id": terminal_id }))
    }

    async fn terminal_write(
        &self,
        workspace_id: String,
        terminal_id: String,
        data: String,
    ) -> Result<(), String> {
        let key = terminal_key(&workspace_id, &terminal_id);
        let session = {
            let sessions = self.terminal_sessions.lock().await;
            sessions
                .get(&key)
                .cloned()
                .ok_or_else(|| "Terminal session not found".to_string())?
        };

        let write_result = tokio::task::spawn_blocking(move || {
            let mut writer = session.writer.blocking_lock();
            writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("Failed to write to pty: {e}"))?;
            writer
                .flush()
                .map_err(|e| format!("Failed to flush pty: {e}"))?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| format!("Terminal write task failed: {e}"))?;

        if let Err(err) = write_result {
            if is_terminal_closed_error(&err) {
                let mut sessions = self.terminal_sessions.lock().await;
                sessions.remove(&key);
            }
            return Err(err);
        }

        Ok(())
    }

    async fn terminal_resize(
        &self,
        workspace_id: String,
        terminal_id: String,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let key = terminal_key(&workspace_id, &terminal_id);
        let session = {
            let sessions = self.terminal_sessions.lock().await;
            sessions
                .get(&key)
                .cloned()
                .ok_or_else(|| "Terminal session not found".to_string())?
        };

        let size = PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };

        let resize_result = tokio::task::spawn_blocking(move || {
            let master = session.master.blocking_lock();
            master
                .resize(size)
                .map_err(|e| format!("Failed to resize pty: {e}"))
        })
        .await
        .map_err(|e| format!("Terminal resize task failed: {e}"))?;

        if let Err(err) = resize_result {
            if is_terminal_closed_error(&err) {
                let mut sessions = self.terminal_sessions.lock().await;
                sessions.remove(&key);
            }
            return Err(err);
        }

        Ok(())
    }

    async fn terminal_close(&self, workspace_id: String, terminal_id: String) -> Result<(), String> {
        let key = terminal_key(&workspace_id, &terminal_id);
        let session = {
            let mut sessions = self.terminal_sessions.lock().await;
            sessions
                .remove(&key)
                .ok_or_else(|| "Terminal session not found".to_string())?
        };

        tokio::task::spawn_blocking(move || {
            let mut child = session.child.blocking_lock();
            let _ = child.kill();
        })
        .await
        .map_err(|e| format!("Terminal close task failed: {e}"))?;

        Ok(())
    }
}

fn terminal_key(workspace_id: &str, terminal_id: &str) -> String {
    format!("{workspace_id}:{terminal_id}")
}

fn is_terminal_closed_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("broken pipe")
        || lower.contains("input/output error")
        || lower.contains("os error 5")
        || lower.contains("eio")
        || lower.contains("io error")
        || lower.contains("not connected")
        || lower.contains("closed")
}

fn shell_path() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

fn resolve_locale() -> String {
    let candidate = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_else(|_| "en_US.UTF-8".to_string());
    let lower = candidate.to_lowercase();
    if lower.contains("utf-8") || lower.contains("utf8") {
        return candidate;
    }
    "en_US.UTF-8".to_string()
}

fn spawn_terminal_reader(
    event_sink: DaemonEventSink,
    workspace_id: String,
    terminal_id: String,
    mut reader: Box<dyn Read + Send>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    pending.extend_from_slice(&buffer[..count]);
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(decoded) => {
                                if !decoded.is_empty() {
                                    event_sink.emit_terminal_output(TerminalOutput {
                                        workspace_id: workspace_id.clone(),
                                        terminal_id: terminal_id.clone(),
                                        data: decoded.to_string(),
                                    });
                                }
                                pending.clear();
                                break;
                            }
                            Err(error) => {
                                let valid_up_to = error.valid_up_to();
                                if valid_up_to == 0 {
                                    if error.error_len().is_none() {
                                        break;
                                    }
                                    let invalid_len = error.error_len().unwrap_or(1);
                                    pending.drain(..invalid_len.min(pending.len()));
                                    continue;
                                }
                                let chunk =
                                    String::from_utf8_lossy(&pending[..valid_up_to]).to_string();
                                if !chunk.is_empty() {
                                    event_sink.emit_terminal_output(TerminalOutput {
                                        workspace_id: workspace_id.clone(),
                                        terminal_id: terminal_id.clone(),
                                        data: chunk,
                                    });
                                }
                                pending.drain(..valid_up_to);
                                if error.error_len().is_none() {
                                    break;
                                }
                                let invalid_len = error.error_len().unwrap_or(1);
                                pending.drain(..invalid_len.min(pending.len()));
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        event_sink.emit_terminal_exit(TerminalExit {
            workspace_id,
            terminal_id,
        });
    });
}

async fn reveal_path(path: &str) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("Path is required".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let status = tokio::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .status()
            .await
            .map_err(|err| format!("Failed to reveal path: {err}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("Failed to reveal path".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let parent = if target.is_dir() {
            target.clone()
        } else {
            target.parent().map(PathBuf::from).unwrap_or(target.clone())
        };
        let status = tokio::process::Command::new("xdg-open")
            .arg(parent)
            .status()
            .await
            .map_err(|err| format!("Failed to open folder: {err}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("Failed to reveal path".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let status = tokio::process::Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .status()
            .await
            .map_err(|err| format!("Failed to reveal path: {err}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("Failed to reveal path".to_string());
    }

    #[allow(unreachable_code)]
    Ok(())
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "dist" | "target" | "release-artifacts"
    )
}

fn normalize_git_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn list_workspace_files_inner(root: &PathBuf, max_files: usize) -> Vec<String> {
    let mut results = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                let name = entry.file_name().to_string_lossy();
                return !should_skip_dir(&name);
            }
            true
        })
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        if let Ok(rel_path) = entry.path().strip_prefix(root) {
            let normalized = normalize_git_path(&rel_path.to_string_lossy());
            if !normalized.is_empty() {
                results.push(normalized);
            }
        }
        if results.len() >= max_files {
            break;
        }
    }

    results.sort();
    results
}

const MAX_WORKSPACE_FILE_BYTES: u64 = 400_000;

fn read_workspace_file_inner(
    root: &PathBuf,
    relative_path: &str,
) -> Result<WorkspaceFileResponse, String> {
    let canonical_path = resolve_workspace_file_path(root, relative_path)?;

    let file = File::open(&canonical_path).map_err(|err| format!("Failed to open file: {err}"))?;
    let mut buffer = Vec::new();
    file.take(MAX_WORKSPACE_FILE_BYTES + 1)
        .read_to_end(&mut buffer)
        .map_err(|err| format!("Failed to read file: {err}"))?;

    let truncated = buffer.len() > MAX_WORKSPACE_FILE_BYTES as usize;
    if truncated {
        buffer.truncate(MAX_WORKSPACE_FILE_BYTES as usize);
    }

    let content =
        String::from_utf8(buffer).map_err(|_| "File is not valid UTF-8".to_string())?;
    Ok(WorkspaceFileResponse { content, truncated })
}

fn resolve_workspace_file_path(root: &PathBuf, relative_path: &str) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|err| format!("Failed to resolve workspace root: {err}"))?;
    let candidate = canonical_root.join(relative_path);
    let canonical_path = candidate
        .canonicalize()
        .map_err(|err| format!("Failed to open file: {err}"))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err("Invalid file path".to_string());
    }
    let metadata = std::fs::metadata(&canonical_path)
        .map_err(|err| format!("Failed to read file metadata: {err}"))?;
    if !metadata.is_file() {
        return Err("Path is not a file".to_string());
    }
    Ok(canonical_path)
}

fn content_type_for_path(path: &FsPath) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_ascii_lowercase()) {
        Some(ext) if ext == "png" => "image/png",
        Some(ext) if ext == "jpg" || ext == "jpeg" => "image/jpeg",
        Some(ext) if ext == "gif" => "image/gif",
        Some(ext) if ext == "webp" => "image/webp",
        Some(ext) if ext == "bmp" => "image/bmp",
        Some(ext) if ext == "svg" => "image/svg+xml",
        Some(ext) if ext == "txt" || ext == "md" || ext == "json" || ext == "toml" || ext == "yaml" || ext == "yml" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn default_data_dir() -> PathBuf {
    if let Ok(xdg) = env::var("XDG_DATA_HOME") {
        let trimmed = xdg.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("codex-monitor-web");
        }
    }
    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("codex-monitor-web")
}

fn usage() -> String {
    format!(
        "\
USAGE:
  codex-monitor-web [--listen <addr>] [--data-dir <path>] [--token <token>]\n\nOPTIONS:
  --listen <addr>        Bind address (default: {DEFAULT_LISTEN_ADDR})
  --data-dir <path>      Data dir holding workspaces.json/settings.json
  --token <token>        Optional shared token required by clients
  -h, --help             Show this help
"
    )
}

fn parse_args() -> Result<DaemonConfig, String> {
    let mut listen = DEFAULT_LISTEN_ADDR
        .parse::<SocketAddr>()
        .map_err(|err| err.to_string())?;
    let mut token = env::var("CODEX_MONITOR_WEB_TOKEN")
        .ok()
        .or_else(|| env::var("CODEX_MONITOR_DAEMON_TOKEN").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut data_dir: Option<PathBuf> = None;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{}", usage());
                std::process::exit(0);
            }
            "--listen" => {
                let value = args.next().ok_or("--listen requires a value")?;
                listen = value.parse::<SocketAddr>().map_err(|err| err.to_string())?;
            }
            "--token" => {
                let value = args.next().ok_or("--token requires a value")?;
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return Err("--token requires a non-empty value".to_string());
                }
                token = Some(trimmed.to_string());
            }
            "--data-dir" => {
                let value = args.next().ok_or("--data-dir requires a value")?;
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return Err("--data-dir requires a non-empty value".to_string());
                }
                data_dir = Some(PathBuf::from(trimmed));
            }
            _ => return Err(format!("Unknown argument: {arg}")),
        }
    }

    Ok(DaemonConfig {
        listen,
        token,
        data_dir: data_dir.unwrap_or_else(default_data_dir),
    })
}

fn build_error_response(id: Option<u64>, message: &str) -> Option<String> {
    let id = id?;
    Some(
        serde_json::to_string(&json!({
            "id": id,
            "error": { "message": message }
        }))
        .unwrap_or_else(|_| "{\"id\":0,\"error\":{\"message\":\"serialization failed\"}}".to_string()),
    )
}

fn build_result_response(id: Option<u64>, result: Value) -> Option<String> {
    let id = id?;
    Some(serde_json::to_string(&json!({ "id": id, "result": result })).unwrap_or_else(|_| {
        "{\"id\":0,\"error\":{\"message\":\"serialization failed\"}}".to_string()
    }))
}

fn build_event_notification(event: DaemonEvent) -> Option<String> {
    let payload = match event {
        DaemonEvent::AppServer(payload) => json!({
            "method": "app-server-event",
            "params": payload,
        }),
        DaemonEvent::TerminalOutput(payload) => json!({
            "method": "terminal-output",
            "params": payload,
        }),
        DaemonEvent::TerminalExit(payload) => json!({
            "method": "terminal-exit",
            "params": payload,
        }),
    };
    serde_json::to_string(&payload).ok()
}

fn parse_auth_token(params: &Value) -> Option<String> {
    match params {
        Value::String(value) => Some(value.clone()),
        Value::Object(map) => map
            .get("token")
            .and_then(|value| value.as_str())
            .map(|v| v.to_string()),
        _ => None,
    }
}

fn parse_string(value: &Value, key: &str) -> Result<String, String> {
    match value {
        Value::Object(map) => map
            .get(key)
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .ok_or_else(|| format!("missing or invalid `{key}`")),
        _ => Err(format!("missing `{key}`")),
    }
}

fn parse_optional_string(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(map) => map
            .get(key)
            .and_then(|value| value.as_str())
            .map(|v| v.to_string()),
        _ => None,
    }
}

fn parse_optional_u32(value: &Value, key: &str) -> Option<u32> {
    match value {
        Value::Object(map) => map.get(key).and_then(|value| value.as_u64()).and_then(|v| {
            if v > u32::MAX as u64 {
                None
            } else {
                Some(v as u32)
            }
        }),
        _ => None,
    }
}

fn parse_optional_bool(value: &Value, key: &str) -> Option<bool> {
    match value {
        Value::Object(map) => map.get(key).and_then(|value| value.as_bool()),
        _ => None,
    }
}

fn parse_optional_string_array(value: &Value, key: &str) -> Option<Vec<String>> {
    match value {
        Value::Object(map) => map.get(key).and_then(|value| value.as_array()).map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.to_string()))
                .collect::<Vec<_>>()
        }),
        _ => None,
    }
}

fn parse_string_array(value: &Value, key: &str) -> Result<Vec<String>, String> {
    parse_optional_string_array(value, key).ok_or_else(|| format!("missing `{key}`"))
}

fn parse_optional_value(value: &Value, key: &str) -> Option<Value> {
    match value {
        Value::Object(map) => map.get(key).cloned(),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileReadRequest {
    scope: file_policy::FileScope,
    kind: file_policy::FileKind,
    workspace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileWriteRequest {
    scope: file_policy::FileScope,
    kind: file_policy::FileKind,
    workspace_id: Option<String>,
    content: String,
}

fn parse_file_read_request(params: &Value) -> Result<FileReadRequest, String> {
    serde_json::from_value(params.clone()).map_err(|err| err.to_string())
}

fn parse_file_write_request(params: &Value) -> Result<FileWriteRequest, String> {
    serde_json::from_value(params.clone()).map_err(|err| err.to_string())
}

fn build_commit_message_prompt(diff: &str) -> String {
    format!(
        "Generate a concise git commit message for the following changes. \
Follow conventional commit format (e.g., feat:, fix:, refactor:, docs:, etc.). \
Keep the summary line under 72 characters. \
Only output the commit message, nothing else.\n\n\
Changes:\n{diff}"
    )
}

fn heuristic_commit_message(diff: &str) -> String {
    let changed_files = diff
        .lines()
        .filter_map(|line| line.strip_prefix("diff --git a/"))
        .filter_map(|line| line.split(" b/").nth(1))
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if changed_files.is_empty() {
        return "chore: update workspace files".to_string();
    }
    if changed_files.len() == 1 {
        return format!("chore: update {}", changed_files[0]);
    }
    format!("chore: update {} files", changed_files.len())
}

fn build_run_title(prompt: &str) -> String {
    let cleaned = prompt.trim();
    if cleaned.is_empty() {
        return "New Task".to_string();
    }
    let words = cleaned
        .split_whitespace()
        .take(7)
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>();
    words.join(" ")
}

fn build_worktree_name(prompt: &str) -> String {
    let slug = prompt
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|segment| !segment.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "feat/new-task".to_string()
    } else {
        format!("feat/{slug}")
    }
}

async fn handle_rpc_request(
    state: &DaemonState,
    method: &str,
    params: Value,
    client_version: String,
) -> Result<Value, String> {
    match method {
        "ping" => Ok(json!({ "ok": true })),
        "list_workspaces" => {
            let workspaces = state.list_workspaces().await;
            serde_json::to_value(workspaces).map_err(|err| err.to_string())
        }
        "is_workspace_path_dir" => {
            let path = parse_string(&params, "path")?;
            let is_dir = state.is_workspace_path_dir(path).await;
            serde_json::to_value(is_dir).map_err(|err| err.to_string())
        }
        "add_workspace" => {
            let path = parse_string(&params, "path")?;
            let codex_bin = parse_optional_string(&params, "codex_bin");
            let workspace = state.add_workspace(path, codex_bin, client_version).await?;
            serde_json::to_value(workspace).map_err(|err| err.to_string())
        }
        "add_worktree" => {
            let parent_id = parse_string(&params, "parentId")?;
            let branch = parse_string(&params, "branch")?;
            let name = parse_optional_string(&params, "name");
            let copy_agents_md = parse_optional_bool(&params, "copyAgentsMd").unwrap_or(true);
            let workspace = state
                .add_worktree(parent_id, branch, name, copy_agents_md, client_version)
                .await?;
            serde_json::to_value(workspace).map_err(|err| err.to_string())
        }
        "worktree_setup_status" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let status = state.worktree_setup_status(workspace_id).await?;
            serde_json::to_value(status).map_err(|err| err.to_string())
        }
        "worktree_setup_mark_ran" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            state.worktree_setup_mark_ran(workspace_id).await?;
            Ok(json!({ "ok": true }))
        }
        "connect_workspace" => {
            let id = parse_string(&params, "id")?;
            state.connect_workspace(id, client_version).await?;
            Ok(json!({ "ok": true }))
        }
        "remove_workspace" => {
            let id = parse_string(&params, "id")?;
            state.remove_workspace(id).await?;
            Ok(json!({ "ok": true }))
        }
        "remove_worktree" => {
            let id = parse_string(&params, "id")?;
            state.remove_worktree(id).await?;
            Ok(json!({ "ok": true }))
        }
        "rename_worktree" => {
            let id = parse_string(&params, "id")?;
            let branch = parse_string(&params, "branch")?;
            let workspace = state.rename_worktree(id, branch, client_version).await?;
            serde_json::to_value(workspace).map_err(|err| err.to_string())
        }
        "rename_worktree_upstream" => {
            let id = parse_string(&params, "id")?;
            let old_branch = parse_string(&params, "oldBranch")?;
            let new_branch = parse_string(&params, "newBranch")?;
            state
                .rename_worktree_upstream(id, old_branch, new_branch)
                .await?;
            Ok(json!({ "ok": true }))
        }
        "update_workspace_settings" => {
            let id = parse_string(&params, "id")?;
            let settings_value = match params {
                Value::Object(map) => map.get("settings").cloned().unwrap_or(Value::Null),
                _ => Value::Null,
            };
            let settings: WorkspaceSettings =
                serde_json::from_value(settings_value).map_err(|err| err.to_string())?;
            let workspace = state
                .update_workspace_settings(id, settings, client_version)
                .await?;
            serde_json::to_value(workspace).map_err(|err| err.to_string())
        }
        "update_workspace_codex_bin" => {
            let id = parse_string(&params, "id")?;
            let codex_bin = parse_optional_string(&params, "codex_bin");
            let workspace = state.update_workspace_codex_bin(id, codex_bin).await?;
            serde_json::to_value(workspace).map_err(|err| err.to_string())
        }
        "list_workspace_files" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let files = state.list_workspace_files(workspace_id).await?;
            serde_json::to_value(files).map_err(|err| err.to_string())
        }
        "read_workspace_file" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let path = parse_string(&params, "path")?;
            let response = state.read_workspace_file(workspace_id, path).await?;
            serde_json::to_value(response).map_err(|err| err.to_string())
        }
        "file_read" => {
            let request = parse_file_read_request(&params)?;
            let response = state
                .file_read(request.scope, request.kind, request.workspace_id)
                .await?;
            serde_json::to_value(response).map_err(|err| err.to_string())
        }
        "file_write" => {
            let request = parse_file_write_request(&params)?;
            state
                .file_write(
                    request.scope,
                    request.kind,
                    request.workspace_id,
                    request.content,
                )
                .await?;
            serde_json::to_value(json!({ "ok": true })).map_err(|err| err.to_string())
        }
        "get_app_settings" => {
            let settings = state.get_app_settings().await;
            serde_json::to_value(settings).map_err(|err| err.to_string())
        }
        "update_app_settings" => {
            let settings_value = match params {
                Value::Object(map) => map.get("settings").cloned().unwrap_or(Value::Null),
                _ => Value::Null,
            };
            let settings: AppSettings =
                serde_json::from_value(settings_value).map_err(|err| err.to_string())?;
            let updated = state.update_app_settings(settings).await?;
            serde_json::to_value(updated).map_err(|err| err.to_string())
        }
        "get_codex_config_path" => {
            let path = settings_core::get_codex_config_path_core()?;
            Ok(Value::String(path))
        }
        "get_config_model" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            state.get_config_model(workspace_id).await
        }
        "start_thread" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            state.start_thread(workspace_id).await
        }
        "resume_thread" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let thread_id = parse_string(&params, "threadId")?;
            state.resume_thread(workspace_id, thread_id).await
        }
        "fork_thread" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let thread_id = parse_string(&params, "threadId")?;
            state.fork_thread(workspace_id, thread_id).await
        }
        "list_threads" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let cursor = parse_optional_string(&params, "cursor");
            let limit = parse_optional_u32(&params, "limit");
            let sort_key = parse_optional_string(&params, "sortKey");
            state.list_threads(workspace_id, cursor, limit, sort_key).await
        }
        "list_mcp_server_status" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let cursor = parse_optional_string(&params, "cursor");
            let limit = parse_optional_u32(&params, "limit");
            state.list_mcp_server_status(workspace_id, cursor, limit).await
        }
        "archive_thread" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let thread_id = parse_string(&params, "threadId")?;
            state.archive_thread(workspace_id, thread_id).await
        }
        "compact_thread" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let thread_id = parse_string(&params, "threadId")?;
            state.compact_thread(workspace_id, thread_id).await
        }
        "set_thread_name" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let thread_id = parse_string(&params, "threadId")?;
            let name = parse_string(&params, "name")?;
            state.set_thread_name(workspace_id, thread_id, name).await
        }
        "send_user_message" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let thread_id = parse_string(&params, "threadId")?;
            let text = parse_string(&params, "text")?;
            let model = parse_optional_string(&params, "model");
            let effort = parse_optional_string(&params, "effort");
            let access_mode = parse_optional_string(&params, "accessMode");
            let images = parse_optional_string_array(&params, "images");
            let collaboration_mode = parse_optional_value(&params, "collaborationMode");
            state
                .send_user_message(
                    workspace_id,
                    thread_id,
                    text,
                    model,
                    effort,
                    access_mode,
                    images,
                    collaboration_mode,
                )
                .await
        }
        "turn_interrupt" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let thread_id = parse_string(&params, "threadId")?;
            let turn_id = parse_string(&params, "turnId")?;
            state.turn_interrupt(workspace_id, thread_id, turn_id).await
        }
        "start_review" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let thread_id = parse_string(&params, "threadId")?;
            let target = params
                .as_object()
                .and_then(|map| map.get("target"))
                .cloned()
                .ok_or("missing `target`")?;
            let delivery = parse_optional_string(&params, "delivery");
            state.start_review(workspace_id, thread_id, target, delivery).await
        }
        "model_list" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            state.model_list(workspace_id).await
        }
        "collaboration_mode_list" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            state.collaboration_mode_list(workspace_id).await
        }
        "account_rate_limits" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            state.account_rate_limits(workspace_id).await
        }
        "account_read" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            state.account_read(workspace_id).await
        }
        "codex_login" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            state.codex_login(workspace_id).await
        }
        "codex_login_cancel" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            state.codex_login_cancel(workspace_id).await
        }
        "skills_list" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            state.skills_list(workspace_id).await
        }
        "apps_list" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let cursor = parse_optional_string(&params, "cursor");
            let limit = parse_optional_u32(&params, "limit");
            state.apps_list(workspace_id, cursor, limit).await
        }
        "respond_to_server_request" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let map = params.as_object().ok_or("missing requestId")?;
            let request_id = map
                .get("requestId")
                .cloned()
                .filter(|value| value.is_number() || value.is_string())
                .ok_or("missing requestId")?;
            let result = map.get("result").cloned().ok_or("missing `result`")?;
            state
                .respond_to_server_request(workspace_id, request_id, result)
                .await
        }
        "remember_approval_rule" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let command = parse_string_array(&params, "command")?;
            state.remember_approval_rule(workspace_id, command).await
        }
        "add_clone" => {
            let source_workspace_id = parse_string(&params, "sourceWorkspaceId")?;
            let copies_folder = parse_string(&params, "copiesFolder")?;
            let copy_name = parse_string(&params, "copyName")?;
            let workspace = state
                .add_clone(source_workspace_id, copies_folder, copy_name, client_version)
                .await?;
            serde_json::to_value(workspace).map_err(|err| err.to_string())
        }
        "apply_worktree_changes" => Ok(json!({ "ok": true })),
        "open_workspace_in" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let target = params
                .as_object()
                .and_then(|map| map.get("target"))
                .cloned()
                .ok_or("missing `target`")?;
            let path = state.workspace_path(&workspace_id).await?;
            let kind = target
                .as_object()
                .and_then(|map| map.get("kind"))
                .and_then(|value| value.as_str())
                .unwrap_or("finder");
            if kind == "finder" {
                reveal_path(&path.to_string_lossy()).await?;
                return Ok(json!({ "ok": true }));
            }

            let mut command = if kind == "app" {
                #[cfg(target_os = "macos")]
                {
                    let app_name = target
                        .as_object()
                        .and_then(|map| map.get("appName"))
                        .and_then(|value| value.as_str())
                        .ok_or("missing app name")?;
                    let mut command = tokio::process::Command::new("open");
                    command.arg("-a").arg(app_name);
                    command
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let app_name = target
                        .as_object()
                        .and_then(|map| map.get("appName"))
                        .and_then(|value| value.as_str())
                        .ok_or("missing app name")?;
                    tokio::process::Command::new(app_name)
                }
            } else {
                let executable = target
                    .as_object()
                    .and_then(|map| map.get("command"))
                    .and_then(|value| value.as_str())
                    .ok_or("missing command")?;
                tokio::process::Command::new(executable)
            };

            if let Some(args) = target
                .as_object()
                .and_then(|map| map.get("args"))
                .and_then(|value| value.as_array())
            {
                for arg in args {
                    if let Some(value) = arg.as_str() {
                        command.arg(value);
                    }
                }
            }
            command.arg(&path);
            let status = command
                .status()
                .await
                .map_err(|err| format!("Failed to open workspace: {err}"))?;
            if !status.success() {
                return Err("Failed to open workspace".to_string());
            }
            Ok(json!({ "ok": true }))
        }
        "reveal_item_in_dir" => {
            let path = parse_string(&params, "path")?;
            state.reveal_item_in_dir(path).await?;
            Ok(json!({ "ok": true }))
        }
        "get_open_app_icon" => Ok(Value::Null),
        "get_git_status" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = git::get_git_status(workspace_id, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "list_git_roots" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let depth = parse_optional_u32(&params, "depth").map(|value| value as usize);
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = git::list_git_roots(workspace_id, depth, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "get_git_diffs" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = git::get_git_diffs(workspace_id, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "get_git_log" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let limit = parse_optional_u32(&params, "limit").map(|value| value as usize);
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = git::get_git_log(workspace_id, limit, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "get_git_commit_diff" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let sha = parse_string(&params, "sha")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = git::get_git_commit_diff(workspace_id, sha, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "get_git_remote" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = git::get_git_remote(workspace_id, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "stage_git_file" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let path = parse_string(&params, "path")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::stage_git_file(workspace_id, path, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "stage_git_all" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::stage_git_all(workspace_id, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "unstage_git_file" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let path = parse_string(&params, "path")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::unstage_git_file(workspace_id, path, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "revert_git_file" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let path = parse_string(&params, "path")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::revert_git_file(workspace_id, path, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "revert_git_all" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::revert_git_all(workspace_id, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "commit_git" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let message = parse_string(&params, "message")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::commit_git(workspace_id, message, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "push_git" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::push_git(workspace_id, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "pull_git" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::pull_git(workspace_id, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "fetch_git" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::fetch_git(workspace_id, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "sync_git" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::sync_git(workspace_id, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "get_github_issues" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = git::get_github_issues(workspace_id, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "get_github_pull_requests" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = git::get_github_pull_requests(workspace_id, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "get_github_pull_request_diff" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let pr_number = parse_optional_u32(&params, "prNumber").ok_or("missing prNumber")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = git::get_github_pull_request_diff(workspace_id, pr_number as u64, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "get_github_pull_request_comments" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let pr_number = parse_optional_u32(&params, "prNumber").ok_or("missing prNumber")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = git::get_github_pull_request_comments(workspace_id, pr_number as u64, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "local_usage_snapshot" => {
            let days = parse_optional_u32(&params, "days");
            let workspace_path = parse_optional_string(&params, "workspacePath");
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = local_usage::local_usage_snapshot(days, workspace_path, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "prompts_list" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = prompts::prompts_list(tauri_state, workspace_id).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "prompts_workspace_dir" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = prompts::prompts_workspace_dir(tauri_state, workspace_id).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "prompts_global_dir" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = prompts::prompts_global_dir(tauri_state, workspace_id).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "prompts_create" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let scope = parse_string(&params, "scope")?;
            let name = parse_string(&params, "name")?;
            let description = parse_optional_string(&params, "description");
            let argument_hint = parse_optional_string(&params, "argumentHint");
            let content = parse_string(&params, "content")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = prompts::prompts_create(
                tauri_state,
                workspace_id,
                scope,
                name,
                description,
                argument_hint,
                content,
            )
            .await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "prompts_update" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let path = parse_string(&params, "path")?;
            let name = parse_string(&params, "name")?;
            let description = parse_optional_string(&params, "description");
            let argument_hint = parse_optional_string(&params, "argumentHint");
            let content = parse_string(&params, "content")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = prompts::prompts_update(
                tauri_state,
                workspace_id,
                path,
                name,
                description,
                argument_hint,
                content,
            )
            .await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "prompts_delete" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let path = parse_string(&params, "path")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            prompts::prompts_delete(tauri_state, workspace_id, path).await?;
            Ok(json!({ "ok": true }))
        }
        "prompts_move" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let path = parse_string(&params, "path")?;
            let scope = parse_string(&params, "scope")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = prompts::prompts_move(tauri_state, workspace_id, path, scope).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "list_git_branches" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let result = git::list_git_branches(workspace_id, tauri_state).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "checkout_git_branch" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let name = parse_string(&params, "name")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::checkout_git_branch(workspace_id, name, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "create_git_branch" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let name = parse_string(&params, "name")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            git::create_git_branch(workspace_id, name, tauri_state).await?;
            Ok(json!({ "ok": true }))
        }
        "terminal_open" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let terminal_id = parse_string(&params, "terminalId")?;
            let cols = parse_optional_u32(&params, "cols").unwrap_or(120) as u16;
            let rows = parse_optional_u32(&params, "rows").unwrap_or(40) as u16;
            state.terminal_open(workspace_id, terminal_id, cols, rows).await
        }
        "terminal_write" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let terminal_id = parse_string(&params, "terminalId")?;
            let data = parse_string(&params, "data")?;
            state.terminal_write(workspace_id, terminal_id, data).await?;
            Ok(json!({ "ok": true }))
        }
        "terminal_resize" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let terminal_id = parse_string(&params, "terminalId")?;
            let cols = parse_optional_u32(&params, "cols").unwrap_or(120) as u16;
            let rows = parse_optional_u32(&params, "rows").unwrap_or(40) as u16;
            state.terminal_resize(workspace_id, terminal_id, cols, rows).await?;
            Ok(json!({ "ok": true }))
        }
        "terminal_close" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let terminal_id = parse_string(&params, "terminalId")?;
            state.terminal_close(workspace_id, terminal_id).await?;
            Ok(json!({ "ok": true }))
        }
        "get_commit_message_prompt" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let diff = git::get_workspace_diff(&workspace_id, &tauri_state).await?;
            if diff.trim().is_empty() {
                return Err("No changes to generate commit message for".to_string());
            }
            Ok(Value::String(build_commit_message_prompt(&diff)))
        }
        "generate_commit_message" => {
            let workspace_id = parse_string(&params, "workspaceId")?;
            let app_state = state.snapshot_app_state().await;
            let tauri_state = DaemonState::as_tauri_state(&app_state);
            let diff = git::get_workspace_diff(&workspace_id, &tauri_state).await?;
            if diff.trim().is_empty() {
                return Err("No changes to generate commit message for".to_string());
            }
            Ok(Value::String(heuristic_commit_message(&diff)))
        }
        "menu_set_accelerators" => Ok(json!({ "ok": true })),
        "codex_doctor" => {
            let codex_bin = parse_optional_string(&params, "codexBin");
            let codex_args = parse_optional_string(&params, "codexArgs");
            Ok(json!({
                "ok": true,
                "codexBin": codex_bin,
                "version": null,
                "appServerOk": true,
                "details": null,
                "path": null,
                "nodeOk": true,
                "nodeVersion": null,
                "nodeDetails": null,
                "codexArgs": codex_args,
            }))
        }
        "generate_run_metadata" => {
            let prompt = parse_string(&params, "prompt")?;
            let title = build_run_title(&prompt);
            let worktree_name = build_worktree_name(&prompt);
            Ok(json!({ "title": title, "worktreeName": worktree_name }))
        }
        "send_notification_fallback" => Ok(json!({ "ok": true })),
        _ => Err(format!("unknown method: {method}")),
    }
}

async fn forward_events(
    mut rx: broadcast::Receiver<DaemonEvent>,
    out_tx_events: mpsc::UnboundedSender<String>,
) {
    loop {
        let event = match rx.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        };

        let Some(payload) = build_event_notification(event) else {
            continue;
        };

        if out_tx_events.send(payload).is_err() {
            break;
        }
    }
}

#[derive(Clone)]
struct RuntimeState {
    config: Arc<DaemonConfig>,
    daemon_state: Arc<DaemonState>,
    events: broadcast::Sender<DaemonEvent>,
}

#[derive(Deserialize, Default)]
struct RpcQuery {
    token: Option<String>,
}

#[derive(Deserialize)]
struct WorkspaceFileQuery {
    path: String,
    token: Option<String>,
}

async fn ws_rpc_route(
    ws: WebSocketUpgrade,
    AxumState(runtime): AxumState<Arc<RuntimeState>>,
    Query(query): Query<RpcQuery>,
) -> impl IntoResponse {
    let authenticated = runtime
        .config
        .token
        .as_ref()
        .map(|expected| query.token.as_deref() == Some(expected.as_str()))
        .unwrap_or(true);
    ws.on_upgrade(move |socket| handle_ws_client(socket, runtime, authenticated))
}

fn unauthorized_response() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

async fn workspace_file_route(
    AxumState(runtime): AxumState<Arc<RuntimeState>>,
    Path(workspace_id): Path<String>,
    Query(query): Query<WorkspaceFileQuery>,
) -> Response {
    if let Some(expected) = runtime.config.token.as_ref() {
        if query.token.as_deref() != Some(expected.as_str()) {
            return unauthorized_response();
        }
    }

    let root = {
        let workspaces = runtime.daemon_state.workspaces.lock().await;
        let Some(entry) = workspaces.get(&workspace_id) else {
            return (StatusCode::NOT_FOUND, "workspace not found").into_response();
        };
        PathBuf::from(&entry.path)
    };

    let canonical_path = match resolve_workspace_file_path(&root, &query.path) {
        Ok(path) => path,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };

    let content = match tokio::fs::read(&canonical_path).await {
        Ok(content) => content,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read file: {error}"),
            )
                .into_response();
        }
    };

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, content_type_for_path(&canonical_path))],
        content,
    )
        .into_response()
}

async fn handle_ws_client(socket: WebSocket, runtime: Arc<RuntimeState>, mut authenticated: bool) {
    let (mut sender, mut receiver) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();

    let write_task = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            if sender.send(Message::Text(message.into())).await.is_err() {
                break;
            }
        }
    });

    let mut events_task: Option<tokio::task::JoinHandle<()>> = None;
    if authenticated {
        let rx = runtime.events.subscribe();
        let out_tx_events = out_tx.clone();
        events_task = Some(tokio::spawn(forward_events(rx, out_tx_events)));
    }

    while let Some(incoming) = receiver.next().await {
        let incoming = match incoming {
            Ok(message) => message,
            Err(_) => break,
        };

        let payload = match incoming {
            Message::Text(text) => text.to_string(),
            Message::Binary(data) => match String::from_utf8(data.to_vec()) {
                Ok(text) => text,
                Err(_) => continue,
            },
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
        };

        let line = payload.trim();
        if line.is_empty() {
            continue;
        }

        let message: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let id = message.get("id").and_then(|value| value.as_u64());
        let method = message
            .get("method")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        if !authenticated {
            if method != "auth" {
                if let Some(response) = build_error_response(id, "unauthorized") {
                    let _ = out_tx.send(response);
                }
                continue;
            }

            let expected = runtime.config.token.clone().unwrap_or_default();
            let provided = parse_auth_token(&params).unwrap_or_default();
            if expected != provided {
                if let Some(response) = build_error_response(id, "invalid token") {
                    let _ = out_tx.send(response);
                }
                continue;
            }

            authenticated = true;
            if let Some(response) = build_result_response(id, json!({ "ok": true })) {
                let _ = out_tx.send(response);
            }

            let rx = runtime.events.subscribe();
            let out_tx_events = out_tx.clone();
            events_task = Some(tokio::spawn(forward_events(rx, out_tx_events)));
            continue;
        }

        let client_version = format!("web-{}", env!("CARGO_PKG_VERSION"));
        let result =
            handle_rpc_request(&runtime.daemon_state, &method, params, client_version).await;
        let response = match result {
            Ok(result) => build_result_response(id, result),
            Err(message) => build_error_response(id, &message),
        };
        if let Some(response) = response {
            let _ = out_tx.send(response);
        }
    }

    drop(out_tx);
    if let Some(task) = events_task {
        task.abort();
    }
    write_task.abort();
}

fn main() {
    let config = match parse_args() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("{err}\n\n{}", usage());
            std::process::exit(2);
        }
    };

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");

    runtime.block_on(async move {
        let (events_tx, _events_rx) = broadcast::channel::<DaemonEvent>(2048);
        let event_sink = DaemonEventSink {
            tx: events_tx.clone(),
        };
        let daemon_state = Arc::new(DaemonState::load(&config, event_sink));
        let config = Arc::new(config);

        let runtime_state = Arc::new(RuntimeState {
            config: Arc::clone(&config),
            daemon_state: Arc::clone(&daemon_state),
            events: events_tx,
        });

        let app = Router::new()
            .route("/rpc", get(ws_rpc_route))
            .route("/api/workspaces/:workspace_id/file", get(workspace_file_route))
            .with_state(runtime_state);

        eprintln!(
            "codex-monitor-web listening on {} (data dir: {})",
            config.listen,
            daemon_state
                .storage_path
                .parent()
                .unwrap_or(&daemon_state.storage_path)
                .display()
        );

        let listener = tokio::net::TcpListener::bind(config.listen)
            .await
            .unwrap_or_else(|err| panic!("failed to bind {}: {err}", config.listen));
        axum::serve(listener, app)
            .await
            .unwrap_or_else(|err| panic!("web server failed: {err}"));
    });
}
