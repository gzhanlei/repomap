import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import type { DeclarationRecord } from "../ir.js";
import {
  adapterCapabilitySchema, emptyParseResult, packageRoot, projectUnitSchema,
  type AdapterCapability, type BuildContext, type ImportRef, type ImportResolution,
  type EntrypointCandidate, type LanguageAdapter, type ParseProjectResult,
  type ProjectUnit, type SymbolRecord,
} from "./adapter.js";
import type { SourceSnapshot } from "./snapshot.js";

/**
 * PR #6 `ts-module-graph`: the adapter now builds ONE project-wide Program over
 * the immutable raw snapshot. A per-unit Program could not resolve imports that
 * cross workspace boundaries, which made a module graph impossible. Resolution
 * rules (tsconfig paths / baseUrl / references, workspace package names) are
 * read from the snapshot itself; the host machine's node_modules is never used.
 *
 * Route→handler, call summaries and protocol operations are still later PRs and
 * remain declared unavailable rather than being approximated by regex.
 */

const virtualRoot = "/__repomap_snapshot__/";
const virtualRootBase = virtualRoot.slice(0, -1);
const tsExtension = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const tsLanguages = ["typescript", "javascript"] as const;
const moduleCandidates = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const indexCandidates = ["index.ts", "index.tsx", "index.mts", "index.cts", "index.js", "index.jsx", "index.mjs", "index.cjs"];

const entrypointRules: [RegExp, string][] = [
  [/(?:^|\/)app\/.*(?:page|route|layout)\.tsx?$/, "app-router-file"],
  [/(?:^|\/)pages\/.*\.tsx?$/, "pages-router-file"],
  [/(?:^|\/)src\/main\.(?:ts|tsx|js|jsx)$/, "bundler-entry"],
  [/(?:^|\/)main\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "module-main"],
  [/(?:^|\/)index\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "barrel-or-index"],
];

interface TsConfigRule {
  path: string;
  root: string;
  baseUrl: string;
  paths: Record<string, string[]>;
  references: string[];
}

interface WorkspacePackage {
  name: string;
  root: string;
  manifestPath: string;
  main?: string;
}

export interface TypeScriptResolutionRules {
  tsconfigs: TsConfigRule[];
  workspacePackages: WorkspacePackage[];
  extensionCandidates: string[];
}

interface ProgramBundle {
  fileMap: Map<string, string>;
  host: ts.CompilerHost;
  program: ts.Program;
  options: ts.CompilerOptions;
  rules: TypeScriptResolutionRules;
  packageOf: Map<string, string>;
  resolve(source: string, containingFile: string, config?: TsConfigRule): ResolvedImport;
}

interface ResolvedImport {
  resolvedPath?: string;
  targetPackageId?: string;
  resolution: ImportResolution;
  barrel: boolean;
  unresolvedReason?: string;
}

function virtualPath(fileName: string) {
  const normalized = fileName.replaceAll("\\", "/");
  if (normalized.startsWith(virtualRoot)) return normalized;
  return `${virtualRoot}${normalized.replace(/^\/+/, "")}`;
}

function repoPath(fileName: string) {
  return virtualPath(fileName).slice(virtualRoot.length);
}

