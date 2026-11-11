import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import { initializeTreeSitter } from "./tree-sitter-runtime.js";

/** Fixed offline Python grammar over immutable raw source, never repository execution. */
export const PYTHON_PARSER_ID = "tree-sitter-python";
export const PYTHON_GRAMMAR_VERSION = "0.25.0";
export const PYTHON_RUNTIME = "web-tree-sitter";
export const PYTHON_RUNTIME_VERSION = "0.27.2";
export const PYTHON_PARSER_VERSION = `${PYTHON_PARSER_ID}@${PYTHON_GRAMMAR_VERSION}/${PYTHON_RUNTIME}@${PYTHON_RUNTIME_VERSION}`;

const require = createRequire(import.meta.url);
let pythonParser: Parser | undefined;
let unavailableReason: string | undefined;

try {
  await initializeTreeSitter();
  const grammar = readFileSync(require.resolve("tree-sitter-python/tree-sitter-python.wasm"));
  const language = await Language.load(grammar);
  pythonParser = new Parser();
  pythonParser.setLanguage(language);
} catch (error) {
  unavailableReason = error instanceof Error ? error.message : String(error);
}

export function pythonParserStatus(): { status: "available" | "unavailable"; detail: string } {
  if (pythonParser) return { status: "available", detail: `${PYTHON_PARSER_VERSION} (offline WASM grammar over the immutable raw snapshot)` };
  return { status: "unavailable", detail: `Python WASM grammar could not be loaded: ${unavailableReason ?? "unknown reason"}` };
}

export interface PythonParsedImport {
  source: string;
  kind: "static" | "dynamic";
  importedNames: string[];
  bindings: Record<string, string>;
  moduleScope: boolean;
  wildcard: boolean;
  package?: string;
  level?: number;
  line: number;
}

export interface PythonParsedSymbol {
  name: string;
  kind: "function" | "class" | "var";
  exported: boolean;
  line: number;
  endLine?: number;
}

export interface PythonParsedCall {
  name: string;
  arguments: { text: string; type: string }[];
  receiver?: string;
  line: number;
}

export interface PythonParsedDecorator {
  name: string;
  arguments: { text: string; type: string }[];
  handler?: string;
  handlerLine?: number;
  line: number;
}

export interface PythonParseDiagnostic {
  line: number;
  message: string;
}

export interface PythonParsedFile {
  imports: PythonParsedImport[];
  symbols: PythonParsedSymbol[];
  calls: PythonParsedCall[];
  decorators: PythonParsedDecorator[];
  allExports?: Set<string>;
  allExportsDynamic?: boolean;
  mainGuardLine?: number;
  diagnostics: PythonParseDiagnostic[];
}

function firstNamed(node: SyntaxNode, ...types: string[]) {
  return node.namedChildren.find((child) => types.includes(child.type));
}

function diagnostics(root: SyntaxNode): PythonParseDiagnostic[] {
  const result: PythonParseDiagnostic[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    if (node.isMissing || node.type === "ERROR") {
      result.push({ line: node.startPosition.row + 1, message: node.isMissing ? `missing ${node.type}` : `unexpected syntax near ${JSON.stringify(node.text.slice(0, 40))}` });
    }
    for (const child of node.children) stack.push(child);
  }
  return [...new Map(result.map((item) => [`${item.line}:${item.message}`, item])).values()].sort((a, b) => a.line - b.line || a.message.localeCompare(b.message)).slice(0, 100);
}

