#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { stat, rename, chmod, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const distDir = resolve(projectRoot, "dist");
const frontendServerScript = resolve(projectRoot, "scripts", "serve-frontend.mjs");
const packageJsonPath = resolve(projectRoot, "package.json");

const DEFAULT_LISTEN = "127.0.0.1:4732";
const DEFAULT_FRONTEND_HOST = "0.0.0.0";
const DEFAULT_FRONTEND_PORT = 5176;
const DEFAULT_FRONTEND_CONFIG_FILENAME = "codex-monitor.server.json";
const DEFAULT_TOKEN = "dev-token";
const DEFAULT_BACKEND_READY_TIMEOUT_MS = 180_000;
const DEFAULT_BACKEND_RETRY_INTERVAL_MS = 300;
const DEFAULT_DEFAULT_WORKSPACE_PATH = "/workspace";
const DEFAULT_USER_CONFIG_PATH = join(homedir(), ".miu-codex-monitor.json");

const homeDir = process.env.HOME || process.env.USERPROFILE || projectRoot;
const DEFAULT_DATA_DIR = resolve(homeDir, ".codexmonitor-web");
const DEFAULT_TMP_DIR = resolve(homeDir, ".codexmonitor", "tmp");

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalPort(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function resolveUserConfigPath() {
  const configured = normalizeOptionalString(process.env.MIU_CODEX_MONITOR_CONFIG);
  if (configured) {
    return resolve(configured);
  }
  return DEFAULT_USER_CONFIG_PATH;
}

function readUserConfig() {
  const configPath = resolveUserConfigPath();
  if (!existsSync(configPath)) {
    return { path: configPath, config: null };
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("config must be a JSON object");
    }
    return { path: configPath, config: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[codex-monitor] Ignoring invalid config at ${configPath}: ${message}`);
    return { path: configPath, config: null };
  }
}

function pickUserConfigValue(config, keys) {
  if (!config || typeof config !== "object") {
    return undefined;
  }
  for (const key of keys) {
    const parts = key.split(".");
    let current = config;
    let ok = true;
    for (const part of parts) {
      if (!current || typeof current !== "object" || !(part in current)) {
        ok = false;
        break;
      }
      current = current[part];
    }
    if (ok) {
      return current;
    }
  }
  return undefined;
}

function printHelp() {
  console.log(`codex-monitor - start CodexMonitor web stack

USAGE:
  codex-monitor [options]

OPTIONS:
  --listen <addr>         Backend bind address (default: ${DEFAULT_LISTEN})
  --data-dir <path>       Backend data directory (default: ${DEFAULT_DATA_DIR})
  --token <token>         Shared backend/frontend token (default: ${DEFAULT_TOKEN})
  --no-token              Disable auth token
  --backend-path <path>   Use an existing backend executable (skips download)
  --backend-cache-dir <path>  Backend binary cache directory (default: ${DEFAULT_DATA_DIR})
  --no-backend-download   Disable backend auto-download
  --frontend-host <host>  Frontend bind host (default: ${DEFAULT_FRONTEND_HOST})
  --frontend-port <port>  Frontend bind port (default: ${DEFAULT_FRONTEND_PORT}; can be overridden by dist/${DEFAULT_FRONTEND_CONFIG_FILENAME})
  --default-workspace <path>  Default workspace path to open (default: ${DEFAULT_DEFAULT_WORKSPACE_PATH})
  --no-default-workspace  Disable default workspace auto-open
  --backend-only          Start backend only
  --frontend-only         Start frontend only
  -h, --help              Show this help

NOTES:
  - Frontend serves prebuilt static assets from dist/.
  - Frontend bind host/port defaults can be set in dist/${DEFAULT_FRONTEND_CONFIG_FILENAME}.
  - User config (npm/global install friendly): ${DEFAULT_USER_CONFIG_PATH}
    - Override path via env: MIU_CODEX_MONITOR_CONFIG=/path/to/config.json
  - If dist/ is missing, run: npm run build
  - Backend is started from a native binary when available (no Rust required).
  - Dev fallback: if no backend binary is available, we can run via cargo (requires Rust).

EXAMPLES:
  codex-monitor
  codex-monitor --token my-token
  codex-monitor --backend-only --listen 127.0.0.1:4732
  codex-monitor --frontend-only --listen 127.0.0.1:4732
`);
}

function parseArgs(argv) {
  const options = {
    listen: DEFAULT_LISTEN,
    _listenProvided: false,
    dataDir: DEFAULT_DATA_DIR,
    _dataDirProvided: false,
    backendCacheDir: DEFAULT_DATA_DIR,
    _backendCacheDirProvided: false,
    token: DEFAULT_TOKEN,
    _tokenProvided: false,
    frontendPort: DEFAULT_FRONTEND_PORT,
    _frontendPortProvided: false,
    frontendHost: DEFAULT_FRONTEND_HOST,
    _frontendHostProvided: false,
    defaultWorkspacePath: DEFAULT_DEFAULT_WORKSPACE_PATH,
    _defaultWorkspaceProvided: false,
    backendOnly: false,
    frontendOnly: false,
    backendPath: null,
    allowBackendDownload: true,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--backend-only") {
      options.backendOnly = true;
      continue;
    }
    if (arg === "--frontend-only") {
      options.frontendOnly = true;
      continue;
    }
    if (arg === "--no-token") {
      options.token = null;
      options._tokenProvided = true;
      continue;
    }
    if (arg === "--backend-path") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --backend-path");
      }
      options.backendPath = value;
      index += 1;
      continue;
    }
    if (arg === "--backend-cache-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --backend-cache-dir");
      }
      options.backendCacheDir = value;
      options._backendCacheDirProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--no-backend-download") {
      options.allowBackendDownload = false;
      continue;
    }
    if (arg === "--listen") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --listen");
      }
      options.listen = value;
      options._listenProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--data-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --data-dir");
      }
      options.dataDir = value;
      options._dataDirProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--token") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --token");
      }
      options.token = value;
      options._tokenProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--frontend-port") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("Invalid value for --frontend-port");
      }
      options.frontendPort = value;
      options._frontendPortProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--frontend-host") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --frontend-host");
      }
      options.frontendHost = value;
      options._frontendHostProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--default-workspace") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --default-workspace");
      }
      options.defaultWorkspacePath = value;
      options._defaultWorkspaceProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--no-default-workspace") {
      options.defaultWorkspacePath = null;
      options._defaultWorkspaceProvided = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.backendOnly && options.frontendOnly) {
    throw new Error("--backend-only and --frontend-only cannot be used together");
  }

  return options;
}

function applyUserConfigDefaults(options) {
  const { config } = readUserConfig();
  if (!config) {
    return options;
  }

  if (!options._listenProvided) {
    const listen = normalizeOptionalString(
      pickUserConfigValue(config, ["backend.listen", "listen", "backendListen"]),
    );
    if (listen) {
      options.listen = listen;
    }
  }

  if (!options._dataDirProvided) {
    const dataDir = normalizeOptionalString(
      pickUserConfigValue(config, ["backend.dataDir", "dataDir", "backendDataDir"]),
    );
    if (dataDir) {
      options.dataDir = dataDir;
    }
  }

  if (!options._backendCacheDirProvided) {
    const backendCacheDir = normalizeOptionalString(
      pickUserConfigValue(config, [
        "backend.backendCacheDir",
        "backendCacheDir",
        "backend.cacheDir",
      ]),
    );
    if (backendCacheDir) {
      options.backendCacheDir = backendCacheDir;
    }
  }

  if (!options._tokenProvided) {
    const tokenValue = pickUserConfigValue(config, ["backend.token", "token", "authToken"]);
    if (tokenValue === null) {
      options.token = null;
    } else {
      const token = normalizeOptionalString(tokenValue);
      if (token) {
        options.token = token;
      }
    }
  }

  if (!options._frontendHostProvided) {
    const frontendHost = normalizeOptionalString(
      pickUserConfigValue(config, ["frontend.host", "frontendHost"]),
    );
    if (frontendHost) {
      options.frontendHost = frontendHost;
      options._frontendHostProvided = true;
    }
  }

  if (!options._frontendPortProvided) {
    const frontendPort = normalizeOptionalPort(
      pickUserConfigValue(config, ["frontend.port", "frontendPort"]),
    );
    if (frontendPort) {
      options.frontendPort = frontendPort;
      options._frontendPortProvided = true;
    }
  }

  if (!options._defaultWorkspaceProvided) {
    const defaultWorkspaceValue = pickUserConfigValue(config, [
      "defaultWorkspacePath",
      "defaultWorkspace",
      "workspace.defaultPath",
    ]);
    if (defaultWorkspaceValue === null) {
      options.defaultWorkspacePath = null;
    } else {
      const defaultWorkspacePath = normalizeOptionalString(defaultWorkspaceValue);
      if (defaultWorkspacePath) {
        options.defaultWorkspacePath = defaultWorkspacePath;
      }
    }
  }

  return options;
}

function validateFrontendServerConfig(config, configPath) {
  if (config == null || typeof config !== "object") {
    throw new Error(`Invalid frontend config file (expected object): ${configPath}`);
  }
  if ("host" in config && typeof config.host !== "string") {
    throw new Error(`Invalid frontend config host (expected string): ${configPath}`);
  }
  if ("port" in config) {
    const port = config.port;
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid frontend config port (expected positive integer): ${configPath}`);
    }
  }
}

