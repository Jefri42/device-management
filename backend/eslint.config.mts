import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const layers = (patterns: string[], message: string) =>
  ["error", { patterns: [{ group: patterns, message }] }] as const;

export default defineConfig([
  globalIgnores(["dist/**", "coverage/**"]),
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  {
    files: ["src/business/**/*.ts"],
    rules: {
      "no-restricted-imports": layers(
        [
          "@/presentation/**",
          "@/db/**",
          "@/config/**",
          "**/presentation/**",
          "**/db/**",
          "express",
          "express/**",
          "cors",
        ],
        "Negocio solo depende de sus entidades, reglas y contratos (ports).",
      ),
    },
  },
  {
    files: ["src/presentation/**/*.ts"],
    rules: {
      "no-restricted-imports": layers(
        ["@/db/**", "**/db/**"],
        "Presentación solo llama casos de uso; nunca accede a DB.",
      ),
    },
  },
  {
    files: ["src/db/**/*.ts"],
    rules: {
      "no-restricted-imports": layers(
        [
          "@/presentation/**",
          "**/presentation/**",
          "@/business/use-cases/**",
          "@/business/rules/**",
          "express",
          "express/**",
        ],
        "DB implementa los ports de negocio; no decide reglas ni conoce HTTP.",
      ),
    },
  },
]);
