import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("operator React web bundler is available in production installs", () => {
  assert.equal(packageJson.dependencies["vite-plus"], "^0.1.24");
  assert.equal(packageJson.devDependencies["vite-plus"], undefined);
});
