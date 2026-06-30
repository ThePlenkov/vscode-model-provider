import baseConfig from "../../eslint.config.base.js";

export default [
  ...baseConfig,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];