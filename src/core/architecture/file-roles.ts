import { z } from "zod";

/** Path-level classification shared by the raw census, declarations and detectors. */
export const sourceFileRoleSchema = z.enum([
  "source", "test", "fixture", "generated", "vendored", "schema", "migration",
  "manifest", "lockfile", "config", "documentation", "binary", "unknown", "asset",
]);
export type SourceFileRole = z.infer<typeof sourceFileRoleSchema>;

export const rawEntryStatusSchema = z.enum(["inventoried", "selected", "excluded", "unsupported", "parse-error", "not-required"]);
export type RawEntryStatus = z.infer<typeof rawEntryStatusSchema>;

export const excludedDirectoryRules = [".git", "node_modules", "vendor", "third_party", "dist", "build", "out", "coverage"];

const lockfilePattern = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|flake\.lock|deno\.lock|packages\.lock\.json)$/i;
const manifestPattern = /(?:^|\/)(?:package\.json|go\.mod|go\.work|pnpm-workspace\.ya?ml|Cargo\.toml|pyproject\.toml|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|Gemfile|requirements\.txt|[^/]+\.csproj)$/i;
const testPattern = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?|spec)(?:\/|\.)|\.(?:test|spec)\.[a-z]+$|_test\.(?:go|py)$|\.d\.ts$/i;
const generatedPattern = /(?:^|\/)(?:generated|gen|__generated__)(?:\/|$)|(?:^|\/)(?:static|public|assets)\/(?:.*\/)?(?:mathjax|katex|plotly|monaco|codemirror|ckeditor|tinymce)(?:\/|$)|(?:^|\/)(?:static|public|assets)\/.*-full\.js$|\.min\.js$/i;
const vendoredPattern = /(?:^|\/)(?:vendor|third_party|node_modules|bower_components|dist|build|out|coverage)(?:\/|$)/i;
const migrationPattern = /(?:^|\/)(?:migrations?|migrate|alembic|db\/migrate)(?:\/|$)/i;
const schemaPattern = /\.(?:sql|prisma|graphql|gql)$/i;
const documentationPattern = /(?:^|\/)docs?\/|\.(?:md|mdx|rst)$|^(?:LICENSE|CHANGELOG|NOTICE|README)(?:\..*)?$/i;
const binaryPattern = /\.(?:png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|otf|mp3|mp4|wav|pdf|zip|gz|tgz|jar|class|so|dylib|dll|exe|wasm|pyc|lockb)$/i;
const configPattern = /\.(?:ya?ml|toml|ini|conf|properties|env|xml|json)$|(?:^|\/)(?:Dockerfile|Makefile|\.env(?:\..*)?)$/i;
const sourcePattern = /\.(?:go|ts|tsx|js|jsx|mjs|cjs|mts|cts|php|py|java|kt|kts|rs|cs|rb|swift|vue|svelte|sh|css)$/i;

export function isLockfilePath(path: string) { return lockfilePattern.test(path); }
export function isManifestPath(path: string) { return manifestPattern.test(path); }
export function isDeclarationOnlyPath(path: string) { return isLockfilePath(path) || isManifestPath(path); }

/** Only real source/schema/config files can prove runtime behaviour. */
export function isRuntimeEvidencePath(path: string) {
  return !isDeclarationOnlyPath(path) && !testPattern.test(path) && !generatedPattern.test(path) && !vendoredPattern.test(path) && !documentationPattern.test(path);
}

export function classifySourcePath(path: string): SourceFileRole {
  if (isLockfilePath(path)) return "lockfile";
  if (isManifestPath(path)) return "manifest";
  if (testPattern.test(path)) return /fixtures?|__snapshots__/i.test(path) ? "fixture" : "test";
  if (vendoredPattern.test(path)) return "vendored";
  if (generatedPattern.test(path)) return "generated";
  if (binaryPattern.test(path)) return "binary";
  if (documentationPattern.test(path)) return "documentation";
  if (migrationPattern.test(path) && !sourcePattern.test(path)) return "migration";
  if (schemaPattern.test(path)) return "schema";
  if (/\.css$/i.test(path)) return "asset";
  if (sourcePattern.test(path)) return "source";
  if (configPattern.test(path)) return "config";
  return "unknown";
}

const languageByExtension: Record<string, string> = {
  go: "go", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
  php: "php", py: "python", java: "java", kt: "kotlin", kts: "kotlin", rs: "rust", cs: "csharp", rb: "ruby", swift: "swift",
  vue: "vue", svelte: "svelte", sh: "shell", css: "css", sql: "sql", prisma: "prisma", graphql: "graphql", gql: "graphql",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown", mdx: "markdown", xml: "xml",
};

export function detectSourceLanguage(path: string) {
  if (path.endsWith("go.mod") || path.endsWith("go.sum")) return "go-module";
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return languageByExtension[extension] ?? "unknown";
}

const managerByManifest: [RegExp, string][] = [
  [/package\.json$/i, "npm"], [/go\.mod$/i, "go"], [/go\.work$/i, "go-workspace"], [/pnpm-workspace\.ya?ml$/i, "pnpm-workspace"],
  [/Cargo\.toml$/i, "cargo"], [/pyproject\.toml$/i, "python"], [/composer\.json$/i, "composer"], [/pom\.xml$/i, "maven"],
  [/build\.gradle(?:\.kts)?$/i, "gradle"], [/Gemfile$/i, "bundler"], [/requirements\.txt$/i, "pip"], [/\.csproj$/i, "dotnet"],
];

export function manifestManager(path: string): string | undefined {
  return managerByManifest.find(([pattern]) => pattern.test(path))?.[1];
}
