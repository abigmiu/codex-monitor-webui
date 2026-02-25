#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 5176;
const DEFAULT_CONFIG_FILENAME = "codex-monitor.server.json";

function parseArgs(argv) {
  const options = {
    root: "dist",
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    apiBase: null,
    token: null,
    defaultWorkspacePath: null,
    disableDefaultWorkspace: false,
    help: false,
    _hostProvided: false,
    _portProvided: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --root");
      }
      options.root = value;
      index += 1;
      continue;
    }
    if (arg === "--host") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --host");
      }
      options.host = value;
      options._hostProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("Invalid value for --port");
      }
      options.port = value;
      options._portProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--api-base") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --api-base");
      }
      options.apiBase = value;
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
    if (arg === "--default-workspace") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --default-workspace");
      }
      options.defaultWorkspacePath = value;
      options.disableDefaultWorkspace = false;
      index += 1;
      continue;
    }
    if (arg === "--no-default-workspace") {
      options.defaultWorkspacePath = null;
      options.disableDefaultWorkspace = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function usage() {
  return `serve-frontend - static file server for CodexMonitor

USAGE:
  node scripts/serve-frontend.mjs [options]

CONFIG:
  - If <root>/${DEFAULT_CONFIG_FILENAME} exists, it provides default host/port.
  - CLI flags --host/--port override config values.

OPTIONS:
  --root <path>        Frontend dist root (default: dist)
  --host <host>        Bind host (default: 0.0.0.0)
  --port <port>        Bind port (default: 5176)
  --api-base <url>     Runtime API base override
  --token <token>      Runtime token override
  --default-workspace <path>  Runtime default workspace path
  --no-default-workspace      Disable default workspace auto-open
  -h, --help           Show this help
`;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentTypeFor(pathname) {
  const ext = extname(pathname).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function buildInjectedRuntimeScript(options) {
  const config = {
    apiBase: options.apiBase ?? undefined,
    token: options.token ?? undefined,
    defaultWorkspacePath: options.defaultWorkspacePath ?? undefined,
    disableDefaultWorkspace: options.disableDefaultWorkspace ? true : undefined,
  };
  return `<script>window.__CODEX_MONITOR_RUNTIME_CONFIG__ = ${JSON.stringify(config)};</script>`;
}

function resolvePathSafe(rootDir, requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const sanitized = normalize(decodedPath).replace(/^([/\\])+/, "");
  const absolute = resolve(join(rootDir, sanitized));
  if (!absolute.startsWith(rootDir)) {
    return null;
  }
  return absolute;
}

async function createRequestHandler(options) {
  const rootDir = resolve(options.root);
  const indexFile = join(rootDir, "index.html");

  if (!existsSync(indexFile)) {
    throw new Error(`Frontend assets not found: ${indexFile}`);
  }

  const indexTemplate = await readFile(indexFile, "utf8");
  const runtimeScript = buildInjectedRuntimeScript(options);
  const injectedIndex = indexTemplate.includes("</head>")
    ? indexTemplate.replace("</head>", `${runtimeScript}</head>`)
    : `${runtimeScript}${indexTemplate}`;

  return async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = requestUrl.pathname;

    if (pathname === "/") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.end(injectedIndex);
      return;
    }

    const target = resolvePathSafe(rootDir, pathname);
    if (!target) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("invalid path");
      return;
    }

    try {
      const body = await readFile(target);
      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeFor(target));
      res.end(body);
      return;
    } catch {
      if (extname(pathname)) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("not found");
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.end(injectedIndex);
    }
  };
}

function validateServerConfig(config, configPath) {
  if (config == null || typeof config !== "object") {
    throw new Error(`Invalid config file (expected object): ${configPath}`);
  }
  if ("host" in config && typeof config.host !== "string") {
    throw new Error(`Invalid config host (expected string): ${configPath}`);
  }
  if ("port" in config) {
    const port = config.port;
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid config port (expected positive integer): ${configPath}`);
    }
  }
}

async function applyConfigFileDefaults(options) {
  const rootDir = resolve(options.root);
  const configPath = join(rootDir, DEFAULT_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return options;
  }

  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  validateServerConfig(config, configPath);

  if (!options._hostProvided && typeof config.host === "string" && config.host.trim()) {
    options.host = config.host.trim();
  }
  if (!options._portProvided && Number.isInteger(config.port) && config.port > 0) {
    options.port = config.port;
  }

  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[serve-frontend] ${error.message}`);
    console.error(usage());
    process.exit(2);
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  try {
    await applyConfigFileDefaults(options);
  } catch (error) {
    console.error(`[serve-frontend] ${error.message}`);
    process.exit(2);
  }

  const handler = await createRequestHandler(options);
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  server.listen(options.port, options.host, () => {
    console.log(`[serve-frontend] listening on http://${options.host}:${options.port}`);
  });
}

main().catch((error) => {
  console.error(`[serve-frontend] ${error.message}`);
  process.exit(1);
});
