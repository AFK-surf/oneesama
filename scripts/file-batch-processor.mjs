#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_EXCLUDES = [
  ".git/**",
  "node_modules/**",
  "runtime/**",
  "tmp/**",
  "dist/**",
  "coverage/**",
];

const DEFAULT_OPTIONS = {
  request: "用 codex 帮我写个脚本处理这批文件",
  input: "",
  files: [],
  fileList: "",
  output: "tmp/file-batch-output",
  include: ["**/*"],
  exclude: DEFAULT_EXCLUDES,
  ext: [],
  operation: "copy",
  concurrency: 4,
  overwrite: false,
  write: false,
  recursive: true,
  followSymlinks: false,
  failOnParseError: false,
  renameTemplate: "{dir}/{base}{ext}",
  jsonIndent: 2,
  log: "",
  summary: "",
  manifest: "",
  config: "",
};

function printHelp() {
  console.log(`Usage: node scripts/file-batch-processor.mjs [options]

Generic, safe batch-file processing framework.

Options:
  --config <path>                 JSON config file; CLI flags override it
  --request <text>                Original user request stored in run summaries
  --input <path[,path]>           Input directories or files (default: . when no files/list is provided)
  --files <path[,path]>           Additional explicit files
  --file-list <path>              Newline list or JSON array of files
  --output <dir>                  Output directory (default: ${DEFAULT_OPTIONS.output})
  --include <glob[,glob]>         Include globs relative to input (default: **/*)
  --exclude <glob[,glob]>         Exclude globs relative to input
  --ext <.md,.json>               Keep only these extensions
  --operation <name>              copy | rename | metadata | pretty-json | custom (default: copy)
  --rename-template <template>    Used by rename; tokens: {dir} {name} {base} {ext}
  --concurrency <n>               Files processed at once (default: 4)
  --overwrite                     Replace changed outputs
  --write                         Write transformed outputs; otherwise dry-run
  --dry-run                       Force dry-run mode
  --recursive                     Recurse into input directories (default)
  --no-recursive                  Only process direct children of input directories
  --follow-symlinks               Follow symlinked files/directories
  --fail-on-parse-error           Treat parse failures as errors instead of skipped files
  --log <path>                    Write JSONL per-file events
  --summary <path>                Write run summary JSON
  --manifest <path>               Write metadata manifest JSON
  --json-indent <n>               Indentation for pretty-json (default: 2)
  -h, --help                      Show this help

Examples:
  node scripts/file-batch-processor.mjs --input notes --ext .md
  node scripts/file-batch-processor.mjs --files docs/architecture.md,README.md --operation metadata
  node scripts/file-batch-processor.mjs --input scripts/fixtures --output tmp/pretty --ext .json --operation pretty-json --write
  node scripts/file-batch-processor.mjs --input docs --output tmp/docs-renamed --operation rename --rename-template "{dir}/{base}.bak{ext}" --write
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const [flag, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const value = () => inlineValue ?? argv[++i];
    if (flag === "--help" || flag === "-h") {
      printHelp();
      process.exit(0);
    } else if (flag === "--config") args.config = value();
    else if (flag === "--request") args.request = value();
    else if (flag === "--input") args.input = value();
    else if (flag === "--files") args.files = csv(value());
    else if (flag === "--file-list") args.fileList = value();
    else if (flag === "--output") args.output = value();
    else if (flag === "--include") args.include = csv(value());
    else if (flag === "--exclude") args.exclude = csv(value());
    else if (flag === "--ext") args.ext = csv(value()).map(normalizeExt);
    else if (flag === "--operation") args.operation = value();
    else if (flag === "--rename-template") args.renameTemplate = value();
    else if (flag === "--concurrency") args.concurrency = Number(value());
    else if (flag === "--json-indent") args.jsonIndent = Number(value());
    else if (flag === "--overwrite") args.overwrite = true;
    else if (flag === "--write") args.write = true;
    else if (flag === "--dry-run") args.write = false;
    else if (flag === "--recursive") args.recursive = true;
    else if (flag === "--no-recursive") args.recursive = false;
    else if (flag === "--follow-symlinks") args.followSymlinks = true;
    else if (flag === "--fail-on-parse-error") args.failOnParseError = true;
    else if (flag === "--log") args.log = value();
    else if (flag === "--summary") args.summary = value();
    else if (flag === "--manifest") args.manifest = value();
    else throw new Error(`unknown argument: ${raw}`);
  }
  return args;
}

async function loadConfig(path) {
  if (!path) return {};
  const body = await readFile(path, "utf8");
  return JSON.parse(body);
}

function csv(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeExt(value) {
  return value.startsWith(".") ? value.toLowerCase() : `.${value.toLowerCase()}`;
}

function normalizeOptions(options) {
  const normalized = { ...options };
  const inputPaths = csv(normalized.input);
  const filePaths = csv(normalized.files);
  const hasExplicitFileInput = filePaths.length > 0 || Boolean(normalized.fileList);
  const resolvedInputPaths = inputPaths.length > 0 ? inputPaths : hasExplicitFileInput ? [] : ["."];
  normalized.inputs = resolvedInputPaths.map((path) => resolve(String(path)));
  normalized.input = normalized.inputs.length === 1 ? normalized.inputs[0] : normalized.inputs;
  normalized.files = filePaths.map((path) => resolve(String(path)));
  normalized.fileList = normalized.fileList ? resolve(String(normalized.fileList)) : "";
  normalized.output = resolve(String(normalized.output || DEFAULT_OPTIONS.output));
  normalized.request = String(normalized.request || DEFAULT_OPTIONS.request);
  normalized.include = csv(normalized.include).length ? csv(normalized.include) : ["**/*"];
  normalized.exclude = csv(normalized.exclude);
  normalized.ext = csv(normalized.ext).map(normalizeExt);
  normalized.operation = String(normalized.operation || "copy");
  normalized.concurrency = Math.max(1, Math.floor(Number(normalized.concurrency) || 1));
  normalized.jsonIndent = Math.max(0, Math.floor(Number(normalized.jsonIndent) || 2));
  normalized.write = Boolean(normalized.write);
  normalized.overwrite = Boolean(normalized.overwrite);
  normalized.recursive = normalized.recursive !== false;
  normalized.followSymlinks = Boolean(normalized.followSymlinks);
  normalized.failOnParseError = Boolean(normalized.failOnParseError);
  for (const key of ["log", "summary", "manifest"]) {
    normalized[key] = normalized[key] ? resolve(String(normalized[key])) : "";
  }
  if (!["copy", "rename", "metadata", "pretty-json", "custom"].includes(normalized.operation)) {
    throw new Error(`unsupported operation: ${normalized.operation}`);
  }
  return normalized;
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    const next = glob[i + 1];
    if (char === "*" && next === "*") {
      const after = glob[i + 2];
      if (after === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

function compileMatchers(patterns) {
  return patterns.map((pattern) => globToRegExp(toPosix(pattern)));
}

function matchesAny(path, matchers) {
  return matchers.some((matcher) => matcher.test(path));
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.includes(`..${sep}`));
}

async function readFileList(path) {
  if (!path) return [];
  const body = await readFile(path, "utf8");
  const trimmed = body.trim();
  const baseDir = dirname(path);
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error(`file list must be a JSON array of strings: ${path}`);
    }
    return parsed.map((item) => resolve(baseDir, item));
  }

  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => resolve(baseDir, line));
}

function relativePathForExplicitFile(path) {
  const cwd = process.cwd();
  return isInside(path, cwd) ? toPosix(relative(cwd, path)) : basename(path);
}

function filterReason(file, options, matchers) {
  const lowerExt = extname(file.relativePath).toLowerCase();
  if (matchesAny(file.relativePath, matchers.exclude)) return "excluded-by-pattern";
  if (options.ext.length > 0 && !options.ext.includes(lowerExt)) return "extension-not-allowed";
  if (!matchesAny(file.relativePath, matchers.include)) return "not-matched-by-include";
  return "";
}

function addCandidate(files, seen, candidate, options, matchers, logSkipped) {
  const skipReason = filterReason(candidate, options, matchers);
  if (skipReason) {
    if (logSkipped) files.push({ ...candidate, skipReason });
    return;
  }
  if (seen.has(candidate.absolute)) return;
  seen.add(candidate.absolute);
  files.push(candidate);
}

async function collectFiles(options) {
  const include = compileMatchers(options.include);
  const excludePatterns = [...options.exclude];
  const files = [];
  const seen = new Set();

  for (const input of options.inputs) {
    let inputInfo;
    try {
      inputInfo = await lstat(input);
    } catch {
      continue;
    }
    if (inputInfo.isDirectory() && isInside(options.output, input)) {
      excludePatterns.push(`${toPosix(relative(input, options.output))}/**`);
    }
  }
  const exclude = compileMatchers(excludePatterns);
  const matchers = { include, exclude };

  async function visit(dir, root) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = toPosix(relative(root, absolute));
      if (matchesAny(rel, exclude)) continue;
      let info = entry;
      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        info = await stat(absolute);
      }
      if (info.isDirectory()) {
        if (options.recursive) await visit(absolute, root);
      } else if (info.isFile()) {
        addCandidate(files, seen, { absolute, relativePath: rel }, options, matchers, false);
      }
    }
  }

  for (const input of options.inputs) {
    let info;
    try {
      info = await lstat(input);
    } catch {
      throw new Error(`input not found: ${input}`);
    }
    if (info.isSymbolicLink()) {
      if (!options.followSymlinks) {
        files.push({
          absolute: input,
          relativePath: relativePathForExplicitFile(input),
          skipReason: "symlink-skipped",
        });
        continue;
      }
      info = await stat(input);
    }
    if (info.isDirectory()) {
      await visit(input, input);
    } else if (info.isFile()) {
      addCandidate(
        files,
        seen,
        { absolute: input, relativePath: relativePathForExplicitFile(input) },
        options,
        matchers,
        true,
      );
    } else {
      files.push({
        absolute: input,
        relativePath: relativePathForExplicitFile(input),
        skipReason: "not-a-file",
      });
    }
  }

  const listedFiles = [...options.files, ...(await readFileList(options.fileList))];
  for (const file of listedFiles) {
    let info;
    try {
      info = await lstat(file);
    } catch {
      files.push({
        absolute: file,
        relativePath: relativePathForExplicitFile(file),
        skipReason: "file-not-found",
      });
      continue;
    }
    if (info.isSymbolicLink()) {
      if (!options.followSymlinks) {
        files.push({
          absolute: file,
          relativePath: relativePathForExplicitFile(file),
          skipReason: "symlink-skipped",
        });
        continue;
      }
      info = await stat(file);
    }
    if (!info.isFile()) {
      files.push({
        absolute: file,
        relativePath: relativePathForExplicitFile(file),
        skipReason: "not-a-file",
      });
      continue;
    }
    addCandidate(
      files,
      seen,
      { absolute: file, relativePath: relativePathForExplicitFile(file) },
      options,
      matchers,
      true,
    );
  }

  return files.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function targetRelativePath(file, options) {
  if (options.operation !== "rename") return file.relativePath;
  const ext = extname(file.relativePath);
  const dir = toPosix(dirname(file.relativePath));
  const base = basename(file.relativePath, ext);
  const rendered = options.renameTemplate
    .replaceAll("{dir}", dir === "." ? "" : dir)
    .replaceAll("{name}", basename(file.relativePath))
    .replaceAll("{base}", base)
    .replaceAll("{ext}", ext)
    .replace(/\/+/g, "/")
    .replace(/^\//, "");
  return rendered || basename(file.relativePath);
}

function decodeUtf8(data) {
  if (data.includes(0)) return { ok: false, reason: "contains-nul-byte", text: "" };
  const text = data.toString("utf8");
  if (text.includes("\uFFFD")) return { ok: false, reason: "invalid-utf8", text: "" };
  return { ok: true, reason: "", text };
}

function looksDelimited(text, delimiter) {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (rows.length < 2) return false;
  const counts = rows.map((line) => line.split(delimiter).length);
  return counts[0] > 1 && counts.every((count) => count === counts[0]);
}

function detectFormat(file, data) {
  const ext = extname(file.relativePath).toLowerCase();
  const decoded = decodeUtf8(data);
  if (!decoded.ok) {
    return { kind: "binary", ext, parseable: false, reason: decoded.reason };
  }

  const text = decoded.text;
  const trimmed = text.trim();
  if (ext === ".json" || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed || "null");
      return {
        kind: "json",
        ext,
        parseable: true,
        detection: ext === ".json" ? "extension" : "content",
      };
    } catch (error) {
      return {
        kind: "json",
        ext,
        parseable: false,
        detection: ext === ".json" ? "extension" : "content",
        reason: String(error?.message || error),
      };
    }
  }

  if (ext === ".csv" || looksDelimited(text, ",")) {
    return {
      kind: "csv",
      ext,
      parseable: true,
      delimiter: ",",
      detection: ext === ".csv" ? "extension" : "content",
    };
  }
  if (ext === ".tsv" || looksDelimited(text, "\t")) {
    return {
      kind: "tsv",
      ext,
      parseable: true,
      delimiter: "\t",
      detection: ext === ".tsv" ? "extension" : "content",
    };
  }

  return { kind: "text", ext, parseable: true, detection: "utf8" };
}

function metadataFor(file, data) {
  return {
    path: file.relativePath,
    bytes: data.length,
    ext: extname(file.relativePath).toLowerCase(),
    format: detectFormat(file, data),
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function skipped(metadata, reason) {
  return {
    metadata,
    outputData: null,
    skipReason: reason,
    targetRelativePath: metadata.path,
  };
}

async function customTransform(_file, _data, metadata, _options) {
  // TODO: replace this placeholder with the real batch-specific rule.
  return skipped(metadata, "custom-transform-not-configured");
}

async function transformFile(file, data, options) {
  const metadata = metadataFor(file, data);
  if (options.operation === "metadata") {
    return { metadata, outputData: null, targetRelativePath: file.relativePath };
  }
  if (options.operation === "pretty-json") {
    if (metadata.format.kind !== "json") {
      return skipped(metadata, "operation-requires-json");
    }
    if (!metadata.format.parseable) {
      if (options.failOnParseError) throw new Error(`invalid JSON: ${metadata.format.reason}`);
      return skipped(metadata, `invalid-json: ${metadata.format.reason}`);
    }
    const parsed = JSON.parse(data.toString("utf8").trim() || "null");
    const body = `${JSON.stringify(parsed, null, options.jsonIndent)}\n`;
    return {
      metadata,
      outputData: Buffer.from(body, "utf8"),
      targetRelativePath: file.relativePath,
    };
  }
  if (options.operation === "custom") {
    return customTransform(file, data, metadata, options);
  }
  // TODO: plug project-specific content conversion here once "this batch" has rules.
  return { metadata, outputData: data, targetRelativePath: targetRelativePath(file, options) };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sameBytes(path, data) {
  if (!(await exists(path))) return false;
  const existing = await readFile(path);
  return existing.equals(data);
}

async function writeEvent(logPath, event) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  if (!logPath) {
    const method = event.status === "error" ? "error" : "log";
    console[method](line.trimEnd());
    return;
  }
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, line, { flag: "a" });
}

async function processOne(file, options) {
  try {
    if (file.skipReason) {
      return { status: "skipped", source: file.relativePath, reason: file.skipReason };
    }
    const data = await readFile(file.absolute);
    const result = await transformFile(file, data, options);
    if (result.skipReason) {
      return {
        status: "skipped",
        source: file.relativePath,
        reason: result.skipReason,
        metadata: result.metadata,
      };
    }
    if (result.outputData === null) {
      return { status: "metadata", source: file.relativePath, metadata: result.metadata };
    }
    const targetPath = resolve(options.output, result.targetRelativePath);
    if (!isInside(targetPath, options.output)) {
      throw new Error(`target escapes output directory: ${result.targetRelativePath}`);
    }
    if (!options.write) {
      return { status: "dry-run", source: file.relativePath, target: result.targetRelativePath };
    }
    if (await sameBytes(targetPath, result.outputData)) {
      return { status: "unchanged", source: file.relativePath, target: result.targetRelativePath };
    }
    if ((await exists(targetPath)) && !options.overwrite) {
      throw new Error(`target exists; pass --overwrite to replace: ${result.targetRelativePath}`);
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, result.outputData);
    return { status: "written", source: file.relativePath, target: result.targetRelativePath };
  } catch (error) {
    return {
      status: "error",
      source: file.relativePath,
      error: String(error?.message || error),
    };
  }
}

async function runPool(files, options) {
  const results = [];
  let index = 0;
  async function worker() {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= files.length) return;
      const result = await processOne(files[current], options);
      results[current] = result;
      await writeEvent(options.log, result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, files.length) }, worker));
  return results;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const config = await loadConfig(cli.config);
  const options = normalizeOptions({ ...DEFAULT_OPTIONS, ...config, ...cli });
  if (options.log && (await exists(options.log))) await writeFile(options.log, "");

  const files = await collectFiles(options);
  const startedAt = new Date().toISOString();
  const results = await runPool(files, options);
  const counts = Object.fromEntries(
    ["dry-run", "written", "unchanged", "metadata", "skipped", "error"].map((status) => [
      status,
      results.filter((result) => result.status === status).length,
    ]),
  );
  const manifest = results
    .filter((result) => result.metadata)
    .map((result) => result.metadata)
    .toSorted((a, b) => a.path.localeCompare(b.path));
  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    request: options.request,
    inputs: options.inputs,
    files: options.files,
    fileList: options.fileList || undefined,
    output: options.output,
    operation: options.operation,
    write: options.write,
    overwrite: options.overwrite,
    recursive: options.recursive,
    matched: files.length,
    counts,
    skipped: results.filter((result) => result.status === "skipped"),
    errors: results.filter((result) => result.status === "error"),
  };

  if (options.manifest) {
    await mkdir(dirname(options.manifest), { recursive: true });
    await writeFile(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (options.summary) {
    await mkdir(dirname(options.summary), { recursive: true });
    await writeFile(options.summary, `${JSON.stringify(summary, null, 2)}\n`);
  }
  const summaryHash = options.summary && options.write ? await sha256File(options.summary) : "";
  console.log(JSON.stringify({ ...summary, summarySha256: summaryHash || undefined }, null, 2));
  if (counts.error > 0) process.exit(1);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  main().catch((error) => {
    console.error(String(error?.stack || error?.message || error));
    process.exit(1);
  });
}
