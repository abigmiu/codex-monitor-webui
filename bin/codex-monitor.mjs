#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const tauriDir = resolve(projectRoot, "src-tauri");

const DEFAULT_LISTEN = "127.0.0.1:4732";
const DEFAULT_FRONTEND_PORT = 5173;
const DEFAULT_TOKEN = "dev-token";
const DEFAULT_BACKEND_READY_TIMEOUT_MS = 180_000;
const DEFAULT_BACKEND_RETRY_INTERVAL_MS = 300;

const homeDir = process.env.HOME || process.env.USERPROFILE || projectRoot;
const DEFAULT_DATA_DIR = resolve(homeDir, ".codexmonitor-web");
const DEFAULT_TMP_DIR = resolve(projectRoot, ".tmp");

function printHelp() {
  console.log(`codex-monitor - start CodexMonitor web stack

USAGE:
  codex-monitor [options]

OPTIONS:
  --listen <addr>         Backend bind address (default: ${DEFAULT_LISTEN})
  --data-dir <path>       Backend data directory (default: ${DEFAULT_DATA_DIR})
  --token <token>         Shared backend/frontend token (default: ${DEFAULT_TOKEN})
  --no-token              Disable auth token
  --frontend-port <port>  Vite dev server port (default: ${DEFAULT_FRONTEND_PORT})
  --backend-only          Start backend only
  --frontend-only         Start frontend only
  -h, --help              Show this help

EXAMPLES:
  codex-monitor
  codex-monitor --token my-token
  codex-monitor --backend-only --listen 127.0.0.1:4732
`);
}

function parseArgs(argv) {
  const options = {
    listen: DEFAULT_LISTEN,
    dataDir: DEFAULT_DATA_DIR,
    token: DEFAULT_TOKEN,
    frontendPort: DEFAULT_FRONTEND_PORT,
    backendOnly: false,
    frontendOnly: false,
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
      continue;
    }
    if (arg === "--listen") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --listen");
      }
      options.listen = value;
      index += 1;
      continue;
    }
    if (arg === "--data-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --data-dir");
      }
      options.dataDir = value;
      index += 1;
      continue;
    }
    if (arg === "--token") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --token");
      }
      options.token = value;
      index += 1;
      continue;
    }
    if (arg === "--frontend-port") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("Invalid value for --frontend-port");
      }
      options.frontendPort = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.backendOnly && options.frontendOnly) {
    throw new Error("--backend-only and --frontend-only cannot be used together");
  }

  return options;
}

function commandFor(name) {
  if (process.platform === "win32") {
    return `${name}.cmd`;
  }
  return name;
}

function spawnManaged(command, args, cwd, env) {
  return spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
}

function ensureBackendPrereqs() {
  if (!existsSync(tauriDir)) {
    throw new Error(`Missing backend directory: ${tauriDir}`);
  }
  mkdirSync(DEFAULT_TMP_DIR, { recursive: true });
}

function buildApiBase(listenAddr) {
  return `http://${listenAddr}`;
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

function waitForBackendReady(listenAddr, timeoutMs = DEFAULT_BACKEND_READY_TIMEOUT_MS) {
  const target = parseListenAddress(listenAddr);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > timeoutMs) {
        reject(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s (${target.host}:${target.port})`));
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
  const cargoArgs = [
    "run",
    "--bin",
    "codex_monitor_web",
    "--",
    "--listen",
    options.listen,
    "--data-dir",
    options.dataDir,
  ];

  if (options.token) {
    cargoArgs.push("--token", options.token);
  }

  const tmpDir = resolveTmpDir();
  const backendEnv = {
    ...process.env,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
  };

  console.log(`[codex-monitor] tmp dir: ${tmpDir}`);
  return spawnManaged(commandFor("cargo"), cargoArgs, tauriDir, backendEnv);
}

function startFrontend(options) {
  const frontendEnv = {
    ...process.env,
    VITE_CODEX_MONITOR_API_BASE: buildApiBase(options.listen),
  };

  if (options.token) {
    frontendEnv.VITE_CODEX_MONITOR_TOKEN = options.token;
  } else {
    delete frontendEnv.VITE_CODEX_MONITOR_TOKEN;
  }

  const npmArgs = [
    "run",
    "dev",
    "--",
    "--host",
    "127.0.0.1",
    "--port",
    String(options.frontendPort),
  ];

  return spawnManaged(commandFor("npm"), npmArgs, projectRoot, frontendEnv);
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
  } catch (error) {
    console.error(`[codex-monitor] ${error.message}`);
    printHelp();
    process.exit(2);
  }

  if (options.help) {
    printHelp();
    return;
  }

  ensureBackendPrereqs();

  console.log(
    `[codex-monitor] starting (${options.backendOnly ? "backend" : options.frontendOnly ? "frontend" : "backend + frontend"})`,
  );
  console.log(`[codex-monitor] backend: ${buildApiBase(options.listen)}`);
  if (!options.backendOnly) {
    console.log(`[codex-monitor] frontend: http://127.0.0.1:${options.frontendPort}`);
  }

  const children = [];
  let backendChild = null;

  if (!options.frontendOnly) {
    backendChild = startBackend(options);
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
