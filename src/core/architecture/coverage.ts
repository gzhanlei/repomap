import { architectureFactSetSchema, type ArchitectureFactSet } from "./facts.js";
import { architectureSignalInventorySchema, architectureSignalKindSchema, type ArchitectureSignal, type ArchitectureSignalInventory, type ArchitectureSignalKind } from "./signals.js";

export interface CoverageMetric {
  total: number;
  covered: number;
  missingSignalIds: string[];
}

export interface ArchitectureCoverage {
  scope: ArchitectureSignalInventory["scope"];
  publishable: boolean;
  metrics: Record<ArchitectureSignalKind, CoverageMetric>;
  unclassifiedCriticalSignals: ArchitectureSignal[];
  unsupportedNodes: string[];
  unsupportedEdges: string[];
  unreachableRuntimeUnits: string[];
}

const runtimeNodeKinds = new Set(["frontend", "api", "worker", "agent", "cli", "database", "object-store", "queue"]);

function coveredSignalIds(facts: ArchitectureFactSet) {
  return new Set([...facts.nodes, ...facts.edges].flatMap((fact) => fact.signalIds));
}

function assertKnownSignals(inventory: ArchitectureSignalInventory, facts: ArchitectureFactSet) {
  const known = new Set(inventory.signals.map((signal) => signal.id));
  for (const id of coveredSignalIds(facts)) {
    if (!known.has(id)) throw new Error(`Unknown architecture signal: ${id}`);
  }
}

function coverageMetrics(inventory: ArchitectureSignalInventory, covered: Set<string>) {
  const signals = [...inventory.signals].sort((a, b) => a.id.localeCompare(b.id));
  return Object.fromEntries(architectureSignalKindSchema.options.map((kind) => {
    const matching = signals.filter((signal) => signal.kind === kind);
    const missingSignalIds = matching.filter((signal) => !covered.has(signal.id)).map((signal) => signal.id);
    return [kind, { total: matching.length, covered: matching.length - missingSignalIds.length, missingSignalIds }];
  })) as Record<ArchitectureSignalKind, CoverageMetric>;
}

function reachableNodes(facts: ArchitectureFactSet) {
  const reached = new Set(facts.roots);
  const pending = [...facts.roots];
  while (pending.length > 0) {
    const current = pending.shift() as string;
    for (const edge of facts.edges.filter((edge) => edge.from === current)) {
      if (reached.has(edge.to)) continue;
      reached.add(edge.to);
      pending.push(edge.to);
    }
  }
  return reached;
}

function architectureProblems(inventory: ArchitectureSignalInventory, facts: ArchitectureFactSet) {
  const covered = coveredSignalIds(facts);
  const reached = reachableNodes(facts);
  return {
    unclassifiedCriticalSignals: inventory.signals.filter((signal) => signal.critical && !covered.has(signal.id)).sort((a, b) => a.id.localeCompare(b.id)),
    unsupportedNodes: facts.nodes.filter((node) => node.kind !== "user" && node.synthetic !== true && node.evidence.length === 0).map((node) => node.id).sort(),
    unsupportedEdges: facts.edges.filter((edge) => edge.evidence.length === 0).map((edge) => edge.id).sort(),
    unreachableRuntimeUnits: facts.nodes.filter((node) => runtimeNodeKinds.has(node.kind) && !reached.has(node.id)).map((node) => node.id).sort(),
  };
}

type ArchitectureProblems = ReturnType<typeof architectureProblems>;

function isPublishable(inventory: ArchitectureSignalInventory, facts: ArchitectureFactSet, problems: ArchitectureProblems) {
  return [
    inventory.scope === "repository",
    facts.roots.length > 0,
    facts.nodes.length > 1,
    facts.edges.length > 0,
    ...Object.values(problems).map((problem) => problem.length === 0),
  ].every(Boolean);
}

export function evaluateArchitectureCoverage(inventoryInput: ArchitectureSignalInventory, factsInput: ArchitectureFactSet): ArchitectureCoverage {
  const inventory = architectureSignalInventorySchema.parse(inventoryInput);
  const facts = architectureFactSetSchema.parse(factsInput);
  if (inventory.revision !== facts.revision) throw new Error("Architecture inventory and facts must use the same revision");
  assertKnownSignals(inventory, facts);
  const problems = architectureProblems(inventory, facts);
  return {
    scope: inventory.scope,
    publishable: isPublishable(inventory, facts, problems),
    metrics: coverageMetrics(inventory, coveredSignalIds(facts)),
    ...problems,
  };
}
