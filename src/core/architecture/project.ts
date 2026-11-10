import { createHash } from "node:crypto";
import { architectureDocumentSchema, type ArchitectureDocument, type ArchitectureDraftInput } from "./document.js";
import type { ArchitectureFactSet, NodeFact } from "./facts.js";
import { uniqueEvidence } from "./source.js";
import { layoutArchitecture } from "./layout.js";

type Component = ArchitectureDocument["components"][number];
type Connection = ArchitectureDocument["connections"][number];

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

function componentSublabel(node: NodeFact) {
  const value = node.runtimeUnit === undefined ? node.kind : node.runtimeUnit;
  return value.length > 24 ? `${value.slice(0, 23)}…` : value;
}

function componentConnectionLabel(label: string) {
  return label.length > 40 ? `${label.slice(0, 39)}…` : label;
}

function components(facts: ArchitectureFactSet) {
  return facts.nodes.map((node): Component => ({
    id: architectureProjectionId(node.id),
    type: componentType(node),
    label: node.label,
    sublabel: componentSublabel(node),
    pos: [Number.NaN, Number.NaN],
    size: [componentWidth(node.label), 64],
    sources: uniqueEvidence(node.evidence).slice(0, 3).map((item) => ({ path: item.path, line: item.line })),
  }));
}

const dashedEdgeKinds = new Set(["poll", "schedule", "callback"]);

function gridArchitecture(components: Component[], connections: Connection[]) {
  components.forEach((component, index) => {
    component.pos = [60 + (index % 3) * 480, 80 + Math.floor(index / 3) * 180];
  });
  const byId = new Map(components.map((component) => [component.id, component]));
  const routed = connections.map((connection) => {
    const from = byId.get(connection.from);
    const to = byId.get(connection.to);
    const labelAt = from && to ? [(from.pos[0] + from.size[0] / 2 + to.pos[0] + to.size[0] / 2) / 2, (from.pos[1] + to.pos[1]) / 2] as [number, number] : undefined;
    return { ...connection, via: [], ...(labelAt ? { labelAt } : {}) };
  });
  const maxX = Math.max(1200, ...components.map((component) => component.pos[0] + component.size[0] + 100));
  const maxY = Math.max(900, ...components.map((component) => component.pos[1] + component.size[1] + 100));
  return { components, connections: routed, viewBox: [Math.ceil(maxX), Math.ceil(maxY)] as [number, number] };
}

export function projectArchitectureDocument(input: Pick<ArchitectureDraftInput, "productName" | "productSlug" | "owner" | "name" | "provider" | "revision" | "locale">, facts: ArchitectureFactSet, options: { layout?: "full" | "grid" } = {}): ArchitectureDocument {
  const projected = components(facts);
  const roles = new Map(facts.nodes.map((node) => [architectureProjectionId(node.id), node.kind]));
  const roots = new Set(facts.roots.map(architectureProjectionId));
  const connections = facts.edges.map((edge) => ({
    id: architectureProjectionId(edge.id),
    from: architectureProjectionId(edge.from),
    to: architectureProjectionId(edge.to),
    label: componentConnectionLabel(edge.label),
    variant: edge.kind === "oauth" ? "security" as const : dashedEdgeKinds.has(edge.kind) ? "dashed" as const : undefined,
  }));
  const layout = options.layout === "grid" ? gridArchitecture(projected, connections) : layoutArchitecture(projected, connections, roles, roots);
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
