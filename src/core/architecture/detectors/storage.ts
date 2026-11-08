import type { NodeFact } from "../facts.js";
import { architectureRuntimeSources, findArchitectureEvidence, signalIdsForPaths, uniqueEvidence } from "../source.js";
import { emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureDetector } from "./types.js";

const mysqlMarkers = ["sql.Open(\"mysql\"", "mysql2", "new PDO", "gorm.Open", "DB::", "CREATE TABLE", "provider = \"mysql\"", "provider=\"mysql\""];
const fileCacheMarkers = ["file_get_contents", "file_put_contents"];

function storageEvidence(context: ArchitectureContext, markers: string[], detector: string) {
  return uniqueEvidence(context.sources.flatMap((source) => {
    const match = findArchitectureEvidence(source, markers, detector);
    return match ? [match] : [];
  }));
}

function storageNode(context: ArchitectureContext, id: string, kind: NodeFact["kind"], label: string, markers: string[], detector: string, supportingMarkers: string[] = markers): NodeFact | undefined {
  const detected = storageEvidence(context, markers, detector);
  if (detected.length === 0) return undefined;
  const evidence = supportingMarkers === markers ? detected : storageEvidence(context, supportingMarkers, detector);
  return { id, kind, label, signalIds: signalIdsForPaths(context.signals, evidence.map((item) => item.path)), evidence };
}

function detectStorage(context: ArchitectureContext) {
  const fragment = emptyArchitectureFragment();
  const mysql = storageNode(context, "store:mysql", "database", "MySQL", mysqlMarkers, "mysql-usage", [...mysqlMarkers, "database/sql"]);
  const files = storageNode(context, "store:file-cache", "object-store", "文件缓存", fileCacheMarkers, "file-cache-usage");
  if (mysql) fragment.nodes.push(mysql);
  if (files) fragment.nodes.push(files);
  return fragment;
}

function storageCalls(node: NodeFact, context: ArchitectureContext, markers: string[], detector: string) {
  return uniqueEvidence(architectureRuntimeSources(node, context.sources).flatMap((source) => {
    const evidence = findArchitectureEvidence(source, markers, detector);
    return evidence ? [evidence] : [];
  }));
}

export function linkStorageRelationships(context: ArchitectureContext, nodes: NodeFact[]) {
  const storeIds = new Set(nodes.filter((node) => node.id.startsWith("store:")).map((node) => node.id));
  return nodes.filter((node) => !storeIds.has(node.id) && ["api", "worker", "agent", "cli"].includes(node.kind)).flatMap((node) => {
    const edges = [];
    if (storeIds.has("store:mysql")) {
      const evidence = storageCalls(node, context, ["store.Open", "sql.Open", "mysql2", "new PDO", "getDb(", "DB::", "new PrismaClient", "prisma."], "mysql-caller");
      if (evidence.length > 0) {
        const polling = node.kind === "worker" ? storageCalls(node, context, ["time.NewTicker", "for {", "POLL_INTERVAL", "ClaimRendering", "render-tasks"], "worker-database-poll") : [];
        const kind = polling.length > 0 ? "poll" : "sql";
        edges.push(factEdge(`${kind}:${node.id}->store:mysql`, node.id, "store:mysql", kind, kind === "poll" ? "轮询 / 更新任务" : "SQL 读写", uniqueEvidence([...evidence, ...polling])));
      }
    }
    if (storeIds.has("store:file-cache")) {
      const evidence = storageCalls(node, context, ["CacheManager", "file_get_contents", "file_put_contents"], "file-cache-caller");
      if (evidence.length > 0) edges.push(factEdge(`file:${node.id}->store:file-cache`, node.id, "store:file-cache", "file", "文件缓存读写", evidence));
    }
    return edges;
  });
}

export const storageArchitectureDetector: ArchitectureDetector = { id: "storage-usage", detect: detectStorage };
