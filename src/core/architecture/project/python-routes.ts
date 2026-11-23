import { posix } from "node:path";
import type { ProjectPreparation } from "./adapter.js";
import type { SourceSnapshot } from "./snapshot.js";
import { importBindingAt, parsePythonSource, type PythonParsedCall, type PythonParsedDecorator, type PythonParsedFile } from "./python-parser.js";
import { pythonParserStatus } from "./python-parser.js";
import {
  emptyRouteExtraction, handlerCallId, handlerId, parserEvidence, routeEdgeId, routeId,
  type RouteExtraction, type RouteHandler,
} from "./route-graph.js";
import { irOmissionSchema } from "../ir.js";
import { pythonCodeLines } from "./python-source.js";

const methods: Record<string, string> = { get: "GET", post: "POST", put: "PUT", delete: "DELETE", patch: "PATCH", head: "HEAD", options: "OPTIONS" };
const builtins = new Set(["print", "len", "str", "int", "float", "bool", "list", "dict", "set", "tuple", "min", "max", "sum", "range", "enumerate", "zip", "isinstance", "getattr", "setattr", "hasattr", "super", "next", "iter", "await"]);

function stringValue(argument?: { text: string; type: string }) {
  if (!argument) return undefined;
  let text = argument.text.trim();
  if (/^[A-Za-z_]\w*\s*=/.test(text)) text = text.slice(text.indexOf("=") + 1).trim();
  if (/^[rbRBRB]/.test(text)) text = text.slice(1).trim();
  if (/^[fF]/.test(text)) return undefined;
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return undefined;
}

function dynamicText(argument?: { text: string; type: string }) {
  if (!argument) return "dynamic";
  const text = /^[A-Za-z_]\w*\s*=/.test(argument.text) ? argument.text.slice(argument.text.indexOf("=") + 1).trim() : argument.text.trim();
  return text || "dynamic";
}

function joinPath(prefix: string, path: string) {
  const left = prefix === "/" || prefix === "" ? "" : prefix.replace(/\/$/, "");
  const right = path.startsWith("/") ? path : `/${path}`;
  return `${left}${right}` || "/";
}

function callName(call: PythonParsedCall) {
  return call.name.split(".").at(-1) ?? call.name;
}

function receiverName(call: PythonParsedCall) {
  return call.name.split(".")[0];
}

function decoratorName(call: PythonParsedDecorator) {
  return call.name.split(".").at(-1)?.toLowerCase() ?? "";
}

