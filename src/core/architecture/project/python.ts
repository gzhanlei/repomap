import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { DeclarationRecord } from "../ir.js";
import {
  adapterCapabilitySchema, emptyParseResult, packageRoot, projectUnitSchema,
  type AdapterCapability, type BuildContext, type ImportRef, type ImportResolution,
  type EntrypointCandidate, type LanguageAdapter, type ParseProjectResult,
  type ProjectUnit, type SymbolRecord,
} from "./adapter.js";
import type { SourceSnapshot } from "./snapshot.js";
import { pythonCodeLines } from "./python-source.js";
import {
  PYTHON_PARSER_VERSION, pythonParserStatus, parsePythonSource,
  type PythonParsedImport, type PythonParsedFile,
} from "./python-parser.js";

interface PythonResolution {
  resolvedPath?: string;
  targetPackageId?: string;
  resolution: ImportResolution;
  barrel?: boolean;
  unresolvedReason?: string;
}

interface PythonSnapshotIndex {
  paths: Set<string>;
  packageOf: Map<string, string>;
  byModule: Map<string, string[]>;
  localRoots: Set<string>;
  parsedFiles: Map<string, PythonParsedFile>;
  symbols: Map<string, Set<string>>;
  allExports: Map<string, Set<string>>;
  allExportsDynamic: Set<string>;
}

const indexes = new WeakMap<SourceSnapshot, PythonSnapshotIndex>();

function declarationId(kind: string, path: string, detail: string) {
  return `decl:project:${createHash("sha256").update(`${kind}|${path}|${detail}`).digest("hex").slice(0, 16)}`;
}

function importable(parts: string[]) {
  return parts.length > 0 && parts.every((part) => /^[A-Za-z_]\w*$/.test(part));
}

function moduleNames(path: string, packageId: string) {
  const withoutExtension = path.slice(0, -3);
  const parts = withoutExtension.split("/");
  if (parts.at(-1) === "__init__") parts.pop();
  const candidates: string[][] = [];
  const add = (value: string[]) => { if (importable(value)) candidates.push(value); };
  add(parts);
  const src = parts.indexOf("src");
  if (src >= 0) add(parts.slice(src + 1));
  const root = packageRoot(packageId);
  if (root !== "." && path.startsWith(`${root}/`)) {
    const relative = path.slice(root.length + 1, -3).split("/");
    if (relative.at(-1) === "__init__") relative.pop();
    add(relative);
  }
  return [...new Set(candidates.map((parts) => parts.join(".")))];
}

function buildIndex(snapshot: SourceSnapshot): PythonSnapshotIndex {
  const cached = indexes.get(snapshot);
  if (cached) return cached;
  const paths = new Set(snapshot.files.filter((file) => file.language === "python" && file.role === "source" && file.path.endsWith(".py")).map((file) => file.path));
  const packageOf = new Map(snapshot.files.map((file) => [file.path, file.packageId]));
  const byModule = new Map<string, string[]>();
  const localRoots = new Set<string>();
  const parsedFiles = new Map<string, PythonParsedFile>();
  const symbols = new Map<string, Set<string>>();
  const allExports = new Map<string, Set<string>>();
  const allExportsDynamic = new Set<string>();
  for (const path of [...paths].sort()) {
    const raw = snapshot.rawText(path);
    if (raw === undefined) continue;
    const file = parsePythonSource(raw);
    if (!file) continue;
    parsedFiles.set(path, file);
    symbols.set(path, new Set(file.symbols.map((symbol) => symbol.name)));
    if (file.allExports) allExports.set(path, file.allExports);
    if (file.allExportsDynamic) allExportsDynamic.add(path);
    for (const name of moduleNames(path, packageOf.get(path) ?? "package:root")) {
      byModule.set(name, [...(byModule.get(name) ?? []), path]);
      localRoots.add(name.split(".")[0]);
    }
  }
  const index = { paths, packageOf, byModule, localRoots, parsedFiles, symbols, allExports, allExportsDynamic };
  indexes.set(snapshot, index);
  return index;
}

