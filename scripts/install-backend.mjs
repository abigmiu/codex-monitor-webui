#!/usr/bin/env node
import { accessSync, constants, createWriteStream, readFileSync } from "node:fs";
import { chmod, mkdir, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = resolve(projectRoot, "package.json");

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPackageJson() {
  try {
    return JSON.parse(String(readFileSync(packageJsonPath, "utf8")));
  } catch {
    return null;
  }
}

function readPackageVersion() {
  const parsed = readPackageJson();
  const version = normalizeOptionalString(parsed?.version) ?? normalizeOptionalString(process.env.npm_package_version);
  return version ?? "0.0.0";
}

function readPackageRepositoryUrl() {
  const parsed = readPackageJson();
  return normalizeOptionalString(parsed?.repository?.url)?.replace(/\.git$/i, "") ?? "";
}

function readBackendReleaseBaseFromPackage() {
  const parsed = readPackageJson();
  return normalizeOptionalString(parsed?.codexMonitor?.backendReleaseBase) ?? "";
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function backendFilename() {
  return process.platform === "win32" ? "codex_monitor_web.exe" : "codex_monitor_web";
}

function resolveHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

function defaultDataDir() {
  return resolve(resolveHomeDir(), ".codexmonitor-web");
}

function resolveBackendCacheDir() {
  const configured = normalizeOptionalString(process.env.CODEX_MONITOR_BACKEND_CACHE_DIR);
  if (configured) {
    return resolve(configured);
  }
  return defaultDataDir();
}

function deriveReleaseBaseFromRepositoryUrl(repositoryUrl) {
  if (!repositoryUrl) {
    return "";
  }
  const normalized = repositoryUrl.replace(/\/+$/, "");
  if (normalized.includes("github.com/")) {
    return `${normalized}/releases/download`;
  }
  return `${normalized}/-/releases`;
}

function resolveReleaseBase() {
  const configured = normalizeOptionalString(process.env.CODEX_MONITOR_BACKEND_RELEASE_BASE);
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  const packageConfigured = readBackendReleaseBaseFromPackage();
  if (packageConfigured) {
    return packageConfigured.replace(/\/+$/, "");
  }
  return deriveReleaseBaseFromRepositoryUrl(readPackageRepositoryUrl());
}

function buildBackendDownloadUrl({ version, platform, releaseBase }) {
  const tag = normalizeOptionalString(process.env.CODEX_MONITOR_BACKEND_RELEASE_TAG) ?? `v${version}`;
  const assetOverride = normalizeOptionalString(process.env.CODEX_MONITOR_BACKEND_ASSET);
  const ext = process.platform === "win32" ? ".exe" : "";
  const assetName = assetOverride ?? `codex_monitor_web-${platform}${ext}`;

  const base = releaseBase.replace(/\/+$/, "");
  if (base.includes("/releases/download")) {
    return `${base}/${tag}/${assetName}`;
  }
  if (base.includes("/-/releases")) {
    return `${base}/${tag}/downloads/${assetName}`;
  }
  return `${base}/${tag}/${assetName}`;
}

async function ensureExecutableExists(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0) {
      return false;
    }
    if (process.platform !== "win32") {
      accessSync(filePath, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function shouldSkipDownload() {
  if (process.env.CODEX_MONITOR_SKIP_BACKEND_DOWNLOAD === "1") {
    return true;
  }
  if (process.env.npm_config_ignore_scripts === "true") {
    return true;
  }
  return false;
}

async function downloadFile(url, targetPath) {
  const tmpPath = `${targetPath}.download`;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));
  await rename(tmpPath, targetPath);
  if (process.platform !== "win32") {
    await chmod(targetPath, 0o755);
  }
}

async function main() {
  if (shouldSkipDownload()) {
    return;
  }

  const strict = process.env.CODEX_MONITOR_BACKEND_INSTALL_STRICT === "1";
  const version = readPackageVersion();
  const platform = platformKey();
  const cacheDir = resolveBackendCacheDir();
  const targetPath = resolve(cacheDir, "backend", version, platform, backendFilename());

  if (await ensureExecutableExists(targetPath)) {
    return;
  }

  const directUrl = normalizeOptionalString(process.env.CODEX_MONITOR_BACKEND_URL);
  const releaseBase = resolveReleaseBase();
  const downloadUrl =
    directUrl ??
    (releaseBase
      ? buildBackendDownloadUrl({ version, platform, releaseBase })
      : null);

  if (!downloadUrl) {
    const message =
      "[codex-monitor] backend download skipped: no CODEX_MONITOR_BACKEND_URL or CODEX_MONITOR_BACKEND_RELEASE_BASE/repository.url";
    if (strict) {
      throw new Error(message);
    }
    console.warn(message);
    return;
  }

  await mkdir(dirname(targetPath), { recursive: true });

  console.log(`[codex-monitor] downloading backend (${platform}) -> ${targetPath}`);
  console.log(`[codex-monitor] url: ${downloadUrl}`);

  try {
    await downloadFile(downloadUrl, targetPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const help = [
      `[codex-monitor] backend download failed: ${reason}`,
      `- platform: ${platform}`,
      `- expected path: ${targetPath}`,
      "",
      "Fix options:",
      "- Set CODEX_MONITOR_BACKEND_URL to a direct binary URL",
      "- Or set CODEX_MONITOR_BACKEND_RELEASE_BASE + CODEX_MONITOR_BACKEND_RELEASE_TAG",
      "- Or later run: codex-monitor --backend-path /path/to/codex_monitor_web",
      "- Or disable download: CODEX_MONITOR_SKIP_BACKEND_DOWNLOAD=1",
      "",
    ].join("\n");

    if (strict) {
      throw new Error(help);
    }
    console.warn(help);
    return;
  }

  const ok = await ensureExecutableExists(targetPath);
  if (!ok) {
    const message = `[codex-monitor] backend download did not produce an executable: ${targetPath}`;
    if (strict) {
      throw new Error(message);
    }
    console.warn(message);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