function scriptKind(path: string) {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function declarationId(kind: string, path: string, detail: string) {
  return `decl:project:${createHash("sha256").update(`${kind}|${path}|${detail}`).digest("hex").slice(0, 16)}`;
}

function structuralEntrypoints(paths: string[]): EntrypointCandidate[] {
  return paths.flatMap((path) => {
    const rule = entrypointRules.find(([pattern]) => pattern.test(path));
    return rule ? [{ path, kind: rule[1], line: 1 }] : [];
  }).sort((a, b) => `${a.path}:${a.kind}`.localeCompare(`${b.path}:${b.kind}`));
}

/** tsconfig files commonly contain comments and trailing commas. */
function parseJsonLike(text: string): unknown {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeRepoPath(path: string) {
  const normalized = posix.normalize(path.replace(/^\.\//, ""));
  return normalized === "." ? "." : normalized.replace(/\/$/, "");
}

export function readTypeScriptResolutionRules(snapshot: SourceSnapshot): TypeScriptResolutionRules {
  const tsconfigs: TsConfigRule[] = [];
  const workspacePackages: WorkspacePackage[] = [];
  for (const file of snapshot.files) {
    const text = snapshot.rawText(file.path);
    if (text === undefined) continue;
    if (/(?:^|\/)tsconfig(?:[.-][^/]*)?\.json$/i.test(file.path)) {
      try {
        const json = asRecord(parseJsonLike(text));
        const compiler = asRecord(json.compilerOptions);
        const paths: Record<string, string[]> = {};
        for (const [alias, targets] of Object.entries(asRecord(compiler.paths))) {
          if (Array.isArray(targets)) paths[alias] = targets.filter((target): target is string => typeof target === "string");
        }
        const references = Array.isArray(json.references)
          ? json.references
            .map((reference) => {
              const target = asRecord(reference).path;
              return typeof target === "string" ? normalizeRepoPath(posix.join(posix.dirname(file.path), target)) : "";
            })
            .filter((reference) => reference.length > 0 && reference !== ".")
          : [];
        tsconfigs.push({
          path: file.path,
          root: posix.dirname(file.path) === "." ? "." : posix.dirname(file.path),
          baseUrl: typeof compiler.baseUrl === "string" ? compiler.baseUrl : ".",
          paths,
          references: [...new Set(references)].sort(),
        });
      } catch { /* malformed tsconfig: declared below as an unsupported-syntax note */ }
    }
    if (/(?:^|\/)package\.json$/i.test(file.path)) {
      try {
        const json = asRecord(parseJsonLike(text));
        if (typeof json.name === "string" && json.name.length > 0) {
          workspacePackages.push({
            name: json.name,
            root: posix.dirname(file.path) === "." ? "." : posix.dirname(file.path),
            manifestPath: file.path,
            ...(typeof json.main === "string" ? { main: json.main } : {}),
          });
        }
      } catch { /* malformed manifest: not a resolution rule */ }
    }
  }
  return {
    tsconfigs: tsconfigs.sort((a, b) => a.path.localeCompare(b.path)),
    workspacePackages: workspacePackages.sort((a, b) => a.name.localeCompare(b.name)),
    extensionCandidates: [...moduleCandidates.filter(Boolean), ...indexCandidates],
  };
}

function configFor(path: string, rules: TypeScriptResolutionRules) {
  const candidates = rules.tsconfigs
    .filter((config) => config.root === "." || path === config.root || path.startsWith(`${config.root}/`))
    .sort((a, b) => b.root.length - a.root.length);
  return candidates[0];
}

function optionsFor(config: TsConfigRule | undefined, base: ts.CompilerOptions): ts.CompilerOptions {
  if (!config) return base;
  const prefix = posix.normalize(`${virtualRoot}${config.root === "." ? "" : `${config.root}/`}${config.baseUrl === "." ? "" : config.baseUrl}`);
  const baseUrl = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const paths = Object.fromEntries(Object.entries(config.paths).map(([alias, targets]) => [alias, targets.map((target) => posix.normalize(`${baseUrl}${target}`))]));
  return { ...base, baseUrl, paths };
}

function matchesAlias(source: string, config: TsConfigRule | undefined) {
  if (!config) return false;
  return Object.keys(config.paths).some((alias) => {
    if (alias.endsWith("*")) return source.startsWith(alias.slice(0, -1));
    return source === alias;
  });
}

function buildBundle(snapshot: SourceSnapshot): ProgramBundle {
  const fileMap = new Map<string, string>();
  const packageOf = new Map<string, string>();
  for (const file of snapshot.files) {
    if (!tsExtension.test(file.path)) continue;
    const raw = snapshot.rawText(file.path);
    if (raw === undefined) continue;
    fileMap.set(virtualRoot + file.path, raw);
    packageOf.set(file.path, file.packageId);
  }
  const rules = readTypeScriptResolutionRules(snapshot);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    // Bundler resolution matches extensionless TS/JS imports; it must never
    // fall back to the host's node_modules.
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true,
    noResolve: false, types: [], jsx: ts.JsxEmit.Preserve,
  };
  const directories = new Set<string>([virtualRootBase]);
  for (const fileName of fileMap.keys()) {
    let directory = posix.dirname(fileName);
    while (directory.length >= virtualRootBase.length) {
      directories.add(directory);
      if (directory === virtualRootBase) break;
      directory = posix.dirname(directory);
    }
  }
  // Pre-index children so resolution stays O(1) per directory instead of
  // re-scanning the whole directory set for every specifier.
  const children = new Map<string, string[]>();
  for (const directory of directories) {
    const parent = posix.dirname(directory);
    children.set(parent, [...(children.get(parent) ?? []), posix.basename(directory)]);
  }
  for (const [parent, names] of children) children.set(parent, names.sort());
  const host = ts.createCompilerHost(options, true);
  host.getCurrentDirectory = () => virtualRoot;
  host.fileExists = (fileName) => fileMap.has(virtualPath(fileName));
  host.readFile = (fileName) => fileMap.get(virtualPath(fileName));
  host.directoryExists = (directory) => directories.has(posix.normalize(directory.replace(/\/$/, "")));
  host.realpath = (fileName) => fileName;
  host.getDirectories = (directory) => children.get(posix.normalize(directory.replace(/\/$/, ""))) ?? [];
  host.getSourceFile = (fileName, languageVersion) => {
    const text = fileMap.get(virtualPath(fileName));
    return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true, scriptKind(fileName));
  };
  const program = ts.createProgram([...fileMap.keys()], options, host);

  const known = (relative: string) => fileMap.has(virtualRoot + relative);
  const tryCandidate = (base: string): string | undefined => {
    const clean = base.replace(/^\/+/, "");
    for (const suffix of moduleCandidates) if (known(`${clean}${suffix}`)) return `${clean}${suffix}`;
    for (const index of indexCandidates) if (known(`${clean}/${index}`)) return `${clean}/${index}`;
    return undefined;
  };
  const workspaceFor = (source: string) => rules.workspacePackages
    .filter((entry) => source === entry.name || source.startsWith(`${entry.name}/`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const references = new Set(rules.tsconfigs.flatMap((config) => config.references));

  const decorate = (resolvedPath: string, resolution: ImportResolution, specifier: string): ResolvedImport => {
    const inReference = [...references].some((reference) => resolvedPath.startsWith(`${reference}/`));
    // A workspace package name stays a workspace edge even when its target
    // directory is also listed in tsconfig references; only relative/alias
    // specifiers are reclassified as project references.
    const asReference = inReference && (resolution === "relative" || resolution === "alias");
    return {
      resolvedPath,
      targetPackageId: packageOf.get(resolvedPath) ?? "package:root",
      resolution: asReference ? "project-reference" : resolution,
      barrel: /(?:^|\/)index\.[a-z]+$/i.test(resolvedPath) && !/(?:^|\/)index(?:\.[a-z]+)?$/i.test(specifier),
    };
  };

  const resolve = (source: string, containingFile: string, config?: TsConfigRule): ResolvedImport => {
    const isRelative = /^\.{1,2}\//.test(source) || source.startsWith("/");
    // 1. Explicit tsconfig path aliases.
    if (matchesAlias(source, config)) {
      const resolved = ts.resolveModuleName(source, containingFile, optionsFor(config, options), host).resolvedModule;
      if (resolved && known(repoPath(resolved.resolvedFileName))) return decorate(repoPath(resolved.resolvedFileName), "alias", source);
    }
    // 2. Workspace package names resolve to the local package, not the registry.
    const workspace = workspaceFor(source);
    if (workspace && !isRelative) {
      const subpath = source.slice(workspace.name.length).replace(/^\//, "");
      const roots = [subpath, workspace.main, "src/index", "index"].filter((value): value is string => typeof value === "string" && value.length > 0);
      for (const root of roots) {
        const base = workspace.root === "." ? root : posix.join(workspace.root, root);
        const found = tryCandidate(base);
        if (found) return decorate(found, "workspace-package", source);
      }
    }
    // Bare specifiers with no alias/workspace/baseUrl rule are external by
    // definition of the snapshot; probing node_modules paths cannot succeed.
    const hasBaseLookup = config !== undefined && (config.baseUrl !== "." || Object.keys(config.paths).length > 0);
    if (!isRelative && !hasBaseLookup) {
      return { resolution: "unresolved", barrel: false, unresolvedReason: "external-package-not-in-snapshot" };
    }
    // 3. Relative paths, directory roots and barrels through the Compiler API.
    const resolved = ts.resolveModuleName(source, containingFile, options, host).resolvedModule;
    if (resolved && known(repoPath(resolved.resolvedFileName))) {
      return decorate(repoPath(resolved.resolvedFileName), isRelative ? "relative" : "alias", source);
    }
    return {
      resolution: "unresolved",
      barrel: false,
      unresolvedReason: isRelative ? "relative-import-not-resolved-in-snapshot" : "external-package-not-in-snapshot",
    };
  };

  return { fileMap, host, program, options, rules, packageOf, resolve };
}

interface UnitInput { snapshot: SourceSnapshot; context: BuildContext }

export function createTypeScriptAdapter(): LanguageAdapter {
  const inputs = new WeakMap<ProjectUnit, UnitInput>();
  const parsed = new WeakMap<ProjectUnit, ParseProjectResult>();
  const bundles = new WeakMap<SourceSnapshot, ProgramBundle>();
  const bundleFor = (snapshot: SourceSnapshot) => {
    const existing = bundles.get(snapshot);
    if (existing) return existing;
    const created = buildBundle(snapshot);
    bundles.set(snapshot, created);
    return created;
  };

  const capabilities = (): AdapterCapability[] => [
    adapterCapabilitySchema.parse({ id: "typescript-compiler", version: ts.version, status: "available", detail: "One project-wide TypeScript Compiler API Program over the immutable raw snapshot" }),
    adapterCapabilitySchema.parse({ id: "ast-typescript", version: "1", status: "partial", detail: "syntax diagnostics, imports/re-exports, symbols, tsconfig/workspace resolution; routes and call summaries are not implemented" }),
    adapterCapabilitySchema.parse({ id: "module-graph", version: "1", status: "partial", detail: "TypeScript/JavaScript module graph with cycles, barrels, aliases and workspace packages; Go module graph is not shipped" }),
    adapterCapabilitySchema.parse({ id: "module-graph-go", version: "0", status: "unavailable", detail: "Package-aware Go AST helper lands in go-module-graph" }),
    adapterCapabilitySchema.parse({ id: "route-graph", version: "0", status: "unavailable", detail: "route-to-handler resolution lands in route-and-call-graph" }),
  ];

  function parseProject(project: ProjectUnit): ParseProjectResult {
    const cached = parsed.get(project);
    if (cached) return cached;
    const input = inputs.get(project);
    if (!input) return emptyParseResult(project.id, ["project unit was not produced by prepareProject"]);
    const bundle = bundleFor(input.snapshot);
    const config = configFor(project.root === "." ? project.files[0] ?? "" : `${project.root}/`, bundle.rules);
    const imports: ImportRef[] = [];
    const symbols: SymbolRecord[] = [];
    const notes: string[] = [];

    for (const path of project.files) {
      const fileName = virtualRoot + path;
      if (!bundle.fileMap.has(fileName)) continue;
      const sourceFile = bundle.program.getSourceFile(fileName);
      if (!sourceFile) continue;
      const lineAt = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const addImport = (source: string, kind: ImportRef["kind"], node: ts.Node) => {
        imports.push({ path, source, kind, line: lineAt(node), ...bundle.resolve(source, fileName, config) });
      };
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          addImport(node.moduleSpecifier.text, "static", node);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          addImport(node.moduleSpecifier.text, "re-export", node);
        } else if (ts.isCallExpression(node)) {
          const argument = node.arguments[0];
          const literal = argument && ts.isStringLiteral(argument) ? argument.text : undefined;
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword && literal) {
            addImport(literal, "dynamic", node);
          } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && literal) {
            addImport(literal, "require", node);
          }
        }
        if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
          const name = node.name?.text ?? "default";
          const exported = (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
          symbols.push({ path, name, kind: ts.SyntaxKind[node.kind].replace(/Declaration$/, "").toLowerCase(), exported, line: lineAt(node) });
        } else if (ts.isVariableStatement(node)) {
          const exported = (ts.getCombinedModifierFlags(node as unknown as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
          for (const declaration of node.declarationList.declarations) {
            const name = ts.isIdentifier(declaration.name) ? declaration.name.text : declaration.name.getText(sourceFile);
            symbols.push({ path, name, kind: "variable", exported, line: lineAt(declaration) });
          }
        } else if (ts.isExportAssignment(node)) {
          symbols.push({ path, name: "default", kind: "export-assignment", exported: true, line: lineAt(node) });
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    const diagnostics = bundle.program.getSyntacticDiagnostics().filter((diagnostic) => diagnostic.file && project.files.includes(repoPath(diagnostic.file.fileName)));
    const parseErrors = diagnostics.slice(0, 100).map((diagnostic) => {
      const file = diagnostic.file;
      const line = file && diagnostic.start !== undefined ? file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 1;
      return {
        path: file ? repoPath(file.fileName) : "(project)",
        line,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      };
    });
    if (diagnostics.length > parseErrors.length) notes.push(`parse errors truncated to ${parseErrors.length} of ${diagnostics.length}`);
    notes.push("Bare package specifiers are deliberately unresolved unless a workspace package or tsconfig alias resolves them inside the snapshot.");
    if (bundle.rules.tsconfigs.length > 0) notes.push(`Applied ${bundle.rules.tsconfigs.length} tsconfig resolution rule set(s) from the snapshot.`);

    const result: ParseProjectResult = {
      unitId: project.id,
      imports: imports.sort((a, b) => `${a.path}:${a.line}:${a.source}`.localeCompare(`${b.path}:${b.line}:${b.source}`)),
      symbols: symbols.sort((a, b) => `${a.path}:${a.line}:${a.name}`.localeCompare(`${b.path}:${b.line}:${b.name}`)),
      entrypoints: structuralEntrypoints(project.files),
      parseErrors,
      notes,
    };
    parsed.set(project, result);
    return result;
  }

  return {
    id: "ast-typescript",
    version: "1",
    languages: tsLanguages,
    prepareProject(snapshot, context) {
      const groups = new Map<string, { files: string[]; manifests: string[] }>();
      for (const file of snapshot.files) {
        const group = groups.get(file.packageId) ?? { files: [], manifests: [] };
        if (file.role === "manifest" || file.role === "config") group.manifests.push(file.path);
        if (file.role === "source" && tsLanguages.includes(file.language as typeof tsLanguages[number])) group.files.push(file.path);
        groups.set(file.packageId, group);
      }
      return [...groups.entries()]
        .filter(([, group]) => group.files.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([packageId, group]) => {
          const unit = projectUnitSchema.parse({
            id: `unit:${packageId}:typescript-javascript`,
            language: "typescript-javascript",
            packageId,
            root: packageRoot(packageId),
            adapterId: "ast-typescript",
            files: group.files.sort(),
            manifests: group.manifests.sort(),
            status: "prepared",
          });
          inputs.set(unit, { snapshot, context });
          return unit;
        });
    },
    parseProject,
    /** Structural declaration discovery: independent of the AST detector above. */
    declarations(project) {
      const records: DeclarationRecord[] = structuralEntrypoints(project.files).map((entry) => ({
        declarationId: declarationId("entrypoint", entry.path, entry.kind),
        kind: "entrypoint",
        owner: project.packageId,
        required: true,
        critical: true,
        sourcePath: entry.path,
        detail: `project-preparation structural entrypoint: ${entry.kind}`,
        capability: "project-preparation-structure",
        evidenceIds: [],
      }));
      for (const manifest of project.manifests) {
        records.push({
          declarationId: declarationId("package", manifest, "project-manifest"),
          kind: "package",
          owner: project.packageId,
          required: false,
          critical: false,
          sourcePath: manifest,
          detail: "project-preparation structural manifest",
          capability: "project-preparation-structure",
          evidenceIds: [],
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
