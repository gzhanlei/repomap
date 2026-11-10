import type { NodeFact } from "../facts.js";
import { architectureRuntimeSources, findArchitectureEvidence, findSemanticEvidence, isRuntimeEvidenceSource, signalIdsForEvidence, signalIdsForPaths, uniqueEvidence } from "../source.js";
import { emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureDetector } from "./types.js";

const mysqlMarkers = ["sql.Open(\"mysql\"", "mysql2", "new PDO", "gorm.Open", "DB::", "go-sql-driver/mysql", "provider = \"mysql\"", "provider=\"mysql\""];
const sqliteMarkers = ["go-sqlite3", "sqlite3_with_regex", "driverSQLite", "sqlite_master"];
const postgresMarkers = ["lib/pq", "pgx", "postgres", "postgresql"];
const fileCacheMarkers = ["file_get_contents", "file_put_contents"];

/** A migration or schema file can be huge; only lines with storage semantics are evidence. */
const schemaMarkers = [
  "CREATE TABLE", "ALTER TABLE", "CREATE INDEX", "DROP TABLE", "INSERT", "UPDATE", "DELETE", "SELECT",
  "PRAGMA", "BEGIN", "COMMIT", "ENGINE=InnoDB", "AUTO_INCREMENT", "utf8mb4", "AUTOINCREMENT",
  "sqlite_master", "INSERT OR REPLACE", "INTEGER PRIMARY KEY", "datasource", "provider", "sql.Open",
  "gorm.Open", "PrismaClient", "Migrate", "NewDatastore",
];
function storageEvidence(context: ArchitectureContext, markers: string[], detector: string) {
  return uniqueEvidence(context.sources.filter(isRuntimeEvidenceSource).flatMap((source) => {
    const match = findArchitectureEvidence(source, markers, detector);
    return match ? [match] : [];
  }));
}

function storageNode(context: ArchitectureContext, id: string, kind: NodeFact["kind"], label: string, markers: string[], detector: string, supportingMarkers: string[] = markers, supportingPaths?: (path: string) => boolean): NodeFact | undefined {
  const detected = storageEvidence(context, markers, detector);
  const pathEvidence = supportingPaths === undefined
    ? []
    : context.sources.filter((source) => isRuntimeEvidenceSource(source) && supportingPaths(source.path))
      .flatMap((source) => findSemanticEvidence(source, [...supportingMarkers, ...schemaMarkers], `${id}-schema`));
  const evidence = uniqueEvidence([...detected, ...pathEvidence]);
  if (evidence.length === 0) return undefined;
  return { id, kind, label, signalIds: signalIdsForPaths(context.signals, evidence.map((item) => item.path)), evidence };
}

function storageSchemaEvidence(context: ArchitectureContext, storeId: string) {
  const identity = storeId.replace("store:", "");
  return context.sources.filter((source) => {
    if (!isRuntimeEvidenceSource(source)) return false;
    if (source.path.toLowerCase().includes(identity)) return true;
    if (!source.path.toLowerCase().endsWith(".sql")) return false;
    const content = source.content.toLowerCase();
    if (identity === "mysql") return content.includes("engine=innodb") || content.includes("auto_increment") || content.includes("utf8mb4");
    if (identity === "sqlite") return content.includes("autoincrement") || content.includes("sqlite_master") || content.includes("insert or replace") || content.includes("integer primary key");
    if (identity === "postgres") return source.path.toLowerCase().includes("postgres");
    return false;
  }).flatMap((source) => findSemanticEvidence(source, schemaMarkers, `${storeId}-schema`));
}

function detectStorage(context: ArchitectureContext) {
  const fragment = emptyArchitectureFragment();
  const mysql = storageNode(context, "store:mysql", "database", "MySQL", mysqlMarkers, "mysql-usage", [...mysqlMarkers, "database/sql"]);
  const sqlite = storageNode(context, "store:sqlite", "database", "SQLite", sqliteMarkers, "sqlite-usage", sqliteMarkers, (path) => path.toLowerCase().includes("sqlite"));
  const postgres = storageNode(context, "store:postgres", "database", "PostgreSQL", postgresMarkers, "postgres-usage", postgresMarkers, (path) => path.toLowerCase().includes("postgres"));
  const files = storageNode(context, "store:file-cache", "object-store", "文件缓存", fileCacheMarkers, "file-cache-usage");
  for (const store of [mysql, sqlite, postgres].filter((value) => value !== undefined)) {
    const schemaEvidence = storageSchemaEvidence(context, store.id);
    store.evidence = uniqueEvidence([...store.evidence, ...schemaEvidence]);
    store.signalIds = signalIdsForPaths(context.signals, store.evidence.map((item) => item.path));
  }
  if (mysql) fragment.nodes.push(mysql);
  if (sqlite) fragment.nodes.push(sqlite);
  if (postgres) fragment.nodes.push(postgres);
  if (files) fragment.nodes.push(files);
  return fragment;
}

