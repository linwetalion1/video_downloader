import { defineConfig } from "vitest/config";

// Конфиг только для тестов (vitest). Сборка расширения — scripts/build.mjs.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
