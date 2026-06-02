# file-batch-processor

`scripts/file-batch-processor.mjs` 是一个通用批量文件处理框架，用来接住“这批文件”尚未明确规则时的安全默认流程：遍历目录或显式文件列表、筛选文件、探测常见格式、执行可替换的处理函数、写入输出、记录日志，并汇总错误。

原始请求：用 codex 帮我写个脚本处理这批文件。

## 当前仓库观察

- 仓库已有 `scripts/` 作为运维和批处理脚本入口，脚本多为 `.sh` / `.mjs`。
- 样例批处理输入可见于 `scripts/fixtures/*.json`、`docs/*.md`、`notes/**/*.md`、`examples/*`。
- 当前没有能直接判断“这批文件”业务规则的路径、文件类型或目标变换，因此脚本默认只做 dry-run，并把业务变换留在 `transformFile()` 的 TODO 钩子里。
- 脚本默认把原始请求写入 summary；如果要复用同一个框架处理另一批文件，可用 `--request` 或配置文件里的 `request` 覆盖。

## 快速使用

先演练，不写文件：

```bash
node scripts/file-batch-processor.mjs --input scripts/fixtures --ext .json
```

只处理明确给出的几个文件：

```bash
node scripts/file-batch-processor.mjs \
  --files docs/architecture.md,README.md \
  --operation metadata \
  --manifest tmp/file-batch-manifest.json
```

从文件清单读取输入；清单支持换行文本或 JSON 字符串数组，清单内相对路径按清单文件所在目录解析：

```bash
node scripts/file-batch-processor.mjs \
  --file-list tmp/file-batch-inputs.txt \
  --operation metadata
```

只处理输入目录第一层：

```bash
node scripts/file-batch-processor.mjs --input notes --ext .md --no-recursive
```

格式化 JSON 到输出目录：

```bash
node scripts/file-batch-processor.mjs \
  --input scripts/fixtures \
  --output tmp/pretty-fixtures \
  --ext .json \
  --operation pretty-json \
  --write
```

复制 Markdown，并生成日志和摘要：

```bash
node scripts/file-batch-processor.mjs \
  --input notes \
  --output tmp/notes-copy \
  --ext .md \
  --write \
  --log tmp/file-batch.log.jsonl \
  --summary tmp/file-batch-summary.json
```

按模板重命名：

```bash
node scripts/file-batch-processor.mjs \
  --input docs \
  --output tmp/docs-renamed \
  --operation rename \
  --rename-template "{dir}/{base}.bak{ext}" \
  --write
```

只提取元数据清单：

```bash
node scripts/file-batch-processor.mjs \
  --input examples \
  --operation metadata \
  --manifest tmp/examples-manifest.json
```

## 配置文件

可把选项写成 JSON，再用命令行覆盖：

```json
{
  "request": "用 codex 帮我写个脚本处理这批文件",
  "input": "scripts/fixtures",
  "files": ["README.md"],
  "fileList": "tmp/file-batch-inputs.txt",
  "output": "tmp/fixtures-out",
  "include": ["**/*.json"],
  "exclude": ["**/*.tmp.json"],
  "operation": "pretty-json",
  "recursive": true,
  "concurrency": 4,
  "overwrite": false
}
```

运行：

```bash
node scripts/file-batch-processor.mjs --config tmp/file-batch.config.json --write
```

## 幂等与安全策略

- 默认 dry-run；必须传 `--write` 才会写处理后的输出文件。
- `--log`、`--summary`、`--manifest` 是运行产物，显式指定路径时会写入，方便 dry-run 留证据。
- 默认保留相对路径，处理输出写到 `--output`，不会原地覆盖输入。
- 若输出文件已存在且内容相同，记为 `unchanged`。
- 若输出文件已存在但内容不同，默认报错；传 `--overwrite` 才替换。
- 若 `--output` 位于 `--input` 内部，遍历时会自动排除输出目录，避免重复处理。
- 默认递归遍历目录；传 `--no-recursive` 时只处理目录第一层文件。
- 显式文件输入若被 `--include` / `--exclude` / `--ext` 过滤掉，会记为 `skipped`；目录遍历中过滤掉的文件默认静默跳过，避免日志过噪。
- `pretty-json` 只处理探测为 JSON 的文件；非 JSON 或解析失败默认记为 `skipped`，需要硬失败时传 `--fail-on-parse-error`。
- 元数据会探测 `json`、`csv`、`tsv`、`text`、`binary`；二进制或无效 UTF-8 不做文本解析。
- 默认跳过 `.git/`、`node_modules/`、`runtime/`、`tmp/`、`dist/`、`coverage/`。

## 可扩展点

核心扩展点在脚本的 `customTransform(file, data, metadata, options)` 和 `transformFile(file, data, options)`：

- `data` 是原始 `Buffer`，可实现文本替换、格式转换、拆分/合并前的中间产物等。
- 返回 `outputData` 写入输出；返回 `null` 表示只收集元数据。
- 返回 `skipReason` 表示安全跳过，不计为失败。
- 返回 `targetRelativePath` 可改变输出路径或文件名。

当前内置操作：

- `copy`：复制匹配文件到输出目录。
- `rename`：按 `--rename-template` 改名后复制。
- `metadata`：提取 `path`、`bytes`、`ext`、格式探测结果、`sha256`，配合 `--manifest` 输出清单。
- `pretty-json`：格式化可解析 JSON；非 JSON 或解析失败默认跳过。
- `custom`：调用占位处理函数，当前默认跳过并提示 `custom-transform-not-configured`。

## 用户需要补充的最小配置信息

- 输入范围：目录、单个文件，或文件清单路径。
- 文件类型与匹配规则：扩展名、include/exclude glob、是否递归。
- 处理规则：每个文件要如何转换、是否需要解析 JSON/CSV/文本、解析失败是否跳过。
- 输出策略：输出目录、是否保持原相对路径、是否允许覆盖已有文件。
- 验收方式：期望生成的文件、日志、manifest 或人工检查样例。
