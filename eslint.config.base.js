/**
 * Root ESLint flat config.
 *
 * Each package extends this and adds a `parserOptions.project` so the
 * typescript-eslint recommended config can type-check. Per-package ignores
 * are layered on top.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/node_modules/**",
      "**/.nx/**",
      "**/*.d.ts",
      "**/*.config.js",
      "**/*.config.ts",
      "scripts/**",
      "test/**",
    ],
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
];