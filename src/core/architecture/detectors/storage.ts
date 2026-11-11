import type { NodeFact } from "../facts.js";
import { architectureRuntimeSources, findArchitectureEvidence, findSemanticEvidence, isRuntimeEvidenceSource, signalIdsForEvidence, signalIdsForPaths, uniqueEvidence } from "../source.js";
import { emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureDetector } from "./types.js";
import { pythonCodeLines } from "../project/python-source.js";

const mysqlMarkers = ["sql.Open(\"mysql\"", "mysql2", "new PDO", "gorm.Open", "DB::", "go-sql-driver/mysql", "provider = \"mysql\"", "provider=\"mysql\"", "mysql.connector", "pymysql", "MySQLdb", "mysql://"];
const sqliteMarkers = ["go-sqlite3", "sqlite3_with_regex", "driverSQLite", "sqlite_master", "sqlite3", "sqlite3.connect", "sqlite://"];
const postgresMarkers = ["lib/pq", "pgx", "postgres", "postgresql", "psycopg", "psycopg2", "asyncpg", "postgres://", "postgresql://"];
const fileCacheMarkers = ["file_get_contents", "file_put_contents"];

function pythonSqlLineFilter(path: string, line: string) {
  if (!path.endsWith(".py")) return true;
  const code = line.replace(/^\s*\d+:\s?/, "").trim();
  if (code.startsWith("@") || /\b(?:requests|httpx)\./.test(code)) return false;
  if (/(?:^|\/)(?:alembic|migrations?|migrate)(?:\/|$)/i.test(path) && /(?:from\s+alembic\s+import|from\s+sqlalchemy\s+import|import\s+(?:sqlalchemy|sqlmodel)|engine_from_config)/i.test(code)) return true;
  if (/(?:execute|executemany|create_engine|commit|rollback|session\.(?:add|delete|query|get|exec|execute)|cursor\.execute|op\.(?:execute|create_table|drop_table|add_column|drop_column|alter_column|create_index|drop_index|create_foreign_key|drop_constraint|create_primary_key)|conn\.execute|db\.execute|engine\.execute)\s*\(/i.test(code)) return true;
  return /["'](?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK)\b/i.test(code);
}

function storageSourceContent(source: { path: string; content: string }) {
  return source.path.endsWith(".py") ? pythonCodeLines(source.content).join("\n") : source.content;
}

/** A migration or schema file can be huge; only lines with storage semantics are evidence. */
const schemaMarkers = [
  "CREATE TABLE", "ALTER TABLE", "CREATE INDEX", "DROP TABLE", "INSERT", "UPDATE", "DELETE", "SELECT",
  "PRAGMA", "BEGIN", "COMMIT", "ENGINE=InnoDB", "AUTO_INCREMENT", "utf8mb4", "AUTOINCREMENT",
  "sqlite_master", "INSERT OR REPLACE", "INTEGER PRIMARY KEY", "datasource", "provider", "sql.Open",
  "gorm.Open", "PrismaClient", "Migrate", "NewDatastore", "op.execute", "alembic", "create_engine", "sqlalchemy",
  // Alembic DDL helpers: pythonSqlLineFilter already treats these as executable
  // migration statements, so the marker list must match or their evidence rows
  // are silently dropped (authelia: 62 hand-audited op.* statements, 31 emitted).
  "op.alter_column", "add_column", "drop_column", "create_table", "drop_table",
  "create_index", "drop_index", "create_foreign_key", "drop_constraint", "create_primary_key",
];
function storageEvidence(context: ArchitectureContext, markers: string[], detector: string) {
  return uniqueEvidence(context.sources.filter(isRuntimeEvidenceSource).flatMap((source) => {
    const match = findArchitectureEvidence({ ...source, content: storageSourceContent(source) }, markers, detector);
    return match ? [match] : [];
  }));
}

function storageNode(context: ArchitectureContext, id: string, kind: NodeFact["kind"], label: string, markers: string[], detector: string, supportingMarkers: string[] = markers, supportingPaths?: (path: string) => boolean): NodeFact | undefined {
  const detected = storageEvidence(context, markers, detector);
  const pathEvidence = supportingPaths === undefined
    ? []
    : context.sources.filter((source) => isRuntimeEvidenceSource(source) && supportingPaths(source.path))
      .flatMap((source) => findSemanticEvidence({ ...source, content: storageSourceContent(source) }, [...supportingMarkers, ...schemaMarkers], `${id}-schema`));
  const evidence = uniqueEvidence([...detected, ...pathEvidence]);
  if (evidence.length === 0) return undefined;
  return { id, kind, label, signalIds: signalIdsForPaths(context.signals, evidence.map((item) => item.path)), evidence };
}

function storageSchemaEvidence(context: ArchitectureContext, storeId: string) {
  const identity = storeId.replace("store:", "");
  return context.sources.filter((source) => {
    if (!isRuntimeEvidenceSource(source)) return false;
    if (!source.path.endsWith(".py")) {
      if (/(?:^|\/)(?:alembic|migrations?|migrate)(?:\/|$)/i.test(source.path)) return true;
      if (source.path.toLowerCase().includes(identity)) return true;
      if (!source.path.toLowerCase().endsWith(".sql")) return false;
      const content = source.content.toLowerCase();
      if (identity === "mysql") return content.includes("engine=innodb") || content.includes("auto_increment") || content.includes("utf8mb4");
      if (identity === "sqlite") return content.includes("autoincrement") || content.includes("sqlite_master") || content.includes("insert or replace") || content.includes("integer primary key");
      if (identity === "postgres") return source.path.toLowerCase().includes("postgres");
      return false;
    }
    const hasIdentity = (text: string) => identity === "postgres"
      ? text.includes("postgres") || text.includes("psycopg") || text.includes("asyncpg")
      : identity === "mysql" ? text.includes("mysql") : identity === "sqlite" ? text.includes("sqlite") : false;
    const text = storageSourceContent(source).toLowerCase();
    const driverCount = [text.includes("sqlite"), text.includes("postgres") || text.includes("psycopg") || text.includes("asyncpg"), text.includes("mysql")].filter(Boolean).length;
    if (driverCount > 1) return false;
    if (hasIdentity(text)) return true;
    const root = source.path.match(/^(.*(?:alembic|migrations?|migrate)\/)/)?.[1];
    if (!root) return false;
    const treeDrivers = new Set<string>();
    for (const other of context.sources.filter((entry) => entry.path.startsWith(root))) {
      const otherText = storageSourceContent(other).toLowerCase();
      if (otherText.includes("sqlite")) treeDrivers.add("sqlite");
      if (otherText.includes("postgres") || otherText.includes("psycopg") || otherText.includes("asyncpg")) treeDrivers.add("postgres");
      if (otherText.includes("mysql")) treeDrivers.add("mysql");
    }
    return treeDrivers.size === 1 && treeDrivers.has(identity);
  }).flatMap((source) => findSemanticEvidence({ ...source, content: storageSourceContent(source) }, schemaMarkers, `${storeId}-schema`, (line) => pythonSqlLineFilter(source.path, line)));
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

function pythonDriverMatches(source: { path: string; content: string }, storeId: string | undefined, storeCount: number) {
  if (!storeId || !source.path.endsWith(".py")) return true;
  const text = storageSourceContent(source).toLowerCase();
  const drivers = new Set<string>();
  if (text.includes("sqlite")) drivers.add("sqlite");
  if (text.includes("postgres") || text.includes("psycopg") || text.includes("asyncpg")) drivers.add("postgres");
  if (text.includes("mysql")) drivers.add("mysql");
  const identity = storeId.replace(/^store:/, "");
  return drivers.size === 0 ? storeCount <= 1 : (drivers.size === 1 && drivers.has(identity));
}

function storageCalls(node: NodeFact, context: ArchitectureContext, markers: string[], detector: string, storeId?: string, schemaOnly = false, storeCount = 1) {
  const runtimeEvidence = architectureRuntimeSources(node, context.sources)
    .filter(isRuntimeEvidenceSource)
    .filter((source) => pythonDriverMatches(source, storeId, storeCount))
    .flatMap((source) => findSemanticEvidence({ ...source, content: storageSourceContent(source) }, [...markers, "session.get", "session.exec", "session.query"], detector, (line) => pythonSqlLineFilter(source.path, line)));
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
  const sqlStoreCount = ["store:mysql", "store:sqlite", "store:postgres"].filter((id) => storeIds.has(id)).length;
  return runtimeNodes.flatMap((node) => {
    const edges = [];
    if (storeIds.has("store:mysql")) {
      const markers = ["store.Open", "sql.Open", "mysql2", "new PDO", "getDb(", "DB::", "new PrismaClient", "prisma.", "db.Begin", "db.Exec", "db.Query", "t.Exec", "t.Commit", "RunTransaction", "Migrate", "CreateSchema", "NewDatastore", "execute", "executemany", "create_engine", "session.query", "session.add", "session.delete", "cursor.execute", "conn.execute", "db.execute", "session.execute", "commit", "rollback", "CREATE TABLE", "ALTER TABLE", "CREATE INDEX", "DROP TABLE", "INSERT", "UPDATE", "DELETE", "SELECT", "BEGIN", "COMMIT", "ROLLBACK"];
      const evidence = storageCalls(node, context, markers, "mysql-caller", "store:mysql", schemaOnlyTarget(node, markers, "mysql-caller"), sqlStoreCount);
      if (evidence.length > 0) {
        const polling = node.kind === "worker" ? storageCalls(node, context, ["time.NewTicker", "for {", "POLL_INTERVAL", "ClaimRendering", "render-tasks"], "worker-database-poll") : [];
        const kind = polling.length > 0 ? "poll" : "sql";
        const relationshipEvidence = uniqueEvidence([...evidence, ...polling]);
        edges.push(factEdge(`${kind}:${node.id}->store:mysql`, node.id, "store:mysql", kind, kind === "poll" ? "轮询 / 更新任务" : "SQL 读写", relationshipEvidence, signalIdsForEvidence(context.signals, relationshipEvidence)));
      }
    }
    if (storeIds.has("store:sqlite")) {
      const markers = ["sql.Open", "go-sqlite3", "sqlite3_with_regex", "driverSQLite", "ConnectToDatabase", "db.Begin", "db.Exec", "db.Query", "t.Exec", "t.Commit", "RunTransaction", "Migrate", "CreateSchema", "NewDatastore", "execute", "executemany", "create_engine", "session.query", "session.add", "session.delete", "cursor.execute", "conn.execute", "db.execute", "session.execute", "commit", "rollback", "CREATE TABLE", "ALTER TABLE", "CREATE INDEX", "DROP TABLE", "INSERT", "UPDATE", "DELETE", "SELECT", "BEGIN", "COMMIT", "ROLLBACK"];
      const evidence = storageCalls(node, context, markers, "sqlite-caller", "store:sqlite", schemaOnlyTarget(node, markers, "sqlite-caller"), sqlStoreCount);
      if (evidence.length > 0) edges.push(factEdge(`sql:${node.id}->store:sqlite`, node.id, "store:sqlite", "sql", "SQLite 读写", uniqueEvidence(evidence), signalIdsForEvidence(context.signals, evidence)));
    }
    if (storeIds.has("store:postgres")) {
      const markers = ["sql.Open", "lib/pq", "pgx", "postgres", "db.Begin", "db.Exec", "db.Query", "t.Exec", "t.Commit", "RunTransaction", "Migrate", "CreateSchema", "NewDatastore", "execute", "executemany", "create_engine", "session.query", "session.add", "session.delete", "cursor.execute", "conn.execute", "db.execute", "session.execute", "commit", "rollback", "CREATE TABLE", "ALTER TABLE", "CREATE INDEX", "DROP TABLE", "INSERT", "UPDATE", "DELETE", "SELECT", "BEGIN", "COMMIT", "ROLLBACK"];
      const evidence = storageCalls(node, context, markers, "postgres-caller", "store:postgres", schemaOnlyTarget(node, markers, "postgres-caller"), sqlStoreCount);
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
