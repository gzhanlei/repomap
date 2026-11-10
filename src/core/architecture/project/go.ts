import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { DeclarationRecord } from "../ir.js";
import {
  adapterCapabilitySchema, emptyParseResult, packageRoot, projectUnitSchema,
  type AdapterCapability, type BuildContext, type ImportRef, type ImportResolution,
  type EntrypointCandidate, type LanguageAdapter, type ParseProjectResult,
  type ProjectUnit, type SymbolRecord,
} from "./adapter.js";
import type { SourceSnapshot } from "./snapshot.js";
import {
  GO_GRAMMAR_VERSION, GO_PARSER_VERSION, GO_RUNTIME_VERSION,
  goParserStatus, parseGoSource, type GoParsedFile,
} from "./go-parser.js";

/**
 * PR #7 `go-module-graph`: a package-aware Go LanguageAdapter over the fixed
 * Tree-sitter/WASM grammar (see docs/adr-go-parser.md).
 *
 * It resolves go.mod / go.work / replace rules and Go build constraints from
 * the immutable snapshot only. It produces a *syntax* tree: receiver types,
 * SSA, dynamic dispatch, route→handler and call graphs are explicitly NOT
 * shipped, so the capability stays partial and unresolved semantics fail
 * closed instead of being guessed.
 */

export const goModuleSchema = z.object({
  path: z.string().min(1),
  root: z.string(),
  modulePath: z.string().min(1),
  goVersion: z.string(),
  requires: z.array(z.object({ path: z.string().min(1), version: z.string().min(1) }).strict()),
  replaces: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), local: z.boolean() }).strict()),
  workspaceMember: z.boolean(),
}).strict();
export type GoModule = z.infer<typeof goModuleSchema>;

export const goWorkspaceSchema = z.object({
  path: z.string().min(1),
  root: z.string(),
  uses: z.array(z.string().min(1)),
}).strict();
export type GoWorkspace = z.infer<typeof goWorkspaceSchema>;

export const goExcludedFileSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
}).strict();
export type GoExcludedFile = z.infer<typeof goExcludedFileSchema>;

export interface GoSourceFile {
  path: string;
  dir: string;
  packageName: string;
  packageId: string;
  parsed: GoParsedFile;
}

export interface GoImportResolution {
  kind: "internal" | "standard-library" | "external" | "unresolved";
  resolution: ImportResolution;
  /** Snapshot-relative package directory, only for internal imports. */
  dir?: string;
  modulePath?: string;
  reason?: string;
}

export interface GoSnapshotAnalysis {
  parser: { id: string; version: string; runtime: string; status: "available" | "unavailable"; detail: string };
  modules: GoModule[];
  workspaces: GoWorkspace[];
  moduleErrors: { path: string; line: number; message: string }[];
  files: GoSourceFile[];
  excludedFiles: GoExcludedFile[];
  packageDirs: Map<string, GoSourceFile[]>;
  resolve(source: string, fromDir: string): GoImportResolution;
}

