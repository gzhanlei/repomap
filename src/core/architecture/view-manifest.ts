import { createHash } from "node:crypto";
import { z } from "zod";
import { architectureFactSetSchema, type ArchitectureEvidence, type ArchitectureFactSet, type EdgeFact, type NodeFact } from "./facts.js";
import { evidenceIdsFor, evidenceIdsForRecords, type EvidenceRecord } from "./evidence-index.js";
import { type ArchitectureIr, type OperationFact } from "./ir.js";
import { architectureProjectionId } from "./project.js";
import type { analyzeArchitectureFacts } from "./extract.js";

export const viewKindSchema = z.enum(["overview", "modules", "flows"]);
export type ViewKind = z.infer<typeof viewKindSchema>;

export const viewEntitySchema = z.object({
  ownerType: z.enum(["node", "edge", "operation"]),
  ownerId: z.string().min(1),
  projectionId: z.string().min(1).optional(),
  relatedProjectionIds: z.array(z.string().min(1)).optional(),
  irFactIds: z.array(z.string().min(1)),
  evidenceIds: z.array(z.string().min(1)),
  representativeEvidenceIds: z.array(z.string().min(1)),
  remainingEvidenceIds: z.array(z.string().min(1)),
  page: z.number().int().positive(),
  aliasOf: z.string().min(1).optional(),
  aggregateOf: z.array(z.string().min(1)).optional(),
  selectionReason: z.string().min(1),
}).strict();
export type ViewEntity = z.infer<typeof viewEntitySchema>;

export const viewPageEntrySchema = z.object({
  page: z.number().int().positive(),
  totalPages: z.number().int().positive(),
  json: z.string().min(1),
  html: z.string().min(1),
  nodeIds: z.array(z.string().min(1)),
  edgeIds: z.array(z.string().min(1)),
  operationIds: z.array(z.string().min(1)),
  entities: z.array(viewEntitySchema),
}).strict();
export type ViewPageEntry = z.infer<typeof viewPageEntrySchema>;

export const viewRoundtripSchema = z.object({
  ok: z.boolean(),
  missingFactIds: z.array(z.string().min(1)),
  duplicateFactIds: z.array(z.string().min(1)),
  danglingEvidenceIds: z.array(z.string().min(1)),
}).strict();
export type ViewRoundtrip = z.infer<typeof viewRoundtripSchema>;

export const viewDetailOwnerSchema = z.object({
  scope: z.enum(["module-architecture", "protocol-flows"]),
  owner: z.string().min(1),
  nodeIds: z.array(z.string().min(1)),
  edgeIds: z.array(z.string().min(1)),
  operationIds: z.array(z.string().min(1)),
}).strict();
export type ViewDetailOwner = z.infer<typeof viewDetailOwnerSchema>;

export const viewManifestSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  detailOwners: z.array(viewDetailOwnerSchema),
  views: z.array(z.object({
    id: z.string().min(1),
    kind: viewKindSchema,
    owner: z.string().min(1),
    title: z.string().min(1),
    pages: z.array(viewPageEntrySchema),
  }).strict()),
  roundtrip: viewRoundtripSchema,
}).strict();
export type ViewManifest = z.infer<typeof viewManifestSchema>;

export interface ViewPage {
  id: string;
  kind: ViewKind;
  owner: string;
  title: string;
  page: number;
  totalPages: number;
  facts: ArchitectureFactSet;
  operations: OperationFact[];
  edgeGroups?: Map<string, { ids: string[]; evidence: EdgeFact["evidence"] }>;
  operationProjections?: Map<string, string[]>;
  sourceEvidenceIds: EvidenceIdMap;
}

export interface ViewManifestBuild {
  manifest: ViewManifest;
  pages: ViewPage[];
  additionalEvidenceRecords: EvidenceRecord[];
  detailFacts: Array<{ facts: ArchitectureFactSet; scope: "module-architecture" | "protocol-flows"; owner: string; operations: OperationFact[]; evidenceIds: Map<string, string[]> }>;
}

type EvidenceIdMap = Map<string, string[]>;

const evidenceIdSets = new WeakMap<EvidenceIdMap, Map<string, Set<string>>>();
const evidenceIdMergedArrays = new WeakMap<EvidenceIdMap, WeakMap<string[], Set<string>>>();

function mergeEvidenceIds(map: EvidenceIdMap, ownerId: string, ids: string[]) {
  let owners = evidenceIdSets.get(map);
  if (!owners) {
    owners = new Map<string, Set<string>>();
    evidenceIdSets.set(map, owners);
  }
  // Stable evidence-id arrays (from baseEvidenceIdMap and the module evidence
  // maps) are merged into the same owners many times; skipping by array
  // identity keeps repeat merges O(1) instead of re-scanning every id.
  let mergedArrays = evidenceIdMergedArrays.get(map);
  if (!mergedArrays) {
    mergedArrays = new WeakMap<string[], Set<string>>();
    evidenceIdMergedArrays.set(map, mergedArrays);
  }
  const done = mergedArrays.get(ids);
  if (done?.has(ownerId)) return;
  let seen = owners.get(ownerId);
  let target = map.get(ownerId);
  if (!target) {
    target = [];
    map.set(ownerId, target);
  }
  if (!seen) {
    seen = new Set(target);
    owners.set(ownerId, seen);
  }
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      target.push(id);
    }
  }
  if (done) {
    done.add(ownerId);
  } else {
    mergedArrays.set(ids, new Set([ownerId]));
  }
}

function baseEvidenceIdMap(facts: ArchitectureFactSet): EvidenceIdMap {
  const map: EvidenceIdMap = new Map();
  for (const fact of [...facts.nodes, ...facts.edges]) mergeEvidenceIds(map, fact.id, evidenceIdsFor(fact.evidence));
  return map;
}

type Analysis = ReturnType<typeof analyzeArchitectureFacts>;

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

const evidenceRecordMaps = new WeakMap<EvidenceRecord[], Map<string, EvidenceRecord>>();

function evidenceFromIds(records: EvidenceRecord[], ids: string[]): ArchitectureEvidence[] {
  let byId = evidenceRecordMaps.get(records);
  if (!byId) {
    byId = new Map(records.map((record) => [record.id, record]));
    evidenceRecordMaps.set(records, byId);
  }
  return [...new Set(ids)].sort().map((id) => {
    const record = byId.get(id);
    if (!record) throw new Error(`Missing source evidence record: ${id}`);
    return { path: record.path, line: record.startLine, detector: record.extractor };
  });
}

function compactViewLabel(value: string, limit = 24) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function moduleImportLabel(source: string, unresolved = false) {
  const tail = source.split("/").filter(Boolean).at(-1) ?? source;
  const limit = unresolved ? 16 : 24;
  const compact = tail.length > limit ? `${tail.slice(0, limit - 1)}…` : tail;
  return unresolved ? `? ${compact}` : compact;
}

function moduleLabel(path: string) {
  const parts = path.split("/");
  const label = parts.slice(-2).join("/");
  return label.length > 22 ? `${label.slice(0, 21)}…` : label;
}

function moduleNode(node: Analysis["moduleGraph"]["nodes"][number], evidence: ArchitectureEvidence[]): NodeFact {
  return {
    id: node.id,
    kind: node.language === "python" && node.entrypoint ? "cli" : node.entrypoint ? "frontend" : "api",
    label: moduleLabel(node.path),
    runtimeUnit: node.packageId,
    sourcePaths: [node.path],
    signalIds: [],
    evidence,
  };
}

function goPackageNode(node: Analysis["goModuleGraph"]["nodes"][number], evidence: ArchitectureEvidence[]): NodeFact {
  const path = node.files[0] ?? node.dir;
  return {
    id: node.id,
    kind: node.kind === "main-package" ? "frontend" : "api",
    label: compactViewLabel(node.packageName, 22),
    runtimeUnit: node.dir,
    sourcePaths: node.files,
    signalIds: [],
    evidence,
  };
}

