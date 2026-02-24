import { accessSync, constants, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

function ensureWritableTmpdir() {
  const candidate = process.env.TMPDIR || process.env.TMP || process.env.TEMP;
  const fallback = resolve(process.cwd(), ".tmp", "vitest");
  const target = candidate?.trim() ? candidate.trim() : fallback;

  try {
    mkdirSync(target, { recursive: true });
    accessSync(target, constants.W_OK);
    process.env.TMPDIR = target;
    process.env.TMP = target;
    process.env.TEMP = target;
    return;
  } catch {
    // ignore
  }

  mkdirSync(fallback, { recursive: true });
  process.env.TMPDIR = fallback;
  process.env.TMP = fallback;
  process.env.TEMP = fallback;
}

ensureWritableTmpdir();

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as {
  version: string;
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  worker: {
    format: "es",
  },
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/vitest.setup.ts"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/.codex-worktrees/**"],
    },
  },
}));
