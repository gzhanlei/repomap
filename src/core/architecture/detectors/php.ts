import { findArchitectureEvidence, signalIdsForPaths } from "../source.js";
import { actorNode, emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureDetector, type ArchitectureFragment } from "./types.js";

function phpRoot(path: string) {
  const directory = path.split("/").slice(0, -1).join("/");
  return directory || "root";
}

function phpSourceFragment(source: ArchitectureContext["sources"][number], context: ArchitectureContext): ArchitectureFragment {
  const fragment = emptyArchitectureFragment();
  const uiEvidence = findArchitectureEvidence(source, ["<!DOCTYPE html", "<form", "document.addEventListener"], "php-ui-entrypoint");
  const appEvidence = findArchitectureEvidence(source, ["$_SERVER", "$_POST", "require_once", "new PDO", "new CacheManager"], "php-request-entrypoint");
  if (!uiEvidence && !appEvidence) return fragment;
  const root = phpRoot(source.path);
  const uiId = `php:${root}:ui`;
  const appId = `php:${root}:app`;
  const signals = signalIdsForPaths(context.signals, [source.path]);
  fragment.nodes.push(actorNode("actor:users", "产品用户"));
  fragment.roots.push("actor:users");
  if (uiEvidence) {
    fragment.nodes.push({ id: uiId, kind: "frontend", label: "PHP 浏览器页面", runtimeUnit: root, signalIds: signals, evidence: [uiEvidence] });
    fragment.edges.push(factEdge(`entry:users->${uiId}`, "actor:users", uiId, "http", "页面入口", [uiEvidence], signals));
  }
  if (appEvidence) {
    fragment.nodes.push({ id: appId, kind: "api", label: "PHP 请求应用", runtimeUnit: root, signalIds: signals, evidence: [appEvidence] });
    const entryEvidence = uiEvidence === undefined ? appEvidence : uiEvidence;
    const from = uiEvidence ? uiId : "actor:users";
    fragment.edges.push(factEdge(`entry:${from}->${appId}`, from, appId, "http", "请求处理", [entryEvidence], signals));
  }
  return fragment;
}

function detectPhp(context: ArchitectureContext): ArchitectureFragment {
  const fragment = emptyArchitectureFragment();
  for (const source of context.sources.filter((source) => source.path.endsWith(".php"))) {
    const detected = phpSourceFragment(source, context);
    fragment.nodes.push(...detected.nodes);
    fragment.edges.push(...detected.edges);
    fragment.roots.push(...detected.roots);
  }
  return fragment;
}

export const phpArchitectureDetector: ArchitectureDetector = { id: "php-request-entrypoints", detect: detectPhp };
