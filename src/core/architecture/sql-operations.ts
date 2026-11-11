import { createHash } from "node:crypto";
import type { ArchitectureFactSet, ArchitectureEvidence } from "./facts.js";
import type { OperationFact } from "./ir.js";
import { evidenceRecord, type EvidenceReference } from "./evidence-index.js";
import { architectureLineNumber, type ArchitectureSource } from "./source.js";
import { irOmissionSchema, type IrOmission } from "./ir.js";
import { pythonCodeLines } from "./project/python-source.js";

function lineText(source: ArchitectureSource | undefined, line: number) {
  if (!source) return "";
  const lines = source.content.split("\n");
  return lines.find((item) => item.match(/^\s*\d+:\s?/)?.[0] && Number(item.match(/^\s*(\d+):/)?.[1]) === line) ?? lines[line - 1] ?? "";
}

function executableSqlEvidence(evidence: ArchitectureEvidence, source: ArchitectureSource | undefined) {
  if (!evidence.path.endsWith(".py")) return true;
  const text = lineText(source, evidence.line).replace(/^\s*\d+:\s?/, "").trim();
  if (!text || /^(?:from|import)\s+/.test(text) || /\bcreate_engine\s*\(/.test(text)) return false;
  if (/\b(?:session|cursor|conn|db|engine|op)\.[A-Za-z_][\w]*\s*\(/.test(text)) return true;
  return /["'](?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK)\b/i.test(text);
}

function lineContext(source: ArchitectureSource | undefined, line: number) {
  if (!source) return "";
  const lines = source.content.split("\n");
  return lines.slice(Math.max(0, line - 1), line + 8).join("\n");
}

function actionFor(evidence: ArchitectureEvidence, source: ArchitectureSource | undefined, edgeKind: string) {
  if (edgeKind === "poll") return "poll";
  const path = evidence.path.toLowerCase();
  const text = lineText(source, evidence.line).toUpperCase();
  const context = lineContext(source, evidence.line).toUpperCase();
  const migrationPath = /(?:^|\/)(?:migrations?|migrate|alembic|db\/migrate)(?:\/|$)/.test(path);
  const ddl = /CREATE TABLE|ALTER TABLE|CREATE INDEX|DROP TABLE/.test(text);
  if (migrationPath || (evidence.detector.includes("schema") && ddl)) return "migration";
  if (/\bSESSION\.(?:GET|QUERY)\s*\(/.test(text)) return "read";
  if (/\bSESSION\.(?:EXEC|EXECUTE)\s*\(/.test(text)) {
    if (/\bSELECT\b|\.(?:ALL|ONE|FIRST)\s*\(/.test(context)) return "read";
    if (/\b(?:INSERT|UPDATE|DELETE)\s*\(/.test(context)) return "write";
    return "read-write";
  }
  if (/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\.BEGIN\b|\.COMMIT\b|\.ROLLBACK\b/.test(text)) return "transaction";
  if (/\bSELECT\b|\.QUERY\b|\.SELECT\b/.test(text) || (/\b(?:CURSOR|CONN|DB|ENGINE)\.EXECUTE\s*\(/.test(text) && /\bSELECT\b/.test(context))) return "read";
  if (/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b|\bALTER\b|\bDROP\b|\.EXEC\b|\.WRITE\b|\.ADD\b|\.DELETE\b|MIGRATE|CREATESCHEMA|NEWDATASTORE/.test(text)) return "write";
  return "read-write";
}

function operationOwner(facts: ArchitectureFactSet, evidence: ArchitectureEvidence, edge: ArchitectureFactSet["edges"][number]) {
  const candidates = facts.nodes.filter((node) => ["frontend", "api", "worker", "agent", "cli"].includes(node.kind) && (node.sourcePaths ?? []).includes(evidence.path));
  if (candidates.length === 0) return edge.from;
  return candidates.sort((a, b) => (b.runtimeUnit?.length ?? 0) - (a.runtimeUnit?.length ?? 0) || a.id.localeCompare(b.id))[0].id;
}

export function sqlOperationFacts(facts: ArchitectureFactSet, sources: ArchitectureSource[]): OperationFact[] {
  const byPath = new Map(sources.map((source) => [source.path, source]));
  const operations = new Map<string, OperationFact>();
  for (const edge of facts.edges.filter((edge) => edge.to.startsWith("store:") && ["sql", "poll"].includes(edge.kind)).sort((a, b) => a.id.localeCompare(b.id))) {
    for (const evidence of edge.evidence) {
      if (!executableSqlEvidence(evidence, byPath.get(evidence.path))) continue;
      const action = actionFor(evidence, byPath.get(evidence.path), edge.kind);
      const text = lineText(byPath.get(evidence.path), evidence.line).toUpperCase();
      const migrationCall = action === "migration" && (/MIGRATE|CREATESCHEMA|NEWDATASTORE/.test(text) || /\bOP\.[A-Z_]+\s*\(/.test(text));
      // Schema/migration evidence attached to every runtime edge is one resource
      // operation, not N different runtime migrations. A real Migrate call keeps
      // its runtime owner; schema-only evidence belongs to the store itself.
      const owner = action === "migration" && !migrationCall ? edge.to : operationOwner(facts, evidence, edge);
      const driver = edge.to.replace(/^store:/, "");
      const id = `operation:sql:${createHash("sha256").update(`${driver}|${evidence.path}|${evidence.line}|${action}`).digest("hex").slice(0, 16)}`;
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

export function sqlOperationOmissions(facts: ArchitectureFactSet, sources: ArchitectureSource[]): IrOmission[] {
  const stores = new Set(facts.nodes.filter((node) => node.kind === "database" && node.id.startsWith("store:")).map((node) => node.id));
  if (stores.size <= 1) return [];
  const omissions: IrOmission[] = [];
  for (const source of sources.filter((item) => item.path.endsWith(".py"))) {
    const sanitized = { ...source, content: pythonCodeLines(source.content).join("\n") };
    const text = sanitized.content.toLowerCase();
    const drivers = new Set<string>();
    if (text.includes("sqlite")) drivers.add("sqlite");
    if (text.includes("postgres") || text.includes("psycopg") || text.includes("asyncpg")) drivers.add("postgres");
    if (text.includes("mysql")) drivers.add("mysql");
    sanitized.content.split("\n").forEach((line, index) => {
      const evidence = { path: source.path, line: architectureLineNumber(line, index), detector: "python-sql-operation" };
      if (!executableSqlEvidence(evidence, sanitized)) return;
      if (drivers.size === 1 && stores.has(`store:${[...drivers][0]}`)) return;
      omissions.push(irOmissionSchema.parse({
        id: `omission:python-sql-driver:${source.path}:${index + 1}`,
        owner: `python-sql:${source.path}:${index + 1}`,
        reason: "unknown-identity",
        detail: `Python SQL call has no unique database driver in a multi-store project: ${source.path}:${index + 1}`,
        declarationIds: [],
        evidenceIds: [evidenceRecord(evidence).id],
        affectedViews: ["protocol-flows", "full-declared-scope"],
        blocking: true,
      }));
    });
  }
  return omissions;
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
