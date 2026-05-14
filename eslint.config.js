import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "snake-mobile-app/**",
      "downloads/**",
      "output/**",
      "reports/**",
      "tmp/**",
      "**/*.min.js",
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-constant-condition": ["warn", { checkLoops: false }],
      "no-prototype-builtins": "off",
      "no-control-regex": "off",
      "no-misleading-character-class": "off",
      "no-useless-escape": "off",
      "no-irregular-whitespace": "off",
      "prefer-const": "warn",
      eqeqeq: ["warn", "always", { null: "ignore" }],
    },
  },
];