function dynamicImport(node: SyntaxNode, moduleScope: boolean): PythonParsedImport | undefined {
  if (node.type !== "call") return undefined;
  const fn = node.childForFieldName("function")?.text;
  if (fn !== "importlib.import_module" && fn !== "__import__") return undefined;
  const args = node.childForFieldName("arguments");
  const first = args?.namedChildren[0];
  const interpolation = first?.namedChildren.some((child) => child.type === "interpolation" || child.type === "escape_sequence");
  const literal = first?.type === "string" && !interpolation ? firstNamed(first, "string_content")?.text : undefined;
  let packageName: string | undefined;
  let level: number | undefined;
  for (const argument of args?.namedChildren ?? []) {
    if (argument.type !== "keyword_argument") continue;
    const name = argument.childForFieldName("name")?.text;
    const value = argument.childForFieldName("value");
    if (name === "package" && value?.type === "string" && !value.namedChildren.some((child) => child.type === "interpolation" || child.type === "escape_sequence")) packageName = firstNamed(value, "string_content")?.text;
    if (name === "level") level = value?.type === "integer" ? Number(value.text) : -1;
  }
  return {
    source: literal ?? fn,
    kind: "dynamic",
    importedNames: [],
    bindings: {},
    moduleScope,
    wildcard: false,
    ...(packageName === undefined ? {} : { package: packageName }),
    ...(level === undefined ? {} : { level }),
    line: node.startPosition.row + 1,
  };
}