const knownGoos = new Set(["aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "js", "linux", "netbsd", "openbsd", "plan9", "solaris", "wasip1", "windows", "zos"]);
const knownGoarch = new Set(["386", "amd64", "amd64p32", "arm", "arm64", "arm64be", "armbe", "loong64", "mips", "mips64", "mips64le", "mips64p32", "mips64p32le", "mipsle", "ppc", "ppc64", "ppc64le", "riscv", "riscv64", "s390", "s390x", "sparc", "sparc64", "wasm"]);
const unixGoos = new Set(["aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "linux", "netbsd", "openbsd", "solaris"]);

function normalizeDir(path: string) {
  const dir = posix.normalize(path.replace(/^\.\//, ""));
  return dir === "." ? "." : dir.replace(/\/$/, "");
}

function stripComment(line: string) {
  return line.replace(/\s+\/\/.*$/, "").trim();
}

function parseGoDirectiveFiles(snapshot: SourceSnapshot) {
  const modules: GoModule[] = [];
  const workspaces: GoWorkspace[] = [];
  const moduleErrors: { path: string; line: number; message: string }[] = [];

  for (const file of snapshot.files) {
    if (!/(?:^|\/)go\.(?:mod|work)$/.test(file.path)) continue;
    const raw = snapshot.rawText(file.path);
    if (raw === undefined) continue;
    const root = posix.dirname(file.path) === "." ? "." : posix.dirname(file.path);
    let block: "require" | "replace" | "exclude" | "use" | null = null;
    let modulePath = "";
    let goVersion = "";
    const requires: GoModule["requires"] = [];
    const replaces: GoModule["replaces"] = [];
    const uses: string[] = [];
    raw.split("\n").forEach((lineText, index) => {
      const line = stripComment(lineText);
      if (!line) return;
      const lineNumber = index + 1;
      if (line === ")") { block = null; return; }
      const blockStart = line.match(/^(require|replace|exclude|use)\s*\($/);
      if (blockStart) { block = blockStart[1] as typeof block; return; }
      const statement = block ? `${block} ${line}` : line;
      const keyword = statement.split(/\s+/)[0];
      const rest = statement.slice(keyword.length).trim();
      if (keyword === "module" && !block) { modulePath = rest; return; }
      if (keyword === "go" && !block) { goVersion = rest; return; }
      if (keyword === "require" || keyword === "exclude") {
        const parts = rest.split(/\s+/);
        if (parts.length >= 2) requires.push({ path: parts[0], version: parts[1] });
        return;
      }
      if (keyword === "use") { uses.push(rest); return; }
      if (keyword === "replace") {
        const sides = rest.split(/\s*=>\s*/);
        if (sides.length !== 2 || !sides[0] || !sides[1]) {
          moduleErrors.push({ path: file.path, line: lineNumber, message: `malformed replace directive: ${line}` });
          return;
        }
        const from = sides[0].trim().split(/\s+/)[0];
        const to = sides[1].trim().split(/\s+/)[0];
        replaces.push({ from, to, local: /^\.{1,2}\//.test(to) });
        return;
      }
      // Unknown directives are declared, not silently treated as supported.
      if (!block && line.length > 0 && !/^(toolchain|godebug|retract|ignore)\b/.test(line)) {
        moduleErrors.push({ path: file.path, line: lineNumber, message: `unhandled go directive: ${line}` });
      }
    });
    if (file.path.endsWith("go.work")) {
      workspaces.push(goWorkspaceSchema.parse({ path: file.path, root, uses: uses.sort() }));
    } else {
      if (!modulePath) moduleErrors.push({ path: file.path, line: 1, message: "go.mod has no module directive" });
      modules.push(goModuleSchema.parse({
        path: file.path, root, modulePath: modulePath || `(missing:${file.path})`, goVersion,
        requires: requires.sort((a, b) => a.path.localeCompare(b.path)),
        replaces: replaces.sort((a, b) => a.from.localeCompare(b.from)),
        workspaceMember: false,
      }));
    }
  }

  const workspaceRoots = new Set(workspaces.flatMap((workspace) => workspace.uses.map((use) => normalizeDir(posix.join(workspace.root, use)))));
  const marked = modules.map((module) => goModuleSchema.parse({
    ...module,
    workspaceMember: workspaceRoots.has(normalizeDir(module.root)) || (module.root === "." && workspaces.length > 0),
  }));
  return {
    modules: marked.sort((a, b) => a.path.localeCompare(b.path)),
    workspaces: workspaces.sort((a, b) => a.path.localeCompare(b.path)),
    moduleErrors: moduleErrors.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`)),
  };
}

/** Tokenise a //go:build expression; unknown characters are whitespace. */
function buildExpressionTokens(expression: string) {
  return expression.match(/\|\||&&|!|\(|\)|[A-Za-z0-9_.]+/g) ?? [];
}

function evaluateBuildExpression(expression: string, tags: Set<string>) {
  const tokens = buildExpressionTokens(expression);
  let index = 0;
  const peek = () => tokens[index];
  const parseOr = (): boolean => {
    let value = parseAnd();
    while (peek() === "||") { index += 1; value = parseAnd() || value; }
    return value;
  };
  const parseAnd = (): boolean => {
    let value = parseUnary();
    while (peek() === "&&") { index += 1; value = parseUnary() && value; }
    return value;
  };
  const parseUnary = (): boolean => {
    const token = peek();
    if (token === undefined) return false;
    index += 1;
    if (token === "!") return !parseUnary();
    if (token === "(") { const value = parseOr(); if (peek() === ")") index += 1; return value; }
    if (token === ")" || token === "&&" || token === "||") return false;
    return tags.has(token);
  };
  return tokens.length > 0 && parseOr();
}

function evaluateLegacyBuildLines(lines: string[], tags: Set<string>) {
  if (lines.length === 0) return true;
  return lines.every((options) => options.trim().split(/\s+/).some((option) => option.split(",").every((tag) => tag.startsWith("!") ? !tags.has(tag.slice(1)) : tags.has(tag))));
}

/**
 * Explicit build-context evaluation. GOOS/GOARCH/tags come from the declared
 * build context only; process.env is never consulted.
 */
export function goFileSelection(path: string, raw: string, context: BuildContext): { included: boolean; reason?: string } {
  const tags = new Set([context.goos, context.goarch, "gc", ...context.buildTags]);
  if (unixGoos.has(context.goos)) tags.add("unix");
  const base = posix.basename(path).replace(/\.go$/, "");
  const parts = base.split("_");
  const last = parts.at(-1) ?? "";
  const previous = parts.at(-2) ?? "";
  if (knownGoos.has(last) && last !== context.goos) return { included: false, reason: `filename suffix _${last}.go does not match GOOS=${context.goos}` };
  if (knownGoarch.has(last) && last !== context.goarch) return { included: false, reason: `filename suffix _${last}.go does not match GOARCH=${context.goarch}` };
  if (knownGoarch.has(last) && knownGoos.has(previous) && previous !== context.goos) {
    return { included: false, reason: `filename suffix _${previous}_${last}.go does not match GOOS=${context.goos}` };
  }

  const header = raw.split("\n").slice(0, 60);
  const modern: string[] = [];
  const legacy: string[] = [];
  for (const line of header) {
    const trimmed = line.trim();
    if (/^package\s/.test(trimmed)) break;
    const goBuild = trimmed.match(/^\/\/go:build\s+(.+)$/);
    if (goBuild) modern.push(goBuild[1]);
    const plusBuild = trimmed.match(/^\/\/\s*\+build\s+(.+)$/);
    if (plusBuild) legacy.push(plusBuild[1]);
    if (trimmed.length > 0 && !trimmed.startsWith("//") && !/^\/\*/.test(trimmed)) break;
  }
  const contextLabel = `GOOS=${context.goos} GOARCH=${context.goarch} tags=[${context.buildTags.join(",")}]`;
  if (modern.length > 0) {
    const expression = modern[0];
    const value = evaluateBuildExpression(expression, tags);
    return value ? { included: true } : { included: false, reason: `//go:build ${expression} evaluated false for ${contextLabel}` };
  }
  if (legacy.length > 0 && !evaluateLegacyBuildLines(legacy, tags)) {
    return { included: false, reason: `// +build ${legacy.join(" ")} evaluated false for ${contextLabel}` };
  }
  return { included: true };
}

const analysisCache = new Map<string, GoSnapshotAnalysis>();

/** Shared by the adapter and the Go module graph: one deterministic analysis per snapshot + build context. */
export function analyzeGoSnapshot(snapshot: SourceSnapshot, context: BuildContext): GoSnapshotAnalysis {
  const cacheKey = `${snapshot.snapshotId}|${context.goos}|${context.goarch}|${context.buildTags.join(",")}`;
  const cached = analysisCache.get(cacheKey);
  if (cached) return cached;

  const parserStatus = goParserStatus();
  const directives = parseGoDirectiveFiles(snapshot);
  const files: GoSourceFile[] = [];
  const excludedFiles: GoExcludedFile[] = [];
  for (const file of snapshot.files) {
    if (file.language !== "go" || file.role !== "source" || !/\.go$/i.test(file.path)) continue;
    const raw = snapshot.rawText(file.path);
    if (raw === undefined) {
      excludedFiles.push({ path: file.path, reason: "raw text is not present in the immutable snapshot" });
      continue;
    }
    const selection = goFileSelection(file.path, raw, context);
    if (!selection.included) {
      excludedFiles.push(goExcludedFileSchema.parse({ path: file.path, reason: selection.reason ?? "excluded by build context" }));
      continue;
    }
    const parsed = parseGoSource(raw);
    if (!parsed) {
      excludedFiles.push(goExcludedFileSchema.parse({ path: file.path, reason: `Go grammar unavailable: ${parserStatus.detail}` }));
      continue;
    }
    files.push({ path: file.path, dir: posix.dirname(file.path) === "." ? "." : posix.dirname(file.path), packageName: parsed.packageName, packageId: file.packageId, parsed });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  excludedFiles.sort((a, b) => a.path.localeCompare(b.path));

  const packageDirs = new Map<string, GoSourceFile[]>();
  for (const file of files) packageDirs.set(file.dir, [...(packageDirs.get(file.dir) ?? []), file]);
  const sortedModules = [...directives.modules].sort((a, b) => b.modulePath.length - a.modulePath.length);
  const moduleForDir = (dir: string) => sortedModules.find((module) => normalizeDir(module.root) === "." || dir === normalizeDir(module.root) || dir.startsWith(`${normalizeDir(module.root)}/`));

  const resolve = (source: string, fromDir: string): GoImportResolution => {
    // 1. A replace pointing at a local directory is an in-snapshot package.
    for (const module of sortedModules) {
      for (const replace of module.replaces.filter((entry) => entry.local)) {
        if (source !== replace.from && !source.startsWith(`${replace.from}/`)) continue;
        const rest = source.slice(replace.from.length).replace(/^\//, "");
        const dir = normalizeDir(posix.join(module.root, replace.to, rest));
        if (packageDirs.has(dir)) return { kind: "internal", resolution: "go-replace-local", dir, modulePath: module.modulePath };
        return { kind: "unresolved", resolution: "unresolved", reason: `replace ${replace.from} => ${replace.to} has no Go package at ${dir} in the snapshot` };
      }
    }
    // 2. The longest matching go.mod module path owns the specifier.
    const module = sortedModules.find((entry) => source === entry.modulePath || source.startsWith(`${entry.modulePath}/`));
    if (module) {
      const rest = source.slice(module.modulePath.length).replace(/^\//, "");
      const dir = normalizeDir(posix.join(module.root, rest));
      if (packageDirs.has(dir)) {
        const sourceModule = moduleForDir(fromDir);
        const resolution: ImportResolution = sourceModule && sourceModule.path !== module.path ? "go-workspace-module" : "go-module-internal";
        return { kind: "internal", resolution, dir, modulePath: module.modulePath };
      }
      return { kind: "unresolved", resolution: "unresolved", reason: `${source} is inside module ${module.modulePath} but no Go package exists at ${dir} in the snapshot` };
    }
    // 3. Go standard library packages have no dot in their first path segment.
    if (!source.split("/")[0].includes(".")) return { kind: "standard-library", resolution: "standard-library", reason: "standard-library-package-not-in-snapshot" };
    return { kind: "external", resolution: "external", reason: "external-module-not-in-snapshot" };
  };

  const analysis: GoSnapshotAnalysis = {
    parser: {
      id: "tree-sitter-go", version: GO_GRAMMAR_VERSION, runtime: `web-tree-sitter@${GO_RUNTIME_VERSION}`,
      status: parserStatus.status, detail: parserStatus.detail,
    },
    modules: directives.modules,
    workspaces: directives.workspaces,
    moduleErrors: directives.moduleErrors,
    files,
    excludedFiles,
    packageDirs,
    resolve,
  };
  analysisCache.set(cacheKey, analysis);
  return analysis;
}

function declarationId(kind: string, path: string, detail: string) {
  return `decl:go:${createHash("sha256").update(`${kind}|${path}|${detail}`).digest("hex").slice(0, 16)}`;
}

export function createGoAdapter(): LanguageAdapter {
  const inputs = new WeakMap<ProjectUnit, { snapshot: SourceSnapshot; context: BuildContext }>();
  const parsed = new WeakMap<ProjectUnit, ParseProjectResult>();
  const grammarStatus = goParserStatus().status;

  const capabilities = (): AdapterCapability[] => {
    const status = grammarStatus === "available" ? "partial" : "unavailable";
    return [
      adapterCapabilitySchema.parse({ id: "tree-sitter-go", version: GO_PARSER_VERSION, status: grammarStatus, detail: goParserStatus().detail }),
      adapterCapabilitySchema.parse({ id: "ast-go", version: "1", status, detail: "Package-aware Go syntax tree: package clause, imports, symbols, call expressions and ERROR/MISSING diagnostics; no type/SSA/receiver/route resolution" }),
      adapterCapabilitySchema.parse({ id: "module-graph-go", version: "1", status, detail: "Go package graph from go.mod/go.work/replace and build constraints; delivered in architecture.go-module-graph.json" }),
      adapterCapabilitySchema.parse({ id: "route-graph-go", version: "1", status, detail: "net/http, mux and chi-style route registrations with local/package handlers and bounded direct package calls" }),
    ];
  };

  function parseProject(project: ProjectUnit): ParseProjectResult {
    const cached = parsed.get(project);
    if (cached) return cached;
    const input = inputs.get(project);
    if (!input) return emptyParseResult(project.id, ["Go project unit was not produced by prepareProject"]);
    if (goParserStatus().status === "unavailable") return emptyParseResult(project.id, [goParserStatus().detail]);
    const analysis = analyzeGoSnapshot(input.snapshot, input.context);
    const included = new Set(project.files);
    const imports: ImportRef[] = [];
    const symbols: SymbolRecord[] = [];
    const entrypoints: EntrypointCandidate[] = [];
    const parseErrors: ParseProjectResult["parseErrors"] = [];

    for (const file of analysis.files.filter((entry) => included.has(entry.path))) {
      if (!file.packageName) {
        parseErrors.push({ path: file.path, line: 1, message: "Go source has no package clause" });
      }
      for (const diagnostic of file.parsed.diagnostics) {
        parseErrors.push({ path: file.path, line: diagnostic.line, message: diagnostic.message });
      }
      for (const item of file.parsed.imports) {
        const resolved = analysis.resolve(item.source, file.dir);
        const targetFiles = resolved.dir ? analysis.packageDirs.get(resolved.dir) : undefined;
        imports.push({
          path: file.path,
          source: item.source,
          kind: "static",
          line: item.line,
          ...(item.alias ? { alias: item.alias } : {}),
          importForm: item.form,
          resolution: resolved.resolution,
          ...(resolved.dir ? { resolvedPath: resolved.dir, targetPackageId: targetFiles?.[0]?.packageId ?? "package:root" } : {}),
          ...(resolved.reason ? { unresolvedReason: resolved.reason } : {}),
        });
      }
      for (const symbol of file.parsed.symbols) {
        symbols.push({ path: file.path, name: symbol.name, kind: symbol.kind, exported: symbol.exported, line: symbol.line });
      }
      if (file.packageName === "main" && file.parsed.symbols.some((symbol) => symbol.name === "main" && symbol.kind === "function")) {
        entrypoints.push({ path: file.path, kind: "go-main", line: file.parsed.symbols.find((symbol) => symbol.name === "main")?.line ?? 1 });
      }
    }
    const result: ParseProjectResult = {
      unitId: project.id,
      imports: imports.sort((a, b) => `${a.path}:${a.line}:${a.source}`.localeCompare(`${b.path}:${b.line}:${b.source}`)),
      symbols: symbols.sort((a, b) => `${a.path}:${a.line}:${a.name}`.localeCompare(`${b.path}:${b.line}:${b.name}`)),
      entrypoints: entrypoints.sort((a, b) => `${a.path}:${a.kind}`.localeCompare(`${b.path}:${b.kind}`)),
      parseErrors: parseErrors.sort((a, b) => `${a.path}:${a.line}:${a.message}`.localeCompare(`${b.path}:${b.line}:${b.message}`)),
      notes: [
        `${GO_PARSER_VERSION} syntax tree over the immutable raw snapshot; no host go toolchain, no network, no repository code execution`,
        `Explicit build context GOOS=${input.context.goos} GOARCH=${input.context.goarch} tags=[${input.context.buildTags.join(",")}]`,
        "Receiver types, SSA, dynamic dispatch, route→handler and call graphs are NOT resolved in this slice",
      ],
    };
    parsed.set(project, result);
    return result;
  }

  return {
    id: "ast-go",
    version: GO_PARSER_VERSION,
    languages: ["go"],
    prepareProject(snapshot, context) {
      const analysis = analyzeGoSnapshot(snapshot, context);
      const includedPaths = new Set(analysis.files.map((file) => file.path));
      const groups = new Map<string, { files: string[]; manifests: string[] }>();
      for (const file of snapshot.files) {
        const group = groups.get(file.packageId) ?? { files: [], manifests: [] };
        if (/(?:^|\/)go\.(?:mod|work)$/.test(file.path) && (file.role === "manifest" || file.role === "config")) group.manifests.push(file.path);
        if (file.language === "go" && file.role === "source" && includedPaths.has(file.path)) group.files.push(file.path);
        groups.set(file.packageId, group);
      }
      return [...groups.entries()]
        .filter(([, group]) => group.files.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([packageId, group]) => {
          const unit = projectUnitSchema.parse({
            id: `unit:${packageId}:go`,
            language: "go",
            packageId,
            root: packageRoot(packageId),
            adapterId: "ast-go",
            files: group.files.sort(),
            manifests: group.manifests.sort(),
            status: analysis.parser.status === "available" ? "prepared" : "parser-unavailable",
          });
          inputs.set(unit, { snapshot, context });
          return unit;
        });
    },
    parseProject,
    /** Independent structural discovery: a line scan, never the AST detector. */
    declarations(project) {
      const input = inputs.get(project);
      const snapshot = input?.snapshot;
      const records: DeclarationRecord[] = [];
      for (const path of project.files) {
        const raw = snapshot?.rawText(path) ?? "";
        raw.split("\n").forEach((line, index) => {
          const packageName = line.match(/^package\s+([A-Za-z_][\w]*)/)?.[1];
          if (packageName) {
            records.push({
              declarationId: declarationId("package", path, packageName), kind: "package", owner: project.packageId,
              required: false, critical: false, sourcePath: path, detail: `independent Go package clause line scan: ${packageName}`,
              capability: "go-structure-line-scan", evidenceIds: [],
            });
          }
          if (/^func\s+main\s*\(/.test(line)) {
            records.push({
              declarationId: declarationId("entrypoint", path, `main:${index + 1}`), kind: "entrypoint", owner: project.packageId,
              required: true, critical: true, sourcePath: path, detail: `independent Go func main line scan at line ${index + 1}`,
              capability: "go-structure-line-scan", evidenceIds: [],
            });
          }
        });
      }
      for (const manifest of project.manifests) {
        records.push({
          declarationId: declarationId("package", manifest, "go-manifest"), kind: "package", owner: project.packageId,
          required: false, critical: false, sourcePath: manifest, detail: "independent Go module/workspace manifest discovery",
          capability: "go-structure-line-scan", evidenceIds: [],
        });
      }
      return records.sort((a, b) => a.declarationId.localeCompare(b.declarationId));
    },
    symbols(project) { return parseProject(project).symbols; },
    imports(project) { return parseProject(project).imports; },
    entrypoints(project) { return parseProject(project).entrypoints; },
    capabilities,
  };
}
