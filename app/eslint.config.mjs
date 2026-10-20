// Only the rules that catch real crashes: the order of hooks (React error 310 = a hook after an early return).
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["node_modules/**", "android/**", "ios/**", "dist/**", "web-build/**", ".expo/**", "scripts/**"] },
  {
    files: ["App.tsx", "src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
