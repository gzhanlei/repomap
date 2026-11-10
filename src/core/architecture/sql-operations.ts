import { createHash } from "node:crypto";
import type { ArchitectureFactSet, ArchitectureEvidence } from "./facts.js";
import type { OperationFact } from "./ir.js";
import { evidenceRecord, type EvidenceReference } from "./evidence-index.js";
import type { ArchitectureSource } from "./source.js";

function lineText(source: ArchitectureSource | undefined, line: number) {
  if (!source) return "";
  const lines = source.content.split("\n");
  return lines.find((item) => item.match(/^\s*\d+:\s?/)?.[0] && Number(item.match(/^\s*(\d+):/)?.[1]) === line) ?? lines[line - 1] ?? "";
}

function actionFor(evidence: ArchitectureEvidence, source: ArchitectureSource | undefined, edgeKind: string) {
  if (edgeKind === "poll") return "poll";
  const path = evidence.path.toLowerCase();
  const text = lineText(source, evidence.line).toUpperCase();
  const migrationPath = /(?:^|\/)(?:migrations?|migrate|alembic|db\/migrate)(?:\/|$)/.test(path);
  const ddl = /CREATE TABLE|ALTER TABLE|CREATE INDEX|DROP TABLE/.test(text);
  if (migrationPath || (evidence.detector.includes("schema") && ddl)) return "migration";
  if (/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\.BEGIN\b|\.COMMIT\b|\.ROLLBACK\b/.test(text)) return "transaction";
  if (/\bSELECT\b|\.QUERY\b|\.SELECT\b/.test(text)) return "read";
  if (/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b|\bALTER\b|\bDROP\b|\.EXEC\b|\.WRITE\b|MIGRATE|CREATESCHEMA|NEWDATASTORE/.test(text)) return "write";
  return "read-write";
}

export function sqlOperationFacts(facts: ArchitectureFactSet, sources: ArchitectureSource[]): OperationFact[] {
  const byPath = new Map(sources.map((source) => [source.path, source]));
  const operations = new Map<string, OperationFact>();
  for (const edge of facts.edges.filter((edge) => edge.to.startsWith("store:") && ["sql", "poll"].includes(edge.kind)).sort((a, b) => a.id.localeCompare(b.id))) {
    for (const evidence of edge.evidence) {
      const action = actionFor(evidence, byPath.get(evidence.path), edge.kind);
      const text = lineText(byPath.get(evidence.path), evidence.line).toUpperCase();
      const migrationCall = action === "migration" && /MIGRATE|CREATESCHEMA|NEWDATASTORE/.test(text);
      // Schema/migration evidence attached to every runtime edge is one resource
      // operation, not N different runtime migrations. A real Migrate call keeps
      // its runtime owner; schema-only evidence belongs to the store itself.
      const owner = action === "migration" && !migrationCall ? edge.to : edge.from;
      const driver = edge.to.replace(/^store:/, "");
      const id = `operation:sql:${createHash("sha256").update(`${owner}|${driver}|${evidence.path}|${evidence.line}|${action}`).digest("hex").slice(0, 16)}`;
      if (operations.has(id)) continue;
      operations.set(id, {
        id,
        kind: "sql",
        owner,
        declarationIds: [],
        evidenceIds: [evidenceRecord(evidence).id],
        targetKind: "database",
        resolution: "static",
        action,
        driver,
        callSite: `${evidence.path}:${evidence.line}`,
      });
    }
  }
  return [...operations.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function operationEvidenceReferences(operations: OperationFact[]): EvidenceReference[] {
  return operations.map((operation) => ({
    ownerType: "operation",
    ownerId: operation.id,
    evidenceIds: operation.evidenceIds,
    renderedEvidenceIds: operation.evidenceIds.slice(0, 3),
    remainingEvidenceIds: operation.evidenceIds.slice(3),
    selectionReason: "first three stable operation evidence IDs; complete operation evidence retained in the index",
  }));
}
