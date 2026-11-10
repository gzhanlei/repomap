import { posix } from "node:path";
import type { BuildContext } from "./adapter.js";
import { analyzeGoSnapshot, type GoSnapshotAnalysis, type GoSourceFile } from "./go.js";
import type { GoParsedCall, GoParsedSymbol } from "./go-parser.js";
import type { SourceSnapshot } from "./snapshot.js";
import {
  emptyRouteExtraction, handlerCallId, handlerId, parserEvidence, routeEdgeId, routeId,
  type RouteExtraction, type RouteHandler,
} from "./route-graph.js";
import { irOmissionSchema, type IrOmission } from "../ir.js";

const httpMethods: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE", Patch: "PATCH", Head: "HEAD", Options: "OPTIONS",
  GET: "GET", POST: "POST", PUT: "PUT", DELETE: "DELETE", PATCH: "PATCH", HEAD: "HEAD", OPTIONS: "OPTIONS",
};
const builtins = new Set(["make", "new", "len", "cap", "append", "copy", "delete", "panic", "recover", "print", "println", "close", "complex", "real", "imag", "min", "max", "clear"]);

function callName(call: GoParsedCall) {
  return call.name.split(".").at(-1) ?? call.name;
}

function pathText(raw: string) {
  const value = raw.trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("`") && value.endsWith("`"))) return value.slice(1, -1);
  return value;
}

function pathArgument(call: GoParsedCall) {
  const argument = call.arguments[0];
  if (!argument) return undefined;
  if (["interpreted_string_literal", "raw_string_literal"].includes(argument.type)) {
    const value = pathText(argument.text);
    return value.startsWith("/") ? value : undefined;
  }
  const name = callName(call);
  // Dynamic router paths are preserved as expressions. Lowercase client-style
  // Get/Post calls are not treated as inbound routes without a literal path.
  if (["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "Handle", "HandleFunc", "Path"].includes(name)) return pathText(argument.text) || undefined;
  return undefined;
}

function firstArgument(line: string, start: number) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "`" || character === "'") { quote = character; continue; }
    if (character === "(") { depth += 1; continue; }
    if (character === ")") {
      if (depth === 0) return line.slice(start, index);
      depth -= 1;
      continue;
    }
    if (character === "," && depth === 0) return line.slice(start, index);
  }
  return line.slice(start);
}

