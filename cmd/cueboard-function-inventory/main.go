// Command cueboard-function-inventory walks one or more Go source roots and
// emits a Markdown function/method inventory with a per-row "Suggested
// status" column so an audit author can mark each function ported / ported
// (verified) / port pending / out of scope.
//
// Why this exists:
//   - The cueboard → oneesama migration relied on per-function port
//     reviews. This binary keeps the audit checklist mechanically generated
//     so we cannot silently drop a function from the review surface.
//   - Use `--root label=/path` (repeatable) to scope; `--out path` to write
//     to disk. `--include-tests` to widen scope to *_test.go files.
//
// Reference: notes/cueboard-function-audit/ uses inventories produced by
// this command as the per-area starting tables.
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type rootFlags []string

func (r *rootFlags) String() string {
	return strings.Join(*r, ",")
}

func (r *rootFlags) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return fmt.Errorf("root cannot be empty")
	}
	*r = append(*r, value)
	return nil
}

type rootSpec struct {
	Label string
	Path  string
}

type functionRecord struct {
	Module     string
	SourceFile string
	Name       string
	Kind       string
	Exported   bool
	StartLine  int
	EndLine    int
}

type outputOptions struct {
	Title       string
	Status      string
	GeneratedAt time.Time
	Command     string
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	var roots rootFlags
	var outPath string
	var includeTests bool
	var title string
	var status string

	flags := flag.NewFlagSet("cueboard-function-inventory", flag.ContinueOnError)
	flags.Var(&roots, "root", "Go source root to inventory. Repeatable. Use label=/path to control the module label.")
	flags.StringVar(&outPath, "out", "", "Write markdown output to this path. Defaults to stdout.")
	flags.BoolVar(&includeTests, "include-tests", false, "Include *_test.go files.")
	flags.StringVar(&title, "title", "Cueboard Function Inventory", "Markdown title.")
	flags.StringVar(&status, "status", "unreviewed", "Initial Suggested status value for each row.")
	if err := flags.Parse(args); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if len(roots) == 0 {
		fmt.Fprintln(os.Stderr, "at least one --root is required")
		return 2
	}

	specs, err := parseRootSpecs(roots)
	if err != nil {
		fmt.Fprintf(os.Stderr, "parse roots: %v\n", err)
		return 1
	}
	records, err := collectInventory(specs, includeTests)
	if err != nil {
		fmt.Fprintf(os.Stderr, "collect inventory: %v\n", err)
		return 1
	}
	markdown := formatMarkdown(records, outputOptions{
		Title:       title,
		Status:      status,
		GeneratedAt: time.Now().UTC(),
		Command:     strings.Join(append([]string{"go run ./cmd/cueboard-function-inventory"}, args...), " "),
	})

	if outPath == "" {
		fmt.Print(markdown)
		return 0
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "create output directory: %v\n", err)
		return 1
	}
	if err := os.WriteFile(outPath, []byte(markdown), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "write output: %v\n", err)
		return 1
	}
	return 0
}

func parseRootSpecs(values []string) ([]rootSpec, error) {
	specs := make([]rootSpec, 0, len(values))
	for _, value := range values {
		label, rootPath, hasLabel := strings.Cut(value, "=")
		if !hasLabel {
			rootPath = value
			label = filepath.Base(strings.TrimRight(rootPath, string(os.PathSeparator)))
		}
		label = strings.TrimSpace(label)
		rootPath = strings.TrimSpace(rootPath)
		if label == "" || rootPath == "" {
			return nil, fmt.Errorf("invalid root %q; use /path or label=/path", value)
		}
		absPath, err := filepath.Abs(rootPath)
		if err != nil {
			return nil, fmt.Errorf("resolve %q: %w", rootPath, err)
		}
		info, err := os.Stat(absPath)
		if err != nil {
			return nil, fmt.Errorf("stat %q: %w", absPath, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("root %q is not a directory", absPath)
		}
		specs = append(specs, rootSpec{Label: label, Path: absPath})
	}
	return specs, nil
}

func collectInventory(roots []rootSpec, includeTests bool) ([]functionRecord, error) {
	var records []functionRecord
	for _, root := range roots {
		rootRecords, err := collectRootInventory(root, includeTests)
		if err != nil {
			return nil, err
		}
		records = append(records, rootRecords...)
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].Module != records[j].Module {
			return records[i].Module < records[j].Module
		}
		if records[i].SourceFile != records[j].SourceFile {
			return records[i].SourceFile < records[j].SourceFile
		}
		if records[i].StartLine != records[j].StartLine {
			return records[i].StartLine < records[j].StartLine
		}
		return records[i].Name < records[j].Name
	})
	return records, nil
}

