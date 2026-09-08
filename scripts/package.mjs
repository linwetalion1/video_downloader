// Упаковка расширения в установочный .crx и .zip.
//
// .crx собирается ТОЛЬКО официальным паковщиком Chromium/Edge:
//   msedge.exe --pack-extension=<директория> [--pack-extension-key=<key.pem>]
// Браузер сам формирует байт-в-байт корректный CRX3 (protobuf-заголовок,
// собственная схема подписи), поэтому файл гарантированно принимается
// при установке перетаскиванием на edge://extensions.
//
// Если msedge.exe недоступен — .crx не собирается: вместо него выдаётся .zip,
// который ставится через «Загрузить распакованное» (этот путь не требует
// подписи вообще и работает всегда).
//
// В manifest.json перед упаковкой добавляется "key" — стабильный ключ
// разработчика: Edge считает такое расширение «известным источником»,
// а ID не меняется между пересборками.
import { spawn } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const outDir = path.join(root, "release");
const edgeKeyFile = path.join(root, "keys", "edge-key.pem");

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

function findEdge() {
  return EDGE_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

function collectFiles(dir, base = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...collectFiles(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

/** Единый ключ разработчика: генерируется один раз, ID расширения стабилен. */
function ensureEdgeKey() {
  mkdirSync(path.dirname(edgeKeyFile), { recursive: true });
  if (existsSync(edgeKeyFile)) return readFileSync(edgeKeyFile);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(edgeKeyFile, privateKey, { mode: 0o600 });
  console.log("🔑 Сгенерирован ключ разработчика:", edgeKeyFile);
  return Buffer.from(privateKey);
}

function publicKeyBase64(pem) {
  return createPublicKey(pem).export({ type: "spki", format: "der" }).toString("base64");
}

/** Добавляет стабильный ключ в manifest.json (dist) — Edge считает такое расширение «известным источником». */
function injectManifestKey(b64) {
  const manifestPath = path.join(dist, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.key = b64;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log("🔑 В manifest.json добавлен key (стабильный ID)");
}

/** Официальная упаковка через msedge --pack-extension. */
function packWithEdge(edgePath, keyPath) {
  return new Promise((resolve, reject) => {
    const tmpProfile = path.join(os.tmpdir(), `ide-pack-${Date.now()}`);
    const parent = path.dirname(dist);
    const crxOut = path.join(parent, "dist.crx");
    const pemOut = path.join(parent, "dist.pem");
    rmSync(crxOut, { force: true });
    rmSync(pemOut, { force: true });

    const args = [
      `--pack-extension=${dist}`,
      `--user-data-dir=${tmpProfile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    ];
    if (keyPath && existsSync(keyPath)) args.push(`--pack-extension-key=${keyPath}`);

    const child = spawn(edgePath, args, { stdio: "ignore" });
    let done = false;
    const deadline = Date.now() + 90_000;
    const timer = setInterval(() => {
      if (existsSync(crxOut)) {
        done = true;
        clearInterval(timer);
        try { child.kill(); } catch { /* noop */ }
        try { rmSync(tmpProfile, { recursive: true, force: true }); } catch { /* noop */ }
        const crx = readFileSync(crxOut);
        rmSync(crxOut, { force: true });
        if (existsSync(pemOut)) {
          copyFileSync(pemOut, keyPath ?? edgeKeyFile);
          rmSync(pemOut, { force: true });
        }
        resolve(crx);
      } else if (Date.now() > deadline) {
        done = true;
        clearInterval(timer);
        try { child.kill(); } catch { /* noop */ }
        reject(new Error("Edge не создал .crx за 90 секунд"));
      }
    }, 400);

    child.on("error", (e) => {
      if (!done) {
        done = true;
        clearInterval(timer);
        reject(e);
      }
    });
    child.on("exit", (code) => {
      if (!done && !existsSync(crxOut)) {
        done = true;
        clearInterval(timer);
        reject(new Error(`Edge завершился (код ${code}) без создания .crx`));
      }
    });
  });
}

function buildZip() {
  if (!existsSync(dist)) throw new Error("Нет dist/ — сначала выполните npm run build");
  const files = collectFiles(dist);
  const zipObj = {};
  for (const f of files) zipObj[f.rel] = readFileSync(f.full);
  return Buffer.from(zipSync(zipObj, { level: 9 }));
}

async function main() {
  if (!existsSync(dist)) throw new Error("Нет dist/ — сначала выполните npm run build");
  mkdirSync(outDir, { recursive: true });

  // 1) Ключ разработчика + stable ID в manifest
  const privateKey = ensureEdgeKey();
  injectManifestKey(publicKeyBase64(privateKey));

  // 2) .zip всегда
  const zip = buildZip();
  const zipPath = path.join(outDir, "image-downloader-explorer.zip");
  writeFileSync(zipPath, zip);
  console.log(`📦 ZIP: ${zipPath} (${(zip.length / 1024).toFixed(1)} KB)`);

  // 3) .crx — только официальным паковщиком
  const edge = findEdge();
  if (!edge) {
    console.warn("⚠️ msedge.exe не найден — .crx не собран.");
    console.warn("Используйте .zip: распакуйте → edge://extensions → режим разработчика → «Загрузить распакованное».");
    process.exit(1);
  }
  console.log("🧬 Пакуем официальным паковщиком Edge:", edge);
  let crx;
  try {
    crx = await packWithEdge(edge, edgeKeyFile);
  } catch (e) {
    console.error(`❌ Не удалось собрать .crx: ${e.message}`);
    console.error("Используйте .zip (см. выше) — установка через «Загрузить распакованное» всегда работает.");
    process.exit(1);
  }

  const crxPath = path.join(outDir, "image-downloader-explorer.crx");
  writeFileSync(crxPath, crx);
  console.log(`📦 CRX: ${crxPath} (${(crx.length / 1024).toFixed(1)} KB)`);
  console.log("✅ Готово. Включите режим разработчика на edge://extensions и перетащите .crx в окно браузера.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});