function routeMethods(decorator: PythonParsedDecorator) {
  const name = decoratorName(decorator);
  if (name === "route") {
    const raw = decorator.arguments[0]?.text ?? "";
    const methodsArgument = decorator.arguments.find((argument) => argument.text.startsWith("methods")) ?? (/\bmethods\s*=/.test(raw) ? { text: raw.slice(raw.indexOf("methods")), type: "raw" } : undefined);
    const values = methodsArgument ? [...methodsArgument.text.matchAll(/["'](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)["']/g)].map((match) => match[1]) : [];
    if (!methodsArgument) return ["GET"];
    const list = methodsArgument.text.match(/methods\s*=\s*[\[\(]([^\]\)]*)[\]\)]/)?.[1];
    const dynamicItems = list?.split(",").map((item) => item.trim()).filter((item) => item && !/^["'](?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)["']$/.test(item)) ?? [];
    if (dynamicItems.length > 0) return [...values, `dynamic:${dynamicItems.join("|")}`];
    return values.length > 0 ? values : [`dynamic:${dynamicText(methodsArgument)}`];
  }
  return methods[name] ? [methods[name]] : [];
}

function frameworkFor(receiver: string, kinds: Map<string, "fastapi" | "flask">) {
  return kinds.get(receiver);
}

function unresolvedHandler(path: string, name: string, line: number, packageId: string, evidenceId: string): RouteHandler {
  return { id: handlerId(path, name, line, "unresolved"), name, sourcePath: path, line, packageId, resolution: "unresolved", evidenceIds: [evidenceId] };
}

function localHandler(file: PythonParsedFile, decorator: PythonParsedDecorator, path: string, packageId: string): RouteHandler {
  const name = decorator.handler ?? "inline";
  const line = decorator.handlerLine ?? decorator.line;
  return {
    id: handlerId(path, name, line, "local"), name, sourcePath: path, line, packageId,
    resolution: "local", targetId: `python-module:${path}`,
    evidenceIds: [parserEvidence(path, line, "ast:python-handler:local").id],
  };
}

function importedCallTarget(file: PythonParsedFile, project: ProjectPreparation, call: PythonParsedCall, path: string, handler: RouteHandler, endLine: number) {
  const name = receiverName(call);
  const imported = file.imports.filter((item) => item.bindings[name] !== undefined && (item.moduleScope || (item.line >= handler.line && item.line <= endLine && item.line <= call.line))).sort((a, b) => a.line - b.line).at(-1);
  if (!imported) return undefined;
  const resolved = project.imports.find((item) => item.path === path && item.source === imported.source && item.line === imported.line);
  return resolved ? { path: resolved.resolvedPath, source: resolved.source, external: resolved.resolvedPath === undefined, resolution: resolved.resolution, unresolvedReason: resolved.unresolvedReason, id: resolved.resolvedPath ? `module:${resolved.targetPackageId ?? "package:root"}:${resolved.resolvedPath}` : undefined } : undefined;
}

function directCalls(file: PythonParsedFile, project: ProjectPreparation, handler: RouteHandler): RouteExtraction {
  const result = emptyRouteExtraction();
  const symbol = file.symbols.find((item) => item.name === handler.name && item.line === handler.line);
  const endLine = symbol?.endLine ?? handler.line;
  for (const call of file.calls) {
    if (call.line < handler.line || call.line > endLine || builtins.has(callName(call)) || call.name === handler.name) continue;
    const target = importedCallTarget(file, project, call, handler.sourcePath, handler, endLine);
    if (target?.resolution === "unresolved" && target.unresolvedReason !== "external-package-not-in-snapshot") continue;
    if (target) {
      const evidence = parserEvidence(handler.sourcePath, call.line, "ast:python-handler-call", "runtime-call");
      result.calls.push({
        id: handlerCallId(handler.id, target.path ?? target.source, call.name, call.line),
        from: handler.id,
        to: target.id ?? `external:${target.source}`,
        toKind: target.external ? "external" : "module",
        kind: "calls",
        source: call.name,
        evidenceIds: [evidence.id],
      });
      result.evidenceRecords.push(evidence);
    } else if (file.symbols.some((symbol) => symbol.name === callName(call))) {
      const evidence = parserEvidence(handler.sourcePath, call.line, "ast:python-handler-call", "runtime-call");
      result.calls.push({
        id: handlerCallId(handler.id, handler.sourcePath, call.name, call.line),
        from: handler.id,
        to: `module:${handler.packageId}:${handler.sourcePath}`,
        toKind: "module",
        kind: "calls",
        source: call.name,
        evidenceIds: [evidence.id],
      });
      result.evidenceRecords.push(evidence);
    }
  }
  return result;
}

function merge(into: RouteExtraction, other: RouteExtraction) {
  into.routes.push(...other.routes);
  into.handlers.push(...other.handlers);
  into.edges.push(...other.edges);
  into.calls.push(...other.calls);
  into.declarations.push(...other.declarations);
  into.omissions.push(...other.omissions);
  into.evidenceRecords.push(...other.evidenceRecords);
}

interface RouterRelation {
  parentFile: string;
  parentVariable: string;
  childFile: string;
  childVariable: string;
  prefix: string;
  line: number;
  replacesOwnPrefix: boolean;
}

interface RouterIndex {
  ownPrefixes: Map<string, string>;
  relations: RouterRelation[];
  constants: Map<string, string>;
  unresolved: { path: string; line: number; reference: string }[];
  unsupported: { path: string; line: number; call: string }[];
}

function buildRouterIndex(snapshot: SourceSnapshot, project: ProjectPreparation): RouterIndex {
  const ownPrefixes = new Map<string, string>();
  const relations: RouterRelation[] = [];
  const unresolved: { path: string; line: number; reference: string }[] = [];
  const unsupported: { path: string; line: number; call: string }[] = [];
  const constants = new Map<string, string>();
  const constantValue = (file: string, expression: string, parsed: PythonParsedFile, line: number) => {
    const key = expression.split(".").at(-1) ?? expression;
    if (!expression.includes(".")) return constants.get(`${file}:${key}`);
    const module = expression.split(".")[0];
    const localImport = importBindingAt(parsed, module, line);
    const candidates = project.imports.filter((item) => item.path === file && item.line === localImport?.line && item.source === localImport?.source && item.resolvedPath);
    if (candidates.length !== 1) return undefined;
    return constants.get(`${candidates[0].resolvedPath}:${key}`);
  };
  for (const file of snapshot.files) {
    if (file.language !== "python" || file.role !== "source") continue;
    const raw = pythonCodeLines(snapshot.rawText(file.path) ?? "").join("\n");
    for (const match of raw.matchAll(/([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=\s*["']([^"']+)["']/g)) constants.set(`${file.path}:${match[1]}`, match[2]);
  }
  for (const file of snapshot.files) {
    if (file.language !== "python" || file.role !== "source") continue;
    const raw = snapshot.rawText(file.path) ?? "";
    const parsed = parsePythonSource(raw);
    if (!parsed) continue;
    const knownRouterReceivers = new Set(parsed.calls.filter((call) => call.name === "FastAPI" || call.name === "APIRouter" || call.name === "Flask" || call.name === "Blueprint").map((call) => call.receiver ?? "app"));
    for (const call of parsed.calls) {
      if (call.name === "APIRouter") {
        const argument = call.arguments.find((item) => item.text.startsWith("prefix"));
        ownPrefixes.set(`${file.path}:${call.receiver ?? "router"}`, argument ? (stringValue(argument) ?? `dynamic:${dynamicText(argument)}`) : "");
      }
      // Flask blueprints carry their own url_prefix and are attached with
      // register_blueprint; the composition machinery mirrors APIRouter, except
      // that a register_blueprint url_prefix replaces the blueprint's own where
      // an include_router prefix is prepended to the router's own.
      if (call.name === "Blueprint") {
        const argument = call.arguments.find((item) => item.text.startsWith("url_prefix"));
        const prefixText = argument?.text.match(/url_prefix\s*=\s*(.+)/)?.[1];
        ownPrefixes.set(`${file.path}:${call.receiver ?? "bp"}`, argument ? (stringValue({ text: prefixText ?? "", type: "string" }) ?? constantValue(file.path, prefixText ?? "", parsed, call.line) ?? `dynamic:${dynamicText(argument)}`) : "");
      }
      if (call.name.endsWith("add_url_rule") && knownRouterReceivers.has(call.name.split(".")[0])) {
        // Endpoint indirection (add_url_rule maps a URL to an endpoint name
        // defined elsewhere) has no deterministic local target here; fail closed.
        unsupported.push({ path: file.path, line: call.line, call: call.name });
        continue;
      }
      if ((call.name.endsWith("include_router") || call.name.endsWith("register_blueprint")) && knownRouterReceivers.has(call.name.split(".")[0])) {
        const reference = call.arguments[0]?.text.trim() ?? "router";
        const prefixArgument = call.arguments.find((item) => item.text.startsWith("prefix")) ?? call.arguments.find((item) => item.text.startsWith("url_prefix"));
        const prefixText = prefixArgument?.text.match(/prefix\s*=\s*(.+)/)?.[1];
        const prefix = prefixArgument ? (stringValue({ text: prefixText ?? "", type: "string" }) ?? constantValue(file.path, prefixText ?? "", parsed, call.line) ?? `dynamic:${dynamicText(prefixArgument)}`) : "";
        let childFile = file.path;
        let childVariable = reference;
        const localImport = importBindingAt(parsed, reference, call.line);
        const importCandidates = project.imports.filter((item) => item.path === file.path && item.line === localImport?.line && item.source === localImport?.source && item.resolvedPath);
        const importedName = localImport?.bindings[reference];
        const exactImport = importCandidates.find((item) => item.resolvedPath?.endsWith(`/${importedName}.py`) || item.resolvedPath?.endsWith(`/${importedName}/__init__.py`));
        const unqualifiedImport = exactImport ?? (importCandidates.length === 1 ? importCandidates[0] : undefined);
        if (unqualifiedImport) {
          childFile = unqualifiedImport.resolvedPath ?? file.path;
          childVariable = localImport?.bindings[reference] ?? reference;
        }
        if (localImport && !unqualifiedImport && !reference.includes(".")) unresolved.push({ path: file.path, line: call.line, reference });
        if (!localImport && !reference.includes(".") && !ownPrefixes.has(`${file.path}:${reference}`)) unresolved.push({ path: file.path, line: call.line, reference });
        if (reference.includes(".")) {
          const [module, variable] = reference.split(".");
          childVariable = variable;
          const localModuleImport = importBindingAt(parsed, module, call.line);
          const candidates = project.imports.filter((item) => item.path === file.path && item.resolvedPath && (item.source === localModuleImport?.source || item.source === module || item.source.endsWith(`.${module}`)));
          const exact = candidates.find((item) => item.resolvedPath?.endsWith(`/${module}.py`) || item.resolvedPath?.endsWith(`/${module}/__init__.py`));
          const target = exact?.resolvedPath ?? (candidates.length === 1 ? candidates[0].resolvedPath : undefined);
          if (target) childFile = target;
          else unresolved.push({ path: file.path, line: call.line, reference });
        }
        relations.push({ parentFile: file.path, parentVariable: call.name.split(".")[0], childFile, childVariable, prefix, line: call.line, replacesOwnPrefix: call.name.endsWith("register_blueprint") && prefixArgument !== undefined });
      }
    }
  }
  for (const relation of relations) {
    if (!ownPrefixes.has(`${relation.childFile}:${relation.childVariable}`)) unresolved.push({ path: relation.parentFile, line: relation.line, reference: `${relation.childFile}:${relation.childVariable}` });
  }
  const uniqueUnresolved = [...new Map(unresolved.map((item) => [`${item.path}:${item.line}:${item.reference}`, item])).values()];
  const uniqueUnsupported = [...new Map(unsupported.map((item) => [`${item.path}:${item.line}`, item])).values()];
  return { ownPrefixes, relations, constants, unresolved: uniqueUnresolved, unsupported: uniqueUnsupported };
}

function prefixFor(index: RouterIndex, file: string, variable: string, seen = new Set<string>()): string {
  const key = `${file}:${variable}`;
  if (seen.has(key)) return `dynamic:cycle`;
  seen.add(key);
  const own = index.ownPrefixes.get(key) ?? "";
  const relations = index.relations.filter((relation) => relation.childFile === file && relation.childVariable === variable).sort((a, b) => `${a.parentFile}:${a.parentVariable}`.localeCompare(`${b.parentFile}:${b.parentVariable}`));
  if (relations.length === 0) return own;
  if (relations.length > 1) return `dynamic:ambiguous`;
  const relation = relations[0];
  const parent = relation.parentVariable ? prefixFor(index, relation.parentFile, relation.parentVariable, seen) : "";
  return joinPath(parent, joinPath(relation.prefix, relation.replacesOwnPrefix ? "" : own));
}

function analyzeFile(snapshot: SourceSnapshot, project: ProjectPreparation, file: PythonParsedFile, path: string, routers: RouterIndex): RouteExtraction {
  const result = emptyRouteExtraction();
  const packageId = snapshot.files.find((entry) => entry.path === path)?.packageId ?? "package:root";
  const kinds = new Map<string, "fastapi" | "flask">();
  for (const call of file.calls) {
    if (call.name === "FastAPI" || call.name === "APIRouter") kinds.set(call.receiver ?? "app", "fastapi");
    if (call.name === "Flask" || call.name === "Blueprint") kinds.set(call.receiver ?? "app", "flask");
  }
  for (const decorator of file.decorators) {
    const receiver = decorator.name.split(".")[0];
    const framework = frameworkFor(receiver, kinds);
    if (!framework) continue;
    for (const method of routeMethods(decorator)) {
      const argument = decorator.arguments[0];
      const routePath = stringValue(argument) ?? `dynamic:${dynamicText(argument)}`;
      const fullPath = joinPath(prefixFor(routers, path, receiver), routePath);
      const line = decorator.line;
      const routeEvidence = parserEvidence(path, line, `ast:python-route:${framework}`);
      const route = { id: routeId(framework, method, fullPath, path, line), framework, method, path: fullPath, sourcePath: path, line, packageId, evidenceIds: [routeEvidence.id] };
      const handler = decorator.handler ? localHandler(file, decorator, path, packageId) : unresolvedHandler(path, decorator.name, line, packageId, routeEvidence.id);
      result.routes.push(route);
      result.handlers.push(handler);
      result.edges.push({ id: routeEdgeId(route.id, handler.id), from: route.id, to: handler.id, kind: "routes-to", evidenceIds: [...new Set([...route.evidenceIds, ...handler.evidenceIds])].sort() });
      result.declarations.push({ id: route.id, path, line });
      if (method.startsWith("dynamic:") || fullPath.includes("dynamic:")) {
        result.omissions.push(irOmissionSchema.parse({
          id: `omission:python-route-path:${route.id}`,
          owner: route.id,
          reason: "unsupported-syntax",
          detail: `Dynamic or unresolved Python route method/path/prefix at ${path}:${line}`,
          declarationIds: [route.id],
          evidenceIds: route.evidenceIds,
          affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"],
          blocking: true,
        }));
      }
      result.evidenceRecords.push(routeEvidence);
      if (handler.resolution !== "unresolved") {
        result.evidenceRecords.push(parserEvidence(handler.sourcePath, handler.line, "ast:python-handler:local"));
        merge(result, directCalls(file, project, handler));
      } else {
        result.omissions.push(irOmissionSchema.parse({
          id: `omission:python-handler:${handler.id}`,
          owner: route.id,
          reason: "unresolved-handler",
          detail: `Cannot resolve Python handler ${handler.name} at ${path}:${line}`,
          declarationIds: [route.id],
          evidenceIds: route.evidenceIds,
          affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"],
          blocking: true,
        }));
      }
    }
  }
  return result;
}

function independentDeclarations(snapshot: SourceSnapshot, routers: RouterIndex) {
  const result = emptyRouteExtraction();
  for (const file of snapshot.files) {
    if (file.language !== "python" || file.role !== "source" || !file.path.endsWith(".py")) continue;
    const raw = snapshot.rawText(file.path);
    if (!raw) continue;
    const lines = pythonCodeLines(raw);
    const frameworks = new Map<string, "fastapi" | "flask">();
    for (const line of lines) {
      const constructor = line.match(/([A-Za-z_]\w*)\s*=\s*(FastAPI|Flask|APIRouter|Blueprint)\s*\(/);
      if (constructor) frameworks.set(constructor[1], constructor[2] === "Flask" || constructor[2] === "Blueprint" ? "flask" : "fastapi");
    }
    lines.forEach((line, index) => {
      const match = line.match(/^@([A-Za-z_]\w*)\.(get|post|put|delete|patch|route)\s*\((.*)$/);
      if (!match) return;
      const receiver = match[1];
      const framework = frameworks.get(receiver);
      if (!framework) return;
      // Cut the decorator's own argument list by paren balance; a fixed line
      // window would swallow methods= from the NEXT decorator in files with
      // several Flask routes and fabricate phantom declarations.
      const statementLines: string[] = [];
      let depth = 0;
      for (const candidate of lines.slice(index, index + 20)) {
        statementLines.push(candidate);
        for (const character of candidate) {
          if (character === "(") depth += 1;
          if (character === ")") depth -= 1;
        }
        if (depth <= 0 && statementLines.length > 0) break;
      }
      const statement = statementLines.join("\n");
      const argsText = statement.slice(statement.indexOf("(") + 1);
      const path = argsText.match(/["']([^"']+)["']/)?.[1] ?? `dynamic:${argsText.split(",")[0].replace(/\)\s*$/, "")}`;
      const fullPath = joinPath(prefixFor(routers, file.path, receiver), path);
      const decorator: PythonParsedDecorator = { name: `${receiver}.${match[2]}`, arguments: [{ text: argsText, type: "raw" }], line: index + 1 };
      for (const method of routeMethods(decorator)) {
        const id = routeId(framework, method, fullPath, file.path, index + 1);
        result.declarations.push({ id, path: file.path, line: index + 1 });
      }
    });
  }
  return result.declarations;
}


// ---------------------------------------------------------------------------
// Django urls.py: declarative path()/re_path() routes with include() composition.
// The whole analysis is raw-scan (no AST parser needed), so the declarations
// survive parser-unavailable mode like the flask independent denominator.
// ---------------------------------------------------------------------------

function djangoBinding(raw: string) {
  const pathNames = new Set<string>();
  const includeNames = new Set<string>();
  for (const line of pythonCodeLines(raw)) {
    const from = line.match(/^\s*from\s+django\.(?:urls|conf\.urls)\s+import\s+(.+)/);
    if (!from) continue;
    for (const part of from[1].split(",")) {
      const [original, alias] = part.trim().split(/\s+as\s+/);
      const name = alias ?? original;
      if (original === "path" || original === "re_path" || original === "url") pathNames.add(name);
      if (original === "include") includeNames.add(name);
    }
  }
  return { pathNames, includeNames };
}

function splitTopLevelArguments(text: string) {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      current += character;
      if (character === quote && text[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === "(" || character === "[" || character === "{") { depth += 1; current += character; continue; }
    if (character === ")" || character === "]" || character === "}") { depth -= 1; current += character; continue; }
    if (character === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function resolveDjangoModuleFile(snapshot: SourceSnapshot, path: string, module: string) {
  const relativeBase = posix.dirname(path) === "." ? "" : `${posix.dirname(path)}/`;
  const candidates = [
    `${relativeBase}${module.split(".").join("/")}.py`,
    `${relativeBase}${module.split(".").join("/")}/__init__.py`,
    `${module.split(".").join("/")}.py`,
    `${module.split(".").join("/")}/__init__.py`,
  ];
  for (const candidate of candidates) {
    const file = snapshot.files.find((entry) => entry.path === candidate);
    if (file) return file.path;
  }
  return undefined;
}

/** Django allows including the same urls module under several prefixes; every
 *  include instance instantiates the child routes, so this returns one prefix
 *  per include chain (deduplicated) instead of a single value. */
function composeDjangoPrefixes(relations: { parentFile: string; prefix: string; childFile: string }[], file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return ["dynamic:cycle"];
  seen.add(file);
  const parents = relations.filter((relation) => relation.childFile === file);
  if (parents.length === 0) return [""];
  const prefixes = new Set<string>();
  for (const parent of parents) {
    for (const parentPrefix of composeDjangoPrefixes(relations, parent.parentFile, new Set([...seen, file]))) {
      prefixes.add(joinPath(parentPrefix, parent.prefix));
    }
  }
  return [...prefixes];
}

function analyzeDjangoUrls(snapshot: SourceSnapshot, project: ProjectPreparation): { extraction: RouteExtraction; declarations: { id: string; path: string; line: number }[] } {
  const extraction = emptyRouteExtraction();
  const declarations: { id: string; path: string; line: number }[] = [];
  const djangoOmission = (id: string, path: string, line: number, reason: "unsupported-syntax" | "unresolved-import", detail: string) => {
    extraction.omissions.push(irOmissionSchema.parse({
      id, owner: `python-django:${path}:${line}`, reason, detail,
      declarationIds: [], evidenceIds: [],
      affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
  };
  // Parser-independent def/class index for view resolution.
  const defIndex = new Map<string, { path: string; line: number }[]>();
  const classIndex = new Map<string, { path: string; line: number }[]>();
  const boundFiles: { path: string; binding: ReturnType<typeof djangoBinding>; lines: string[] }[] = [];
  for (const file of snapshot.files) {
    if (file.language !== "python" || file.role !== "source" || !file.path.endsWith(".py")) continue;
    const raw = snapshot.rawText(file.path);
    if (!raw) continue;
    const lines = pythonCodeLines(raw);
    lines.forEach((line, index) => {
      const def = line.match(/^\s*def\s+([A-Za-z_]\w*)\s*\(/);
      if (def) defIndex.set(def[1], [...(defIndex.get(def[1]) ?? []), { path: file.path, line: index + 1 }]);
      const cls = line.match(/^\s*class\s+([A-Za-z_]\w*)\b/);
      if (cls) classIndex.set(cls[1], [...(classIndex.get(cls[1]) ?? []), { path: file.path, line: index + 1 }]);
    });
    const binding = djangoBinding(raw);
    if (binding.pathNames.size === 0 && binding.includeNames.size === 0) continue;
    boundFiles.push({ path: file.path, binding, lines });
  }
  const djangoHandler = (sourcePath: string, name: string, line: number, packageId: string, resolution: RouteHandler["resolution"]): RouteHandler => {
    return { id: handlerId(sourcePath, name, line, resolution), name, sourcePath, line, packageId, resolution, evidenceIds: [parserEvidence(sourcePath, line, "ast:python-handler:django").id] };
  };
  /** Resolve a receiver/identifier through the file's from-imports, e.g.
   *  accounts_views → hc.accounts.views. Returns the defining module path. */
  const importBindingFor = (file: string, name: string): { module: string; original: string } | undefined => {
    const raw = snapshot.rawText(file) ?? "";
    for (const line of pythonCodeLines(raw)) {
      const from = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/);
      if (!from) continue;
      for (const part of from[2].split(",")) {
        const [original, alias] = part.trim().split(/\s+as\s+/);
        if ((alias ?? original) === name) return { module: from[1], original };
      }
    }
    return undefined;
  };
  const importedModuleFor = (file: string, name: string): string | undefined => {
    const raw = snapshot.rawText(file) ?? "";
    for (const line of pythonCodeLines(raw)) {
      const from = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/);
      if (!from) continue;
      for (const part of from[2].split(",")) {
        const [original, alias] = part.trim().split(/\s+as\s+/);
        if ((alias ?? original) === name) {
          return `${from[1].split(".").filter(Boolean).join(".")}.${original}`;
        }
      }
    }
    return undefined;
  };
  const resolveView = (file: string, viewText: string, packageId: string): RouteHandler | "unsupported" => {
    const asView = viewText.match(/^([A-Za-z_]\w*)\.as_view\s*\(/);
    const dotted = viewText.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*$/);
    const identifier = /^[A-Za-z_]\w*$/.test(viewText) ? viewText : undefined;
    const moduleCandidates = (file: string, module: string) => {
      const candidates = [module];
      const imported = importedModuleFor(file, module);
      if (imported) candidates.unshift(imported);
      return candidates.map((candidate) => resolveDjangoModuleFile(snapshot, file, candidate)).filter((entry): entry is string => Boolean(entry));
    };
    if (identifier) {
      const candidates = defIndex.get(identifier) ?? [];
      const own = candidates.find((entry) => entry.path === file);
      if (own) return djangoHandler(file, identifier, own.line, packageId, "local");
      if (candidates.length === 1) {
        const entry = candidates[0];
        return djangoHandler(entry.path, identifier, entry.line, packageId, "re-export");
      }
      // Aliased imports (`from app.views import year_archive as ya`): the
      // identifier resolves through the import binding, not the def name.
      const identifierBinding = importBindingFor(file, identifier);
      if (identifierBinding) {
        const bindingFile = resolveDjangoModuleFile(snapshot, file, identifierBinding.module);
        const bindingCandidates = (defIndex.get(identifierBinding.original) ?? []).filter((entry) => entry.path === bindingFile);
        if (bindingCandidates.length === 1) {
          const entry = bindingCandidates[0];
          return djangoHandler(entry.path, identifierBinding.original, entry.line, packageId, "re-export");
        }
      }
      return "unsupported";
    }
    if (asView) {
      const candidates = classIndex.get(asView[1]) ?? [];
      const own = candidates.find((entry) => entry.path === file);
      if (own) return djangoHandler(file, asView[1], own.line, packageId, "local");
      if (candidates.length === 1) {
        const entry = candidates[0];
        return djangoHandler(entry.path, asView[1], entry.line, packageId, "re-export");
      }
      const asViewBinding = importBindingFor(file, asView[1]);
      if (asViewBinding) {
        const bindingFile = resolveDjangoModuleFile(snapshot, file, asViewBinding.module);
        const bindingCandidates = (classIndex.get(asViewBinding.original) ?? []).filter((entry) => entry.path === bindingFile);
        if (bindingCandidates.length === 1) {
          const entry = bindingCandidates[0];
          return djangoHandler(entry.path, asViewBinding.original, entry.line, packageId, "re-export");
        }
      }
      return "unsupported";
    }
    if (dotted) {
      const binding = importBindingFor(file, dotted[1]);
      const boundModule = binding ? `${binding.module}.${binding.original}` : undefined;
      const moduleFiles = [resolveDjangoModuleFile(snapshot, file, dotted[1]), boundModule ? resolveDjangoModuleFile(snapshot, file, boundModule) : undefined, resolveDjangoModuleFile(snapshot, file, importedModuleFor(file, dotted[1]) ?? dotted[1])];
      for (const moduleFile of [...new Set(moduleFiles)]) {
        if (!moduleFile) continue;
        const candidates = (defIndex.get(dotted[2]) ?? []).filter((entry) => entry.path === moduleFile);
        if (candidates.length === 1) {
          const entry = candidates[0];
          return djangoHandler(moduleFile, dotted[2], entry.line, packageId, "re-export");
        }
      }
      return "unsupported";
    }
    return "unsupported";
  };
  // First pass: route entries and include relations per bound file.
  const relations: { parentFile: string; prefix: string; childModule: string; childFile?: string; line: number }[] = [];
  const routes = new Map<string, Map<number, { method: string; path: string; viewText: string; packageId: string }>>();
  for (const { path, binding, lines } of boundFiles) {
    const packageId = snapshot.files.find((entry) => entry.path === path)?.packageId ?? "package:root";
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const callMatch of line.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
        const callName = callMatch[1];
        const isPath = binding.pathNames.has(callName);
        const isInclude = binding.includeNames.has(callName);
        if (!isPath && !isInclude) continue;
        let depth = 0;
        let argumentBody = "";
        let started = false;
        let endLine = index;
        for (let cursor = index; cursor < lines.length && (!started || depth > 0); cursor += 1) {
          const candidate = lines[cursor];
          for (let position = cursor === index ? (callMatch.index ?? 0) : 0; position < candidate.length; position += 1) {
            const character = candidate[position];
            if (!started) {
              if (character === "(") { started = true; depth = 1; }
              continue;
            }
            if (character === "(") depth += 1;
            if (character === ")") {
              depth -= 1;
              if (depth === 0) { endLine = cursor; break; }
            }
            argumentBody += character;
          }
          if (started && depth === 0) break;
        }
        const startIndex = index + 1;
        const arguments_ = splitTopLevelArguments(argumentBody);
        if (isInclude) {
          // include() calls are handled through their enclosing path() view
          // argument; a bare top-level include is not a Django pattern.
        } else if (arguments_.length < 2) {
          djangoOmission(`omission:python-django-path:${path}:${startIndex}`, path, startIndex, "unsupported-syntax", `Django ${callName} call needs a route and a view at ${path}:${startIndex}`);
        } else {
          const routePath = stringValue({ text: arguments_[0], type: "string" }) ?? `dynamic:${arguments_[0]}`;
          if (!routes.has(path)) routes.set(path, new Map());
          routes.get(path)!.set(startIndex, { method: "PAGE", path: routePath, viewText: arguments_[1], packageId });
        }
        index = endLine;
      }
    }
  }
  // Second pass: resolve include child modules, then emit composed routes.
  const resolvedRelations: { parentFile: string; prefix: string; childFile: string; line: number }[] = [];
  for (const relation of relations) {
    const childFile = resolveDjangoModuleFile(snapshot, relation.parentFile, relation.childModule);
    if (!childFile) {
      djangoOmission(`omission:python-django-include:${relation.parentFile}:${relation.line}`, relation.parentFile, relation.line, "unresolved-import", `Cannot resolve Django urls module ${relation.childModule} included at ${relation.parentFile}:${relation.line}`);
      continue;
    }
    resolvedRelations.push({ parentFile: relation.parentFile, prefix: relation.prefix, childFile, line: relation.line });
  }
  // Include composition must resolve before prefixes compose.
  for (const [file, entries] of routes) {
    for (const [line, entry] of entries) {
      const includeCall = entry.viewText.match(/^include\s*\(\s*([^)]+)\s*\)\s*$/);
      if (!includeCall) continue;
      const includeArgument = includeCall[1].trim();
      let includeModule = includeArgument.match(/^["']([^"']+)["']$/)?.[1];
      if (!includeModule) {
        // include(<module object variable>): resolve the variable through the
        // file's from-imports, e.g. from hc.api import uuid_urls.
        if (/^[A-Za-z_]\w*$/.test(includeArgument)) {
          for (const line of pythonCodeLines(snapshot.rawText(file) ?? "")) {
            const from = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/);
            if (!from) continue;
            for (const part of from[2].split(",")) {
              const [original, alias] = part.trim().split(/\s+as\s+/);
              if ((alias ?? original) === includeArgument) {
                includeModule = from[1].split(".").filter(Boolean).concat(original).join(".");
              }
            }
          }
        }
      }
      if (!includeModule) continue;
      const childFile = resolveDjangoModuleFile(snapshot, file, includeModule);
      if (!childFile) {
        djangoOmission(`omission:python-django-include:${file}:${line}`, file, line, "unresolved-import", `Cannot resolve Django urls module ${includeModule[1]} included at ${file}:${line}`);
        continue;
      }
      resolvedRelations.push({ parentFile: file, prefix: entry.path, childFile, line });
      entries.delete(line);
    }
  }
  for (const [file, entries] of routes) {
    const prefixes = composeDjangoPrefixes(resolvedRelations, file);
    const packageId = snapshot.files.find((entry) => entry.path === file)?.packageId ?? "package:root";
    for (const [line, entry] of entries) {
      const handler = resolveView(file, entry.viewText, packageId);
      if (handler === "unsupported") {
        djangoOmission(`omission:python-django-view:${file}:${line}`, file, line, "unsupported-syntax", `Django view indirection ${entry.viewText} at ${file}:${line} has no statically identifiable handler`);
        continue;
      }
      for (const prefix of prefixes) {
        const fullPath = joinPath(prefix, entry.path);
        const routeEvidence = parserEvidence(file, line, "ast:python-route:django");
        const route = { id: routeId("django", entry.method, fullPath, file, line), framework: "django" as const, method: entry.method, path: fullPath, sourcePath: file, line, packageId: entry.packageId, evidenceIds: [routeEvidence.id] };
        extraction.routes.push(route);
        declarations.push({ id: route.id, path: file, line });
        extraction.handlers.push(handler);
        for (const evidenceId of handler.evidenceIds) {
          if (!extraction.evidenceRecords.some((item) => item.id === evidenceId)) extraction.evidenceRecords.push(parserEvidence(handler.sourcePath, handler.line, "ast:python-handler:django"));
        }
        extraction.edges.push({ id: routeEdgeId(route.id, handler.id), from: route.id, to: handler.id, kind: "routes-to", evidenceIds: [...new Set([...route.evidenceIds, ...handler.evidenceIds])].sort() });
        extraction.evidenceRecords.push(routeEvidence);
        if (fullPath.includes("dynamic:")) {
          djangoOmission(`omission:python-django-route-path:${route.id}`, file, line, "unsupported-syntax", `Dynamic Django route path or prefix at ${file}:${line}`);
        }
      }
    }
  }
  return { extraction, declarations };
}

export function analyzePythonRoutes(input: { snapshot: SourceSnapshot; project: ProjectPreparation; enabled?: boolean }): RouteExtraction {
  const result = emptyRouteExtraction();
  const routers = buildRouterIndex(input.snapshot, input.project);
  const django = analyzeDjangoUrls(input.snapshot, input.project);
  merge(result, django.extraction);
  result.declarations = [...independentDeclarations(input.snapshot, routers), ...django.declarations];
  for (const unresolved of routers.unresolved) {
    const evidence = parserEvidence(unresolved.path, unresolved.line, "ast:python-router:unresolved");
    result.evidenceRecords.push(evidence);
    result.omissions.push(irOmissionSchema.parse({
      id: `omission:python-router:${unresolved.path}:${unresolved.line}`,
      owner: `python-router:${unresolved.path}:${unresolved.line}`,
      reason: "unresolved-import",
      detail: `Cannot resolve included Python router ${unresolved.reference}`,
      declarationIds: result.declarations.filter((declaration) => declaration.path === unresolved.path).map((declaration) => declaration.id),
      evidenceIds: [evidence.id],
      affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
  }
  for (const unsupported of routers.unsupported) {
    const evidence = parserEvidence(unsupported.path, unsupported.line, "ast:python-router:unsupported");
    result.evidenceRecords.push(evidence);
    result.omissions.push(irOmissionSchema.parse({
      id: `omission:python-router:${unsupported.path}:${unsupported.line}`,
      owner: `python-router:${unsupported.path}:${unsupported.line}`,
      reason: "unsupported-syntax",
      detail: `Unsupported Python ${unsupported.call} endpoint indirection at ${unsupported.path}:${unsupported.line}`,
      declarationIds: result.declarations.filter((declaration) => declaration.path === unsupported.path).map((declaration) => declaration.id),
      evidenceIds: [evidence.id],
      affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
  }
  if (input.enabled === false || pythonParserStatus().status === "unavailable") {
    result.omissions.push(irOmissionSchema.parse({
      id: "omission:python-routes:parser-unavailable",
      owner: "python-route-extractor",
      reason: "parser-unavailable",
      detail: "Python route extraction was not run because the parser is unavailable",
      declarationIds: result.declarations.map((declaration) => declaration.id),
      evidenceIds: [],
      affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
    return result;
  }
  for (const file of input.snapshot.files) {
    if (file.language !== "python" || file.role !== "source" || !file.path.endsWith(".py")) continue;
    const raw = input.snapshot.rawText(file.path);
    if (raw === undefined) continue;
    const parsed = parsePythonSource(raw);
    if (!parsed) continue;
    merge(result, analyzeFile(input.snapshot, input.project, parsed, file.path, routers));
  }
  return result;
}
