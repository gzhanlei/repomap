import type { NodeFact } from "../facts.js";
import { architectureLineNumber, architectureRuntimeSources, signalIdsForEvidence } from "../source.js";
import type { ArchitectureSignal } from "../signals.js";
import { emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureFragment } from "./types.js";
import type { ExternalCandidate } from "../candidates.js";

const reservedIdentities = new Set(["cos", "wechat", "xpay", "aiphoto", "seedance", "chandler", "github", "llm", "archify"]);
const genericSegments = new Set(["app", "api", "lib", "src", "core", "common", "shared", "utils", "util", "helpers", "helper", "types", "models", "config", "constants", "components", "pages", "clients", "services", "server", "providers", "integrations", "hooks", "store", "stores", "database", "db"]);
const genericEnvPrefixes = new Set(["NEXT", "NEXT_PUBLIC", "APP", "APP_URL", "API", "API_URL", "SERVICE", "SERVICE_URL", "DEFAULT", "PUBLIC", "SERVER", "BACKEND", "FRONTEND", "BASE", "BASE_URL"]);
const identitySegments = new Set(["lib", "src", "services", "server", "clients", "providers", "integrations"]);

interface CandidateDraft {
  identity?: string;
  dynamic: boolean;
  protocol: "http" | "graphql";
  operation?: { name: string; kind: "query" | "mutation" | "subscription" | "http" };
  evidence: { path: string; line: number; detector: string };
  omissionReason?: string;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function identityFromPath(path: string) {
  const parts = path.split("/");
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!identitySegments.has(parts[index])) continue;
    const candidate = parts[index + 1];
    if (!genericSegments.has(candidate)) return slug(candidate);
  }
  return undefined;
}

function identityFromEnvironment(content: string) {
  const matches = content.matchAll(/\b([A-Z][A-Z0-9]+)_(?:STORE_DOMAIN|DOMAIN|HOST|ENDPOINT|BASE_URL|URL|API_URL)\b/g);
  for (const match of matches) {
    if (!genericEnvPrefixes.has(match[1])) return slug(match[1]);
  }
  return undefined;
}

function absoluteIdentity(content: string) {
  const match = content.match(/https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)/);
  return match ? match[1].toLowerCase() : undefined;
}

function serviceIdentity(source: { path: string; content: string }) {
  const absolute = absoluteIdentity(source.content);
  if (absolute) return { identity: absolute, dynamic: false };
  const environment = identityFromEnvironment(source.content);
  if (environment) return { identity: environment, dynamic: true };
  const path = identityFromPath(source.path);
  return path ? { identity: path, dynamic: true } : undefined;
}

function candidateId(draft: CandidateDraft) {
  const operation = draft.operation ? `${draft.operation.kind}-${draft.operation.name}` : "http-request";
  return `external:${draft.evidence.path}:${draft.evidence.line}:${operation}`;
}

function toCandidate(draft: CandidateDraft, identity: string, dynamic: boolean, status: "resolved" | "omitted", reason?: string): ExternalCandidate {
  return {
    id: candidateId(draft),
    identity,
    dynamic,
    protocol: draft.protocol,
    ...(draft.operation ? { operation: draft.operation } : {}),
    status,
    ...(reason ? { reason } : {}),
    evidence: draft.evidence,
  };
}

