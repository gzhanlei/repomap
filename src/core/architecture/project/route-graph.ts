import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExternalCandidate } from "../candidates.js";
import { evidenceRecord, evidenceRecordSchema, evidenceReferenceSchema, stableEvidenceId, type EvidenceRecord, type EvidenceReference } from "../evidence-index.js";
import { irOmissionSchema, type IrOmission, type OperationFact } from "../ir.js";
import { architectureViewSchema } from "../scope.js";

export const routeFrameworkSchema = z.enum(["next-app-router", "vite-react-router", "go-http"]);
export const routeSchema = z.object({
  id: z.string().min(1),
  framework: routeFrameworkSchema,
  method: z.string().min(1),
  path: z.string().min(1),
  sourcePath: z.string().min(1),
  line: z.number().int().positive(),
  packageId: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
}).strict();
export type RouteDefinition = z.infer<typeof routeSchema>;

export const handlerResolutionSchema = z.enum(["local", "re-export", "package", "inline", "external", "unresolved"]);
export const routeHandlerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourcePath: z.string().min(1),
  line: z.number().int().positive(),
  packageId: z.string().min(1),
  resolution: handlerResolutionSchema,
  targetId: z.string().min(1).optional(),
  evidenceIds: z.array(z.string().min(1)),
}).strict();
export type RouteHandler = z.infer<typeof routeHandlerSchema>;

export const routeEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.literal("routes-to"),
  evidenceIds: z.array(z.string().min(1)),
}).strict();
export type RouteEdge = z.infer<typeof routeEdgeSchema>;

export const handlerCallSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  toKind: z.enum(["module", "package", "store", "external", "job", "unresolved"]),
  kind: z.literal("calls"),
  source: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
}).strict();
export type HandlerCall = z.infer<typeof handlerCallSchema>;

export const routeDeclarationSchema = z.object({ id: z.string().min(1), path: z.string().min(1), line: z.number().int().positive() }).strict();
export type RouteDeclaration = z.infer<typeof routeDeclarationSchema>;

export const routeGraphSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  snapshotId: z.string().min(1),
  routes: z.array(routeSchema),
  handlers: z.array(routeHandlerSchema),
  edges: z.array(routeEdgeSchema),
  calls: z.array(handlerCallSchema),
  declarations: z.array(routeDeclarationSchema),
  coverage: z.object({
    expected: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    missing: z.array(routeDeclarationSchema),
  }).strict(),
  omissions: z.array(irOmissionSchema),
  gates: z.object({
    blockedViews: z.array(architectureViewSchema),
    runtimeOverviewUnaffected: z.literal(true),
    reasons: z.array(z.string()),
  }).strict(),
  statistics: z.object({
    routes: z.number().int().nonnegative(),
    handlers: z.number().int().nonnegative(),
    routeEdges: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    unresolvedHandlers: z.number().int().nonnegative(),
    evidenceRecords: z.number().int().nonnegative(),
  }).strict(),
  evidenceRecords: z.array(evidenceRecordSchema),
}).strict();
export type RouteGraph = z.infer<typeof routeGraphSchema>;