function externalNode(id: string, label: string, evidence: ArchitectureEvidence[], kind: NodeFact["kind"] = "external"): NodeFact {
  return { id, kind, label: compactViewLabel(label), sourcePaths: [...new Set(evidence.map((item) => item.path))].sort(), signalIds: [], evidence };
}

const viewNodeEvidenceKeys = new WeakMap<NodeFact, Set<string>>();
const viewNodePathKeys = new WeakMap<NodeFact, Set<string>>();
const viewNodeSources = new WeakMap<NodeFact, WeakSet<object>>();
const viewEdgeSources = new WeakMap<EdgeFact, WeakSet<object>>();
const viewEdgeEvidenceKeys = new WeakMap<EdgeFact, Set<string>>();

function addViewNode(nodes: Map<string, NodeFact>, node: NodeFact) {
  const existing = nodes.get(node.id);
  if (!existing) {
    const clone = { ...node, evidence: [...node.evidence], sourcePaths: [...(node.sourcePaths ?? [])] };
    viewNodeEvidenceKeys.set(clone, new Set(clone.evidence.map((item) => `${item.path}:${item.line}:${item.detector}`)));
    viewNodePathKeys.set(clone, new Set(clone.sourcePaths));
    viewNodeSources.set(clone, new WeakSet([node]));
    nodes.set(node.id, clone);
    return;
  }
  if (existing.kind !== node.kind) throw new Error(`Conflicting view node kind for ${node.id}: ${existing.kind} vs ${node.kind}`);
  let sources = viewNodeSources.get(existing);
  if (!sources) {
    sources = new WeakSet<object>();
    viewNodeSources.set(existing, sources);
  }
  if (sources.has(node)) return;
  sources.add(node);
  let seen = viewNodeEvidenceKeys.get(existing);
  if (!seen) {
    seen = new Set(existing.evidence.map((item) => `${item.path}:${item.line}:${item.detector}`));
    viewNodeEvidenceKeys.set(existing, seen);
  }
  for (const item of node.evidence) {
    const key = `${item.path}:${item.line}:${item.detector}`;
    if (!seen.has(key)) {
      seen.add(key);
      existing.evidence.push(item);
    }
  }
  let paths = viewNodePathKeys.get(existing);
  if (!paths) {
    paths = new Set(existing.sourcePaths ?? []);
    viewNodePathKeys.set(existing, paths);
  }
  for (const path of node.sourcePaths ?? []) {
    if (!paths.has(path)) {
      paths.add(path);
      (existing.sourcePaths ??= []).push(path);
    }
  }
}

function addViewEdge(edges: Map<string, EdgeFact>, edge: EdgeFact) {
  const existing = edges.get(edge.id);
  if (!existing) {
    const clone = { ...edge, evidence: [...edge.evidence] };
    viewEdgeEvidenceKeys.set(clone, new Set(clone.evidence.map((item) => `${item.path}:${item.line}:${item.detector}`)));
    viewEdgeSources.set(clone, new WeakSet([edge]));
    edges.set(edge.id, clone);
    return;
  }
  if (existing.from !== edge.from || existing.to !== edge.to || existing.kind !== edge.kind) throw new Error(`Conflicting view edge identity for ${edge.id}`);
  let sources = viewEdgeSources.get(existing);
  if (!sources) {
    sources = new WeakSet<object>();
    viewEdgeSources.set(existing, sources);
  }
  if (sources.has(edge)) return;
  sources.add(edge);
  let seen = viewEdgeEvidenceKeys.get(existing);
  if (!seen) {
    seen = new Set(existing.evidence.map((item) => `${item.path}:${item.line}:${item.detector}`));
    viewEdgeEvidenceKeys.set(existing, seen);
  }
  for (const item of edge.evidence) {
    const key = `${item.path}:${item.line}:${item.detector}`;
    if (!seen.has(key)) {
      seen.add(key);
      existing.evidence.push(item);
    }
  }
  edgeEvidenceIdCache.delete(existing);
}

const moduleIncidentCache = new WeakMap<Analysis, { module: Map<string, string[]>; go: Map<string, string[]> }>();

function moduleNodeEvidenceIds(analysis: Analysis, id: string, go = false) {
  let cache = moduleIncidentCache.get(analysis);
  if (!cache) {
    const build = (edges: Array<{ from: string; to: string; evidenceIds: string[] }>) => {
      const incidents = new Map<string, string[]>();
      for (const edge of edges) for (const endpoint of [edge.from, edge.to]) incidents.set(endpoint, [...(incidents.get(endpoint) ?? []), ...edge.evidenceIds]);
      return incidents;
    };
    cache = { module: build(analysis.moduleGraph.edges), go: build(analysis.goModuleGraph.edges) };
    moduleIncidentCache.set(analysis, cache);
  }
  return (go ? cache.go : cache.module).get(id) ?? [];
}

function moduleNodeEvidence(analysis: Analysis, id: string, go = false) {
  return evidenceFromIds(analysis.evidence.records, moduleNodeEvidenceIds(analysis, id, go));
}

function moduleViewFacts(analysis: Analysis, runtime: NodeFact): { facts: ArchitectureFactSet; operations: OperationFact[]; evidenceIds: EvidenceIdMap } {
  const paths = new Set([...(runtime.sourcePaths ?? []), ...runtime.evidence.map((item) => item.path)]);
  const evidenceIds: EvidenceIdMap = new Map();
  const nodes = new Map<string, NodeFact>();
  const addNode = (node: NodeFact, ids: string[]) => { addViewNode(nodes, node); mergeEvidenceIds(evidenceIds, node.id, ids); };
  const addEdge = (edge: EdgeFact, ids: string[]) => { addViewEdge(edges, edge); mergeEvidenceIds(evidenceIds, edge.id, ids); };
  const moduleById = new Map(analysis.moduleGraph.nodes.map((node) => [node.id, node]));
  const goById = new Map(analysis.goModuleGraph.nodes.map((node) => [node.id, node]));
  const moduleNodes = analysis.moduleGraph.nodes.filter((node) => paths.has(node.path));
  const goNodes = analysis.goModuleGraph.nodes.filter((node) => node.files.some((path) => paths.has(path)));
  for (const node of moduleNodes) addNode(moduleNode(node, moduleNodeEvidence(analysis, node.id)), moduleNodeEvidenceIds(analysis, node.id));
  for (const node of goNodes) addNode(goPackageNode(node, moduleNodeEvidence(analysis, node.id, true)), moduleNodeEvidenceIds(analysis, node.id, true));
  const edges = new Map<string, EdgeFact>();
  const omissions: ArchitectureFactSet["omissions"] = [];
  for (const edge of analysis.moduleGraph.edges.filter((candidate) => nodes.has(candidate.from))) {
    if (edge.toKind === "unresolved") {
      omissions.push({ signalId: edge.id, reason: "unsupported", detail: `Unresolved module import ${edge.source} at ${edge.path}:${edge.line}` });
      continue;
    }
    const evidence = evidenceFromIds(analysis.evidence.records, edge.evidenceIds);
    let target: NodeFact;
    if (edge.toKind === "module") {
      const canonical = moduleById.get(edge.to);
      if (!canonical) throw new Error(`Module graph target is missing: ${edge.to}`);
      target = moduleNode(canonical, moduleNodeEvidence(analysis, canonical.id));
    } else {
      target = externalNode(edge.to, moduleImportLabel(edge.source), evidence);
    }
    addNode(target, edge.toKind === "module" ? moduleNodeEvidenceIds(analysis, target.id) : edge.evidenceIds);
    addEdge({ id: edge.id, from: edge.from, to: target.id, kind: "process", label: "import", signalIds: [], evidence }, edge.evidenceIds);
  }
  for (const edge of analysis.goModuleGraph.edges.filter((candidate) => nodes.has(candidate.from))) {
    if (edge.toKind === "unresolved") {
      omissions.push({ signalId: edge.id, reason: "unsupported", detail: `Unresolved Go import ${edge.source} at ${edge.path}:${edge.line}` });
      continue;
    }
    const evidence = evidenceFromIds(analysis.evidence.records, edge.evidenceIds);
    let target: NodeFact;
    if (edge.toKind === "package") {
      const canonical = goById.get(edge.to);
      if (!canonical) throw new Error(`Go package graph target is missing: ${edge.to}`);
      target = goPackageNode(canonical, moduleNodeEvidence(analysis, canonical.id, true));
    } else {
      target = externalNode(edge.to, moduleImportLabel(edge.source), evidence);
    }
    addNode(target, edge.toKind === "package" ? moduleNodeEvidenceIds(analysis, target.id, true) : edge.evidenceIds);
    addEdge({ id: edge.id, from: edge.from, to: target.id, kind: "process", label: "Go import", signalIds: [], evidence }, edge.evidenceIds);
  }
  const sortedNodes = [...nodes.values()].map((node) => ({ ...node, sourcePaths: [...(node.sourcePaths ?? [])].sort() })).sort((a, b) => a.id.localeCompare(b.id));
  if (sortedNodes.length === 1) {
    sortedNodes.push({ ...runtime, label: compactViewLabel(runtime.label), sourcePaths: [...(runtime.sourcePaths ?? [])] });
    mergeEvidenceIds(evidenceIds, runtime.id, evidenceIdsFor(runtime.evidence));
  }
  const roots = sortedNodes.filter((node) => moduleNodes.some((module) => module.id === node.id && module.entrypoint) || goNodes.some((go) => go.id === node.id && go.entrypoint)).map((node) => node.id);
  return {
    facts: architectureFactSetSchema.parse({
      version: 1,
      revision: analysis.ir.revision,
      roots: roots.length > 0 ? roots : sortedNodes[0] ? [sortedNodes[0].id] : [],
      nodes: sortedNodes,
      edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
      omissions,
    }),
    operations: [],
    evidenceIds,
  };
}

