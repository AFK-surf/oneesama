import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { legacyCockpitHref } from "../packages/core/src/operator/web/OperatorErrorBoundary.tsx";

test("operator error boundary legacy cockpit link preserves token query", () => {
  assert.equal(legacyCockpitHref("?token=abc&x=1"), "/?token=abc&x=1");
  assert.equal(legacyCockpitHref(""), "/");
});
