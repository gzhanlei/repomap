import { architectureFactSetSchema, type ArchitectureFactSet, type EdgeFact, type NodeFact } from "./facts.js";
import { collectArchitectureSignals, type ArchitectureSignalInventory } from "./signals.js";
import { evaluateArchitectureCoverage } from "./coverage.js";
import { uniqueEvidence, isArchitectureSourcePath, type ArchitectureSource } from "./source.js";
import { nextArchitectureDetector } from "./detectors/next.js";
import { goArchitectureDetector } from "./detectors/go.js";
import { phpArchitectureDetector } from "./detectors/php.js";
import { linkStorageRelationships, storageArchitectureDetector } from "./detectors/storage.js";
import { externalArchitectureDetector, externalCallbackRelationships, linkExternalRelationships } from "./detectors/external.js";
import { miniProgramApiRelationships, miniProgramArchitectureDetector } from "./detectors/mini-program.js";
import { goInternalHttpRelationships } from "./detectors/go-http.js";
import { emptyArchitectureFragment, type ArchitectureContext, type ArchitectureFragment } from "./detectors/types.js";

const detectors = [nextArchitectureDetector, goArchitectureDetector, phpArchitectureDetector, miniProgramArchitectureDetector, storageArchitectureDetector, externalArchitectureDetector];

function uniqueStrings(values: string[]) {
  return [...new Set(values)].sort();
}

function mergeNodes(nodes: NodeFact[]) {
  const merged = new Map<string, NodeFact>();
  for (const node of nodes) {
    const existing = merged.get(node.id);
    if (!existing) {
      merged.set(node.id, node);
      continue;
    }
    if (existing.kind !== node.kind) throw new Error(`Conflicting architecture node kind: ${node.id}`);
    const existingPaths = existing.sourcePaths === undefined ? [] : existing.sourcePaths;
    const nodePaths = node.sourcePaths === undefined ? [] : node.sourcePaths;
    merged.set(node.id, {
      ...existing,
      signalIds: uniqueStrings([...existing.signalIds, ...node.signalIds]),
      sourcePaths: uniqueStrings([...existingPaths, ...nodePaths]),
      evidence: uniqueEvidence([...existing.evidence, ...node.evidence]),
    });
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mergeEdges(edges: EdgeFact[]) {
  const merged = new Map<string, EdgeFact>();
  for (const edge of edges) {
    const existing = merged.get(edge.id);
    if (!existing) {
      merged.set(edge.id, edge);
      continue;
    }
    if (existing.from !== edge.from || existing.to !== edge.to || existing.kind !== edge.kind) throw new Error(`Conflicting architecture relationship: ${edge.id}`);
    merged.set(edge.id, { ...existing, signalIds: uniqueStrings([...existing.signalIds, ...edge.signalIds]), evidence: uniqueEvidence([...existing.evidence, ...edge.evidence]) });
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function mergeArchitectureFragments(revision: string, fragments: ArchitectureFragment[]): ArchitectureFactSet {
  const nodes = mergeNodes(fragments.flatMap((fragment) => fragment.nodes));
  const edges = mergeEdges(fragments.flatMap((fragment) => fragment.edges));
  const roots = uniqueStrings(fragments.flatMap((fragment) => fragment.roots));
  const omissions = fragments.flatMap((fragment) => fragment.omissions);
  return architectureFactSetSchema.parse({ version: 1, revision, roots, nodes, edges, omissions });
}

function extractWithInventory(input: Pick<ArchitectureSignalInventory, "revision" | "scope">, sources: ArchitectureSource[], inventory: ArchitectureSignalInventory): ArchitectureFactSet {
  const context: ArchitectureContext = { ...input, sources, signals: inventory.signals };
  const fragments = detectors.map((detector) => detector.detect(context));
  const base = mergeArchitectureFragments(input.revision, fragments);
  const storageEdges = linkStorageRelationships(context, base.nodes);
  const relationshipEdges = [
    ...storageEdges,
    ...linkExternalRelationships(context, base.nodes),
    ...externalCallbackRelationships(context, base.nodes),
    ...miniProgramApiRelationships(context, base.nodes),
    ...goInternalHttpRelationships(context, base.nodes),
  ];
  const callbackRoots = relationshipEdges.filter((edge) => edge.kind === "callback").map((edge) => edge.from);
  return mergeArchitectureFragments(input.revision, [{ ...emptyArchitectureFragment(), nodes: base.nodes, edges: base.edges, roots: [...base.roots, ...callbackRoots], omissions: base.omissions }, { ...emptyArchitectureFragment(), edges: relationshipEdges }]);
}

export function analyzeArchitectureFacts(input: Pick<ArchitectureSignalInventory, "revision" | "scope">, sources: ArchitectureSource[]) {
  const runtimeSources = sources.filter((source) => isArchitectureSourcePath(source.path));
  const inventory = collectArchitectureSignals(input, runtimeSources);
  const facts = extractWithInventory(input, runtimeSources, inventory);
  const coverage = evaluateArchitectureCoverage(inventory, facts);
  return { inventory, facts, coverage };
}

export function extractArchitectureFacts(input: Pick<ArchitectureSignalInventory, "revision" | "scope">, sources: ArchitectureSource[]): ArchitectureFactSet {
  return analyzeArchitectureFacts(input, sources).facts;
}