function readFrontendServerConfig(distRoot) {
  const configPath = resolve(distRoot, DEFAULT_FRONTEND_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return null;
  }
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  validateFrontendServerConfig(parsed, configPath);
  return {
    host: typeof parsed.host === "string" && parsed.host.trim() ? parsed.host.trim() : null,
    port: Number.isInteger(parsed.port) && parsed.port > 0 ? parsed.port : null,
  };
}

function resolveFrontendBind(options) {
  const config = readFrontendServerConfig(distDir);
  const host = options._frontendHostProvided
    ? options.frontendHost
    : (config?.host ?? DEFAULT_FRONTEND_HOST);
  const port = options._frontendPortProvided
    ? options.frontendPort
    : (config?.port ?? DEFAULT_FRONTEND_PORT);
  return { host, port };
}

function commandFor(name) {
  if (process.platform === "win32") {
    return `${name}.cmd`;
  }
  return name;
}

function resolveCommandInPath(name) {
  const rawPath = process.env.PATH ?? "";
  const parts = rawPath.split(delimiter).filter(Boolean);
  const candidates = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];

  for (const dir of parts) {
    for (const candidate of candidates) {
      const fullPath = resolve(dir, candidate);
      try {
        accessSync(fullPath, constants.X_OK);
        return fullPath;
      } catch {
        // ignore
      }
    }
  }

  return null;
}