function fetchDrafts(source: { path: string; content: string }): CandidateDraft[] {
  const identity = serviceIdentity(source);
  const drafts: CandidateDraft[] = [];
  const lines = source.content.split("\n");
  lines.forEach((line, index) => {
    const code = line.replace(/^\s*\d+:\s?/, "").trim();
    if (["//", "#", "*", "/*", "<!--"].some((prefix) => code.startsWith(prefix)) || !/(?:fetch|fetcher|fetchImpl)\s*\(/.test(code)) return;
    const absolute = absoluteIdentity(code);
    const environment = identityFromEnvironment(source.content);
    const pathIdentity = identityFromPath(source.path);
    const dynamicCall = /(?:fetch|fetcher|fetchImpl)\s*\(\s*(?:endpoint|url|uri|host|domain|baseUrl|baseURL|baseUri|apiUrl)\b/i.test(code);
    if (!absolute && !dynamicCall) return;
    const resolved = absolute ? { identity: absolute, dynamic: false } : environment ? { identity: environment, dynamic: true } : pathIdentity ? { identity: pathIdentity, dynamic: true } : identity;
    drafts.push({
      identity: resolved?.identity,
      dynamic: resolved?.dynamic ?? true,
      protocol: "http",
      operation: { name: "request", kind: "http" },
      evidence: { path: source.path, line: architectureLineNumber(lines[index], index), detector: "generic-http-call" },
      omissionReason: resolved ? undefined : "External HTTP call has no statically identifiable service identity",
    });
  });
  return drafts;
}

function graphQLDrafts(source: { path: string; content: string }): CandidateDraft[] {
  const identity = serviceIdentity(source);
  const drafts: CandidateDraft[] = [];
  const lines = source.content.split("\n");
  lines.forEach((line, index) => {
    const code = line.replace(/^\s*\d+:\s?/, "").trim();
    if (["//", "#", "*", "/*", "<!--"].some((prefix) => code.startsWith(prefix))) return;
    for (const match of code.matchAll(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(|\s*\{)/g)) {
      drafts.push({
        identity: identity?.identity,
        dynamic: identity?.dynamic ?? true,
        protocol: "graphql",
        operation: { name: match[2], kind: match[1] as "query" | "mutation" | "subscription" },
        evidence: { path: source.path, line: architectureLineNumber(lines[index], index), detector: "generic-graphql-operation" },
        omissionReason: identity ? undefined : "GraphQL operation has no statically identifiable service identity",
      });
    }
  });
  return drafts;
}

export function detectGenericExternal(context: ArchitectureContext, runtimeNodes: NodeFact[] = []): ArchitectureFragment & { candidates: ExternalCandidate[] } {
  const fragment = emptyArchitectureFragment();
  const candidates: ExternalCandidate[] = [];
  const drafts = [...context.sources.flatMap(fetchDrafts), ...context.sources.flatMap(graphQLDrafts)];
  const externalNodes = new Map<string, { identity: string; dynamic: boolean; evidence: { path: string; line: number; detector: string }[] }>();
  const edgeGroups = new Map<string, { source: string; target: string; kind: "http" | "download" | "upload"; protocol: "http" | "graphql"; operationKind?: "query" | "mutation" | "subscription" | "http"; operations: string[]; evidence: { path: string; line: number; detector: string }[] }>();
  const runtimes = runtimeNodes.filter((node) => ["frontend", "api", "worker", "agent", "cli"].includes(node.kind));

  for (const draft of drafts) {
    const candidate = draft.identity
      ? toCandidate(draft, draft.identity, draft.dynamic, draft.omissionReason ? "omitted" : "resolved", draft.omissionReason)
      : toCandidate(draft, "unknown", true, "omitted", draft.omissionReason ?? "External identity is unknown");
    if (draft.identity && reservedIdentities.has(draft.identity)) continue;
    candidates.push(candidate);
    if (candidate.status === "omitted") {
      fragment.omissions.push({ signalId: candidate.id, reason: "uncertain", detail: candidate.reason ?? "External identity is unknown" });
      continue;
    }

    const node = externalNodes.get(candidate.identity) ?? { identity: candidate.identity, dynamic: candidate.dynamic, evidence: [] };
    node.evidence.push(candidate.evidence);
    externalNodes.set(candidate.identity, node);
    const id = `external:${candidate.identity}`;
    for (const runtime of runtimes) {
      const sources = architectureRuntimeSources(runtime, context.sources);
      if (!sources.some((source) => source.path === candidate.evidence.path)) continue;
      const kind = candidate.protocol === "graphql" && candidate.operation?.kind === "query" ? "download" : candidate.protocol === "graphql" && candidate.operation?.kind === "mutation" ? "upload" : "http";
      const groupKey = `${runtime.id}->${id}:${kind}`;
      const group = edgeGroups.get(groupKey) ?? { source: runtime.id, target: id, kind, protocol: candidate.protocol, operationKind: candidate.operation?.kind, operations: [], evidence: [] };
      if (candidate.operation && !group.operations.includes(candidate.operation.name)) group.operations.push(candidate.operation.name);
      group.evidence.push(candidate.evidence);
      edgeGroups.set(groupKey, group);
    }
  }

  for (const [key, group] of edgeGroups) {
    const operationKind = group.operationKind ?? "http";
    const prefix = group.operations.length === 1 ? "GraphQL" : "GQL";
    const label = group.protocol === "graphql"
      ? `${prefix} ${operationKind}${group.operations.length === 1 ? ` ${group.operations[0]}` : ` ×${group.operations.length}`}`
      : "HTTP request";
    fragment.edges.push(factEdge(`${group.kind}:${key}`, group.source, group.target, group.kind, label, group.evidence, signalIdsForEvidence(context.signals, group.evidence)));
  }

  // Runtime nodes are created by the framework detectors before this generic pass.
  for (const node of externalNodes.values()) {
    const evidence = node.evidence.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`));
    fragment.nodes.push({
      id: `external:${node.identity}`,
      kind: "external",
      label: node.dynamic ? `${node.identity}（动态 endpoint）` : node.identity,
      sourcePaths: [...new Set(evidence.map((item) => item.path))].sort(),
      signalIds: signalIdsForEvidence(context.signals, evidence),
      evidence,
    });
  }
  return { ...fragment, candidates };
}

export function genericExternalCandidates(context: ArchitectureContext): { signals: ArchitectureSignal[]; candidates: ExternalCandidate[] } {
  const { candidates } = detectGenericExternal(context);
  return {
    signals: candidates.map((candidate) => ({ id: candidate.id, kind: "external", critical: true, evidence: candidate.evidence })),
    candidates,
  };
}
