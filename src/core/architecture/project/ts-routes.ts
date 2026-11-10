import { posix } from "node:path";
import ts from "typescript";
import type { SourceSnapshot } from "./snapshot.js";
import { createTypeScriptProgramBundle, resolveTypeScriptImport, typeScriptFileName, type TypeScriptProgramBundle } from "./typescript.js";
import {
  emptyRouteExtraction, handlerCallId, handlerId, parserEvidence, routeEdgeId, routeId,
  type RouteExtraction, type RouteHandler,
} from "./route-graph.js";
import { irOmissionSchema } from "../ir.js";

const httpMethods = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
const globalCalls = new Set(["Response", "Request", "console", "JSON", "Promise", "URL", "URLSearchParams", "Object", "Array", "Math", "Date", "Error", "TextEncoder", "TextDecoder", "Buffer", "process", "fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval"]);

interface ImportBinding { source: string; importedName: string }

function lineAt(sourceFile: ts.SourceFile, node: ts.Node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function routePath(path: string) {
  const match = path.match(/(?:^|\/)app\/(.+)\/route\.tsx?$/);
  return match ? `/${match[1]}` : undefined;
}

function exportedMethods(raw: string) {
  const methods: { method: string; line: number }[] = [];
  raw.split("\n").forEach((line, index) => {
    if (!/^\s*export\b/.test(line)) return;
    const direct = line.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/);
    const braces = line.match(/\{([^}]+)\}/);
    if (braces) {
      for (const specifier of braces[1].split(",")) {
        const alias = specifier.trim().match(/\b(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+as\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/)?.[1];
        const plain = specifier.trim().match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/)?.[1];
        const method = alias ?? plain;
        if (method) methods.push({ method, line: index + 1 });
      }
      return;
    }
    if (direct) methods.push({ method: direct[1], line: index + 1 });
  });
  return methods;
}

function independentDeclarations(snapshot: SourceSnapshot) {
  const result = emptyRouteExtraction();
  const viteRoots = snapshot.files.filter((file) => /(?:^|\/)vite\.config\.(?:ts|js|mts|mjs)$/.test(file.path)).map((file) => posix.dirname(file.path));
  for (const file of snapshot.files) {
    const raw = snapshot.rawText(file.path);
    if (!raw) continue;
    const apiRoute = routePath(file.path);
    if (apiRoute) {
      for (const item of exportedMethods(raw)) {
        result.declarations.push({ id: routeId("next-app-router", item.method, apiRoute, file.path, item.line), path: file.path, line: item.line });
      }
    }
    const inVite = viteRoots.some((root) => root === "." ? file.path.startsWith("src/") : file.path.startsWith(`${root}/src/`));
    if (!inVite || !/\.tsx$/i.test(file.path)) continue;
    raw.split("\n").forEach((line, index) => {
      const match = line.match(/<Route\b[^>]*\bpath\s*=\s*["']([^"']+)["']|\bpath\s*:\s*["']([^"']+)["']/);
      const path = match?.[1] ?? match?.[2];
      if (path) result.declarations.push({ id: routeId("vite-react-router", "PAGE", path, file.path, index + 1), path: file.path, line: index + 1 });
    });
  }
  return result.declarations;
}

function importBindings(sourceFile: ts.SourceFile) {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.set(clause.name.text, { source: statement.moduleSpecifier.text, importedName: "default" });
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, { source: statement.moduleSpecifier.text, importedName: "*" });
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) bindings.set(element.name.text, { source: statement.moduleSpecifier.text, importedName: element.propertyName?.text ?? element.name.text });
    }
  }
  return bindings;
}