function storageCalls(node: NodeFact, context: ArchitectureContext, markers: string[], detector: string, storeId?: string, schemaOnly = false) {
  const runtimeEvidence = architectureRuntimeSources(node, context.sources)
    .filter(isRuntimeEvidenceSource)
    .flatMap((source) => findSemanticEvidence(source, markers, detector));
  if (runtimeEvidence.length === 0 && !schemaOnly) return [];
  const schemaEvidence = storeId === undefined ? [] : storageSchemaEvidence(context, storeId);
  return uniqueEvidence([...runtimeEvidence, ...schemaEvidence]);
}

export function linkStorageRelationships(context: ArchitectureContext, nodes: NodeFact[]) {
  const storeIds = new Set(nodes.filter((node) => node.id.startsWith("store:")).map((node) => node.id));
  const runtimeNodes = nodes.filter((node) => !storeIds.has(node.id) && ["api", "worker", "agent", "cli"].includes(node.kind));
  const primaryRuntime = runtimeNodes.find((node) => node.kind === "api") ?? runtimeNodes[0];
  const hasRuntimeEvidence = (markers: string[], detector: string) => runtimeNodes.some((node) => architectureRuntimeSources(node, context.sources).filter(isRuntimeEvidenceSource).some((source) => findArchitectureEvidence(source, markers, detector) !== undefined));
  const schemaOnlyTarget = (node: NodeFact, markers: string[], detector: string) => primaryRuntime?.id === node.id && !hasRuntimeEvidence(markers, detector);
  return runtimeNodes.flatMap((node) => {
    const edges = [];
    if (storeIds.has("store:mysql")) {
      const markers = ["store.Open", "sql.Open", "mysql2", "new PDO", "getDb(", "DB::", "new PrismaClient", "prisma.", "db.Begin", "db.Exec", "db.Query", "t.Exec", "t.Commit", "RunTransaction", "Migrate", "CreateSchema", "NewDatastore", "CREATE TABLE", "ALTER TABLE", "CREATE INDEX", "DROP TABLE", "INSERT", "UPDATE", "DELETE", "SELECT", "BEGIN", "COMMIT", "ROLLBACK"];
      const evidence = storageCalls(node, context, markers, "mysql-caller", "store:mysql", schemaOnlyTarget(node, markers, "mysql-caller"));
      if (evidence.length > 0) {
        const polling = node.kind === "worker" ? storageCalls(node, context, ["time.NewTicker", "for {", "POLL_INTERVAL", "ClaimRendering", "render-tasks"], "worker-database-poll") : [];
        const kind = polling.length > 0 ? "poll" : "sql";
        const relationshipEvidence = uniqueEvidence([...evidence, ...polling]);
        edges.push(factEdge(`${kind}:${node.id}->store:mysql`, node.id, "store:mysql", kind, kind === "poll" ? "轮询 / 更新任务" : "SQL 读写", relationshipEvidence, signalIdsForEvidence(context.signals, relationshipEvidence)));
      }
    }
    if (storeIds.has("store:sqlite")) {
      const markers = ["sql.Open", "go-sqlite3", "sqlite3_with_regex", "driverSQLite", "ConnectToDatabase", "db.Begin", "db.Exec", "db.Query", "t.Exec", "t.Commit", "RunTransaction", "Migrate", "CreateSchema", "NewDatastore", "CREATE TABLE", "ALTER TABLE", "CREATE INDEX", "DROP TABLE", "INSERT", "UPDATE", "DELETE", "SELECT", "BEGIN", "COMMIT", "ROLLBACK"];
      const evidence = storageCalls(node, context, markers, "sqlite-caller", "store:sqlite", schemaOnlyTarget(node, markers, "sqlite-caller"));
      if (evidence.length > 0) edges.push(factEdge(`sql:${node.id}->store:sqlite`, node.id, "store:sqlite", "sql", "SQLite 读写", uniqueEvidence(evidence), signalIdsForEvidence(context.signals, evidence)));
    }
    if (storeIds.has("store:postgres")) {
      const markers = ["sql.Open", "lib/pq", "pgx", "postgres", "db.Begin", "db.Exec", "db.Query", "t.Exec", "t.Commit", "RunTransaction", "Migrate", "CreateSchema", "NewDatastore", "CREATE TABLE", "ALTER TABLE", "CREATE INDEX", "DROP TABLE", "INSERT", "UPDATE", "DELETE", "SELECT", "BEGIN", "COMMIT", "ROLLBACK"];
      const evidence = storageCalls(node, context, markers, "postgres-caller", "store:postgres", schemaOnlyTarget(node, markers, "postgres-caller"));
      if (evidence.length > 0) edges.push(factEdge(`sql:${node.id}->store:postgres`, node.id, "store:postgres", "sql", "PostgreSQL 读写", uniqueEvidence(evidence), signalIdsForEvidence(context.signals, evidence)));
    }
    if (storeIds.has("store:file-cache")) {
      const evidence = storageCalls(node, context, ["CacheManager", "file_get_contents", "file_put_contents"], "file-cache-caller");
      if (evidence.length > 0) edges.push(factEdge(`file:${node.id}->store:file-cache`, node.id, "store:file-cache", "file", "文件缓存读写", evidence, signalIdsForEvidence(context.signals, evidence)));
    }
    return edges;
  });
}

export const storageArchitectureDetector: ArchitectureDetector = { id: "storage-usage", detect: detectStorage };
