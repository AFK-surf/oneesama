import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

function isSupportedPlatform() {
  if (process.platform === "darwin") return process.arch === "arm64" || process.arch === "x64";
  if (process.platform === "linux") return process.arch === "x64";
  if (process.platform === "win32") return ["arm64", "ia32", "x64"].includes(process.arch);
  return false;
}

test(
  "Recappi SDK is a package-managed dependency on supported platforms",
  {
    skip: isSupportedPlatform()
      ? false
      : `unsupported platform ${process.platform}/${process.arch}`,
  },
  () => {
    const sdk = require("@recappi/sdk");
    assert.equal(typeof sdk.ShareableContent?.applications, "function");
    assert.equal(typeof sdk.ShareableContent?.tapAudio, "function");
  },
);
