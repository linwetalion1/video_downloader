// Сборка расширения: три независимых vite-сборки + копирование манифеста/иконок.
//   1. background.js   – service worker (ES module, одиночный чанк)
//   2. content.js      – content script (IIFE, одиночный чанк)
//   3. sidepanel.html  – React UI (отдельный обычный vite build)
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ensureIcons } from "./make-icons.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const shared = { configFile: false, root } ;
ensureIcons();

async function buildWorker() {
  await build({
    ...shared,
    build: {
      outDir: "dist",
      emptyOutDir: !watch,
      lib: {
        entry: path.join(root, "src/background/service-worker.ts"),
        formats: ["es"],
        name: "background",
        fileName: () => "background.js",
      },
      minify: false,
      sourcemap: true,
      target: "es2022",
      rollupOptions: { output: { inlineDynamicImports: true } },
      watch: watch ? {} : null,
    },
  });
}

async function buildContent() {
  await build({
    ...shared,
    build: {
      outDir: "dist",
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "src/content/content.ts"),
        formats: ["iife"],
        name: "ImageDownloaderContent",
        fileName: () => "content.js",
      },
      minify: false,
      sourcemap: true,
      target: "es2022",
      rollupOptions: { output: { inlineDynamicImports: true } },
      watch: watch ? {} : null,
    },
  });
}

async function buildPanel() {
  await build({
    ...shared,
    plugins: [react()],
    base: "./",
    build: {
      outDir: "dist",
      emptyOutDir: false,
      rollupOptions: { input: path.join(root, "sidepanel.html") },
      target: "es2022",
      watch: watch ? {} : null,
    },
  });
}

async function copyAssets() {
  await mkdir(path.join(root, "dist"), { recursive: true });
  await copyFile(path.join(root, "manifest.json"), path.join(root, "dist/manifest.json"));
  await mkdir(path.join(root, "dist/icons"), { recursive: true });
  for (const s of [16, 32, 48, 128]) {
    await copyFile(
      path.join(root, "icons", `icon${s}.png`),
      path.join(root, "dist", "icons", `icon${s}.png`)
    );
  }
}

async function main() {
  await buildWorker();
  await buildContent();
  await buildPanel();
  await copyAssets();
  console.log("✅ Build complete: dist/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});