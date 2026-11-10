import { posix } from "node:path";
import { findArchitectureEvidence, signalIdsForPaths, type ArchitectureSource } from "../source.js";
import type { NodeFact } from "../facts.js";
import { actorNode, emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureDetector, type ArchitectureFragment } from "./types.js";

function nextRoot(path: string) {
  const match = path.match(/^(.*?)(?:^|\/)(?:app|pages)\//);
  return match === null ? "" : match[1].replace(/\/$/, "");
}

function packagePath(sources: ArchitectureSource[], root: string) {
  const candidate = posix.join(root, "package.json");
  const paths = new Set(sources.map((source) => source.path));
  return paths.has(candidate) ? [candidate] : [];
}

function importSpecifiers(source: ArchitectureSource) {
  const fromImports = [...source.content.matchAll(/(?:from\s+|import\(|require\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const sideEffectImports = [...source.content.matchAll(/import\s*["']([^"']+)["']/g)].map((match) => match[1]);
  return [...fromImports, ...sideEffectImports];
}

function packageRoot(path: string, sources: ArchitectureSource[]) {
  const root = sources.filter((source) => source.path.endsWith("package.json")).map((source) => posix.dirname(source.path))
    .sort((a, b) => b.length - a.length)
    .find((candidate) => path.startsWith(`${candidate}/`));
  if (root) return root;
  return nextRoot(path);
}

function resolveImport(specifier: string, source: ArchitectureSource, sources: ArchitectureSource[], packageSources: ArchitectureSource[]) {
  const relative = specifier.startsWith(".");
  const base = relative ? posix.dirname(source.path) : packageRoot(source.path, packageSources);
  const normalizedSpecifier = specifier.startsWith("@/") ? specifier.slice(2) : specifier;
  const supported = [specifier.startsWith("."), specifier.startsWith("@/"), normalizedSpecifier.startsWith("lib/")].some(Boolean);
  if (!supported) return undefined;
  const target = posix.normalize(posix.join(base, normalizedSpecifier));
  const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}/index.ts`, `${target}/index.tsx`];
  return sources.find((source) => candidates.includes(source.path))?.path;
}

function tsSourcePaths(entry: ArchitectureSource, sources: ArchitectureSource[]) {
  const tsSources = sources.filter((source) => /\.(?:ts|tsx|js)$/.test(source.path));
  const pending = [entry.path];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    const source = tsSources.find((source) => source.path === current);
    if (!source) continue;
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveImport(specifier, source, tsSources, sources);
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return [...visited].sort();
}

function nextNode(id: string, kind: "frontend" | "api", root: string, source: ArchitectureSource, context: ArchitectureContext, evidence: NonNullable<ReturnType<typeof findArchitectureEvidence>>, framework = "Next.js"): NodeFact {
  const deferred = /(?:^|\/)app\/api\/.*route\.ts$/.test(source.path) && findArchitectureEvidence(source, ["after("], "next-after-worker") !== undefined;
  const sourcePaths = deferred ? [source.path] : tsSourcePaths(source, context.sources);
  const paths = [...sourcePaths, ...packagePath(context.sources, root)];
  const accepted = new Set(paths);
  const signalIds = context.signals.filter((signal) => ["entrypoint", "deployable"].includes(signal.kind) && accepted.has(signal.evidence.path)).map((signal) => signal.id).sort();
  return {
    id,
    kind,
    label: `${root || framework} ${kind === "frontend" ? "Web UI" : "API"}`,
    runtimeUnit: root || (framework === "Vite" ? "vite-root" : "next-root"),
    sourcePaths: [...new Set(paths)].sort(),
    signalIds,
    evidence: [evidence],
  };
}

function asyncFragment(context: ArchitectureContext): ArchitectureFragment {
  const fragment = emptyArchitectureFragment();
  for (const source of context.sources.filter((source) => /(?:^|\/)app\/api\/.*route\.ts$/.test(source.path))) {
    const evidence = findArchitectureEvidence(source, ["after("], "next-after-worker");
    if (!evidence) continue;
    const root = nextRoot(source.path);
    const apiId = `next:${root || "root"}:api`;
    const id = `next:${root || "root"}:async`;
    const sourcePaths = tsSourcePaths(source, context.sources);
    const paths = new Set(sourcePaths);
    const signalIds = context.signals.filter((signal) => signal.kind === "worker" && paths.has(signal.evidence.path)).map((signal) => signal.id).sort();
    fragment.nodes.push({ id, kind: "worker", label: "Next.js 后台任务", runtimeUnit: root || "next-root", sourcePaths, signalIds, evidence: [evidence] });
    fragment.edges.push(factEdge(`schedule:${apiId}->${id}`, apiId, id, "schedule", "after() 后台执行", [evidence], signalIds));
  }
  return fragment;
}

function detectNext(context: ArchitectureContext): ArchitectureFragment {
  const next = detectNextAppRouter(context);
  const vite = detectVite(context);
  return {
    nodes: [...next.nodes, ...vite.nodes],
    edges: [...next.edges, ...vite.edges],
    roots: [...next.roots, ...vite.roots],
    omissions: [...next.omissions, ...vite.omissions],
  };
}

function detectVite(context: ArchitectureContext): ArchitectureFragment {
  const fragment = emptyArchitectureFragment();
  const viteConfigs = context.sources.filter((source) => /(?:^|\/)vite\.config\.(?:ts|js|mts|mjs)$/.test(source.path));
  if (viteConfigs.length === 0) return fragment;
  const roots = [...new Set(viteConfigs.map((source) => {
    const root = posix.dirname(source.path);
    return root === "." ? "" : root;
  }))];
  for (const root of roots) {
    const entries = context.sources.filter((source) => {
      const relative = root === "" ? source.path : source.path.startsWith(`${root}/`) ? source.path.slice(root.length + 1) : undefined;
      return relative !== undefined && /^src\/(?:main|index|App)\.tsx?$/.test(relative);
    });
    if (entries.length === 0) continue;
    fragment.nodes.push(actorNode("actor:users", "产品用户"));
    fragment.roots.push("actor:users");
    for (const source of entries) {
      const evidence = findArchitectureEvidence(source, ["createRoot", "export default", "render\\("], "vite-react-entrypoint");
      if (!evidence) continue;
      const id = `vite:${root || "root"}:ui`;
      fragment.nodes.push(nextNode(id, "frontend", root, source, context, evidence, "Vite"));
      fragment.edges.push(factEdge(`entry:users->${id}`, "actor:users", id, "http", "Vite 页面入口", [evidence], signalIdsForPaths(context.signals, [source.path])));
    }
  }
  return fragment;
}

function detectNextAppRouter(context: ArchitectureContext): ArchitectureFragment {
  const fragment = emptyArchitectureFragment();
  const pages = context.sources.filter((source) => /(?:^|\/)app\/.*page\.tsx$|(?:^|\/)pages\/index\.tsx$/.test(source.path));
  const routes = context.sources.filter((source) => /(?:^|\/)app\/.*route\.ts$/.test(source.path));
  if (pages.length + routes.length === 0) return fragment;
  fragment.nodes.push(actorNode("actor:users", "产品用户"));
  fragment.roots.push("actor:users");
  for (const source of pages) {
    const evidence = findArchitectureEvidence(source, ["export default", "export function", "createRoot"], "next-page-entrypoint");
    if (!evidence) continue;
    const root = nextRoot(source.path);
    const id = `next:${root || "root"}:ui`;
    fragment.nodes.push(nextNode(id, "frontend", root, source, context, evidence));
    fragment.edges.push(factEdge(`entry:users->${id}`, "actor:users", id, "http", "页面入口", [evidence], signalIdsForPaths(context.signals, [source.path])));
  }
  for (const source of routes) {
    const evidence = findArchitectureEvidence(source, ["export async function", "export function", "GET", "POST"], "next-route-entrypoint");
    if (!evidence) continue;
    const root = nextRoot(source.path);
    const id = `next:${root || "root"}:api`;
    fragment.nodes.push(nextNode(id, "api", root, source, context, evidence));
    fragment.edges.push(factEdge(`entry:users->${id}`, "actor:users", id, "http", "HTTP API 入口", [evidence], signalIdsForPaths(context.signals, [source.path])));
  }
  const async = asyncFragment(context);
  fragment.nodes.push(...async.nodes);
  fragment.edges.push(...async.edges);
  return fragment;
}

export const nextArchitectureDetector: ArchitectureDetector = { id: "next-app-router", detect: detectNext };