interface FlowViewFacts {
  facts: ArchitectureFactSet;
  operations: OperationFact[];
  evidenceIds: EvidenceIdMap;
}

const edgeEvidenceIdCache = new WeakMap<EdgeFact, string[]>();

function edgeEvidenceIds(edge: EdgeFact, records: EvidenceRecord[]) {
  let ids = edgeEvidenceIdCache.get(edge);
  if (!ids) {
    ids = evidenceIdsForRecords(edge.evidence, records);
    edgeEvidenceIdCache.set(edge, ids);
  }
  return ids;
}

// Indexing base edges by evidence id turns the per-operation edge scan
// (operations x edges x evidence ids) into one lookup per operation evidence id.
const baseEdgeEvidenceIndexCache = new WeakMap<ArchitectureFactSet, Map<string, EdgeFact[]>>();

function baseEdgeEvidenceIndex(facts: ArchitectureFactSet, records: EvidenceRecord[]): Map<string, EdgeFact[]> {
  let index = baseEdgeEvidenceIndexCache.get(facts);
  if (!index) {
    index = new Map();
    for (const edge of facts.edges) {
      for (const id of edgeEvidenceIds(edge, records)) {
        const edges = index.get(id);
        if (edges) edges.push(edge);
        else index.set(id, [edge]);
      }
    }
    baseEdgeEvidenceIndexCache.set(facts, index);
  }
  return index;
}

function matchedBaseEdges(operation: OperationFact, index: Map<string, EdgeFact[]>): EdgeFact[] {
  const matches: EdgeFact[] = [];
  const seen = new Set<string>();
  for (const id of operation.evidenceIds) {
    for (const edge of index.get(id) ?? []) {
      if (!seen.has(edge.id)) {
        seen.add(edge.id);
        matches.push(edge);
      }
    }
  }
  return matches;
}

const candidateByOperationIdCache = new WeakMap<Analysis["candidates"], Map<string, Analysis["candidates"][number]>>();

function candidateForOperation(analysis: Analysis, operation: OperationFact) {
  const primaryId = operation.kind === "config-binding" ? operation.id.slice(0, -":config".length) : operation.id;
  let byOperationId = candidateByOperationIdCache.get(analysis.candidates);
  if (!byOperationId) {
    byOperationId = new Map();
    for (const item of analysis.candidates) {
      if (item.status === "resolved" && !byOperationId.has(`operation:${item.id}`)) byOperationId.set(`operation:${item.id}`, item);
    }
    candidateByOperationIdCache.set(analysis.candidates, byOperationId);
  }
  return byOperationId.get(primaryId);
}

function candidateEdgeKind(candidate: Analysis["candidates"][number]): EdgeFact["kind"] {
  return candidate.operation?.kind === "query" ? "download" : candidate.operation?.kind === "mutation" || candidate.operation?.kind === "upload" ? "upload" : candidate.operation?.kind === "download" ? "download" : candidate.operation?.kind === "oauth" ? "oauth" : candidate.operation?.kind === "callback" ? "callback" : candidate.operation?.kind === "process" ? "process" : "http";
}

function buildOperationProjections(analysis: Analysis, facts: ArchitectureFactSet, operations: OperationFact[], sourceEvidenceIds: EvidenceIdMap) {
  const byEvidence = new Map<string, EdgeFact[]>();
  const byCandidate = new Map<string, EdgeFact[]>();
  for (const edge of facts.edges) {
    for (const id of sourceEvidenceIds.get(edge.id) ?? edgeEvidenceIds(edge, analysis.evidence.records)) {
      const edges = byEvidence.get(id);
      if (edges) edges.push(edge);
      else byEvidence.set(id, [edge]);
    }
    for (const candidate of analysis.candidates) {
      const target = `external:${candidate.identity}`;
      if ((edge.from === target || edge.to === target) && edge.kind === candidateEdgeKind(candidate)) {
        const key = `${target}|${edge.kind}`;
        const edges = byCandidate.get(key);
        if (edges) edges.push(edge);
        else byCandidate.set(key, [edge]);
      }
    }
  }
  return new Map(operations.map((operation) => {
    const related = new Set<EdgeFact>();
    for (const id of operation.evidenceIds) for (const edge of byEvidence.get(id) ?? []) related.add(edge);
    const candidate = candidateForOperation(analysis, operation);
    if (candidate) for (const edge of byCandidate.get(`external:${candidate.identity}|${candidateEdgeKind(candidate)}`) ?? []) related.add(edge);
    return [operation.id, [...related].map((edge) => architectureProjectionId(edge.id)).sort()] as const;
  }));
}

