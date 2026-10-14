// ESLint 扁平配置（CJS 写法：root package.json 非 type:module）
const tseslint = require("@typescript-eslint/eslint-plugin");
const tsparser = require("@typescript-eslint/parser");

module.exports = [
  { ignores: ["**/dist/**", "**/node_modules/**", "tmp/**", ".pi/**"] },
  {
    // 覆盖 .tsx: 此前只配了 **/*.ts, 组件（UI 主体）完全没进 lint 门
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: tseslint.configs.recommended.rules,
  },
];
