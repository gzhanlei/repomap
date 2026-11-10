import type { NodeFact } from "../facts.js";
import { architectureLineNumber, architectureRuntimeSources, signalIdsForEvidence } from "../source.js";
import type { ArchitectureSignal } from "../signals.js";
import { emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureFragment } from "./types.js";
import type { ExternalCandidate } from "../candidates.js";

const genericSegments = new Set(["app", "api", "lib", "src", "core", "common", "shared", "utils", "util", "helpers", "helper", "types", "models", "config", "constants", "components", "pages", "clients", "services", "server", "providers", "integrations", "hooks", "store", "stores", "database", "db"]);
const genericEnvPrefixes = new Set(["NEXT", "NEXT_PUBLIC", "APP", "APP_URL", "API", "API_URL", "SERVICE", "SERVICE_URL", "DEFAULT", "PUBLIC", "SERVER", "BACKEND", "FRONTEND", "BASE", "BASE_URL"]);
const identitySegments = new Set(["lib", "src", "services", "server", "clients", "providers", "integrations", "webhooks"]);
const protocolModulePattern = /(?:^|[_-])(oauth|activitypub|federation|webhook|graphql|grpc|monetization|payments?)(?:[_-]|$)/i;

interface CandidateDraft {
  identity?: string;
  dynamic: boolean;
  protocol: "http" | "graphql";
  operation?: { name: string; kind: "query" | "mutation" | "subscription" | "http" | "upload" | "download" | "oauth" | "callback" | "process" };
  nodeKind?: "external" | "object-store";
  evidence: { path: string; line: number; detector: string };
  omissionReason?: string;
}

interface GoRequestConstruction {
  variable: string;
  target: string;
  method: string;
  line: number;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function identityFromPath(path: string) {
  const parts = path.split("/");
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (!identitySegments.has(parts[index])) continue;
    const candidate = parts[index + 1];
    if (!genericSegments.has(candidate)) return slug(candidate);
  }
  return undefined;
}

