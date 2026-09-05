import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const binary = process.env.SECT_BIN ?? fileURLToPath(new URL(`../../target/debug/sect${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
export default defineConfig({ test: { testTimeout: 30000, hookTimeout: 30000, env: { SECT_BIN: binary } } });
