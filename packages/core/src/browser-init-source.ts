import { existsSync, readFileSync } from "node:fs";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

export function readBrowserInitSource(importMetaUrl: string, jsName: string, tsName: string) {
  const jsUrl = new URL(jsName, importMetaUrl);
  if (existsSync(jsUrl)) return readFileSync(jsUrl, "utf8");

  const tsUrl = new URL(tsName, importMetaUrl);
  const source = readFileSync(tsUrl, "utf8");
  return transpileModule(source, {
    compilerOptions: {
      module: ModuleKind.ESNext,
      target: ScriptTarget.ES2020,
      removeComments: false,
    },
  }).outputText;
}