/** Parse only syntax; package resolution is deliberately handled by the snapshot adapter. */
export function parsePythonSource(raw: string): PythonParsedFile | undefined {
  if (!pythonParser) return undefined;
  const root = pythonParser.parse(raw)?.rootNode;
  if (!root) return { imports: [], symbols: [], calls: [], decorators: [], diagnostics: [{ line: 1, message: "Python grammar produced no syntax tree" }] };
  const imports: PythonParsedImport[] = [];
  const symbols: PythonParsedSymbol[] = [];
  const calls: PythonParsedCall[] = [];
  const decorators: PythonParsedDecorator[] = [];
  let allExports: Set<string> | undefined;
  let allExportsDynamic = false;
  let mainGuardLine: number | undefined;

  const collectImport = (statement: SyntaxNode, moduleScope: boolean) => {
    if (statement.type === "import_statement") {
      for (const child of statement.namedChildren) {
        if (child.type === "dotted_name") {
          const original = child.text.split(".")[0];
          imports.push({ source: child.text, kind: "static", importedNames: [], bindings: { [original]: original }, moduleScope, wildcard: false, line: child.startPosition.row + 1 });
        } else if (child.type === "aliased_import") {
          const name = child.childForFieldName("name") ?? firstNamed(child, "dotted_name");
          const alias = child.childForFieldName("alias")?.text;
          if (name) imports.push({ source: name.text, kind: "static", importedNames: [], bindings: { [alias ?? name.text]: name.text }, moduleScope, wildcard: false, line: child.startPosition.row + 1 });
        }
      }
    } else if (statement.type === "import_from_statement" || statement.type === "future_import_statement") {
      const moduleName = statement.type === "future_import_statement" ? { text: "__future__" } : statement.childForFieldName("module_name") ?? firstNamed(statement, "relative_import", "dotted_name");
      if (!moduleName) return;
      const realModule = "startPosition" in moduleName ? moduleName : undefined;
      const moduleIndex = realModule ? statement.namedChildren.findIndex((child) => child.startPosition.row === realModule.startPosition.row && child.startPosition.column === realModule.startPosition.column && child.endPosition.row === realModule.endPosition.row && child.endPosition.column === realModule.endPosition.column) : -1;
      const importedNames = statement.namedChildren.flatMap((child, index) => {
        if (index === moduleIndex) return [];
        if (child.type === "dotted_name") return [child.text];
        if (child.type === "aliased_import") {
          const name = child.childForFieldName("name") ?? firstNamed(child, "dotted_name");
          return name ? [name.text] : [];
        }
        return [];
      });
      const bindings = Object.fromEntries(statement.namedChildren.flatMap((child, index) => {
        if (index === moduleIndex) return [];
        if (child.type === "dotted_name") return [[child.text, child.text]];
        if (child.type === "aliased_import") {
          const original = child.childForFieldName("name")?.text;
          const alias = child.childForFieldName("alias")?.text;
          return original ? [[alias ?? original, original]] : [];
        }
        return [];
      }));
      imports.push({ source: moduleName.text, kind: "static", importedNames, bindings, moduleScope, wildcard: statement.namedChildren.some((child) => child.type === "wildcard_import"), line: statement.startPosition.row + 1 });
    }
  };

  const visit = (node: SyntaxNode, moduleScope: boolean) => {
    collectImport(node, moduleScope);
    if (node.type === "decorator") {
      const call = firstNamed(node, "call");
      const fn = call?.childForFieldName("function")?.text ?? firstNamed(node, "attribute", "identifier")?.text ?? node.text.replace(/^@/, "");
      if (fn) {
        const owner = node.parent?.type === "decorated_definition" ? firstNamed(node.parent, "function_definition") : undefined;
        const handler = owner?.childForFieldName("name")?.text;
        decorators.push({ name: fn, arguments: (call?.childForFieldName("arguments")?.namedChildren ?? []).map((argument) => ({ text: argument.text, type: argument.type })), ...(handler ? { handler, handlerLine: owner?.startPosition.row + 1 } : {}), line: node.startPosition.row + 1 });
      }
    }
    if (node.type === "call") {
      const fn = node.childForFieldName("function")?.text;
      if (fn) calls.push({ name: fn, arguments: (node.childForFieldName("arguments")?.namedChildren ?? []).map((argument) => ({ text: argument.text, type: argument.type })), ...(node.parent?.type === "assignment" ? { receiver: node.parent.childForFieldName("left")?.text } : {}), line: node.startPosition.row + 1 });
    }
    const dynamic = dynamicImport(node, moduleScope);
    if (dynamic) imports.push(dynamic);
    if ((node.type === "function_definition" || node.type === "class_definition") && moduleScope) {
      const name = node.childForFieldName("name")?.text;
      if (name) symbols.push({ name, kind: node.type === "function_definition" ? "function" : "class", exported: !name.startsWith("_"), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
    } else if (node.type === "assignment" && moduleScope) {
      const left = node.childForFieldName("left");
      if (left?.type === "identifier" && left.text === "__all__") {
        const right = node.childForFieldName("right");
        if (right?.type === "list" || right?.type === "tuple") {
          allExportsDynamic = false;
          allExports = new Set(right.namedChildren.map((child) => firstNamed(child, "string_content")?.text).filter((value): value is string => value !== undefined));
        } else {
          allExportsDynamic = true;
          allExports = undefined;
        }
      }
      if (left?.type === "identifier" && node.childForFieldName("right")) symbols.push({ name: left.text, kind: "var", exported: !left.text.startsWith("_"), line: node.startPosition.row + 1 });
    } else if (node.type === "augmented_assignment" && node.childForFieldName("left")?.text === "__all__") {
      allExportsDynamic = true;
      allExports = undefined;
    } else if (node.type === "call" && node.childForFieldName("function")?.type === "attribute" && node.childForFieldName("function")?.childForFieldName("object")?.text === "__all__") {
      allExportsDynamic = true;
      allExports = undefined;
    } else if (node.type === "if_statement" && moduleScope) {
      const condition = node.childForFieldName("condition")?.text.replaceAll("'", '"').replaceAll(" ", "");
      if (condition === '__name__=="__main__"') mainGuardLine = node.startPosition.row + 1;
    }
    for (const child of node.namedChildren) visit(child, moduleScope && node.type !== "function_definition" && node.type !== "class_definition");
  };
  visit(root, true);

  return {
    imports: imports.sort((a, b) => a.line - b.line || a.source.localeCompare(b.source)),
    symbols: symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    calls: calls.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    decorators: decorators.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    ...(allExportsDynamic ? { allExportsDynamic } : {}),
    ...(allExports === undefined ? {} : { allExports }),
    ...(mainGuardLine === undefined ? {} : { mainGuardLine }),
    diagnostics: diagnostics(root),
  };
}
