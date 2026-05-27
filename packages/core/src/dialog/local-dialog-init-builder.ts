import { readFileSync } from "node:fs";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import type { LocalDialogConfig } from "../browser-runtime-types.ts";

export function buildLocalDialogInitScript(config: LocalDialogConfig = {}) {
  const source = readFileSync(new URL("./local-dialog-bridge.ts", import.meta.url), "utf8");
  const compiled = transpileModule(source, {
    compilerOptions: {
      target: ScriptTarget.ES2022,
      module: ModuleKind.ES2022,
      removeComments: false,
    },
    fileName: "local-dialog-bridge.ts",
  }).outputText.replace(/\nexport \{\};\s*$/u, "");
  return [`window.MAB_LOCAL_DIALOG_CONFIG = ${JSON.stringify(config)};`, compiled].join("\n");
}
