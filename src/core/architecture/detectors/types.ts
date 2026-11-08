import type { ArchitectureOmission, EdgeFact, NodeFact } from "../facts.js";
import type { ArchitectureSignalInventory } from "../signals.js";
import type { ArchitectureSource } from "../source.js";

export interface ArchitectureContext {
  revision: string;
  scope: ArchitectureSignalInventory["scope"];
  sources: ArchitectureSource[];
  signals: ArchitectureSignalInventory["signals"];
}

export interface ArchitectureFragment {
  nodes: NodeFact[];
  edges: EdgeFact[];
  roots: string[];
  omissions: ArchitectureOmission[];
}

export interface ArchitectureDetector {
  id: string;
  detect(context: ArchitectureContext): ArchitectureFragment;
}

export function emptyArchitectureFragment(): ArchitectureFragment {
  return { nodes: [], edges: [], roots: [], omissions: [] };
}

export function actorNode(id: "actor:users" | "actor:scheduler" | "actor:cli-users", label: string): NodeFact {
  return { id, kind: id === "actor:scheduler" ? "external" : "user", label, synthetic: true, signalIds: [], evidence: [] };
}

export function factEdge(id: string, from: string, to: string, kind: EdgeFact["kind"], label: string, evidence: EdgeFact["evidence"], signalIds: string[] = []): EdgeFact {
  return { id, from, to, kind, label, signalIds, evidence };
}