function symbolNode(sourceFile: ts.SourceFile, name: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    const namedDeclaration = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node);
    const defaultDeclaration = name === "default" && namedDeclaration && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (namedDeclaration && (node.name?.text === name || defaultDeclaration)) { found = node; return; }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) { found = node; return; }
    if (ts.isExportAssignment(node) && name === "default") { found = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function resolvedSymbol(bundle: TypeScriptProgramBundle, sourceFile: ts.SourceFile, binding: ImportBinding) {
  const resolved = resolveTypeScriptImport(bundle, binding.source, sourceFile.fileName);
  if (!resolved.resolvedPath) return undefined;
  const target = bundle.program.getSourceFile(typeScriptFileName(resolved.resolvedPath));
  if (!target) return undefined;
  const node = symbolNode(target, binding.importedName) ?? (binding.importedName === "default" ? symbolNode(target, "default") : undefined);
  return node ? { sourceFile: target, node, path: resolved.resolvedPath } : undefined;
}

function appendRoute(result: RouteExtraction, route: RouteExtraction["routes"][number], handler: RouteHandler, routeEvidence: ReturnType<typeof parserEvidence>) {
  result.routes.push(route);
  result.handlers.push(handler);
  result.edges.push({ id: routeEdgeId(route.id, handler.id), from: route.id, to: handler.id, kind: "routes-to", evidenceIds: [...new Set([...route.evidenceIds, ...handler.evidenceIds])].sort() });
  result.evidenceRecords.push(routeEvidence);
  if (handler.resolution !== "unresolved") result.evidenceRecords.push(parserEvidence(handler.sourcePath, handler.line, `ast:ts-handler:${handler.resolution}`));
  if (handler.resolution === "unresolved") {
    result.omissions.push(irOmissionSchema.parse({
      id: `omission:ts-handler:${handler.id}`,
      owner: route.id,
      reason: "unresolved-handler",
      detail: `Cannot resolve TypeScript handler ${handler.name} at ${handler.sourcePath}:${handler.line}`,
      declarationIds: [route.id],
      evidenceIds: route.evidenceIds,
      affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
  }
}

function unresolvedHandler(path: string, name: string, line: number, packageId: string, evidenceId: string): RouteHandler {
  return { id: handlerId(path, name, line, "unresolved"), name, sourcePath: path, line, packageId, resolution: "unresolved", evidenceIds: [evidenceId] };
}

function localHandler(sourceFile: ts.SourceFile, name: string, node: ts.Node, packageId: string, resolution: RouteHandler["resolution"] = "local"): RouteHandler {
  const line = lineAt(sourceFile, node);
  const evidence = parserEvidence(sourceFile.fileName.replace(/^\/__repomap_snapshot__\//, ""), line, `ast:ts-handler:${resolution}`);
  return { id: handlerId(sourceFile.fileName.replace(/^\/__repomap_snapshot__\//, ""), name, line, resolution), name, sourcePath: sourceFile.fileName.replace(/^\/__repomap_snapshot__\//, ""), line, packageId, resolution, evidenceIds: [evidence.id] };
}

function directCalls(bundle: TypeScriptProgramBundle, sourceFile: ts.SourceFile, body: ts.Node, handler: RouteHandler): RouteExtraction {
  const result = emptyRouteExtraction();
  const bindings = importBindings(sourceFile);
  const path = handler.sourcePath;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      let localName: string | undefined;
      if (ts.isIdentifier(node.expression)) localName = node.expression.text;
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) localName = node.expression.expression.text;
      const binding = localName ? bindings.get(localName) : undefined;
      if (binding) {
        const resolved = resolveTypeScriptImport(bundle, binding.source, sourceFile.fileName);
        const target = resolved.resolvedPath ?? `external-package:${binding.source}`;
        const evidence = parserEvidence(path, lineAt(sourceFile, node), "ast:ts-handler-call", "runtime-call");
        result.calls.push({
          id: handlerCallId(handler.id, target, node.expression.getText(sourceFile), lineAt(sourceFile, node)),
          from: handler.id,
          to: target,
          toKind: resolved.resolvedPath ? "module" : "external",
          kind: "calls",
          source: node.expression.getText(sourceFile),
          evidenceIds: [evidence.id],
        });
        result.evidenceRecords.push(evidence);
      } else if (localName && !globalCalls.has(localName) && symbolNode(sourceFile, localName)) {
        const evidence = parserEvidence(path, lineAt(sourceFile, node), "ast:ts-handler-call", "runtime-call");
        result.calls.push({
          id: handlerCallId(handler.id, path, localName, lineAt(sourceFile, node)),
          from: handler.id,
          to: path,
          toKind: "module",
          kind: "calls",
          source: localName,
          evidenceIds: [evidence.id],
        });
        result.evidenceRecords.push(evidence);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
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

function analyzeNextFile(bundle: TypeScriptProgramBundle, sourceFile: ts.SourceFile, path: string, apiPath: string): RouteExtraction {
  const result = emptyRouteExtraction();
  const packageId = bundle.packageOf.get(path) ?? "package:root";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && httpMethods.has(node.name.text)) {
      const method = node.name.text;
      const line = lineAt(sourceFile, node);
      const evidence = parserEvidence(path, line, "ast:ts-route:next");
      const route = { id: routeId("next-app-router", method, apiPath, path, line), framework: "next-app-router" as const, method, path: apiPath, sourcePath: path, line, packageId, evidenceIds: [evidence.id] };
      const handler = localHandler(sourceFile, method, node, packageId);
      appendRoute(result, route, handler, evidence);
      merge(result, directCalls(bundle, sourceFile, node, handler));
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !httpMethods.has(declaration.name.text)) continue;
        const method = declaration.name.text;
        const line = lineAt(sourceFile, declaration);
        const evidence = parserEvidence(path, line, "ast:ts-route:next");
        const route = { id: routeId("next-app-router", method, apiPath, path, line), framework: "next-app-router" as const, method, path: apiPath, sourcePath: path, line, packageId, evidenceIds: [evidence.id] };
        const handler = localHandler(sourceFile, method, declaration, packageId);
        appendRoute(result, route, handler, evidence);
        merge(result, directCalls(bundle, sourceFile, declaration, handler));
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const specifier of node.exportClause.elements) {
        const method = specifier.name.text.toUpperCase();
        if (!httpMethods.has(method)) continue;
        const importedName = specifier.propertyName?.text ?? specifier.name.text;
        const line = lineAt(sourceFile, specifier);
        const evidence = parserEvidence(path, line, "ast:ts-route:next-re-export");
        const route = { id: routeId("next-app-router", method, apiPath, path, line), framework: "next-app-router" as const, method, path: apiPath, sourcePath: path, line, packageId, evidenceIds: [evidence.id] };
        const resolved = resolvedSymbol(bundle, sourceFile, { source: node.moduleSpecifier.text, importedName });
        if (!resolved) {
          appendRoute(result, route, unresolvedHandler(path, importedName, line, packageId, evidence.id), evidence);
          continue;
        }
        const handler = localHandler(resolved.sourceFile, importedName, resolved.node, bundle.packageOf.get(resolved.path) ?? packageId, "re-export");
        appendRoute(result, route, handler, evidence);
        merge(result, directCalls(bundle, resolved.sourceFile, resolved.node, handler));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function componentName(node: ts.Node): string | undefined {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  if (ts.isJsxExpression(node)) {
    const expression = node.expression;
    if (expression && (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression))) return componentName(expression);
    if (expression && ts.isIdentifier(expression)) return expression.text;
  }
  return undefined;
}

function analyzeViteFile(bundle: TypeScriptProgramBundle, sourceFile: ts.SourceFile, path: string): RouteExtraction {
  const result = emptyRouteExtraction();
  const packageId = bundle.packageOf.get(path) ?? "package:root";
  const bindings = importBindings(sourceFile);
  const add = (pathValue: string, component: string, node: ts.Node) => {
    const line = lineAt(sourceFile, node);
    const evidence = parserEvidence(path, line, "ast:ts-route:vite-react-router");
    const route = { id: routeId("vite-react-router", "PAGE", pathValue, path, line), framework: "vite-react-router" as const, method: "PAGE", path: pathValue, sourcePath: path, line, packageId, evidenceIds: [evidence.id] };
    const binding = bindings.get(component);
    const resolved = binding ? resolvedSymbol(bundle, sourceFile, binding) : undefined;
    if (resolved) {
      const handler = localHandler(resolved.sourceFile, component, resolved.node, bundle.packageOf.get(resolved.path) ?? packageId, "re-export");
      appendRoute(result, route, handler, evidence);
      return;
    }
    const local = symbolNode(sourceFile, component);
    if (local) {
      appendRoute(result, route, localHandler(sourceFile, component, local, packageId), evidence);
      return;
    }
    appendRoute(result, route, unresolvedHandler(path, component, line, packageId, evidence.id), evidence);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "Route") {
      const pathAttribute = node.attributes.properties.find((attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText() === "path");
      const pathValue = pathAttribute?.initializer && ts.isStringLiteral(pathAttribute.initializer) ? pathAttribute.initializer.text : undefined;
      const element = node.attributes.properties.find((attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText() === "element");
      const component = element?.initializer ? componentName(element.initializer) : undefined;
      if (pathValue && component) add(pathValue, component, pathAttribute ?? node);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const pathProperty = node.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && property.name.getText() === "path");
      const elementProperty = node.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && property.name.getText() === "element");
      if (pathProperty && elementProperty && ts.isStringLiteral(pathProperty.initializer)) {
        const component = componentName(elementProperty.initializer);
        if (component) add(pathProperty.initializer.text, component, pathProperty);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

export function analyzeTypeScriptRoutes(snapshot: SourceSnapshot, enabled = true): RouteExtraction {
  const result = emptyRouteExtraction();
  result.declarations = independentDeclarations(snapshot);
  if (!enabled) {
    result.omissions.push(irOmissionSchema.parse({
      id: "omission:ts-routes:adapter-unavailable",
      owner: "typescript-route-extractor",
      reason: "parser-unavailable",
      detail: "TypeScript LanguageAdapter is unavailable; semantic route and handler extraction was not run",
      declarationIds: result.declarations.map((declaration) => declaration.id),
      evidenceIds: [],
      affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
    return result;
  }
  const bundle = createTypeScriptProgramBundle(snapshot);
  const viteRoots = snapshot.files.filter((file) => /(?:^|\/)vite\.config\.(?:ts|js|mts|mjs)$/.test(file.path)).map((file) => posix.dirname(file.path));
  for (const file of snapshot.files) {
    if (!/\.(?:ts|tsx|js|jsx)$/i.test(file.path)) continue;
    const sourceFile = bundle.program.getSourceFile(typeScriptFileName(file.path));
    if (!sourceFile) continue;
    const apiPath = routePath(file.path);
    if (apiPath) {
      const extracted = analyzeNextFile(bundle, sourceFile, file.path, apiPath);
      // analyzeNextFile uses repository paths for evidence; sourceFile itself is virtual.
      result.routes.push(...extracted.routes);
      result.handlers.push(...extracted.handlers);
      result.edges.push(...extracted.edges);
      result.calls.push(...extracted.calls);
      result.omissions.push(...extracted.omissions);
      result.evidenceRecords.push(...extracted.evidenceRecords);
    }
    if (viteRoots.some((root) => root === "." ? file.path.startsWith("src/") : file.path.startsWith(`${root}/src/`)) && /\.tsx$/i.test(file.path)) {
      const extracted = analyzeViteFile(bundle, sourceFile, file.path);
      result.routes.push(...extracted.routes);
      result.handlers.push(...extracted.handlers);
      result.edges.push(...extracted.edges);
      result.calls.push(...extracted.calls);
      result.omissions.push(...extracted.omissions);
      result.evidenceRecords.push(...extracted.evidenceRecords);
    }
  }
  return result;
}