function identityFromProtocolModule(path: string) {
  const filename = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  return protocolModulePattern.test(filename) ? slug(filename) : undefined;
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

function goRequestConstructions(lines: string[]) {
  const requests = new Map<string, GoRequestConstruction[]>();
  for (const [index, line] of lines.entries()) {
    const code = line.replace(/^\s*\d+:\s?/, "");
    const match = code.match(/\b([A-Za-z_]\w*)\s*,\s*[A-Za-z_]\w*\s*(?::=|=)\s*http\.(NewRequestWithContext|NewRequest)\s*\((.*)$/);
    if (!match) continue;
    const args = match[3].split(",").map((part) => part.trim());
    const targetIndex = match[2] === "NewRequestWithContext" ? 2 : 1;
    const methodIndex = match[2] === "NewRequestWithContext" ? 1 : 0;
    const target = args[targetIndex];
    if (!target) continue;
    const request = { variable: match[1], target, method: args[methodIndex]?.replace(/["`]/g, "") || "request", line: index };
    requests.set(match[1], [...(requests.get(match[1]) ?? []), request]);
  }
  return requests;
}

function goStaticBindings(lines: string[]) {
  const bindings = new Map<string, string>();
  for (const line of lines) {
    const code = line.replace(/^\s*\d+:\s?/, "");
    const match = code.match(/\b([A-Za-z_]\w*)\s*(?::=|=)\s*["`](https?:\/\/[^"`]+)["`]/);
    const identity = match ? absoluteIdentity(match[2]) : undefined;
    if (match && identity) bindings.set(match[1], identity);
  }
  return bindings;
}

function goDynamicBindings(lines: string[]) {
  const bindings = new Set<string>();
  for (const line of lines) {
    const code = line.replace(/^\s*\d+:\s?/, "");
    const match = code.match(/\b([A-Za-z_]\w*)\s*(?::=|=)\s*os\.(?:Getenv|LookupEnv)\s*\(/);
    if (match) bindings.add(match[1]);
  }
  return bindings;
}

function goTargetIdentity(target: string, source: { path: string; content: string }, staticBindings: Map<string, string>, dynamicBindings: Set<string>) {
  const absolute = absoluteIdentity(target) ?? staticBindings.get(target.trim());
  if (absolute) return { identity: absolute, dynamic: dynamicBindings.has(target.trim()) };
  if (/^["'`]\//.test(target.trim())) return { local: true as const };
  const environment = identityFromEnvironment(source.content);
  if (environment) return { identity: environment, dynamic: true };
  const path = identityFromPath(source.path) ?? identityFromProtocolModule(source.path);
  return path ? { identity: path, dynamic: true } : { identity: undefined, dynamic: true };
}

function goOutboundDrafts(source: { path: string; content: string }): CandidateDraft[] {
  if (!source.path.endsWith(".go")) return [];
  const lines = source.content.split("\n");
  const requests = goRequestConstructions(lines);
  const staticBindings = goStaticBindings(lines);
  const dynamicBindings = goDynamicBindings(lines);
  const drafts: CandidateDraft[] = [];
  lines.forEach((line, index) => {
    const code = line.replace(/^\s*\d+:\s?/, "").trim();
    if (["//", "#", "*", "/*"].some((prefix) => code.startsWith(prefix))) return;
    const direct = code.match(/\bhttp\.(Get|Post|Head)\s*\((.*)$/);
    const send = code.match(/\b((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*(?:Client|client)|[A-Za-z_]\w*(?:Client|client)\(\))\.Do\s*\(\s*([A-Za-z_]\w*)\s*\)/);
    let target: string | undefined;
    let method = "request";
    if (direct) {
      target = direct[2].split(",")[0]?.trim();
      method = direct[1].toLowerCase();
    } else if (send) {
      const request = requests.get(send[2])?.filter((item) => item.line <= index).at(-1);
      if (!request) return;
      target = request.target;
      method = request.method.toLowerCase();
    } else return;
    if (!target) return;
    const resolved = goTargetIdentity(target, source, staticBindings, dynamicBindings);
    if ("local" in resolved) return;
    drafts.push({
      identity: resolved.identity,
      dynamic: resolved.dynamic,
      protocol: "http",
      operation: { name: method, kind: "http" },
      evidence: { path: source.path, line: architectureLineNumber(lines[index], index), detector: "generic-go-http-call" },
      omissionReason: resolved.identity ? undefined : "Go outbound HTTP call has no statically identifiable service identity",
    });
  });
  return drafts;
}

const sdkOperationRules: { pattern: RegExp; kind: NonNullable<CandidateDraft["operation"]>["kind"]; nodeKind?: CandidateDraft["nodeKind"] }[] = [
  { pattern: /\b(PresignPut|PutObject|UploadURL)\s*\(/, kind: "upload", nodeKind: "object-store" },
  { pattern: /\b(PresignGet|GetObject|DownloadURL)\s*\(/, kind: "download", nodeKind: "object-store" },
  { pattern: /\b(Code2Session|ImgSecCheck|requestVirtualPayment|CreateTask|Generate)\s*\(/, kind: "http" },
  { pattern: /\b(Whoami)\s*\(/, kind: "oauth" },
  { pattern: /\b(deliverArchify|visualCheckArchify)\s*\(/, kind: "process" },
  { pattern: /\b(chat\.completions\.create)\s*\(/, kind: "http" },
  { pattern: /\b(http\.(?:Get|Post|Head))\s*\(/, kind: "http" },
];

function sdkDrafts(source: { path: string; content: string }): CandidateDraft[] {
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(source.path)) return [];
  const identity = serviceIdentity(source);
  if (!identity) return [];
  const drafts: CandidateDraft[] = [];
  const lines = source.content.split("\n");
  lines.forEach((line, index) => {
    const code = line.replace(/^\s*\d+:\s?/, "").trim();
    if (["//", "#", "*", "/*"].some((prefix) => code.startsWith(prefix))) return;
    for (const rule of sdkOperationRules) {
      const match = code.match(rule.pattern);
      if (!match) continue;
      drafts.push({
        identity: identity.identity,
        dynamic: identity.dynamic,
        protocol: "http",
        operation: { name: match[1], kind: rule.kind },
        nodeKind: rule.nodeKind,
        evidence: { path: source.path, line: architectureLineNumber(lines[index], index), detector: "generic-sdk-operation" },
      });
    }
  });
  return drafts;
}

function callbackDrafts(source: { path: string; content: string }): CandidateDraft[] {
  if (!/(?:^|\/)webhooks?\//i.test(source.path) || !/(?:webhook|push|xpay_goods_deliver_notify|xpay_refund_notify)/i.test(source.content)) return [];
  const identity = serviceIdentity(source);
  const lines = source.content.split("\n");
  const index = lines.findIndex((line) => /\bexport\s+(?:async\s+)?function\s+POST\b/.test(line));
  if (index < 0) return [];
  return [{
    identity: identity?.identity,
    dynamic: identity?.dynamic ?? true,
    protocol: "http",
    operation: { name: "webhook", kind: "callback" },
    evidence: { path: source.path, line: architectureLineNumber(lines[index], index), detector: "generic-webhook-callback" },
    omissionReason: identity ? undefined : "Webhook callback has no statically identifiable sender identity",
  }];
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
  const drafts = [
    ...context.sources.flatMap(fetchDrafts),
    ...context.sources.flatMap(goOutboundDrafts),
    ...context.sources.flatMap(graphQLDrafts),
    ...context.sources.flatMap(sdkDrafts),
    ...context.sources.flatMap(callbackDrafts),
  ];
  const externalNodes = new Map<string, { identity: string; dynamic: boolean; nodeKind: CandidateDraft["nodeKind"]; evidence: { path: string; line: number; detector: string }[] }>();
  const edgeGroups = new Map<string, { source: string; target: string; kind: "http" | "download" | "upload" | "oauth" | "callback" | "process"; protocol: "http" | "graphql"; operationKind?: NonNullable<CandidateDraft["operation"]>["kind"]; operations: string[]; evidence: { path: string; line: number; detector: string }[] }>();
  const runtimes = runtimeNodes.filter((node) => ["frontend", "api", "worker", "agent", "cli"].includes(node.kind));

  for (const draft of drafts) {
    const candidate = draft.identity
      ? toCandidate(draft, draft.identity, draft.dynamic, draft.omissionReason ? "omitted" : "resolved", draft.omissionReason)
      : toCandidate(draft, "unknown", true, "omitted", draft.omissionReason ?? "External identity is unknown");
    candidates.push(candidate);
    if (candidate.status === "omitted") {
      fragment.omissions.push({ signalId: candidate.id, reason: "uncertain", detail: candidate.reason ?? "External identity is unknown" });
      continue;
    }

    const node = externalNodes.get(candidate.identity) ?? { identity: candidate.identity, dynamic: candidate.dynamic, nodeKind: draft.nodeKind ?? "external", evidence: [] };
    node.evidence.push(candidate.evidence);
    externalNodes.set(candidate.identity, node);
    const id = `${draft.nodeKind === "object-store" ? "store" : "external"}:${candidate.identity}`;
    for (const runtime of runtimes) {
      const sources = architectureRuntimeSources(runtime, context.sources);
      if (!sources.some((source) => source.path === candidate.evidence.path)) continue;
      const kind = candidate.operation?.kind === "query" ? "download"
        : candidate.operation?.kind === "mutation" || candidate.operation?.kind === "upload" ? "upload"
          : candidate.operation?.kind === "download" ? "download"
            : candidate.operation?.kind === "oauth" ? "oauth"
              : candidate.operation?.kind === "callback" ? "callback"
                : candidate.operation?.kind === "process" ? "process" : "http";
      const source = kind === "callback" ? id : runtime.id;
      const target = kind === "callback" ? runtime.id : id;
      const groupKey = `${source}->${target}:${kind}`;
      const group = edgeGroups.get(groupKey) ?? { source, target, kind, protocol: candidate.protocol, operationKind: candidate.operation?.kind, operations: [], evidence: [] };
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
      : operationKind === "callback" ? "Webhook callback"
        : operationKind === "process" ? "Process integration"
          : operationKind === "oauth" ? "OAuth request"
            : operationKind === "upload" ? "Object upload"
              : operationKind === "download" ? "Object download" : "HTTP request";
    fragment.edges.push(factEdge(`${group.kind}:${key}`, group.source, group.target, group.kind, label, group.evidence, signalIdsForEvidence(context.signals, group.evidence)));
  }

  // Runtime nodes are created by the framework detectors before this generic pass.
  for (const node of externalNodes.values()) {
    const evidence = node.evidence.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`));
    fragment.nodes.push({
      id: `${node.nodeKind === "object-store" ? "store" : "external"}:${node.identity}`,
      kind: node.nodeKind ?? "external",
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
