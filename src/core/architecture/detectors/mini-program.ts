import { posix } from "node:path";
import { architectureRuntimeSources, findAllArchitectureEvidence, findArchitectureEvidence, signalIdsForEvidence, signalIdsForPaths } from "../source.js";
import type { NodeFact } from "../facts.js";
import { actorNode, emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureDetector, type ArchitectureFragment } from "./types.js";

function detectMiniProgram(context: ArchitectureContext): ArchitectureFragment {
  const fragment = emptyArchitectureFragment();
  for (const source of context.sources.filter((source) => source.path.endsWith("app.json"))) {
    const evidence = findArchitectureEvidence(source, ["pages", "miniprogram"], "miniprogram-entrypoint");
    if (!evidence) continue;
    const directory = posix.dirname(source.path);
    const root = directory === "." ? "miniprogram" : directory;
    const id = `miniprogram:${root}`;
    const sourcePaths = directory === "."
      ? context.sources.filter((candidate) => !candidate.path.includes("/")).map((candidate) => candidate.path)
      : context.sources.filter((candidate) => candidate.path.startsWith(`${root}/`)).map((candidate) => candidate.path);
    fragment.nodes.push({ id, kind: "frontend", label: "微信小程序", runtimeUnit: root, sourcePaths, signalIds: signalIdsForPaths(context.signals, [source.path]), evidence: [evidence] });
    fragment.nodes.push(actorNode("actor:users", "小程序用户"));
    fragment.roots.push("actor:users");
    fragment.edges.push(factEdge(`entry:users->${id}`, "actor:users", id, "http", "打开小程序", [evidence], signalIdsForPaths(context.signals, [source.path])));
  }
  return fragment;
}

export function miniProgramApiRelationships(context: ArchitectureContext, nodes: NodeFact[]) {
  const miniprograms = nodes.filter((node) => node.id.startsWith("miniprogram:"));
  const apis = nodes.filter((node) => node.kind === "api" && node.id.startsWith("go:"));
  if (apis.length !== 1) return [];
  return miniprograms.flatMap((miniprogram) => {
    const sources = architectureRuntimeSources(miniprogram, context.sources);
    const evidence = sources.flatMap((source) => findAllArchitectureEvidence(source, ["wx.cloud.callContainer"], "miniprogram-cloud-api"));
    return evidence.length > 0 ? [factEdge(`http:${miniprogram.id}->${apis[0].id}`, miniprogram.id, apis[0].id, "http", "云托管 API", evidence, signalIdsForEvidence(context.signals, evidence))] : [];
  });
}

export const miniProgramArchitectureDetector: ArchitectureDetector = { id: "wechat-miniprogram", detect: detectMiniProgram };
