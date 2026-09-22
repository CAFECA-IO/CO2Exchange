import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // e2e 會另起一個實例來測費思（有金鑰／沒金鑰兩種狀態），
    // 它的輸出放在這裡。不排除的話，lint 會去掃編譯產物，
    // 吐出上萬條與原始碼無關的訊息，把真正的錯誤埋掉。
    ".next-faith/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
