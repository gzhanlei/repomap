import { posix } from "node:path";
import type { NodeFact } from "../facts.js";
import { findArchitectureEvidence, signalIdsForPaths } from "../source.js";
import { actorNode, emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureFragment } from "./types.js";

function ownsPackage(nodes: NodeFact[], path: string) {
  return nodes.some((node) => node.sourcePaths?.includes(path) || node.evidence.some((item) => item.path === path));
}

/**
 * Covers independently discovered package start/dev declarations that have no
 * framework runtime owner. This proves a process entry only; it does not infer
 * an HTTP service, frontend or module topology from a package name.
 */
export function packageDeployableFragment(context: ArchitectureContext, runtimeNodes: NodeFact[]): ArchitectureFragment {
  const fragment = emptyArchitectureFragment();
  for (const source of context.sources.filter((item) => item.path.endsWith("package.json"))) {
    if (ownsPackage(runtimeNodes, source.path)) continue;
    const evidence = findArchitectureEvidence(source, ['"start"', '"dev"'], "package-script-entrypoint", (line) => /"(?:start|dev)"\s*:/.test(line));
    if (!evidence) continue;
    const root = posix.dirname(source.path);
    const unit = root === "." ? "root" : root;
    const id = `package:${unit}:deployable`;
    const signalIds = signalIdsForPaths(context.signals, [source.path]);
    fragment.nodes.push({
      id,
      kind: "cli",
      label: `Package ${posix.basename(unit)}`,
      runtimeUnit: unit,
      sourcePaths: [source.path],
      signalIds,
      evidence: [evidence],
    });
    fragment.nodes.push(actorNode("actor:cli-users", "命令行用户"));
    fragment.roots.push("actor:cli-users");
    fragment.edges.push(factEdge(`entry:cli-users->${id}`, "actor:cli-users", id, "process", "包启动脚本", [evidence], signalIds));
  }
  return fragment;
}
