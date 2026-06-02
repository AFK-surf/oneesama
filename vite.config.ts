import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const ignoredPaths = [
  "node_modules/**",
  "dist/**",
  "coverage/**",
  "snake-mobile-app/**",
  "downloads/**",
  "output/**",
  "reports/**",
  "tmp/**",
  "**/*.min.js",
];

export default defineConfig({
  resolve: {
    alias: {
      "@core": fromRoot("./packages/core/src"),
      "@commands": fromRoot("./src/commands"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.{js,mjs,ts}"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  fmt: {
    ignorePatterns: ignoredPaths,
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    bracketSpacing: true,
    arrowParens: "always",
    endOfLine: "lf",
  },
  lint: {
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "node", "vitest"],
    env: {
      browser: true,
      node: true,
      es2022: true,
    },
    ignorePatterns: ignoredPaths,
    options: {
      reportUnusedDisableDirectives: "warn",
      respectEslintDisableDirectives: true,
    },
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
      pedantic: "off",
      style: "off",
      restriction: "off",
      nursery: "off",
    },
    rules: {
      eqeqeq: ["error", "smart"],
      "eslint/no-underscore-dangle": "allow",
      "eslint/no-await-in-loop": "allow",
      "eslint/no-unused-vars": "error",
      "promise/no-multiple-resolved": "off",
      "no-debugger": "error",
      "no-underscore-dangle": "allow",
      "no-unused-vars": "error",
      "no-var": "error",
      "prefer-const": "error",
      "typescript/no-floating-promises": "error",
      "unicorn/consistent-function-scoping": "allow",
      "unicorn/no-array-reverse": "allow",
      "unicorn/no-array-sort": "allow",
      "unicorn/require-post-message-target-origin": "off",
      "unicorn/no-useless-fallback-in-spread": "warn",
      "max-lines": [
        "error",
        {
          max: 1200,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
    },
    overrides: [
      {
        files: ["src/cli.ts"],
        rules: {
          "max-lines": ["error", { max: 11783, skipBlankLines: true }],
        },
      },
      {
        files: ["packages/core/src/meeting/google-meet-joiner.ts"],
        rules: {
          "prefer-const": "allow",
          "max-lines": ["error", { max: 4071, skipBlankLines: true }],
        },
      },
      {
        files: ["apps/slack-agent/src/index.ts"],
        rules: {
          "prefer-const": "allow",
          "max-lines": ["error", { max: 3741, skipBlankLines: true }],
        },
      },
      {
        files: ["packages/core/src/slack/legacy-slack-domain-store.ts"],
        rules: {
          "max-lines": ["error", { max: 1720, skipBlankLines: true }],
        },
      },
      {
        files: ["apps/meeting-agent/src/index.ts"],
        rules: {
          "max-lines": ["error", { max: 1680, skipBlankLines: true }],
        },
      },
      {
        files: ["packages/core/src/avatar/hiyori-avatar-inject.ts"],
        rules: {
          "max-lines": ["error", { max: 1639, skipBlankLines: true }],
        },
      },
      {
        files: ["packages/core/src/meeting/caption-capture.ts"],
        rules: {
          "max-lines": ["error", { max: 1244, skipBlankLines: true }],
        },
      },
      {
        files: ["packages/core/src/realtime/realtime-browser-bridge.ts"],
        rules: {
          "prefer-const": "allow",
        },
      },
    ],
  },
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
  },
});
