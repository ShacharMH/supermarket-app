import { defineConfig } from "vitest/config";

// Unit tests only; e2e/ is run by Playwright.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