function independentDeclarations(snapshot: SourceSnapshot) {
  const extraction = emptyRouteExtraction();
  for (const file of snapshot.files) {
    if (file.language !== "go" || file.role !== "source") continue;
    const raw = snapshot.rawText(file.path);
    if (!raw) continue;
    const importedAliases = new Set([...raw.matchAll(/(?:^|\n)\s*(?:([A-Za-z_]\w*)\s+)?"([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)"/g)].map((match) => match[1] ?? match[2].split("/").at(-1)));
    raw.split("\n").forEach((line, index) => {
      const match = /\b(HandleFunc|Handle|Path|GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Get|Post|Put|Delete|Patch)\s*\(\s*/.exec(line);
      if (!match || (match[1] === "Path" && !line.includes(".Handler"))) return;
      if (match[1] === "Path") {
        const receiver = line.match(/([A-Za-z_]\w*)\.Path\s*\(/)?.[1];
        if (receiver && importedAliases.has(receiver)) return;
      }
      const pathValue = pathText(firstArgument(line, (match.index ?? 0) + match[0].length));
      if (!pathValue.startsWith("/") && !["HandleFunc", "Handle", "Path", "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(match[1])) return;
      const methodArguments = line.match(/\.Methods\s*\(([^)]*)\)/);
      const declaredMethods = methodArguments
        ? [...methodArguments[1].matchAll(/["`]([A-Z]+)["`]/g)].map((method) => method[1])
        : [];
      const methods = declaredMethods.length > 0 ? declaredMethods : [httpMethods[match[1]] ?? "ANY"];
      for (const method of methods) {
        const id = routeId("go-http", method, pathValue, file.path, index + 1);
        extraction.declarations.push({ id, path: file.path, line: index + 1 });
      }
    });
  }
  return extraction.declarations;
}

function symbolIn(files: GoSourceFile[], name: string): { file: GoSourceFile; symbol: GoParsedSymbol } | undefined {
  for (const file of files) {
    const symbol = file.parsed.symbols.find((item) => item.name === name && ["function", "method"].includes(item.kind));
    if (symbol) return { file, symbol };
  }
  return undefined;
}

function symbolValueIn(files: GoSourceFile[], name: string, beforeLine = Number.POSITIVE_INFINITY): { file: GoSourceFile; symbol: GoParsedSymbol } | undefined {
  const matches = files.flatMap((file) => file.parsed.symbols
    .filter((symbol) => symbol.name === name && ["var", "const"].includes(symbol.kind) && symbol.line <= beforeLine)
    .map((symbol) => ({ file, symbol })));
  return matches.sort((a, b) => (a.file.path === b.file.path ? b.symbol.line - a.symbol.line : a.file.path.localeCompare(b.file.path)))[0];
}

function importForCall(file: GoSourceFile, alias: string) {
  return file.parsed.imports.find((item) => (item.alias ?? item.source.split("/").at(-1)) === alias);
}

function unresolvedHandler(file: GoSourceFile, name: string, call: GoParsedCall): RouteHandler {
  return {
    id: handlerId(file.path, name, call.line, "unresolved"),
    name,
    sourcePath: file.path,
    line: call.line,
    packageId: file.packageId,
    resolution: "unresolved",
    evidenceIds: [],
  };
}

function directHandler(analysis: GoSnapshotAnalysis, file: GoSourceFile, call: GoParsedCall, text: string): RouteHandler | undefined {
  if (/^[A-Za-z_]\w*$/.test(text)) {
    const local = symbolIn(analysis.packageDirs.get(file.dir) ?? [], text);
    if (local) {
      return {
        id: handlerId(local.file.path, text, local.symbol.line, "local"), name: text,
        sourcePath: local.file.path, line: local.symbol.line, packageId: local.file.packageId,
        resolution: "local", targetId: `go-package:${local.file.dir}:${local.file.packageName}`,
        evidenceIds: [parserEvidence(local.file.path, local.symbol.line, "ast:go-handler:resolved").id],
      };
    }
    const value = symbolValueIn(analysis.packageDirs.get(file.dir) ?? [], text, call.line);
    if (value) {
      return {
        id: handlerId(value.file.path, text, value.symbol.line, "inline"), name: text,
        sourcePath: value.file.path, line: value.symbol.line, packageId: value.file.packageId,
        resolution: "inline", targetId: `go-package:${value.file.dir}:${value.file.packageName}`,
        evidenceIds: [parserEvidence(value.file.path, value.symbol.line, "ast:go-handler:resolved").id],
      };
    }
    return undefined;
  }
  const selector = text.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
  if (!selector) return undefined;
  const imported = importForCall(file, selector[1]);
  if (!imported) {
    const receiver = symbolValueIn(analysis.packageDirs.get(file.dir) ?? [], selector[1], call.line);
    if (receiver) {
      return {
        id: handlerId(receiver.file.path, text, receiver.symbol.line, "inline"), name: text,
        sourcePath: receiver.file.path, line: receiver.symbol.line, packageId: receiver.file.packageId,
        resolution: "inline", targetId: `go-package:${receiver.file.dir}:${receiver.file.packageName}`,
        evidenceIds: [parserEvidence(receiver.file.path, receiver.symbol.line, "ast:go-handler:resolved").id],
      };
    }
    const method = symbolIn(analysis.packageDirs.get(file.dir) ?? [], selector[2]);
    if (method) {
      return {
        id: handlerId(method.file.path, selector[2], method.symbol.line, "local"), name: selector[2],
        sourcePath: method.file.path, line: method.symbol.line, packageId: method.file.packageId,
        resolution: "local", targetId: `go-package:${method.file.dir}:${method.file.packageName}`,
        evidenceIds: [parserEvidence(method.file.path, method.symbol.line, "ast:go-handler:resolved").id],
      };
    }
    return undefined;
  }
  const resolved = analysis.resolve(imported.source, file.dir);
  if (resolved.kind === "internal" && resolved.dir) {
    const target = symbolIn(analysis.packageDirs.get(resolved.dir) ?? [], selector[2]) ?? symbolValueIn(analysis.packageDirs.get(resolved.dir) ?? [], selector[2]);
    if (!target) return undefined;
    return {
      id: handlerId(target.file.path, selector[2], target.symbol.line, "package"), name: selector[2],
      sourcePath: target.file.path, line: target.symbol.line, packageId: target.file.packageId,
      resolution: "package", targetId: `go-package:${target.file.dir}:${target.file.packageName}`,
      evidenceIds: [parserEvidence(target.file.path, target.symbol.line, "ast:go-handler:resolved").id],
    };
  }
  return {
    id: handlerId(file.path, text, call.line, "external"), name: text,
    sourcePath: file.path, line: call.line, packageId: file.packageId,
    resolution: "external", targetId: imported.source,
    evidenceIds: [parserEvidence(file.path, call.line, "ast:go-handler:resolved").id],
  };
}

function expressionHandler(analysis: GoSnapshotAnalysis, file: GoSourceFile, routeCall: GoParsedCall, expression: string, depth = 0): RouteHandler | undefined {
  const text = expression.replaceAll(" ", "");
  if (!text || depth > 8) return undefined;
  if (text.startsWith("func(")) {
    return {
      id: handlerId(file.path, `inline:${routeCall.line}`, routeCall.line, "inline"), name: `inline:${routeCall.line}`,
      sourcePath: file.path, line: routeCall.line, packageId: file.packageId, resolution: "inline", evidenceIds: [],
    };
  }
  const direct = directHandler(analysis, file, routeCall, text);
  if (direct) return direct;
  const nested = file.parsed.calls
    .filter((call) => call.line === routeCall.line && text.includes(`${call.name}(`))
    .sort((a, b) => b.name.length - a.name.length);
  for (const call of nested) {
    // A package function whose name ends in an HTTP method is a handler
    // factory, not a middleware wrapper. Resolve the factory symbol itself.
    if (/(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(call.name)) {
      const factory = directHandler(analysis, file, routeCall, call.name);
      if (factory) return factory;
    }
    for (const argument of call.arguments) {
      const resolved = expressionHandler(analysis, file, routeCall, argument.text, depth + 1);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function resolveHandler(analysis: GoSnapshotAnalysis, file: GoSourceFile, call: GoParsedCall): RouteHandler {
  const text = call.arguments[1]?.text ?? "";
  return expressionHandler(analysis, file, call, text) ?? unresolvedHandler(file, text.replaceAll(" ", "") || "(missing)", call);
}

function directCalls(analysis: GoSnapshotAnalysis, handler: RouteHandler): RouteExtraction {
  const result = emptyRouteExtraction();
  if (!["local", "package", "inline"].includes(handler.resolution)) return result;
  const file = analysis.files.find((item) => item.path === handler.sourcePath);
  if (!file) return result;
  const symbol = handler.resolution === "inline" ? undefined : file.parsed.symbols.find((item) => item.name === handler.name && item.line === handler.line);
  const endLine = symbol?.endLine ?? handler.line;
  for (const call of file.parsed.calls) {
    if (call.line < handler.line || call.line > endLine) continue;
    const simple = callName(call);
    if (builtins.has(simple) || simple === handler.name) continue;
    const evidence = parserEvidence(file.path, call.line, "ast:go-handler-call", "runtime-call");
    const selector = call.name.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
    if (selector) {
      const imported = importForCall(file, selector[1]);
      if (!imported) continue;
      const resolved = analysis.resolve(imported.source, file.dir);
      if (resolved.kind === "internal" && resolved.dir) {
        const targetFiles = analysis.packageDirs.get(resolved.dir) ?? [];
        const target = `go-package:${resolved.dir}:${targetFiles[0]?.packageName ?? selector[1]}`;
        result.calls.push({ id: handlerCallId(handler.id, target, call.name, call.line), from: handler.id, to: target, toKind: "package", kind: "calls", source: call.name, evidenceIds: [evidence.id] });
        result.evidenceRecords.push(evidence);
      } else if (resolved.kind === "external") {
        const target = `external-module:${imported.source}`;
        result.calls.push({ id: handlerCallId(handler.id, target, call.name, call.line), from: handler.id, to: target, toKind: "external", kind: "calls", source: call.name, evidenceIds: [evidence.id] });
        result.evidenceRecords.push(evidence);
      }
      continue;
    }
    if (/^[A-Za-z_]\w*$/.test(call.name) && symbolIn(analysis.packageDirs.get(file.dir) ?? [], call.name)) {
      const target = `go-package:${file.dir}:${file.packageName}`;
      result.calls.push({ id: handlerCallId(handler.id, target, call.name, call.line), from: handler.id, to: target, toKind: "package", kind: "calls", source: call.name, evidenceIds: [evidence.id] });
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

export function analyzeGoRoutes(input: { snapshot: SourceSnapshot; context: BuildContext; enabled?: boolean }): RouteExtraction {
  const result = emptyRouteExtraction();
  result.declarations = independentDeclarations(input.snapshot);
  if (input.enabled === false) {
    result.omissions.push(irOmissionSchema.parse({
      id: "omission:go-routes:adapter-unavailable",
      owner: "go-http-route-extractor",
      reason: "parser-unavailable",
      detail: "Go LanguageAdapter is unavailable; semantic route and handler extraction was not run",
      declarationIds: result.declarations.map((declaration) => declaration.id),
      evidenceIds: [],
      affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
    return result;
  }
  const analysis = analyzeGoSnapshot(input.snapshot, input.context);
  if (analysis.parser.status === "unavailable") {
    result.omissions.push(irOmissionSchema.parse({
      id: "omission:go-routes:parser-unavailable",
      owner: "go-http-route-extractor",
      reason: "parser-unavailable",
      detail: analysis.parser.detail,
      declarationIds: result.declarations.map((declaration) => declaration.id),
      evidenceIds: [],
      affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
    return result;
  }
  for (const file of analysis.files) {
    const methods = new Map<number, string[]>();
    for (const call of file.parsed.calls.filter((item) => callName(item) === "Methods")) {
      const declared = call.arguments.map((argument) => argument.text.replace(/["`]/g, "")).filter(Boolean);
      if (declared.length > 0) methods.set(call.line, declared);
    }
    for (const call of file.parsed.calls) {
      const name = callName(call);
      const routePath = pathArgument(call);
      if (!routePath || (!httpMethods[name] && name !== "Handle" && name !== "HandleFunc" && name !== "Path")) continue;
      if (name === "Path" && importForCall(file, call.name.split(".")[0])) continue;
      const chainedHandler = name === "Path" ? file.parsed.calls.find((candidate) => candidate.line === call.line && callName(candidate) === "Handler") : undefined;
      if (name === "Path" && !chainedHandler) continue;
      for (const method of methods.get(call.line) ?? [httpMethods[name] ?? "ANY"]) {
        const id = routeId("go-http", method, routePath, file.path, call.line);
        const evidence = parserEvidence(file.path, call.line, `ast:go-route:${name}`);
        const route = { id, framework: "go-http" as const, method, path: routePath, sourcePath: file.path, line: call.line, packageId: file.packageId, evidenceIds: [evidence.id] };
        const handlerInput = chainedHandler ? { ...call, arguments: [call.arguments[0], chainedHandler.arguments[0]] } : call;
        const handler = resolveHandler(analysis, file, handlerInput);
        if (handler.evidenceIds.length === 0) handler.evidenceIds = [evidence.id];
        const edge = { id: routeEdgeId(id, handler.id), from: id, to: handler.id, kind: "routes-to" as const, evidenceIds: [...new Set([...route.evidenceIds, ...handler.evidenceIds])].sort() };
        result.routes.push(route);
        result.handlers.push(handler);
        result.edges.push(edge);
        result.evidenceRecords.push(evidence, ...handler.evidenceIds.map((id) => parserEvidence(handler.sourcePath, handler.line, "ast:go-handler:resolved")));
        if (handler.resolution === "unresolved") {
          const omission: IrOmission = {
            id: `omission:go-handler:${handler.id}`, owner: id, reason: "unresolved-handler",
            detail: `Cannot resolve Go handler ${handler.name} at ${file.path}:${call.line}`,
            declarationIds: [id], evidenceIds: route.evidenceIds,
            affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"], blocking: true,
          };
          result.omissions.push(irOmissionSchema.parse(omission));
        }
        merge(result, directCalls(analysis, handler));
      }
    }
  }
  return result;
}
