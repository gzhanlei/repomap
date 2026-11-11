import { createRequire } from "node:module";
import { Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);
let initialization: Promise<void> | undefined;

/** One process-wide Tree-sitter initialization shared by every language grammar. */
export function initializeTreeSitter() {
  initialization ??= Parser.init({ locateFile: () => require.resolve("web-tree-sitter/web-tree-sitter.wasm") });
  return initialization;
}
