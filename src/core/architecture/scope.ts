import { z } from "zod";
import { excludedDirectoryRules } from "./file-roles.js";
import type { ArchitectureViewEvaluation } from "./coverage-matrix.js";

/** M0 contract: views, declared scope, capabilities and per-view delivery. */
export const architectureViewSchema = z.enum(["system-context", "runtime-overview", "module-architecture", "protocol-flows", "full-declared-scope"]);
export type ArchitectureView = z.infer<typeof architectureViewSchema>;
export const defaultArchitectureView: ArchitectureView = "runtime-overview";

const baseViews = architectureViewSchema.options.filter((view) => view !== "full-declared-scope");

const viewAliases: Record<string, ArchitectureView> = {
  ...Object.fromEntries(architectureViewSchema.options.map((view) => [view, view])),
  system: "system-context", runtime: "runtime-overview", module: "module-architecture", flows: "protocol-flows", full: "full-declared-scope",
};

export function parseView(value: string): ArchitectureView {
  const view = viewAliases[value];
  if (!view) throw new Error(`Unknown architecture view: ${value}`);
  return view;
}

/** Asking for full automatically requires every contributing view. */
export function resolveRequestedViews(values: string[]): ArchitectureView[] {
  const requested = values.length === 0 ? [defaultArchitectureView] : values.map(parseView);
  const expanded = new Set<ArchitectureView>();
  for (const view of requested) {
    if (view === "full-declared-scope") baseViews.forEach((base) => expanded.add(base));
    expanded.add(view);
  }
  return architectureViewSchema.options.filter((view) => expanded.has(view));
}

export const capabilityStatusSchema = z.enum(["available", "partial", "unavailable"]);
export const capabilitySchema = z.object({ id: z.string().min(1), version: z.string().min(1), status: capabilityStatusSchema }).strict();
export type Capability = z.infer<typeof capabilitySchema>;

export const repomapCapabilities: Capability[] = [
  { id: "raw-source-census", version: "1", status: "available" },
  { id: "source-snapshot", version: "1", status: "available" },
  { id: "project-preparation", version: "1", status: "available" },
  { id: "evidence-index", version: "1", status: "available" },
  { id: "declaration-inventory", version: "1", status: "partial" },
  { id: "mutation-harness", version: "1", status: "available" },
  { id: "regex-line-scan", version: "1", status: "partial" },
  { id: "external-candidates", version: "1", status: "partial" },
  { id: "coverage-evaluator", version: "1", status: "available" },
  { id: "ast-typescript", version: "1", status: "partial" },
  { id: "ast-go", version: "1", status: "partial" },
  { id: "ast-python", version: "1", status: "partial" },
  { id: "module-graph", version: "1", status: "partial" },
  { id: "module-graph-go", version: "1", status: "partial" },
  { id: "route-graph", version: "1", status: "partial" },
  { id: "route-graph-go", version: "1", status: "partial" },
  { id: "protocol-flows", version: "1", status: "partial" },
  { id: "identity-resolution", version: "1", status: "partial" },
  { id: "async-operations", version: "1", status: "partial" },
  { id: "sql-operations", version: "1", status: "partial" },
  { id: "gold-evaluation", version: "1", status: "partial" },
];

export function capabilityGaps(capabilities: Capability[] = repomapCapabilities) {
  return capabilities.filter((capability) => capability.status !== "available").map((capability) => capability.id).sort();
}

const parserSchema = z.object({ id: z.string().min(1), version: z.string().min(1), status: capabilityStatusSchema }).strict();

export const declaredScopeSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  userExclusions: z.array(z.string()),
  languages: z.array(z.string()),
  packageManagers: z.array(z.string()),
  workspaces: z.array(z.string()),
  parsers: z.array(parserSchema),
  protocols: z.array(z.string()),
  requestedViews: z.array(architectureViewSchema),
  requiredViews: z.array(architectureViewSchema),
  strictExternalHosts: z.boolean(),
  buildContext: z.object({ goos: z.string(), goarch: z.string(), buildTags: z.array(z.string()) }).strict(),
  capabilityGaps: z.array(z.string()),
}).strict();
export type DeclaredScope = z.infer<typeof declaredScopeSchema>;

export interface DeclaredScopeInput {
  revision: string;
  languages?: string[];
  packageManagers?: string[];
  workspaces?: string[];
  include?: string[];
  exclude?: string[];
  userExclusions?: string[];
  requestedViews?: string[];
  strictExternalHosts?: boolean;
  buildContext?: { goos: string; goarch: string; buildTags: string[] };
  /** Actual parser statuses from project preparation; defaults to the engine catalog. */
  parsers?: Capability[];
}