function spawnManaged(command, args, cwd, env) {
  return spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
}

function isWritableDir(dirPath) {
  if (!dirPath) {
    return false;
  }
  try {
    mkdirSync(dirPath, { recursive: true });
    accessSync(dirPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveTmpDir() {
  const candidates = [
    process.env.CODEX_MONITOR_TMPDIR,
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    DEFAULT_TMP_DIR,
  ];

  for (const candidate of candidates) {
    if (isWritableDir(candidate)) {
      return candidate;
    }
  }

  mkdirSync(DEFAULT_TMP_DIR, { recursive: true });
  return DEFAULT_TMP_DIR;
}

function ensureBackendPrereqs() {
  // No-op: backend can run from a downloaded/prebuilt executable.
}

function ensureFrontendPrereqs() {
  if (!existsSync(frontendServerScript)) {
    throw new Error(`Missing frontend server script: ${frontendServerScript}`);
  }
  const indexFile = resolve(distDir, "index.html");
  if (!existsSync(indexFile)) {
    throw new Error(
      `Frontend assets not found: ${indexFile}. Run 'npm run build' before launching frontend.`,
    );
  }
}

function buildApiBase(listenAddr) {
  return `http://${listenAddr}`;
}

function parseListenAddress(listenAddr) {
  try {
    const url = new URL(`http://${listenAddr}`);
    const port = Number.parseInt(url.port, 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error("invalid port");
    }
    return { host: url.hostname, port };
  } catch {
    throw new Error(`Invalid --listen address: ${listenAddr}`);
  }
}

function platformKey() {
  const platform = process.platform;
  const arch = process.arch;
  return `${platform}-${arch}`;
}

function backendFilename() {
  return process.platform === "win32" ? "codex_monitor_web.exe" : "codex_monitor_web";
}

function defaultBackendReleaseBase() {
  const configured = (process.env.CODEX_MONITOR_BACKEND_RELEASE_BASE ?? "").trim();
  if (configured) {
    return configured;
  }

  const packageConfigured = readBackendReleaseBaseFromPackage();
  if (packageConfigured) {
    return packageConfigured;
  }

  const repositoryUrl = readPackageRepositoryUrl();
  if (!repositoryUrl) {
    return "";
  }

  // GitHub style: https://github.com/<org>/<repo>/releases/download/<tag>/<asset>
  if (repositoryUrl.includes("github.com/")) {
    return `${repositoryUrl.replace(/\/+$/, "")}/releases/download`;
  }

  // GitLab-like (CNB) style: https://<host>/<group>/<repo>/-/releases/<tag>/downloads/<asset>
  return `${repositoryUrl.replace(/\/+$/, "")}/-/releases`;
}

function readPackageJson() {
  try {
    const raw = String(readFileSync(packageJsonPath, "utf8"));
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readPackageVersion() {
  try {
    const parsed = readPackageJson();
    const version = typeof parsed?.version === "string" ? String(parsed.version).trim() : "";
    return version || "0.0.0";
  } catch {
    return process.env.npm_package_version?.trim() || "0.0.0";
  }
}

function readPackageRepositoryUrl() {
  const parsed = readPackageJson();
  const url = parsed?.repository?.url;
  if (typeof url !== "string") {
    return "";
  }
  return url.trim().replace(/\.git$/i, "");
}

function readBackendReleaseBaseFromPackage() {
  const parsed = readPackageJson();
  const value = parsed?.codexMonitor?.backendReleaseBase;
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function buildBackendDownloadUrl({ version, platform, releaseBase }) {
  const tag = (process.env.CODEX_MONITOR_BACKEND_RELEASE_TAG ?? `v${version}`).trim();
  const assetOverride = (process.env.CODEX_MONITOR_BACKEND_ASSET ?? "").trim();
  const baseName = "codex_monitor_web";
  const ext = process.platform === "win32" ? ".exe" : "";
  const assetName = assetOverride || `${baseName}-${platform}${ext}`;

  const normalizedBase = releaseBase.replace(/\/+$/, "");
  if (normalizedBase.includes("/releases/download")) {
    return `${normalizedBase}/${tag}/${assetName}`;
  }
  if (normalizedBase.includes("/-/releases")) {
    return `${normalizedBase}/${tag}/downloads/${assetName}`;
  }
  return `${normalizedBase}/${tag}/${assetName}`;
}

function resolveBackendCacheDir(options) {
  if (options.backendCacheDir) {
    return options.backendCacheDir;
  }
  const envValue = (process.env.CODEX_MONITOR_BACKEND_CACHE_DIR ?? "").trim();
  return envValue || DEFAULT_DATA_DIR;
}

async function ensureDownloadedBackend(options) {
  const version = readPackageVersion();
  const platform = platformKey();
  const backendCacheDir = resolveBackendCacheDir(options);
  const cacheDir = resolve(backendCacheDir, "backend", version, platform);
  const targetPath = resolve(cacheDir, backendFilename());

  try {
    const info = await stat(targetPath);
    if (info.isFile() && info.size > 0) {
      return targetPath;
    }
  } catch {
    // missing
  }

  if (!options.allowBackendDownload) {
    return null;
  }
  if (process.env.CODEX_MONITOR_SKIP_BACKEND_DOWNLOAD === "1") {
    return null;
  }

  const directUrl = (process.env.CODEX_MONITOR_BACKEND_URL ?? "").trim();
  const releaseBase = defaultBackendReleaseBase();
  if (!directUrl && !releaseBase) {
    return null;
  }
  const downloadUrl =
    directUrl ||
    buildBackendDownloadUrl({
      version,
      platform,
      releaseBase,
    });

  await mkdir(cacheDir, { recursive: true });
  const tmpPath = `${targetPath}.download`;

  console.log(`[codex-monitor] downloading backend: ${downloadUrl}`);
  const response = await fetch(downloadUrl);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download backend (${response.status}). Set CODEX_MONITOR_BACKEND_URL or CODEX_MONITOR_BACKEND_RELEASE_BASE.`,
    );
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));
  await rename(tmpPath, targetPath);

  if (process.platform !== "win32") {
    await chmod(targetPath, 0o755);
  }

  return targetPath;
}

async function resolveBackendCommand(options) {
  if (options.backendPath) {
    return { command: options.backendPath, args: [] };
  }

  const envBackendPath = (process.env.CODEX_MONITOR_BACKEND_PATH ?? "").trim();
  if (envBackendPath) {
    return { command: envBackendPath, args: [] };
  }

  const downloaded = await ensureDownloadedBackend(options);
  if (downloaded) {
    return { command: downloaded, args: [] };
  }

  const inPath =
    resolveCommandInPath("codex-monitor-web") ??
    resolveCommandInPath("codex_monitor_web") ??
    resolveCommandInPath("codex-monitor-web.exe") ??
    resolveCommandInPath("codex_monitor_web.exe");
  if (inPath) {
    return { command: inPath, args: [] };
  }

  const cargo = resolveCommandInPath("cargo");
  const tauriDir = resolve(projectRoot, "src-tauri");
  if (cargo && existsSync(tauriDir)) {
    return {
      command: cargo,
      args: ["run", "--bin", "codex_monitor_web", "--"],
      cwd: tauriDir,
    };
  }

  return null;
}

function waitForBackendReady(listenAddr, timeoutMs = DEFAULT_BACKEND_READY_TIMEOUT_MS) {
  const target = parseListenAddress(listenAddr);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > timeoutMs) {
        reject(
          new Error(
            `timeout after ${Math.round(timeoutMs / 1000)}s (${target.host}:${target.port})`,
          ),
        );
        return;
      }

      const socket = createConnection({ host: target.host, port: target.port });
      let settled = false;

      const retry = () => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        setTimeout(attempt, DEFAULT_BACKEND_RETRY_INTERVAL_MS);
      };

      socket.setTimeout(1000);
      socket.once("connect", () => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve();
      });
      socket.once("error", retry);
      socket.once("timeout", retry);
    };

    attempt();
  });
}

function startBackend(options) {
  const tmpDir = resolveTmpDir();
  const backendEnv = {
    ...process.env,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
  };

  console.log(`[codex-monitor] tmp dir: ${tmpDir}`);

  return (async () => {
    const resolved = await resolveBackendCommand(options);
    if (!resolved) {
      const hints = [
        "Install a backend binary and ensure it is in PATH as `codex-monitor-web` / `codex_monitor_web`.",
        "Or set `CODEX_MONITOR_BACKEND_PATH=/path/to/codex_monitor_web`.",
        "Or set `CODEX_MONITOR_BACKEND_CACHE_DIR` to point at a cache containing the downloaded binary.",
        "Or set `CODEX_MONITOR_BACKEND_URL` (direct download URL).",
        "Or set `CODEX_MONITOR_BACKEND_RELEASE_BASE` (defaults to a GitHub Releases base).",
        "Dev fallback: install Rust + cargo and run from source (repo clone).",
      ];
      throw new Error(`No backend available.\n- ${hints.join("\n- ")}`);
    }

    const args = [
      ...(resolved.args ?? []),
      "--listen",
      options.listen,
      "--data-dir",
      options.dataDir,
    ];

    if (options.token) {
      args.push("--token", options.token);
    }

    const cwd = resolved.cwd ?? projectRoot;
    return spawnManaged(resolved.command, args, cwd, backendEnv);
  })();
}

function startFrontend(options) {
  const bind = resolveFrontendBind(options);
  const args = [
    frontendServerScript,
    "--root",
    distDir,
    "--api-base",
    buildApiBase(options.listen),
  ];

  if (options._frontendHostProvided) {
    args.push("--host", String(bind.host));
  }
  if (options._frontendPortProvided) {
    args.push("--port", String(bind.port));
  }
  if (typeof options.defaultWorkspacePath === "string" && options.defaultWorkspacePath.trim()) {
    args.push("--default-workspace", options.defaultWorkspacePath.trim());
  } else if (options.defaultWorkspacePath === null) {
    args.push("--no-default-workspace");
  }

  if (options.token) {
    args.push("--token", options.token);
  }

  return spawnManaged(commandFor("node"), args, projectRoot, process.env);
}

function monitor(children) {
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        child.kill(signal);
      }
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  let remaining = children.length;
  for (const child of children) {
    child.on("exit", (code, signal) => {
      remaining -= 1;

      if (!shuttingDown && (code !== 0 || signal)) {
        shutdown("SIGTERM");
        process.exit(typeof code === "number" ? code : 1);
      }

      if (remaining === 0) {
        process.exit(0);
      }
    });
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    options = applyUserConfigDefaults(options);
  } catch (error) {
    console.error(`[codex-monitor] ${error.message}`);
    printHelp();
    process.exit(2);
  }

  if (options.help) {
    printHelp();
    return;
  }

  if (!options.frontendOnly) {
    ensureBackendPrereqs();
  }
  if (!options.backendOnly) {
    ensureFrontendPrereqs();
  }

  console.log(
    `[codex-monitor] starting (${options.backendOnly ? "backend" : options.frontendOnly ? "frontend" : "backend + frontend"})`,
  );
  console.log(`[codex-monitor] backend: ${buildApiBase(options.listen)}`);
  if (!options.backendOnly) {
    try {
      const bind = resolveFrontendBind(options);
      console.log(`[codex-monitor] frontend: http://${bind.host}:${bind.port}`);
    } catch (error) {
      console.error(`[codex-monitor] ${error.message}`);
      process.exit(2);
    }
  }

  const children = [];
  let backendChild = null;

  if (!options.frontendOnly) {
    backendChild = await startBackend(options);
    children.push(backendChild);
  }

  if (!options.backendOnly) {
    if (backendChild) {
      console.log("[codex-monitor] waiting for backend to become ready...");

      const backendReadyPromise = waitForBackendReady(options.listen);
      const backendExitedPromise = new Promise((_, reject) => {
        backendChild.once("exit", (code, signal) => {
          reject(
            new Error(
              `backend exited before ready (code=${code ?? "null"}, signal=${signal ?? "none"})`,
            ),
          );
        });
      });

      try {
        await Promise.race([backendReadyPromise, backendExitedPromise]);
        console.log("[codex-monitor] backend is ready");
      } catch (error) {
        console.error(`[codex-monitor] ${error.message}`);
        if (backendChild.exitCode === null && !backendChild.killed) {
          backendChild.kill("SIGTERM");
        }
        process.exit(1);
      }
    }

    const frontendChild = startFrontend(options);
    children.push(frontendChild);
  }

  if (children.length === 0) {
    console.error("[codex-monitor] Nothing to start.");
    process.exit(1);
  }

  monitor(children);
}

main().catch((error) => {
  console.error(`[codex-monitor] ${error.message}`);
  process.exit(1);
});
