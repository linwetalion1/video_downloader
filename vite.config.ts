import { defineConfig } from "vitest/config";

// Этот конфиг используется только для тестов (vitest).
// Сборка расширения выполняется через scripts/build.mjs (3 отдельных vite-сборки).
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});