func collectRootInventory(root rootSpec, includeTests bool) ([]functionRecord, error) {
	fset := token.NewFileSet()
	var records []functionRecord
	err := filepath.WalkDir(root.Path, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if shouldSkipDir(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(entry.Name(), ".go") {
			return nil
		}
		if !includeTests && strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}
		source, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
		relPath, err := filepath.Rel(root.Path, path)
		if err != nil {
			return fmt.Errorf("rel %s: %w", path, err)
		}
		records = append(records, recordsFromFile(fset, root.Label, filepath.ToSlash(relPath), source)...)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return records, nil
}

func shouldSkipDir(name string) bool {
	switch name {
	case ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", ".next":
		return true
	default:
		return strings.HasPrefix(name, ".") && name != "."
	}
}

func recordsFromFile(fset *token.FileSet, module string, relPath string, file *ast.File) []functionRecord {
	records := make([]functionRecord, 0)
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name == nil {
			continue
		}
		kind := "function"
		name := fn.Name.Name
		if fn.Recv != nil && len(fn.Recv.List) > 0 {
			kind = "method"
			name = fmt.Sprintf("(%s).%s", receiverName(fn.Recv.List[0].Type), fn.Name.Name)
		}
		start := fset.Position(fn.Pos()).Line
		end := fset.Position(fn.End()).Line
		records = append(records, functionRecord{
			Module:     module,
			SourceFile: relPath,
			Name:       name,
			Kind:       kind,
			Exported:   ast.IsExported(fn.Name.Name),
			StartLine:  start,
			EndLine:    end,
		})
	}
	return records
}

func receiverName(expr ast.Expr) string {
	switch typed := expr.(type) {
	case *ast.Ident:
		return typed.Name
	case *ast.StarExpr:
		return "*" + receiverName(typed.X)
	case *ast.SelectorExpr:
		return receiverName(typed.X) + "." + typed.Sel.Name
	case *ast.IndexExpr:
		return receiverName(typed.X)
	case *ast.IndexListExpr:
		return receiverName(typed.X)
	default:
		return strings.TrimSpace(exprToString(expr))
	}
}

func exprToString(expr ast.Expr) string {
	switch typed := expr.(type) {
	case *ast.Ident:
		return typed.Name
	case *ast.StarExpr:
		return "*" + exprToString(typed.X)
	case *ast.SelectorExpr:
		return exprToString(typed.X) + "." + typed.Sel.Name
	case *ast.ArrayType:
		return "[]" + exprToString(typed.Elt)
	default:
		return "unknown"
	}
}

func formatMarkdown(records []functionRecord, opts outputOptions) string {
	if opts.Title == "" {
		opts.Title = "Cueboard Function Inventory"
	}
	if opts.Status == "" {
		opts.Status = "unreviewed"
	}
	if opts.GeneratedAt.IsZero() {
		opts.GeneratedAt = time.Now().UTC()
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", opts.Title)
	fmt.Fprintf(&b, "Generated: `%s`\n\n", opts.GeneratedAt.Format(time.RFC3339))
	if opts.Command != "" {
		fmt.Fprintf(&b, "Command: `%s`\n\n", escapeBackticks(opts.Command))
	}
	fmt.Fprintln(&b, "Status enum: `identical` / `verbatim_port` / `partial` / `drift` / `missing` / `product_excluded` / `unreviewed`.")
	fmt.Fprintln(&b)
	fmt.Fprintf(&b, "Total functions: **%d**\n\n", len(records))
	fmt.Fprintln(&b, "| Module | Source file | Function | Kind | Exported | Lines | Suggested status | Oneesama target | Evidence | Notes |")
	fmt.Fprintln(&b, "|---|---|---|---|---:|---:|---|---|---|---|")
	for _, record := range records {
		exported := "no"
		if record.Exported {
			exported = "yes"
		}
		fmt.Fprintf(
			&b,
			"| %s | %s | `%s` | %s | %s | %d-%d | %s |  |  |  |\n",
			escapeTable(record.Module),
			escapeTable(record.SourceFile),
			escapeInlineCode(record.Name),
			escapeTable(record.Kind),
			exported,
			record.StartLine,
			record.EndLine,
			escapeTable(opts.Status),
		)
	}
	return b.String()
}

func escapeTable(value string) string {
	value = strings.ReplaceAll(value, "\n", " ")
	value = strings.ReplaceAll(value, "|", "\\|")
	return value
}

func escapeInlineCode(value string) string {
	value = strings.ReplaceAll(value, "`", "\\`")
	return value
}

func escapeBackticks(value string) string {
	return strings.ReplaceAll(value, "`", "\\`")
}