function flowViewFacts(analysis: Analysis, runtime: NodeFact): FlowViewFacts {
  const paths = new Set([...(runtime.sourcePaths ?? []), ...runtime.evidence.map((item) => item.path)]);
  const nodes = new Map<string, NodeFact>();
  const evidenceIds: EvidenceIdMap = new Map();
  const addNode = (node: NodeFact, ids: string[]) => { addViewNode(nodes, node); mergeEvidenceIds(evidenceIds, node.id, ids); };
  const baseEvidenceIds = baseEvidenceIdMap(analysis.facts);
  const baseNodeById = new Map(analysis.facts.nodes.map((node) => [node.id, node]));
  const projectedBaseNodes = new Map<string, NodeFact>();
  const baseViewNode = (id: string) => {
    const cached = projectedBaseNodes.get(id);
    if (cached) return cached;
    const canonical = baseNodeById.get(id);
    if (!canonical) throw new Error(`Base edge endpoint is missing: ${id}`);
    const projected = { ...canonical, label: compactViewLabel(canonical.label) };
    projectedBaseNodes.set(id, projected);
    return projected;
  };
  const moduleById = new Map(analysis.moduleGraph.nodes.map((node) => [node.id, node]));
  const goById = new Map(analysis.goModuleGraph.nodes.map((node) => [node.id, node]));
  const routes = analysis.routeGraph.routes.filter((route) => paths.has(route.sourcePath));
  const handlers = analysis.routeGraph.handlers.filter((handler) => paths.has(handler.sourcePath));
  const routeIds = new Set(routes.map((route) => route.id));
  const handlerIds = new Set(handlers.map((handler) => handler.id));
  for (const route of routes) addNode({ id: route.id, kind: "api", label: compactViewLabel(`${route.method} ${route.path}`), runtimeUnit: route.packageId, sourcePaths: [route.sourcePath], signalIds: [], evidence: evidenceFromIds(analysis.routeGraph.evidenceRecords, route.evidenceIds) }, route.evidenceIds);
  for (const handler of handlers) addNode({ id: handler.id, kind: "worker", label: compactViewLabel(handler.name, 22), runtimeUnit: handler.packageId, sourcePaths: [handler.sourcePath], signalIds: [], evidence: evidenceFromIds(analysis.routeGraph.evidenceRecords, handler.evidenceIds) }, handler.evidenceIds);
  const edges = new Map<string, EdgeFact>();
  const addEdge = (edge: EdgeFact, ids: string[]) => { addViewEdge(edges, edge); mergeEvidenceIds(evidenceIds, edge.id, ids); };
  const omissions: ArchitectureFactSet["omissions"] = [];
  for (const edge of analysis.routeGraph.edges.filter((candidate) => routeIds.has(candidate.from) && handlerIds.has(candidate.to))) {
    addEdge({ id: edge.id, from: edge.from, to: edge.to, kind: "http", label: "route → handler", signalIds: [], evidence: evidenceFromIds(analysis.routeGraph.evidenceRecords, edge.evidenceIds) }, edge.evidenceIds);
  }
  for (const call of analysis.routeGraph.calls.filter((candidate) => handlerIds.has(candidate.from))) {
    if (call.toKind === "unresolved") {
      omissions.push({ signalId: call.id, reason: "unsupported", detail: `Unresolved handler call ${call.source}` });
      continue;
    }
    const evidence = evidenceFromIds(analysis.evidence.records, call.evidenceIds);
    let target = nodes.get(call.to);
    if (!target && call.toKind === "module") {
      const canonical = moduleById.get(call.to);
      if (!canonical) throw new Error(`Handler call module target is missing: ${call.to}`);
      target = moduleNode(canonical, moduleNodeEvidence(analysis, canonical.id));
    }
    if (!target && call.toKind === "package") {
      const canonical = goById.get(call.to);
      if (!canonical) throw new Error(`Handler call package target is missing: ${call.to}`);
      target = goPackageNode(canonical, moduleNodeEvidence(analysis, canonical.id, true));
    }
    if (!target && (call.toKind === "store" || call.toKind === "job")) {
      const canonical = baseNodeById.get(call.to);
      if (!canonical) throw new Error(`Handler call ${call.toKind} target is missing: ${call.to}`);
      target = { ...canonical, label: compactViewLabel(canonical.label) };
    }
    if (!target) target = externalNode(call.to, call.source, evidence);
    const targetEvidenceIds = call.toKind === "module" ? [...call.evidenceIds, ...moduleNodeEvidenceIds(analysis, target.id)] : call.toKind === "package" ? [...call.evidenceIds, ...moduleNodeEvidenceIds(analysis, target.id, true)] : call.toKind === "store" || call.toKind === "job" ? [...call.evidenceIds, ...(baseEvidenceIds.get(target.id) ?? [])] : call.evidenceIds;
    addNode(target, targetEvidenceIds);
    addEdge({ id: call.id, from: call.from, to: target.id, kind: "process", label: `call ${call.source}`, signalIds: [], evidence }, call.evidenceIds);
  }
  const reachablePaths = new Set(paths);
  const moduleByPath = new Map(analysis.moduleGraph.nodes.map((node) => [node.path, node]));
  const moduleOutgoing = new Map<string, string[]>();
  for (const edge of analysis.moduleGraph.edges) if (edge.toKind === "module") moduleOutgoing.set(edge.from, [...(moduleOutgoing.get(edge.from) ?? []), edge.to]);
  const pending = [...paths].map((path) => moduleByPath.get(path)?.id).filter((id): id is string => id !== undefined);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const target of moduleOutgoing.get(current) ?? []) {
      if (visited.has(target)) continue;
      const node = moduleById.get(target);
      if (node) reachablePaths.add(node.path);
      pending.push(target);
    }
  }
  const hasExactRuntime = (operation: OperationFact) => {
    if (!operation.callSite) return false;
    const path = operation.callSite.replace(/:\d+$/, "");
    return analysis.facts.nodes.some((node) => node.id !== runtime.id && ["frontend", "api", "worker", "agent", "cli"].includes(node.kind) && ((node.sourcePaths ?? []).includes(path) || node.evidence.some((item) => item.path === path)));
  };
  const belongsToRuntime = (operation: OperationFact) => {
    if (operation.callSite && paths.has(operation.callSite.replace(/:\d+$/, ""))) return true;
    if (operation.owner === runtime.id) return true;
    if (hasExactRuntime(operation)) return false;
    return operation.callSite ? reachablePaths.has(operation.callSite.replace(/:\d+$/, "")) : false;
  };
  const operations = analysis.ir.operations.filter((operation) => {
    if (operation.kind === "config-binding") {
      if (paths.has(operation.usedAt.replace(/:\d+$/, ""))) return true;
      const primary = analysis.ir.operations.find((candidate) => candidate.id === operation.id.slice(0, -":config".length));
      return primary ? belongsToRuntime(primary) : false;
    }
    return belongsToRuntime(operation);
  });
  if (operations.length > 0) addNode({ ...runtime, label: compactViewLabel(runtime.label) }, baseEvidenceIds.get(runtime.id) ?? []);
  const operationEdgeIndex = baseEdgeEvidenceIndex(analysis.facts, analysis.evidence.records);
  for (const operation of operations) {
    const matches = matchedBaseEdges(operation, operationEdgeIndex);
    for (const edge of matches) {
      for (const endpoint of [edge.from, edge.to]) addNode(baseViewNode(endpoint), baseEvidenceIds.get(endpoint) ?? []);
      addEdge(edge, baseEvidenceIds.get(edge.id) ?? []);
    }
    if (matches.length > 0) continue;
    const candidate = candidateForOperation(analysis, operation);
    if (candidate) {
      const evidence = [candidate.evidence, ...(candidate.configEvidence ? [candidate.configEvidence] : [])];
      const target = externalNode(`external:${candidate.identity}`, candidate.identity, evidence);
      addNode(target, operation.evidenceIds);
      const operationKind = candidateEdgeKind(candidate);
      const callback = candidate.operation?.kind === "callback";
      addEdge({ id: `flow:${runtime.id}:${candidate.identity}:${candidate.protocol}:${operationKind}`, from: callback ? target.id : runtime.id, to: callback ? runtime.id : target.id, kind: operationKind, label: `${candidate.protocol} ${operationKind}`, signalIds: [], evidence }, operation.evidenceIds);
      continue;
    }
    if (operation.kind === "queue") {
      const evidence = evidenceFromIds(analysis.evidence.records, operation.evidenceIds);
      const topic = operation.topic || "async";
      const queueId = `queue:${topic}`;
      const queue = baseNodeById.get(queueId) ?? externalNode(queueId, topic, evidence, "queue");
      addNode(queue, [...operation.evidenceIds, ...(baseEvidenceIds.get(queue.id) ?? [])]);
      const consume = ["consume", "receive", "subscribe", "dequeue", "process"].includes(operation.action);
      addEdge({ id: `flow:${runtime.id}:queue:${topic}:${operation.action}`, from: consume ? queue.id : runtime.id, to: consume ? runtime.id : queue.id, kind: consume ? "poll" : "process", label: `queue ${operation.action} ${topic}`, signalIds: [], evidence }, operation.evidenceIds);
      continue;
    }
    if (operation.kind === "schedule") {
      const evidence = evidenceFromIds(analysis.evidence.records, operation.evidenceIds);
      const jobId = `job:${operation.jobOwner}`;
      const job = baseNodeById.get(jobId) ?? externalNode(jobId, operation.jobOwner, evidence, "worker");
      addNode(job, [...operation.evidenceIds, ...(baseEvidenceIds.get(job.id) ?? [])]);
      addEdge({ id: `flow:${runtime.id}:schedule:${operation.jobOwner}:${operation.schedule}`, from: runtime.id, to: job.id, kind: "schedule", label: `schedule ${operation.schedule}`, signalIds: [], evidence }, operation.evidenceIds);
      continue;
    }
    if (operation.kind === "sql") {
      const evidence = evidenceFromIds(analysis.evidence.records, operation.evidenceIds);
      const database = baseNodeById.get(`store:${operation.driver}`) ?? baseNodeById.get(`database:${operation.driver}`) ?? externalNode(`store:${operation.driver}`, operation.driver, evidence, "database");
      addNode(database, [...operation.evidenceIds, ...(baseEvidenceIds.get(database.id) ?? [])]);
      addEdge({ id: `flow:${runtime.id}:sql:${operation.driver}:${operation.action}`, from: runtime.id, to: database.id, kind: "sql", label: `SQL ${operation.action} ${operation.driver}`, signalIds: [], evidence }, operation.evidenceIds);
      continue;
    }
    omissions.push({ signalId: operation.id, reason: "unsupported", detail: `Operation has no semantic edge projection: ${operation.id}` });
  }
  const sortedNodes = [...nodes.values()].map((node) => ({ ...node, sourcePaths: [...(node.sourcePaths ?? [])].sort() })).sort((a, b) => a.id.localeCompare(b.id));
  const projectedEdges = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  const facts = architectureFactSetSchema.parse({
    version: 1,
    revision: analysis.ir.revision,
    roots: routes.length > 0 ? routes.map((route) => route.id) : operations.length > 0 ? [runtime.id] : sortedNodes[0] ? [sortedNodes[0].id] : [],
    nodes: sortedNodes,
    edges: projectedEdges,
    omissions,
  });
  return {
    facts,
    operations,
    evidenceIds,
  };
}

