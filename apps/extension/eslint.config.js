import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import baseConfig from "../../eslint.config.base.js";

// `import.meta.dirname` is Node 20.10+. The repo targets Node >=18 (per
// `apps/extension/package.json` `engines.node`), so we resolve manually.
const here = dirname(fileURLToPath(import.meta.url));

export default [
  ...baseConfig,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: here,
      },
    },
  },
];