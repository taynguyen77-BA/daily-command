// ESLint 9 flat config (Next 16 removed `next lint`; run `npm run lint`).
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // React Compiler rules new in eslint-plugin-react-hooks v7 (bundled with eslint-config-next
    // 16). They flag existing effect/render patterns that work under React 18 and 19; reported
    // as warnings until those components are refactored.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/use-memo": "warn",
    },
  },
  // Same scope `next lint` had: the app, not the offline test scripts.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "scripts/**"]),
]);
