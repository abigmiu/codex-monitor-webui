#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(projectRoot, "dist");
const distIndex = join(distDir, "index.html");
const configFilename = "codex-monitor.server.json";
const distConfigPath = join(distDir, configFilename);
const rootConfigPath = join(projectRoot, configFilename);

function defaultConfig() {
  return {
    host: "0.0.0.0",
    port: 5176,
  };
}

async function ensureDir(pathname) {
  await mkdir(pathname, { recursive: true });
}

async function main() {
  if (!existsSync(distIndex)) {
    throw new Error(`dist/ not found (missing ${distIndex}). Run: npm run build`);
  }

  await ensureDir(dirname(distConfigPath));

  if (existsSync(distConfigPath)) {
    console.log(`[write-frontend-server-config] exists: ${distConfigPath}`);
    return;
  }

  if (existsSync(rootConfigPath)) {
    const raw = await readFile(rootConfigPath, "utf8");
    await writeFile(distConfigPath, raw, "utf8");
    console.log(`[write-frontend-server-config] copied: ${rootConfigPath} -> ${distConfigPath}`);
    return;
  }

  await writeFile(distConfigPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`, "utf8");
  console.log(`[write-frontend-server-config] created: ${distConfigPath}`);
}

main().catch((error) => {
  console.error(`[write-frontend-server-config] ${error.message}`);
  process.exit(1);
});