export interface RouteExtraction {
  routes: RouteDefinition[];
  handlers: RouteHandler[];
  edges: RouteEdge[];
  calls: HandlerCall[];
  declarations: RouteDeclaration[];
  omissions: IrOmission[];
  evidenceRecords: EvidenceRecord[];
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function routeId(framework: RouteDefinition["framework"], method: string, path: string, sourcePath: string, line: number) {
  return `route:${hash(`${framework}|${method}|${path}|${sourcePath}|${line}`)}`;
}

export function handlerId(sourcePath: string, name: string, line: number, resolution: RouteHandler["resolution"]) {
  return `handler:${hash(`${sourcePath}|${name}|${line}|${resolution}`)}`;
}

export function routeEdgeId(route: string, handler: string) {
  return `route-edge:${hash(`${route}|${handler}`)}`;
}

export function handlerCallId(handler: string, target: string, source: string, line: number) {
  return `handler-call:${hash(`${handler}|${target}|${source}|${line}`)}`;
}

export function parserEvidence(path: string, line: number, extractor: string, role: EvidenceRecord["role"] = "declaration"): EvidenceRecord {
  const base = { path, startLine: line, endLine: line, extractor, role, source: "parser" as const };
  return { id: stableEvidenceId(base), ...base };
}

export function emptyRouteExtraction(): RouteExtraction {
  return { routes: [], handlers: [], edges: [], calls: [], declarations: [], omissions: [], evidenceRecords: [] };
}

function uniqueById<T extends { id: string }>(values: T[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildRouteGraph(input: { revision: string; snapshotId: string; extractions: RouteExtraction[] }): RouteGraph {
  const routes = uniqueById(input.extractions.flatMap((item) => item.routes));
  const handlers = uniqueById(input.extractions.flatMap((item) => item.handlers));
  const edges = uniqueById(input.extractions.flatMap((item) => item.edges));
  const calls = uniqueById(input.extractions.flatMap((item) => item.calls));
  const declarations = uniqueById(input.extractions.flatMap((item) => item.declarations));
  const handlerById = new Map(handlers.map((handler) => [handler.id, handler]));
  const missing = declarations.filter((declaration) => {
    const route = routes.find((item) => item.id === declaration.id);
    if (!route) return true;
    const routeEdges = edges.filter((edge) => edge.from === declaration.id);
    return routeEdges.length === 0 || routeEdges.every((edge) => handlerById.get(edge.to)?.resolution === "unresolved");
  });
  const omissions = uniqueById([
    ...input.extractions.flatMap((item) => item.omissions),
    ...missing.filter((declaration) => !input.extractions.some((item) => item.omissions.some((omission) => omission.declarationIds.includes(declaration.id)))).map((declaration): IrOmission => ({
      id: `omission:unresolved-handler:${declaration.id}`,
      owner: declaration.id,
      reason: "unresolved-handler",
      detail: `Route declaration has no resolved handler: ${declaration.path}:${declaration.line}`,
      declarationIds: [declaration.id],
      evidenceIds: [],
      affectedViews: ["module-architecture", "protocol-flows", "full-declared-scope"],
      blocking: true,
    })),
  ]);
  const blocked = missing.length > 0 || omissions.some((omission) => omission.blocking && omission.affectedViews.some((view) => ["module-architecture", "protocol-flows", "full-declared-scope"].includes(view)));
  return routeGraphSchema.parse({
    version: 1,
    revision: input.revision,
    snapshotId: input.snapshotId,
    routes,
    handlers,
    edges,
    calls,
    declarations,
    coverage: { expected: declarations.length, resolved: declarations.length - missing.length, missing },
    omissions,
    gates: {
      blockedViews: blocked ? ["module-architecture", "protocol-flows", "full-declared-scope"] : [],
      runtimeOverviewUnaffected: true,
      reasons: blocked ? [`${missing.length} route declaration(s) have no resolved handler or parser support`] : [],
    },
    statistics: {
      routes: routes.length,
      handlers: handlers.length,
      routeEdges: edges.length,
      calls: calls.length,
      unresolvedHandlers: handlers.filter((handler) => handler.resolution === "unresolved").length,
      evidenceRecords: uniqueById(input.extractions.flatMap((item) => item.evidenceRecords)).length,
    },
    evidenceRecords: uniqueById(input.extractions.flatMap((item) => item.evidenceRecords)),
  });
}

export function routeGraphEvidenceReferences(graph: RouteGraph): EvidenceReference[] {
  return [
    ...graph.routes.map((route) => ({ ownerType: "route" as const, ownerId: route.id, evidenceIds: route.evidenceIds })),
    ...graph.edges.map((edge) => ({ ownerType: "route-edge" as const, ownerId: edge.id, evidenceIds: edge.evidenceIds })),
    ...graph.calls.map((call) => ({ ownerType: "call-edge" as const, ownerId: call.id, evidenceIds: call.evidenceIds })),
  ].map((reference) => ({
    ...reference,
    renderedEvidenceIds: reference.evidenceIds.slice(0, 3),
    remainingEvidenceIds: reference.evidenceIds.slice(3),
    selectionReason: "first three stable route evidence IDs; complete route evidence retained in the index",
  }));
}

export function routeOperationFacts(graph: RouteGraph): OperationFact[] {
  return graph.routes.map((route) => ({
    id: `operation:${route.id}`,
    kind: "http",
    owner: route.packageId,
    declarationIds: [route.id],
    evidenceIds: route.evidenceIds,
    targetKind: "service",
    resolution: "static",
    method: route.method,
    path: route.path,
    callSite: `${route.sourcePath}:${route.line}`,
  }));
}

function configBinding(candidate: ExternalCandidate, primary: OperationFact): OperationFact {
  const configKey = candidate.target?.configKey as string;
  return {
    id: `${primary.id}:config`,
    kind: "config-binding",
    owner: primary.owner,
    declarationIds: [],
    evidenceIds: primary.evidenceIds,
    targetKind: primary.targetKind,
    resolution: primary.resolution,
    configKey,
    defaultValue: candidate.target?.defaultValue ?? "",
    override: candidate.target?.override ?? `env:${configKey}`,
    usedAt: candidate.configEvidence ? `${candidate.configEvidence.path}:${candidate.configEvidence.line}` : `${candidate.evidence.path}:${candidate.evidence.line}`,
  };
}

export function candidateOperationFacts(candidates: ExternalCandidate[]): OperationFact[] {
  return candidates.flatMap((candidate): OperationFact[] => {
    const targetKind: OperationFact["targetKind"] = candidate.target?.kind ?? (candidate.status === "omitted" ? "unknown" : candidate.identity.includes(".") ? "host" : "service");
    const resolution: OperationFact["resolution"] = candidate.target?.resolution ?? (candidate.status === "omitted" ? "unknown" : candidate.dynamic ? "dynamic" : "static");
    const evidenceIds = [
      evidenceRecord(candidate.evidence).id,
      ...(candidate.configEvidence ? [evidenceRecord(candidate.configEvidence).id] : []),
    ];
    const base = {
      id: `operation:${candidate.id}`,
      owner: candidate.evidence.path,
      declarationIds: [],
      evidenceIds,
      targetKind,
      resolution,
      callSite: `${candidate.evidence.path}:${candidate.evidence.line}`,
    };
    if (candidate.protocol === "graphql" && candidate.operation) {
      const primary: OperationFact = {
        ...base,
        kind: "graphql",
        operationName: candidate.operation.name,
        operationType: candidate.operation.kind,
        documentHash: hash(candidate.id),
      };
      return candidate.target?.configKey ? [primary, configBinding(candidate, primary)] : [primary];
    }
    const primary: OperationFact = { ...base, kind: "http", method: (candidate.operation?.name ?? "request").toUpperCase(), path: "" };
    return candidate.target?.configKey ? [primary, configBinding(candidate, primary)] : [primary];
  });
}
