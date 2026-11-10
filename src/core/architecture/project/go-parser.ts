import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";

/**
 * PR #7 `go-module-graph`: the Go parser runtime is a *fixed, vendored WASM
 * grammar*, not a host `go` toolchain and not a regex line scan. See
 * docs/adr-go-parser.md for the ADR and the capability boundary.
 *
 * Top-level await finishes WASM initialisation before any consumer module is
 * evaluated, so the whole analysis pipeline (prepareProjects, buildGoModuleGraph,
 * analyzeArchitectureFacts) stays synchronous. A missing or broken grammar is a
 * declared `parser-unavailable` state, never an exception at analysis time.
 */

export const GO_PARSER_ID = "tree-sitter-go";
export const GO_GRAMMAR_VERSION = "0.25.0";
export const GO_RUNTIME = "web-tree-sitter";
export const GO_RUNTIME_VERSION = "0.27.2";
export const GO_PARSER_VERSION = `${GO_PARSER_ID}@${GO_GRAMMAR_VERSION}/${GO_RUNTIME}@${GO_RUNTIME_VERSION}`;

const require = createRequire(import.meta.url);
let parser: Parser | undefined;
let unavailableReason: string | undefined;

try {
  await Parser.init({ locateFile: () => require.resolve("web-tree-sitter/web-tree-sitter.wasm") });
  const grammar = readFileSync(require.resolve("tree-sitter-go/tree-sitter-go.wasm"));
  const language = await Language.load(grammar);
  parser = new Parser();
  parser.setLanguage(language);
} catch (error) {
  unavailableReason = error instanceof Error ? error.message : String(error);
}

export function goParserStatus(): { status: "available" | "unavailable"; detail: string } {
  if (parser) return { status: "available", detail: `${GO_PARSER_VERSION} (offline WASM grammar over the immutable raw snapshot)` };
  return { status: "unavailable", detail: `Go WASM grammar could not be loaded: ${unavailableReason ?? "unknown reason"}` };
}

export interface GoParsedImport {
  source: string;
  form: "normal" | "blank" | "dot";
  alias?: string;
  line: number;
}

export interface GoParsedSymbol {
  name: string;
  kind: string;
  exported: boolean;
  line: number;
  endLine: number;
}

export interface GoParsedCall {
  name: string;
  arguments: { text: string; type: string }[];
  line: number;
}

export interface GoParseDiagnostic {
  line: number;
  message: string;
}

export interface GoParsedFile {
  packageName: string;
  imports: GoParsedImport[];
  symbols: GoParsedSymbol[];
  calls: GoParsedCall[];
  callExpressions: number;
  diagnostics: GoParseDiagnostic[];
}

function childrenOf(node: SyntaxNode, type: string) {
  return node.namedChildren.filter((child) => child.type === type);
}

function firstNamed(node: SyntaxNode, ...types: string[]) {
  return node.namedChildren.find((child) => types.includes(child.type));
}

function stringLiteralValue(node: SyntaxNode): string | undefined {
  if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") {
    const content = firstNamed(node, "interpreted_string_literal_content", "raw_string_literal_content");
    return content?.text;
  }
  return undefined;
}

function exported(name: string) {
  return /^[A-Z]/.test(name);
}

function collectDiagnostics(root: SyntaxNode): GoParseDiagnostic[] {
  const diagnostics: GoParseDiagnostic[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    if (node.isMissing || node.type === "ERROR") {
      diagnostics.push({
        line: node.startPosition.row + 1,
        message: node.isMissing ? `missing ${node.type}` : `unexpected syntax near ${JSON.stringify(node.text.slice(0, 40))}`,
      });
    }
    for (const child of node.children) stack.push(child);
  }
  const unique = new Map(diagnostics.map((item) => [`${item.line}:${item.message}`, item]));
  return [...unique.values()].sort((a, b) => a.line - b.line || a.message.localeCompare(b.message)).slice(0, 100);
}

/**
 * Parse one immutable raw Go source string. Returns undefined only when the
 * bundled grammar is unavailable; syntax errors are reported as diagnostics so
 * they can become blocking omissions rather than silently dropped files.
 */
export function parseGoSource(raw: string): GoParsedFile | undefined {
  if (!parser) return undefined;
  const root = parser.parse(raw)?.rootNode;
  if (!root) {
    return { packageName: "", imports: [], symbols: [], calls: [], callExpressions: 0, diagnostics: [{ line: 1, message: "Go grammar produced no syntax tree" }] };
  }
  const packageClause = firstNamed(root, "package_clause");
  const packageName = firstNamed(packageClause ?? root, "package_identifier")?.text ?? "";

  const imports: GoParsedImport[] = [];
  for (const declaration of childrenOf(root, "import_declaration")) {
    const list = firstNamed(declaration, "import_spec_list");
    const specs = list ? childrenOf(list, "import_spec") : childrenOf(declaration, "import_spec");
    for (const spec of specs) {
      const literal = firstNamed(spec, "interpreted_string_literal", "raw_string_literal");
      const source = literal ? stringLiteralValue(literal) : undefined;
      if (!source) continue;
      const aliasNode = firstNamed(spec, "package_identifier", "blank_identifier", "dot");
      const form = aliasNode?.type === "blank_identifier" ? "blank" : aliasNode?.type === "dot" ? "dot" : "normal";
      imports.push({
        source,
        form,
        ...(aliasNode && form === "normal" ? { alias: aliasNode.text } : {}),
        line: spec.startPosition.row + 1,
      });
    }
  }

  const symbols: GoParsedSymbol[] = [];
  const calls: GoParsedCall[] = [];
  let callExpressions = 0;
  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression") {
      callExpressions += 1;
      const fn = node.childForFieldName("function") ?? node.firstNamedChild;
      const args = node.childForFieldName("arguments") ?? firstNamed(node, "argument_list");
      calls.push({
        name: fn?.text ?? "",
        arguments: (args?.namedChildren ?? []).map((argument) => ({ text: argument.text, type: argument.type })),
        line: node.startPosition.row + 1,
      });
    }
    if (node.type === "function_declaration") {
      const name = firstNamed(node, "identifier")?.text;
      if (name) symbols.push({ name, kind: "function", exported: exported(name), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
    } else if (node.type === "method_declaration") {
      const name = firstNamed(node, "field_identifier")?.text;
      if (name) symbols.push({ name, kind: "method", exported: exported(name), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
    } else if (node.type === "short_var_declaration") {
      const left = node.childForFieldName("left") ?? firstNamed(node, "expression_list");
      for (const identifier of childrenOf(left ?? node, "identifier")) {
        symbols.push({ name: identifier.text, kind: "var", exported: exported(identifier.text), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
      }
    } else if (node.type === "type_spec" || node.type === "var_spec" || node.type === "const_spec") {
      for (const identifier of childrenOf(node, "identifier")) {
        symbols.push({ name: identifier.text, kind: node.type.replace("_spec", ""), exported: exported(identifier.text), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);

  return {
    packageName,
    imports: imports.sort((a, b) => a.line - b.line || a.source.localeCompare(b.source)),
    symbols: symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    calls: calls.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    callExpressions,
    diagnostics: collectDiagnostics(root),
  };
}