function moduleFile(index: PythonSnapshotIndex, base: string) {
  const normalized = posix.normalize(base).replace(/^\.\//, "");
  if (index.paths.has(`${normalized}.py`)) return `${normalized}.py`;
  const init = `${normalized}/__init__.py`.replace(/^\.\//, "");
  if (index.paths.has(init)) return init;
  return undefined;
}

function resolved(index: PythonSnapshotIndex, path: string, resolution: ImportResolution): PythonResolution {
  return { resolvedPath: path, targetPackageId: index.packageOf.get(path), resolution, barrel: path.endsWith("__init__.py") };
}

function candidateFor(index: PythonSnapshotIndex, name: string, fromPath: string, resolution: ImportResolution): PythonResolution | undefined {
  const candidates = index.byModule.get(name) ?? [];
  if (candidates.length === 0) return undefined;
  const packageId = index.packageOf.get(fromPath);
  const samePackage = candidates.filter((path) => index.packageOf.get(path) === packageId);
  const allowed = samePackage.length > 0 ? samePackage : candidates;
  if (allowed.length > 1) return { resolution: "unresolved", unresolvedReason: `ambiguous Python module '${name}' across workspaces: ${allowed.join(", ")}` };
  return resolved(index, allowed[0], resolution);
}

function hasSymbol(index: PythonSnapshotIndex, path: string, name: string, visited = new Set<string>(), respectAll = false): boolean {
  const declared = index.allExports.get(path);
  if (respectAll && index.allExportsDynamic.has(path)) return false;
  if (respectAll && declared && !declared.has(name)) return false;
  if (respectAll && name.startsWith("_") && !declared) return false;
  if (index.symbols.get(path)?.has(name)) return true;
  if (visited.has(path)) return false;
  visited.add(path);
  for (const item of index.parsedFiles.get(path)?.imports ?? []) {
    if (!item.moduleScope) continue;
    if (item.wildcard) {
      for (const target of resolveImport(index, item, path, new Set(visited))) {
        if (target.resolvedPath && target.resolution !== "external" && hasSymbol(index, target.resolvedPath, name, new Set(visited), true)) return true;
      }
      continue;
    }
    const original = item.bindings[name];
    if (original === undefined) continue;
    for (const target of resolveImport(index, item, path, new Set(visited))) {
      if (target.resolution === "external") return true;
      if (!target.resolvedPath) continue;
      if (item.source === original || index.byModule.has(original)) return true;
      const directSubmodule = target.resolvedPath.endsWith(`/${original}.py`) || target.resolvedPath.endsWith(`/${original}/__init__.py`);
      if (directSubmodule || hasSymbol(index, target.resolvedPath, original, visited)) return true;
    }
  }
  return false;
}

function importedTargets(index: PythonSnapshotIndex, item: PythonParsedImport, base: PythonResolution | undefined, fromPath: string, resolution: ImportResolution, submodule: (name: string) => PythonResolution | undefined, visited = new Set<string>()): PythonResolution[] {
  if (item.importedNames.length === 0) {
    if (base) return [base];
    if (item.wildcard && item.source.startsWith(".")) return [{ resolution: "unresolved", unresolvedReason: `relative wildcard import target is not present in the snapshot: ${item.source}` }];
    if (item.kind === "dynamic") {
      if (item.source.startsWith(".") || index.localRoots.has(item.source.split(".")[0])) return [{ resolution: "unresolved", unresolvedReason: `dynamic Python import target is not present in snapshot: ${item.source}` }];
      return [{ resolution: "external", unresolvedReason: "external-package-not-in-snapshot" }];
    }
    if (index.localRoots.has(item.source.split(".")[0])) return [{ resolution: "unresolved", unresolvedReason: `local Python package submodule is not present in snapshot: ${item.source}` }];
    return [{ resolution: "external", unresolvedReason: "external-package-not-in-snapshot" }];
  }
  const results: PythonResolution[] = [];
  for (const name of item.importedNames) {
    const target = submodule(name);
    if (target) {
      results.push(target);
    } else if (base && hasSymbol(index, base.resolvedPath!, name, new Set(visited))) {
      results.push(base);
    } else if (item.source.startsWith(".") || index.localRoots.has(item.source.split(".")[0])) {
      results.push({ resolution: "unresolved", unresolvedReason: `Python imported symbol or submodule '${name}' is not present in the snapshot` });
    } else if (base) {
      results.push(base);
    } else {
      results.push({ resolution: "external", unresolvedReason: "external-package-not-in-snapshot" });
    }
  }
  return [...new Map(results.map((result) => [`${result.resolvedPath ?? ""}|${result.resolution}|${result.unresolvedReason ?? ""}`, result])).values()];
}

function absoluteImport(index: PythonSnapshotIndex, item: PythonParsedImport, fromPath: string, visited = new Set<string>()): PythonResolution[] {
  const base = candidateFor(index, item.source, fromPath, "workspace-package");
  if (base?.resolution === "unresolved") return [base];
  return importedTargets(index, item, base, fromPath, "workspace-package", (name) => candidateFor(index, `${item.source}.${name}`, fromPath, "workspace-package"), visited);
}

function relativeImport(index: PythonSnapshotIndex, item: PythonParsedImport, fromPath: string, visited = new Set<string>()): PythonResolution[] {
  const level = item.source.match(/^\.+/)?.[0].length ?? 0;
  const rest = item.source.slice(level).replaceAll(".", "/");
  let base = posix.dirname(fromPath);
  for (let index = 1; index < level; index += 1) base = posix.dirname(base);
  const packageId = index.packageOf.get(fromPath) ?? "package:root";
  const root = packageRoot(packageId);
  const relativePath = root !== "." && fromPath.startsWith(`${root}/`) ? fromPath.slice(root.length + 1) : fromPath;
  const parts = relativePath.split("/");
  const srcIndex = parts.indexOf("src");
  const rooted = (value: string) => root === "." ? value : `${root}/${value}`;
  const top = parts.length === 1 ? root : srcIndex >= 0 && parts.length > srcIndex + 1 ? rooted(parts.slice(0, srcIndex + 2).join("/")) : rooted(parts[0]);
  const insideTop = top !== "." && (base === top || base.startsWith(`${top}/`));
  if ((top === "." && level > 1) || (top !== "." && !insideTop)) {
    return [{ resolution: "unresolved", unresolvedReason: `relative Python import escapes the top-level package: ${item.source}` }];
  }
  const prefix = rest ? `${base}/${rest}` : base;
  if (rest) {
    const module = moduleFile(index, prefix);
    return importedTargets(index, item, module ? resolved(index, module, "relative") : undefined, fromPath, "relative", (name) => moduleFile(index, `${prefix}/${name}`) ? resolved(index, moduleFile(index, `${prefix}/${name}`)!, "relative") : undefined, visited);
  }
  if (item.importedNames.length === 0) {
    const module = moduleFile(index, prefix);
    return module ? [resolved(index, module, "relative")] : [{ resolution: "unresolved", unresolvedReason: `relative Python package is not present in the snapshot: ${item.source}` }];
  }
  const module = moduleFile(index, prefix);
  return importedTargets(index, item, module ? resolved(index, module, "relative") : undefined, fromPath, "relative", (name) => moduleFile(index, `${prefix}/${name}`) ? resolved(index, moduleFile(index, `${prefix}/${name}`)!, "relative") : undefined, visited);
}

function resolveImport(index: PythonSnapshotIndex, item: PythonParsedImport, fromPath: string, visited = new Set<string>()): PythonResolution[] {
  if (item.kind === "dynamic" && (item.source === "importlib.import_module" || item.source === "__import__")) {
    return [{ resolution: "unresolved", unresolvedReason: "dynamic Python import target is not a string literal" }];
  }
  if (item.kind === "dynamic" && (item.source === "importlib.import_module" || item.source === "__import__")) {
    return [{ resolution: "unresolved", unresolvedReason: "dynamic Python import target is not a string literal" }];
  }
  if (item.kind === "dynamic" && item.level !== undefined && item.level !== 1) {
    return [{ resolution: "unresolved", unresolvedReason: `unsupported dynamic Python relative import level: ${item.level}` }];
  }
  if (item.kind === "dynamic" && item.source.startsWith(".")) {
    if (!item.package) return [{ resolution: "unresolved", unresolvedReason: "relative dynamic Python import requires a package argument" }];
    return absoluteImport(index, { ...item, source: `${item.package}${item.source}` }, fromPath, visited);
  }
  return item.source.startsWith(".") ? relativeImport(index, item, fromPath, visited) : absoluteImport(index, item, fromPath, visited);
}

function capabilities(): AdapterCapability[] {
  const status = pythonParserStatus();
  return [adapterCapabilitySchema.parse({ id: "ast-python", version: PYTHON_PARSER_VERSION, status: status.status, detail: status.detail })];
}

export function createPythonAdapter(): LanguageAdapter {
  const inputs = new WeakMap<ProjectUnit, { snapshot: SourceSnapshot; context: BuildContext }>();
  const parsed = new WeakMap<ProjectUnit, ParseProjectResult>();

  function parseProject(project: ProjectUnit): ParseProjectResult {
    const cached = parsed.get(project);
    if (cached) return cached;
    const input = inputs.get(project);
    if (!input) return emptyParseResult(project.id, ["Python project unit was not produced by prepareProject"]);
    if (pythonParserStatus().status === "unavailable") return emptyParseResult(project.id, [pythonParserStatus().detail]);
    const index = buildIndex(input.snapshot);
    const imports: ImportRef[] = [];
    const symbols: SymbolRecord[] = [];
    const entrypoints: EntrypointCandidate[] = [];
    const parseErrors: ParseProjectResult["parseErrors"] = [];
    for (const path of project.files) {
      const raw = input.snapshot.rawText(path);
      if (raw === undefined) continue;
      const file = index.parsedFiles.get(path) ?? parsePythonSource(raw);
      if (!file) continue;
      for (const diagnostic of file.diagnostics) parseErrors.push({ path, line: diagnostic.line, message: diagnostic.message });
      for (const item of file.imports) {
        for (const resolved of resolveImport(index, item, path)) imports.push({
          path,
          source: item.source,
          kind: item.kind,
          line: item.line,
          resolution: resolved.resolution,
          ...(resolved.resolvedPath ? { resolvedPath: resolved.resolvedPath, targetPackageId: resolved.targetPackageId } : {}),
          ...(resolved.unresolvedReason ? { unresolvedReason: resolved.unresolvedReason } : {}),
          ...(resolved.barrel === undefined ? {} : { barrel: resolved.barrel }),
        });
      }
      for (const symbol of file.symbols) symbols.push({ path, name: symbol.name, kind: symbol.kind, exported: symbol.exported, line: symbol.line });
      if (path.endsWith("__main__.py")) entrypoints.push({ path, kind: "python-main-module", line: 1 });
      if (file.mainGuardLine !== undefined) entrypoints.push({ path, kind: "python-main-guard", line: file.mainGuardLine });
      if (path.endsWith("wsgi.py")) entrypoints.push({ path, kind: "python-wsgi", line: 1 });
      if (path.endsWith("asgi.py")) entrypoints.push({ path, kind: "python-asgi", line: 1 });
    }
    const result: ParseProjectResult = {
      unitId: project.id,
      imports: imports.sort((a, b) => `${a.path}:${a.line}:${a.source}`.localeCompare(`${b.path}:${b.line}:${b.source}`)),
      symbols: symbols.sort((a, b) => `${a.path}:${a.line}:${a.name}`.localeCompare(`${b.path}:${b.line}:${b.name}`)),
      entrypoints: entrypoints.sort((a, b) => `${a.path}:${a.kind}`.localeCompare(`${b.path}:${b.kind}`)),
      parseErrors: parseErrors.sort((a, b) => `${a.path}:${a.line}:${a.message}`.localeCompare(`${b.path}:${b.line}:${b.message}`)),
      notes: [
        `${PYTHON_PARSER_VERSION} syntax tree over the immutable raw snapshot; no host Python, virtualenv, installed package or repository execution`,
        "Absolute imports outside the snapshot are external; unresolved relative and non-literal dynamic imports fail closed",
        "Framework routes, ORM sessions, decorators and runtime dispatch are NOT resolved in this slice",
      ],
    };
    parsed.set(project, result);
    return result;
  }

  return {
    id: "ast-python",
    version: PYTHON_PARSER_VERSION,
    languages: ["python"],
    prepareProject(snapshot, context) {
      const groups = new Map<string, { files: string[]; manifests: string[] }>();
      for (const file of snapshot.files) {
        const group = groups.get(file.packageId) ?? { files: [], manifests: [] };
        if (/(?:^|\/)(?:pyproject\.toml|requirements\.txt|setup\.py|setup\.cfg|Pipfile)$/.test(file.path)) group.manifests.push(file.path);
        if (file.language === "python" && file.role === "source" && file.path.endsWith(".py")) group.files.push(file.path);
        groups.set(file.packageId, group);
      }
      return [...groups.entries()]
        .filter(([, group]) => group.files.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([packageId, group]) => {
          const unit = projectUnitSchema.parse({
            id: `unit:${packageId}:python`,
            language: "python",
            packageId,
            root: packageRoot(packageId),
            adapterId: "ast-python",
            files: group.files.sort(),
            manifests: group.manifests.sort(),
            status: pythonParserStatus().status === "available" ? "prepared" : "parser-unavailable",
          });
          inputs.set(unit, { snapshot, context });
          return unit;
        });
    },
    parseProject,
    declarations(project) {
      const input = inputs.get(project);
      const snapshot = input?.snapshot;
      const records: DeclarationRecord[] = [];
      for (const path of project.files) {
        const raw = snapshot?.rawText(path) ?? "";
        if (path.endsWith("__init__.py")) records.push({
          declarationId: declarationId("package", path, "python-package"), kind: "package", owner: project.packageId,
          required: false, critical: false, sourcePath: path, detail: "independent Python package __init__.py discovery",
          capability: "python-structure-line-scan", evidenceIds: [],
        });
        if (path.endsWith("__main__.py")) records.push({
          declarationId: declarationId("entrypoint", path, "python-main-module"), kind: "entrypoint", owner: project.packageId,
          required: true, critical: true, sourcePath: path, detail: "independent Python __main__.py entrypoint",
          capability: "python-structure-line-scan", evidenceIds: [],
        });
        pythonCodeLines(raw).forEach((line, index) => {
          if (/^if\s+__name__\s*==\s*[\"']__main__[\"']\s*:/.test(line)) records.push({
            declarationId: declarationId("entrypoint", path, `python-main-guard:${index + 1}`), kind: "entrypoint", owner: project.packageId,
            required: true, critical: true, sourcePath: path, detail: `independent Python __main__ guard at line ${index + 1}`,
            capability: "python-structure-line-scan", evidenceIds: [],
          });
        });
      }
      for (const manifest of project.manifests) records.push({
        declarationId: declarationId("package", manifest, "python-manifest"), kind: "package", owner: project.packageId,
        required: false, critical: false, sourcePath: manifest, detail: "independent Python project manifest discovery",
        capability: "python-structure-line-scan", evidenceIds: [],
      });
      return records.sort((a, b) => a.declarationId.localeCompare(b.declarationId));
    },
    symbols(project) { return parseProject(project).symbols; },
    imports(project) { return parseProject(project).imports; },
    entrypoints(project) { return parseProject(project).entrypoints; },
    capabilities,
  };
}
