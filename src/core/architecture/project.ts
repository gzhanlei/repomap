import { createHash } from "node:crypto";
import { architectureDocumentSchema, type ArchitectureDocument, type ArchitectureDraftInput } from "./document.js";
import type { ArchitectureFactSet, NodeFact } from "./facts.js";
import { uniqueEvidence } from "./source.js";
import { layoutArchitecture } from "./layout.js";

type Component = ArchitectureDocument["components"][number];

const componentTypes: Record<NodeFact["kind"], Component["type"]> = {
  user: "external",
  frontend: "frontend",
  api: "backend",
  cli: "backend",
  worker: "backend",
  agent: "backend",
  database: "database",
  "object-store": "cloud",
  queue: "messagebus",
  external: "external",
};

function componentType(node: NodeFact): Component["type"] {
  return componentTypes[node.kind];
}

const archifyIdPattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function architectureProjectionId(id: string) {
  if (archifyIdPattern.test(id)) return id;
  const normalized = id.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^[^a-zA-Z]+/, "").replace(/^-+|-+$/g, "").slice(0, 72) || "node";
  return `${normalized}-${createHash("sha256").update(id).digest("hex").slice(0, 10)}`;
}

export function componentWidth(label: string) {
  const estimated = Array.from(label).reduce((width, character) => width + (character.charCodeAt(0) > 255 ? 12 : 7), 44);
  return Math.max(180, Math.min(320, estimated));
}

function components(facts: ArchitectureFactSet) {
  return facts.nodes.map((node): Component => ({
    id: architectureProjectionId(node.id),
    type: componentType(node),
    label: node.label,
    sublabel: node.runtimeUnit === undefined ? node.kind : node.runtimeUnit,
    pos: [Number.NaN, Number.NaN],
    size: [componentWidth(node.label), 64],
    sources: uniqueEvidence(node.evidence).slice(0, 3).map((item) => ({ path: item.path, line: item.line })),
  }));
}

const dashedEdgeKinds = new Set(["poll", "schedule", "callback"]);

export function projectArchitectureDocument(input: Pick<ArchitectureDraftInput, "productName" | "productSlug" | "owner" | "name" | "provider" | "revision" | "locale">, facts: ArchitectureFactSet): ArchitectureDocument {
  const projected = components(facts);
  const roles = new Map(facts.nodes.map((node) => [architectureProjectionId(node.id), node.kind]));
  const roots = new Set(facts.roots.map(architectureProjectionId));
  const connections = facts.edges.map((edge) => ({
    id: architectureProjectionId(edge.id),
    from: architectureProjectionId(edge.from),
    to: architectureProjectionId(edge.to),
    label: edge.label,
    variant: edge.kind === "oauth" ? "security" as const : dashedEdgeKinds.has(edge.kind) ? "dashed" as const : undefined,
  }));
  const layout = layoutArchitecture(projected, connections, roles, roots);
  return architectureDocumentSchema.parse({
    schema_version: 1,
    diagram_type: "architecture",
    meta: {
      title: input.locale === "zh-CN" ? `${input.productName} 系统架构` : `${input.productName} Architecture`,
      output: `${input.productSlug}-architecture.html`,
      locale: input.locale === "zh-CN" ? "zh-CN" : "en",
      quality_profile: "standard",
      repository: { url: `https://github.com/${input.owner}/${input.name}`, provider: "github", revision: input.revision },
      viewBox: layout.viewBox,
    },
    components: layout.components,
    connections: layout.connections,
  });
}
