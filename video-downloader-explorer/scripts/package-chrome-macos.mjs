// Сборка и упаковка отдельной версии Video Downloader Explorer для Google Chrome на macOS.
//
// Выходные артефакты:
//   1. release/chrome-macos/video-downloader-explorer/         – распакованное расширение, готовое к установке
//   2. release/chrome-macos/video-downloader-explorer-chrome-macos.zip – готовый ZIP-архив для переноса на Mac
//   3. release/chrome-macos/INSTALL_MACOS.md                 – подробная инструкция по установке в macOS Chrome
//
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const chromeKeyFile = path.join(root, "keys", "chrome-macos-key.pem");

// Выходные директории (и в корне репозитория, и локально)
const releaseTargets = [
  path.resolve(root, "..", "release", "chrome-macos"),
  path.resolve(root, "release", "chrome-macos"),
];

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

/** Единый ключ разработчика для Chrome macOS (стабильный ID расширения). */
function ensureChromeKey() {
  mkdirSync(path.dirname(chromeKeyFile), { recursive: true });
  if (existsSync(chromeKeyFile)) return readFileSync(chromeKeyFile);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(chromeKeyFile, privateKey, { mode: 0o600 });
  console.log("🔑 Сгенерирован ключ разработчика Chrome macOS:", chromeKeyFile);
  return Buffer.from(privateKey);
}

function publicKeyBase64(pem) {
  return createPublicKey(pem).export({ type: "spki", format: "der" }).toString("base64");
}

function buildChromeManifest(keyB64) {
  const original = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
  const chromeManifest = {
    ...original,
    name: "Video Downloader Explorer (Chrome macOS)",
    description: "Поиск, превью, фильтрация и массовое скачивание видео для Google Chrome на macOS (HTML5, HLS, DASH, blob, трансляции и стримы).",
    minimum_chrome_version: "116",
    key: keyB64,
  };
  return chromeManifest;
}

function copyDirWithManifest(src, dest, chromeManifest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const f of collectFiles(src)) {
    const d = path.join(dest, f.rel);
    mkdirSync(path.dirname(d), { recursive: true });
    if (f.rel === "manifest.json") {
      writeFileSync(d, JSON.stringify(chromeManifest, null, 2) + "\n");
    } else {
      copyFileSync(f.full, d);
    }
  }
}

function buildZipFromDir(dir) {
  const files = collectFiles(dir);
  const zipObj = {};
  for (const f of files) zipObj[f.rel] = readFileSync(f.full);
  return Buffer.from(zipSync(zipObj, { level: 9 }));
}

function generateDocs(dir) {
  const doc = `# Установка Video Downloader Explorer в Google Chrome на macOS

## Быстрый старт (3 шага)

### Шаг 1. Откройте страницу расширений Chrome
1. Запустите **Google Chrome** на Mac.
2. В адресной строке введите:
   \`\`\`
   chrome://extensions
   \`\`\`
   и нажмите **Enter**.

### Шаг 2. Включите «Режим разработчика»
- В правом верхнем углу окна включите тумблер **«Режим разработчика»** (Developer mode).

### Шаг 3. Загрузите расширение
- Нажмите появившуюся слева кнопку **«Загрузить распакованное»** (Load unpacked).
- Выберите папку:
  \`video-downloader-explorer/\`
  *(если вы используете ZIP-архив, предварительно распакуйте его двойным кликом в macOS Finder)*.
- Нажмите кнопку **«Выбрать»**.

Готово! Расширение **Video Downloader Explorer (Chrome macOS)** появится в списке и готово к работе.

---

## Рекомендуемая настройка для удобства
1. **Закрепите иконку в тулбаре**:
   - Нажмите на значок «Пазл» (Расширения) справа от адресной строки Chrome;
   - Нажмите иконку **булавки (Pin)** рядом с *Video Downloader Explorer*.
2. **Открытие боковой панели (Side Panel)**:
   - Кликните по иконке расширения в тулбаре — справа откроется нативная боковая панель Chrome.
   - Также доступно через кнопку Side Panel в верхнем правом углу окна Chrome.

---

## Особенности версии для Chrome на macOS
- **Поддержка APFS / HFS+ и Unicode NFC**: все имена скачиваемых файлов (включая русские названия, длинные названия стримов ВК) автоматически приводятся к стандарту NFC, что предотвращает ошибки загрузки в Chrome на Mac.
- **Горячие клавиши macOS**:
  - \`⌘ + A\` — выбрать все найденные видео
  - \`⌘ + D\` — снять выбор
  - \`⌘ + Enter\` — скачать выбранные видео
  - \`⌘ + F\` — перейти на вкладку поиска
  - \`⌘ + L\` — открыть лог
- **Детектирование любых источников**:
  - HTML5 видео (\`mp4\`, \`webm\`, \`mov\`, \`m4v\`);
  - HLS-плейлисты (\`.m3u8\`) с автоматической сборкой сегментов;
  - DASH-манифесты (\`.mpd\`);
  - Трансляции ВКонтакте любой длительности (включая многочасовые эфиры);
  - Webview, iframe-плееры и прямые потоки.
`;

  writeFileSync(path.join(dir, "INSTALL_MACOS.md"), doc, "utf8");
}

async function main() {
  if (!existsSync(dist)) {
    throw new Error("Нет директории dist/. Сначала выполните: npm run build");
  }

  console.log("🍏 Подготовка отдельной версии для Google Chrome на macOS...");

  // 1) Ключ разработчика Chrome macOS
  const privateKey = ensureChromeKey();
  const keyB64 = publicKeyBase64(privateKey);
  const chromeManifest = buildChromeManifest(keyB64);

  for (const outDir of releaseTargets) {
    mkdirSync(outDir, { recursive: true });

    // 2) Распакованная директория
    const unpackedDir = path.join(outDir, "video-downloader-explorer");
    copyDirWithManifest(dist, unpackedDir, chromeManifest);
    console.log(`📂 Unpacked (Chrome macOS): ${unpackedDir}`);

    // 3) ZIP-архив
    const zip = buildZipFromDir(unpackedDir);
    const zipPath = path.join(outDir, "video-downloader-explorer-chrome-macos.zip");
    writeFileSync(zipPath, zip);
    console.log(`📦 ZIP (Chrome macOS): ${zipPath} (${(zip.length / 1024).toFixed(1)} KB)`);

    // 4) Документация
    generateDocs(outDir);
    copyFileSync(path.join(outDir, "INSTALL_MACOS.md"), path.join(unpackedDir, "README.md"));
    console.log(`📄 Инструкция создана: ${path.join(outDir, "INSTALL_MACOS.md")}`);
  }

  console.log("");
  console.log("✅ Сборка для Chrome macOS успешно завершена!");
  console.log("   Для установки на Mac используйте папку release/chrome-macos/video-downloader-explorer/");
  console.log("   или архив release/chrome-macos/video-downloader-explorer-chrome-macos.zip.");
}

main().catch((e) => {
  console.error("❌ Ошибка сборки Chrome macOS:", e);
  process.exit(1);
});