export function buildDeclaredScope(input: DeclaredScopeInput): DeclaredScope {
  const requestedViews = resolveRequestedViews(input.requestedViews ?? []);
  return declaredScopeSchema.parse({
    revision: input.revision,
    include: [...new Set(input.include ?? ["**"])].sort(),
    exclude: [...new Set([...excludedDirectoryRules.map((directory) => `${directory}/**`), ...(input.exclude ?? [])])].sort(),
    userExclusions: [...new Set(input.userExclusions ?? [])].sort(),
    languages: [...new Set(input.languages ?? [])].sort(),
    packageManagers: [...new Set(input.packageManagers ?? [])].sort(),
    workspaces: [...new Set(input.workspaces ?? [])].sort(),
    parsers: (input.parsers ?? repomapCapabilities.filter((capability) => capability.id.startsWith("ast-") || capability.id === "regex-line-scan"))
      .map(({ id, version, status }) => ({ id, version, status })),
    protocols: ["http", "graphql", "sql", "schedule", "callback", "oauth"],
    requestedViews,
    requiredViews: requestedViews,
    strictExternalHosts: input.strictExternalHosts === true,
    // Build context is explicit, never inherited from the host machine.
    buildContext: input.buildContext ?? { goos: "linux", goarch: "amd64", buildTags: [] },
    capabilityGaps: capabilityGaps(),
  });
}

const viewStatusSchema = z.enum(["accepted", "facts-ready", "failed", "not-requested"]);

export const deliveryStatementSchema = z.object({
  view: architectureViewSchema,
  requestedViews: z.array(architectureViewSchema),
  status: z.enum(["accepted", "facts-ready", "failed"]),
  publishable: z.boolean(),
  fullArchitecture: z.boolean(),
  reason: z.string().min(1),
  views: z.array(z.object({
    view: architectureViewSchema,
    status: viewStatusSchema,
    blockingReasons: z.array(z.string()),
    omissionCount: z.number().int().nonnegative(),
  }).strict()),
  strictExternalHosts: z.boolean(),
  evaluation: z.custom<ArchitectureViewEvaluation>((value) => value !== undefined).optional(),
}).strict();
export type DeliveryStatement = z.infer<typeof deliveryStatementSchema>;

const fullScopeReason = "full-declared-scope is evaluated per input and requires system, runtime, module and protocol views, independent mutations and projection reconciliation. It is not generator release qualification.";

export interface DeliveryInput {
  status: "accepted" | "facts-ready" | "failed";
  publishable: boolean;
  requestedViews?: string[];
  visualPassed?: boolean;
  strictExternalHosts?: boolean;
  blockingOmissionCount?: number;
  evaluation?: ArchitectureViewEvaluation;
}

export function buildDeliveryStatement(input: DeliveryInput): DeliveryStatement {
  const requested = resolveRequestedViews(input.requestedViews ?? []);
  const requestedSet = new Set(requested);
  const gaps = capabilityGaps();
  const evaluation = input.evaluation;
  const failedRequestedViews = evaluation ? requested.filter((view) => evaluation.views[view].status === "failed") : [];
  const status = failedRequestedViews.length > 0 ? "failed" : input.status;
  const fullArchitecture = requestedSet.has("full-declared-scope") && evaluation?.fullArchitecture === true;
  const reason = evaluation
    ? `${fullArchitecture ? "Per-input semantic full gates passed; this is not generator release qualification." : "Per-input semantic full is not available."}${failedRequestedViews.length > 0 ? ` Failed views: ${failedRequestedViews.join(", ")}.` : ""}`
    : `${fullScopeReason}${input.visualPassed ? " A passing visual check does not change the declared view." : ""}`;
  return deliveryStatementSchema.parse({
    view: defaultArchitectureView,
    requestedViews: requested,
    status,
    publishable: evaluation ? evaluation.views["runtime-overview"].status === "passed" : input.publishable,
    fullArchitecture,
    reason,
    views: architectureViewSchema.options.map((view) => {
      if (evaluation) {
        const gate = evaluation.views[view];
        return {
          view,
          status: requestedSet.has(view) ? (gate.status === "passed" ? input.status : "failed") : "not-requested",
          blockingReasons: requestedSet.has(view) ? gate.blockingReasons : [],
          omissionCount: requestedSet.has(view) ? gate.omissionCount : 0,
        };
      }
      if (view === defaultArchitectureView) {
        return {
          view,
          status: requestedSet.has(view) ? input.status : "not-requested",
          blockingReasons: input.publishable ? [] : ["runtime-overview coverage gate failed"],
          omissionCount: input.publishable ? 0 : (input.blockingOmissionCount ?? 1),
        };
      }
      return {
        view,
        status: requestedSet.has(view) ? "failed" : "not-requested",
        blockingReasons: requestedSet.has(view)
          ? ["view gate is not implemented", ...gaps.map((gap) => `capability gap: ${gap}`)]
          : [],
        omissionCount: requestedSet.has(view) ? 1 : 0,
      };
    }),
    strictExternalHosts: input.strictExternalHosts === true,
  });
}

/** Any requested-but-failed view makes the CLI exit non-zero. */
export function deliveryExitCode(statement: DeliveryStatement) {
  return statement.views.some((entry) => entry.status === "failed") ? 1 : 0;
}