function aggregateEdges(facts: ArchitectureFactSet): { facts: ArchitectureFactSet; groups: Map<string, { ids: string[]; evidence: EdgeFact["evidence"] }> } {
  const grouped = new Map<string, EdgeFact[]>();
  for (const edge of facts.edges) {
    const key = `${edge.from}|${edge.to}|${edge.kind}`;
    grouped.set(key, [...(grouped.get(key) ?? []), edge]);
  }
  const groups = new Map<string, { ids: string[]; evidence: EdgeFact["evidence"] }>();
  const edges = [...grouped.values()].sort((a, b) => a[0].id.localeCompare(b[0].id)).map((members) => {
    const first = members[0];
    const id = `aggregate:${createHash("sha256").update(`${first.from}|${first.to}|${first.kind}`).digest("hex").slice(0, 16)}`;
    const originalIds = members.map((edge) => edge.id).sort();
    const evidence = [...new Map(members.flatMap((edge) => edge.evidence).map((item) => [`${item.path}:${item.line}:${item.detector}`, item])).values()];
    groups.set(id, { ids: originalIds, evidence });
    return { ...first, id, label: members.length > 1 ? `import ×${members.length}` : "import", evidence };
  });
  return { facts: { ...facts, edges }, groups };
}

function boundedPageFacts(facts: ArchitectureFactSet, operations: OperationFact[], pageSize: number, sourceEvidenceIds: EvidenceIdMap, analysis: Analysis, kind: ViewKind): ViewPage[] {
  const limit = Math.max(2, pageSize);
  const operationProjections = buildOperationProjections(analysis, facts, operations, sourceEvidenceIds);
  const pageEvidenceIds = new Map(sourceEvidenceIds);
  const grouped = kind === "modules" ? aggregateEdges(facts) : { facts, groups: new Map<string, { ids: string[]; evidence: EdgeFact["evidence"] }>() };
  if (kind === "modules") for (const [id, group] of grouped.groups) mergeEvidenceIds(pageEvidenceIds, id, group.ids.flatMap((originalId) => sourceEvidenceIds.get(originalId) ?? []));
  const nodes = [...facts.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, EdgeFact[]>();
  for (const edge of grouped.facts.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  const pages: Array<{ nodes: Map<string, NodeFact>; originalIds: Set<string>; edges: EdgeFact[] }> = [];
  let current = { nodes: new Map<string, NodeFact>(), originalIds: new Set<string>(), edges: [] as EdgeFact[] };
  const finish = () => {
    if (current.nodes.size > 0 || current.edges.length > 0) pages.push(current);
    current = { nodes: new Map<string, NodeFact>(), originalIds: new Set<string>(), edges: [] };
  };
  const aliasId = (id: string, page: number) => `${id}::alias-${page}`;
  const promote = (node: NodeFact) => {
    const pageNumber = pages.length + 1;
    const id = aliasId(node.id, pageNumber);
    if (current.nodes.has(id)) {
      current.nodes.delete(id);
      current.nodes.set(node.id, node);
      current.originalIds.add(node.id);
      current.edges = current.edges.map((edge) => ({ ...edge, from: edge.from === id ? node.id : edge.from, to: edge.to === id ? node.id : edge.to }));
      return;
    }
    if (current.nodes.size >= limit) finish();
    current.nodes.set(node.id, node);
    current.originalIds.add(node.id);
  };
  const promoteExisting = (node: NodeFact) => {
    const candidates = [...pages, current];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const id = aliasId(node.id, index + 1);
      if (!candidate.nodes.has(id)) continue;
      candidate.nodes.delete(id);
      candidate.nodes.set(node.id, node);
      candidate.originalIds.add(node.id);
      candidate.edges = candidate.edges.map((edge) => ({ ...edge, from: edge.from === id ? node.id : edge.from, to: edge.to === id ? node.id : edge.to }));
      return true;
    }
    return false;
  };
  const orderedNodes = [...nodes.filter((node) => (outgoing.get(node.id)?.length ?? 0) > 0), ...nodes.filter((node) => (outgoing.get(node.id)?.length ?? 0) === 0)];
  for (const node of orderedNodes) {
    if ((outgoing.get(node.id)?.length ?? 0) === 0 && promoteExisting(node)) continue;
    promote(node);
    for (const edge of [...(outgoing.get(node.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
      let pageNumber = pages.length + 1;
      let sourceId = current.originalIds.has(node.id) ? node.id : aliasId(node.id, pageNumber);
      const target = nodeById.get(edge.to);
      if (!target) throw new Error(`Paginated edge target is missing: ${edge.to}`);
      let targetId = current.originalIds.has(target.id) ? target.id : aliasId(target.id, pageNumber);
      const required = new Set([sourceId, targetId]);
      const missing = [...required].filter((id) => !current.nodes.has(id)).length;
      if (current.nodes.size + missing > limit) {
        finish();
        pageNumber = pages.length + 1;
        sourceId = aliasId(node.id, pageNumber);
        targetId = current.originalIds.has(target.id) ? target.id : aliasId(target.id, pageNumber);
      }
      if (!current.nodes.has(sourceId)) current.nodes.set(sourceId, sourceId === node.id ? node : { ...node, id: sourceId, label: `${node.label} (link)`, synthetic: true });
      if (!current.nodes.has(targetId)) current.nodes.set(targetId, targetId === target.id ? target : { ...target, id: targetId, label: `${target.label} (link)`, synthetic: true });
      if (!pageEvidenceIds.has(sourceId)) pageEvidenceIds.set(sourceId, sourceEvidenceIds.get(node.id) ?? []);
      if (!pageEvidenceIds.has(targetId)) pageEvidenceIds.set(targetId, sourceEvidenceIds.get(target.id) ?? []);
      current.edges.push({ ...edge, from: sourceId, to: targetId });
    }
  }
  finish();
  if (pages.length === 0) pages.push(current);
  const result = pages.map((page, index) => {
    const roots = facts.roots.filter((id) => page.originalIds.has(id));
    const allNodes = [...page.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (allNodes.length === 1) {
      const only = allNodes[0];
      const originalId = only.id.split(/::(?:alias|scope)-/)[0];
      allNodes.push({ ...only, id: `${originalId}::scope-${index + 1}`, label: "Scope", synthetic: true });
      pageEvidenceIds.set(`${originalId}::scope-${index + 1}`, pageEvidenceIds.get(originalId) ?? []);
    }
    return {
      id: `page-${index + 1}`,
      kind,
      owner: "",
      title: "",
      page: index + 1,
      totalPages: pages.length,
      facts: architectureFactSetSchema.parse({ version: 1, revision: facts.revision, roots: roots.length > 0 ? roots : allNodes[0] ? [allNodes[0].id] : [], nodes: allNodes, edges: page.edges, omissions: facts.omissions }),
      operations: index === 0 ? operations : [],
      edgeGroups: grouped.groups,
      operationProjections,
      sourceEvidenceIds: pageEvidenceIds,
    };
  });
  return result;
}

function pageFacts(facts: ArchitectureFactSet, operations: OperationFact[], pageSize: number, sourceEvidenceIds: EvidenceIdMap, analysis: Analysis, kind: ViewKind = "overview"): ViewPage[] {
  if (kind !== "overview") return boundedPageFacts(facts, operations, pageSize, sourceEvidenceIds, analysis, kind);
  const operationProjections = buildOperationProjections(analysis, facts, operations, sourceEvidenceIds);
  const pageEvidenceIds = new Map(sourceEvidenceIds);
  const nodes = [...facts.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const grouped = { facts, groups: new Map<string, { ids: string[]; evidence: EdgeFact["evidence"] }>() };
  const totalPages = Math.max(1, Math.ceil(nodes.length / pageSize));
  const pages: ViewPage[] = [];
  for (let page = 1; page <= totalPages; page += 1) {
    const pageNodes = nodes.slice((page - 1) * pageSize, page * pageSize);
    const nodeIds = new Set(pageNodes.map((node) => node.id));
    const aliases = new Map<string, NodeFact>();
    const edges = grouped.facts.edges.filter((edge) => nodeIds.has(edge.from)).map((edge) => {
      if (nodeIds.has(edge.to)) return edge;
      const original = facts.nodes.find((node) => node.id === edge.to);
      if (!original) return edge;
      const aliasId = `${edge.to}::alias-${page}`;
      if (!aliases.has(aliasId)) aliases.set(aliasId, { ...original, id: aliasId, label: `${original.label} (link)`, synthetic: true });
      pageEvidenceIds.set(aliasId, sourceEvidenceIds.get(original.id) ?? []);
      return { ...edge, to: aliasId };
    });
    const allNodes = [...pageNodes, ...aliases.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (allNodes.length === 1) {
      const only = allNodes[0];
      const originalId = only.id.split(/::(?:alias|scope)-/)[0];
      allNodes.push({ ...only, id: `${originalId}::scope-${page}`, label: "Scope", synthetic: true });
      pageEvidenceIds.set(`${originalId}::scope-${page}`, pageEvidenceIds.get(originalId) ?? []);
    }
    const roots = facts.roots.filter((root) => nodeIds.has(root));
    pages.push({
      id: `page:${page}`,
      kind: "overview",
      owner: "root",
      title: `Page ${page}`,
      page,
      totalPages,
      facts: architectureFactSetSchema.parse({ version: 1, revision: facts.revision, roots: roots.length > 0 ? roots : allNodes[0] ? [allNodes[0].id] : [], nodes: allNodes, edges, omissions: facts.omissions }),
      operations: page === 1 ? operations : [],
      edgeGroups: grouped.groups,
      operationProjections,
      sourceEvidenceIds: pageEvidenceIds,
    });
  }
  return pages;
}

function artifactStem(page: ViewPage) {
  if (page.kind === "overview") return page.page === 1 ? "architecture.overview" : `architecture.overview.${page.page}`;
  const ownerHash = createHash("sha256").update(page.owner).digest("hex").slice(0, 10);
  return `architecture.${page.kind}.${slug(page.owner)}-${ownerHash}.${page.page}`;
}

function sourceIds(page: ViewPage, ownerId: string) {
  const ids = page.sourceEvidenceIds.get(ownerId);
  if (!ids) throw new Error(`Missing projected evidence identity: ${ownerId}`);
  return ids;
}

function entitiesFor(page: ViewPage): ViewEntity[] {
  const nodeEntities = page.facts.nodes.map((node): ViewEntity => ({
    ownerType: "node",
    ownerId: node.id,
    projectionId: architectureProjectionId(node.id),
    irFactIds: [node.id],
    evidenceIds: sourceIds(page, node.id),
    representativeEvidenceIds: sourceIds(page, node.id).slice(0, 3),
    remainingEvidenceIds: sourceIds(page, node.id).slice(3),
    page: page.page,
    ...(node.id.includes("::alias-") || node.id.includes("::scope-") ? { aliasOf: node.id.split(/::(?:alias|scope)-/)[0] } : {}),
    selectionReason: node.synthetic ? "cross-page projection alias derived from the same IR node" : "original IR node evidence partition",
  }));
  const edgeEntities = page.facts.edges.map((edge): ViewEntity => {
    const group = page.edgeGroups?.get(edge.id);
    const originalIds = group?.ids ?? [edge.id];
    const evidenceIds = sourceIds(page, edge.id);
    return {
      ownerType: "edge",
      ownerId: edge.id,
      projectionId: architectureProjectionId(edge.id),
      irFactIds: originalIds,
      evidenceIds,
      representativeEvidenceIds: evidenceIds.slice(0, 3),
      remainingEvidenceIds: evidenceIds.slice(3),
      page: page.page,
      ...(group ? { aggregateOf: group.ids } : {}),
      selectionReason: group && group.ids.length > 1 ? `reversible aggregation of ${group.ids.length} IR edges; aggregateOf retains every original edge ID` : group ? "single IR edge projection with aggregateOf identity" : "original IR edge evidence partition",
    };
  });
  const operationEntities = page.operations.map((operation): ViewEntity => ({
    ownerType: "operation",
    ownerId: operation.id,
    relatedProjectionIds: page.operationProjections?.get(operation.id) ?? [],
    irFactIds: [operation.id],
    evidenceIds: operation.evidenceIds,
    representativeEvidenceIds: operation.evidenceIds.slice(0, 3),
    remainingEvidenceIds: operation.evidenceIds.slice(3),
    page: page.page,
    selectionReason: operation.kind === "config-binding" ? "manifest-only config-binding evidence; relatedProjectionIds reference the primary operation's semantic edges" : "unaggregated operation evidence with related semantic edge projections",
  }));
  return [...nodeEntities, ...edgeEntities, ...operationEntities];
}

function detailOwnersFor(details: ViewManifestBuild["detailFacts"]): ViewDetailOwner[] {
  return details.map((projection) => ({
    scope: projection.scope,
    owner: projection.owner,
    nodeIds: [...new Set(projection.facts.nodes.map((node) => node.id))].sort(),
    edgeIds: [...new Set(projection.facts.edges.map((edge) => edge.id))].sort(),
    operationIds: [...new Set(projection.operations.map((operation) => operation.id))].sort(),
  }));
}

export function validateViewManifest(manifest: ViewManifest, pages: ViewPage[], evidence: EvidenceRecord[], ir?: ArchitectureIr, details?: ViewManifestBuild["detailFacts"]): ViewRoundtrip {
  const missing = new Set<string>();
  const duplicates = new Set<string>();
  const dangling = new Set<string>();
  const evidenceIds = new Set(evidence.map((record) => record.id));
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const originalNodeIds = new Set(pages.flatMap((page) => page.facts.nodes.filter((node) => !node.id.includes("::alias-") && !node.id.includes("::scope-")).map((node) => node.id)));
  const expectedViews = new Set(pages.map((page) => `${page.kind}:${page.owner}`));
  const actualViews = new Set<string>();
  for (const page of pages) {
    const view = manifest.views.find((candidate) => candidate.kind === page.kind && candidate.owner === page.owner);
    if (!view) {
      missing.add(`${page.kind}:${page.owner}`);
      continue;
    }
    if (!view.pages.some((entry) => entry.page === page.page)) missing.add(`${page.kind}:${page.owner}:${page.page}`);
  }
  for (const view of manifest.views) {
    const viewKey = `${view.kind}:${view.owner}`;
    if (actualViews.has(viewKey)) duplicates.add(viewKey);
    actualViews.add(viewKey);
    if (!expectedViews.has(viewKey)) missing.add(viewKey);
    if (view.id !== viewKey) missing.add(`${viewKey}:view-id`);
    const seen = new Map<string, string>();
    const viewEdgeProjectionIds = new Set(view.pages.flatMap((entry) => entry.entities.filter((entity) => entity.ownerType === "edge").map((entity) => entity.projectionId)));
    for (const entry of view.pages) {
      const page = pageById.get(`${view.kind}:${view.owner}:${entry.page}`);
      if (!page) { missing.add(`${view.kind}:${view.owner}:${entry.page}`); continue; }
      if (entry.totalPages !== page.totalPages || entry.totalPages !== view.pages.length) missing.add(`${viewKey}:${entry.page}:page-total`);
      if (entry.json !== `${artifactStem(page)}.json` || entry.html !== `${artifactStem(page)}.html`) missing.add(`${viewKey}:${entry.page}:artifact-path`);
      const nodeIds = new Set(page.facts.nodes.map((node) => node.id));
      const edgeIds = new Set(page.facts.edges.map((edge) => edge.id));
      const operationIds = new Set(page.operations.map((operation) => operation.id));
      const nodeById = new Map(page.facts.nodes.map((node) => [node.id, node]));
      const edgeById = new Map(page.facts.edges.map((edge) => [edge.id, edge]));
      const operationById = new Map(page.operations.map((operation) => [operation.id, operation]));
      const entryNodeIds = new Set(entry.nodeIds);
      const entryEdgeIds = new Set(entry.edgeIds);
      const entryOperationIds = new Set(entry.operationIds);
      const entityOwnerIds = new Set(entry.entities.map((entity) => entity.ownerId));
      if (entityOwnerIds.size !== entry.entities.length) duplicates.add(`${viewKey}:${entry.page}:entity-owner`);
      for (const id of nodeIds) if (!entryNodeIds.has(id) || !entityOwnerIds.has(id)) missing.add(id);
      for (const id of edgeIds) if (!entryEdgeIds.has(id) || !entityOwnerIds.has(id)) missing.add(id);
      for (const id of operationIds) if (!entryOperationIds.has(id) || !entityOwnerIds.has(id)) missing.add(id);
      for (const id of entry.nodeIds) if (!nodeIds.has(id)) missing.add(id);
      for (const id of entry.edgeIds) if (!edgeIds.has(id)) missing.add(id);
      for (const id of entry.operationIds) if (!operationIds.has(id)) missing.add(id);
      for (const entity of entry.entities) {
        const node = nodeById.get(entity.ownerId);
        const edge = edgeById.get(entity.ownerId);
        const operation = operationById.get(entity.ownerId);
        const expectedOwnerType = node ? "node" : edge ? "edge" : operation ? "operation" : undefined;
        if (!expectedOwnerType || entity.ownerType !== expectedOwnerType) missing.add(`${entity.ownerId}:owner-mapping`);
        if (entity.page !== entry.page) missing.add(`${entity.ownerId}:page-mapping`);
        if (expectedOwnerType === "operation") {
          if (entity.projectionId !== undefined) missing.add(`${entity.ownerId}:projection-mapping`);
          const expectedRelated = operation ? page.operationProjections?.get(operation.id) ?? [] : [];
          if ([...(entity.relatedProjectionIds ?? [])].sort().join("|") !== [...expectedRelated].sort().join("|")) missing.add(`${entity.ownerId}:operation-projection`);
          for (const id of expectedRelated) if (!viewEdgeProjectionIds.has(id)) missing.add(`${entity.ownerId}:operation-projection-target`);
          const requiresProjection = view.kind === "flows" && operation && (["graphql", "queue", "schedule", "sql"].includes(operation.kind) || (operation.kind === "http" && operation.path === ""));
          if (requiresProjection && expectedRelated.length === 0) missing.add(`${entity.ownerId}:operation-projection-missing`);
        } else {
          if (entity.projectionId !== architectureProjectionId(entity.ownerId)) missing.add(`${entity.ownerId}:projection-mapping`);
          if (entity.relatedProjectionIds !== undefined) missing.add(`${entity.ownerId}:operation-projection`);
        }
        const group = edge ? page.edgeGroups?.get(edge.id) : undefined;
        const expectedIrFactIds = node ? [node.id] : edge ? group?.ids ?? [edge.id] : operation ? [operation.id] : [];
        if (entity.irFactIds.length === 0 || [...entity.irFactIds].sort().join("|") !== [...expectedIrFactIds].sort().join("|")) missing.add(`${entity.ownerId}:fact-mapping`);
        const expectedAggregate = group?.ids;
        if ((entity.aggregateOf === undefined) !== (expectedAggregate === undefined) || (entity.aggregateOf && expectedAggregate && [...entity.aggregateOf].sort().join("|") !== [...expectedAggregate].sort().join("|"))) missing.add(`${entity.ownerId}:aggregate-mapping`);
        const expectedAlias = node && (node.id.includes("::alias-") || node.id.includes("::scope-")) ? node.id.split(/::(?:alias|scope)-/)[0] : undefined;
        if (entity.aliasOf !== expectedAlias) missing.add(`${entity.ownerId}:alias-mapping`);
        if (expectedAlias && !originalNodeIds.has(expectedAlias)) missing.add(expectedAlias);
        const expectedEvidence = node || edge ? sourceIds(page, entity.ownerId) : operation?.evidenceIds ?? [];
        if ([...entity.evidenceIds].sort().join("|") !== [...expectedEvidence].sort().join("|")) missing.add(`${entity.ownerId}:evidence-mapping`);
        for (const id of entity.irFactIds) {
          if (!nodeIds.has(id) && !edgeIds.has(id) && !operationIds.has(id) && !entity.aliasOf && !entity.aggregateOf) missing.add(id);
          if (entity.aliasOf) continue;
          if (seen.has(id)) duplicates.add(id);
          seen.set(id, entity.ownerId);
        }
        const partition = [...entity.representativeEvidenceIds, ...entity.remainingEvidenceIds];
        if (partition.length !== entity.evidenceIds.length || new Set(partition).size !== partition.length || [...partition].sort().join("|") !== [...entity.evidenceIds].sort().join("|")) missing.add(`${entity.ownerId}:evidence-partition`);
        for (const id of entity.evidenceIds) if (!evidenceIds.has(id)) dangling.add(id);
      }
    }
  }
  if (ir) {
    const projectedIds = new Set(manifest.views.flatMap((view) => view.pages.flatMap((entry) => entry.entities.flatMap((entity) => entity.irFactIds))));
    const projectedByKind = new Map<ViewKind, Set<string>>();
    for (const kind of ["overview", "modules", "flows"] as const) {
      projectedByKind.set(kind, new Set(manifest.views.filter((view) => view.kind === kind).flatMap((view) => view.pages.flatMap((entry) => entry.entities.flatMap((entity) => entity.irFactIds)))));
    }
    for (const node of ir.nodes) {
      const kind = node.scope === "module-architecture" ? "modules" : node.scope === "protocol-flows" ? "flows" : node.scope === "runtime-overview" ? "overview" : undefined;
      if (kind ? !projectedByKind.get(kind)?.has(node.id) : !projectedIds.has(node.id)) missing.add(node.id);
    }
    for (const fact of [...ir.edges, ...ir.operations]) if (!projectedIds.has(fact.id)) missing.add(fact.id);
  }
  const manifestDetails = manifest.detailOwners ?? [];
  const independentDetails = details ? detailOwnersFor(details) : ir?.viewOwners;
  const expectedDetails = independentDetails ?? manifestDetails;
  if (ir && !details && (!ir.viewOwners || ir.viewOwners.length === 0)) missing.add("detail-ownership-required");
  if (independentDetails) {
    const expected = independentDetails;
    const scopes = new Set(expected.map((projection) => projection.scope));
    const actual = manifestDetails.filter((projection) => scopes.has(projection.scope));
    for (const projection of expected) {
      const match = actual.find((candidate) => candidate.scope === projection.scope && candidate.owner === projection.owner);
      if (!match || match.nodeIds.join("|") !== projection.nodeIds.join("|") || match.edgeIds.join("|") !== projection.edgeIds.join("|") || match.operationIds.join("|") !== projection.operationIds.join("|")) missing.add(`${projection.scope}:${projection.owner}:detail-owner-mapping`);
    }
    for (const projection of actual) if (!expected.some((candidate) => candidate.scope === projection.scope && candidate.owner === projection.owner)) missing.add(`${projection.scope}:${projection.owner}:unexpected-detail-owner`);
  }
  for (const projection of expectedDetails) {
    const kind = projection.scope === "module-architecture" ? "modules" : "flows";
    const view = manifest.views.find((candidate) => candidate.kind === kind && candidate.owner === projection.owner);
    if (!view) {
      missing.add(`${kind}:${projection.owner}`);
      continue;
    }
    const projectedIds = new Set(view.pages.flatMap((entry) => entry.entities.flatMap((entity) => entity.irFactIds)));
    for (const id of [...projection.nodeIds, ...projection.edgeIds, ...projection.operationIds]) if (!projectedIds.has(id)) missing.add(id);
  }
  return viewRoundtripSchema.parse({ ok: missing.size === 0 && duplicates.size === 0 && dangling.size === 0, missingFactIds: [...missing].sort(), duplicateFactIds: [...duplicates].sort(), danglingEvidenceIds: [...dangling].sort() });
}

export function buildViewManifest(analysis: Analysis, pageSize = 48): ViewManifestBuild {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("View page size must be a positive integer");
  const runtimeNodes = analysis.facts.nodes.filter((node) => ["frontend", "api", "worker", "agent", "cli"].includes(node.kind));
  const detailFacts: ViewManifestBuild["detailFacts"] = [];
  const pages: ViewPage[] = [];
  const overview = pageFacts(analysis.facts, analysis.ir.operations, pageSize, baseEvidenceIdMap(analysis.facts), analysis);
  for (const page of overview) {
    const id = `overview:root:${page.page}`;
    pages.push({ ...page, id, kind: "overview", owner: "root", title: "Runtime Overview" });
  }
  for (const runtime of runtimeNodes) {
    const owner = runtime.id;
    const module = moduleViewFacts(analysis, runtime);
    if (module.facts.nodes.length > 0) {
      detailFacts.push({ facts: module.facts, scope: "module-architecture", owner, operations: module.operations, evidenceIds: module.evidenceIds });
      for (const page of pageFacts(module.facts, module.operations, pageSize, module.evidenceIds, analysis, "modules")) {
        pages.push({ ...page, id: `modules:${owner}:${page.page}`, kind: "modules", owner, title: `${runtime.label} Modules` });
      }
    }
    const flow = flowViewFacts(analysis, runtime);
    if (flow.facts.nodes.length > 0) {
      detailFacts.push({ facts: flow.facts, scope: "protocol-flows", owner, operations: flow.operations, evidenceIds: flow.evidenceIds });
      for (const page of pageFacts(flow.facts, flow.operations, Math.min(pageSize, 16), flow.evidenceIds, analysis, "flows")) {
        pages.push({ ...page, id: `flows:${owner}:${page.page}`, kind: "flows", owner, title: `${runtime.label} Flows` });
      }
    }
  }
  for (const page of pages) for (const ids of page.sourceEvidenceIds.values()) ids.sort();
  for (const projection of detailFacts) for (const ids of projection.evidenceIds.values()) ids.sort();
  const views = [...new Map(pages.map((page) => [`${page.kind}:${page.owner}`, page])).values()].map((page) => ({
    id: `${page.kind}:${page.owner}`,
    kind: page.kind,
    owner: page.owner,
    title: page.title,
    pages: pages.filter((candidate) => candidate.kind === page.kind && candidate.owner === page.owner).sort((a, b) => a.page - b.page).map((candidate) => ({
      page: candidate.page,
      totalPages: candidate.totalPages,
      json: `${artifactStem(candidate)}.json`,
      html: `${artifactStem(candidate)}.html`,
      nodeIds: candidate.facts.nodes.map((node) => node.id),
      edgeIds: candidate.facts.edges.map((edge) => edge.id),
      operationIds: candidate.operations.map((operation) => operation.id),
      entities: entitiesFor(candidate),
    })),
  }));
  const artifactPaths = views.flatMap((view) => view.pages.flatMap((page) => [page.json, page.html]));
  if (new Set(artifactPaths).size !== artifactPaths.length) throw new Error("View artifact paths must be unique");
  const knownEvidence = new Map(analysis.evidence.records.map((record) => [record.id, record]));
  const projectedEvidenceIds = [...new Set(pages.flatMap((page) => [...page.sourceEvidenceIds.values()].flat()))].sort();
  for (const id of projectedEvidenceIds) if (!knownEvidence.has(id)) throw new Error(`Projected evidence is missing from the source index: ${id}`);
  const additionalEvidenceRecords = projectedEvidenceIds.filter((id) => !knownEvidence.has(id)).map((id) => knownEvidence.get(id)!);
  const detailOwners = detailOwnersFor(detailFacts);
  const manifest = viewManifestSchema.parse({ version: 1, revision: analysis.ir.revision, detailOwners, views, roundtrip: validateViewManifest({ version: 1, revision: analysis.ir.revision, detailOwners, views, roundtrip: { ok: true, missingFactIds: [], duplicateFactIds: [], danglingEvidenceIds: [] } }, pages, [...analysis.evidence.records, ...additionalEvidenceRecords]) });
  return { manifest, pages, additionalEvidenceRecords, detailFacts };
}
