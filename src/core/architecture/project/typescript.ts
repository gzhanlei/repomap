import { createHash } from "node:crypto";
import ts from "typescript";
import type { DeclarationRecord } from "../ir.js";
import {
  adapterCapabilitySchema, emptyParseResult, packageRoot, projectUnitSchema,
  type AdapterCapability, type BuildContext,
  type EntrypointCandidate, type ImportRef, type LanguageAdapter, type ParseProjectResult,
  type ProjectUnit, type SymbolRecord,
} from "./adapter.js";
import type { SourceSnapshot } from "./snapshot.js";

/**
 * First real adapter: a project-level TypeScript Program over the immutable
 * raw snapshot. This slice extracts syntax diagnostics, import/export refs,
 * symbols and structural entrypoint candidates. Full module-graph resolution,
 * route→handler mapping and call summaries are later PRs; they are declared
 * unavailable rather than silently approximated by regex.
 */

const virtualRoot = "/__repomap_snapshot__/";
const tsExtension = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const tsLanguages = ["typescript", "javascript"] as const;

const entrypointRules: [RegExp, string][] = [
  [/(?:^|\/)app\/.*(?:page|route|layout)\.tsx?$/, "app-router-file"],
  [/(?:^|\/)pages\/.*\.tsx?$/, "pages-router-file"],
  [/(?:^|\/)src\/main\.(?:ts|tsx|js|jsx)$/, "bundler-entry"],
  [/(?:^|\/)main\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "module-main"],
  [/(?:^|\/)index\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "barrel-or-index"],
];

function virtualPath(fileName: string) {
  const normalized = fileName.replaceAll("\\", "/");
  if (normalized.startsWith(virtualRoot)) return normalized;
  return `${virtualRoot}${normalized.replace(/^\/+/, "")}`;
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

interface UnitInput { snapshot: SourceSnapshot; context: BuildContext }

export function createTypeScriptAdapter(): LanguageAdapter {
  const inputs = new WeakMap<ProjectUnit, UnitInput>();
  const parsed = new WeakMap<ProjectUnit, ParseProjectResult>();

  const capabilities = (): AdapterCapability[] => [
    adapterCapabilitySchema.parse({ id: "typescript-compiler", version: ts.version, status: "available", detail: "TypeScript Compiler API Program over the immutable raw snapshot" }),
    adapterCapabilitySchema.parse({ id: "ast-typescript", version: "1", status: "partial", detail: "syntax diagnostics, imports/re-exports, symbols and structural entrypoints; module graph, route handlers and call summaries are not implemented" }),
    adapterCapabilitySchema.parse({ id: "module-graph", version: "0", status: "unavailable", detail: "tsconfig paths, project references and graph resolution land in ts-module-graph" }),
    adapterCapabilitySchema.parse({ id: "route-graph", version: "0", status: "unavailable", detail: "route-to-handler resolution lands in route-and-call-graph" }),
  ];

  function parseProject(project: ProjectUnit): ParseProjectResult {
    const cached = parsed.get(project);
    if (cached) return cached;
    const input = inputs.get(project);
    if (!input) return emptyParseResult(project.id, ["project unit was not produced by prepareProject"]);

    const fileMap = new Map<string, string>();
    for (const path of project.files.filter((item) => tsExtension.test(item))) {
      const raw = input.snapshot.rawText(path);
      if (raw !== undefined) fileMap.set(virtualRoot + path, raw);
    }
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      // Bundler resolution matches how TS/JS projects import extensionless
      // relative files; it must not fall back to the host's node_modules.
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
      noResolve: false,
      types: [],
      jsx: ts.JsxEmit.Preserve,
    };
    const host = ts.createCompilerHost(options, true);
    host.getCurrentDirectory = () => virtualRoot;
    host.fileExists = (fileName) => fileMap.has(virtualPath(fileName));
    host.readFile = (fileName) => fileMap.get(virtualPath(fileName));
    host.directoryExists = () => true;
    host.realpath = (fileName) => fileName;
    host.getDirectories = () => [];
    host.getSourceFile = (fileName, languageVersion) => {
      const text = fileMap.get(virtualPath(fileName));
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true, scriptKind(fileName));
    };

    const program = ts.createProgram([...fileMap.keys()], options, host);
    const imports: ImportRef[] = [];
    const symbols: SymbolRecord[] = [];
    const notes: string[] = [];

    const resolveImport = (source: string, containingFile: string) => {
      const resolved = ts.resolveModuleName(source, containingFile, options, host).resolvedModule;
      if (!resolved) {
        return { unresolvedReason: /^\.{1,2}\//.test(source) ? "relative-import-not-resolved-in-snapshot" : "external-package-not-in-snapshot" };
      }
      const candidate = virtualPath(resolved.resolvedFileName);
      if (!fileMap.has(candidate)) return { unresolvedReason: "resolved-outside-snapshot" };
      return { resolvedPath: candidate.slice(virtualRoot.length) };
    };

    for (const [fileName] of fileMap) {
      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) continue;
      const path = fileName.slice(virtualRoot.length);
      const lineAt = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const source = node.moduleSpecifier.text;
          imports.push({ path, source, kind: "static", line: lineAt(node), ...resolveImport(source, fileName) });
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const source = node.moduleSpecifier.text;
          imports.push({ path, source, kind: "re-export", line: lineAt(node), ...resolveImport(source, fileName) });
        } else if (ts.isCallExpression(node)) {
          const argument = node.arguments[0];
          const literal = argument && ts.isStringLiteral(argument) ? argument.text : undefined;
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword && literal) {
            imports.push({ path, source: literal, kind: "dynamic", line: lineAt(node), ...resolveImport(literal, fileName) });
          } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && literal) {
            imports.push({ path, source: literal, kind: "require", line: lineAt(node), ...resolveImport(literal, fileName) });
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

    const diagnostics = program.getSyntacticDiagnostics();
    const parseErrors = diagnostics.slice(0, 100).map((diagnostic) => {
      const file = diagnostic.file;
      const line = file && diagnostic.start !== undefined ? file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 1;
      return {
        path: file ? virtualPath(file.fileName).slice(virtualRoot.length) : "(project)",
        line,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      };
    });
    if (diagnostics.length > parseErrors.length) notes.push(`parse errors truncated to ${parseErrors.length} of ${diagnostics.length}`);
    notes.push("Bare package specifiers are deliberately unresolved: the snapshot has no node_modules.");

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
