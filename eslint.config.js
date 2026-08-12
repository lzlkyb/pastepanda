import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      // 允许使用 console（开发调试用）
      "no-console": "off",
      // 禁止空 catch 块
      "no-empty": ["warn", { allowEmptyCatch: false }],
      // 禁止未使用的变量
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // 推荐使用 const
      "prefer-const": "warn",
      // React hooks 规则
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // 禁止 any 类型（警告级别）
      "@typescript-eslint/no-explicit-any": "warn",
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  {
    // 测试文件放宽：mock / 桩对象需要 any 来伪造第三方结构，
    // 在这里强求真实类型只会写出一堆没人维护的假接口。
    files: ["src/__tests__/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    ignores: [
      "node_modules/",
      "dist/",
      "src-tauri/",
      "build/",
      "*.config.*",
    ],
  },
);
