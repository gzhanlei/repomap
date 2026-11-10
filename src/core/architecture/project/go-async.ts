import type { BuildContext } from "./adapter.js";
import { analyzeGoSnapshot } from "./go.js";
import type { SourceSnapshot } from "./snapshot.js";
import { asyncDeclarationId, emptyAsyncExtraction, type AsyncExtraction } from "./async-graph.js";
import { parserEvidence } from "./route-graph.js";
import { irOmissionSchema, type OperationFact } from "../ir.js";

function operation(action: string, path: string, line: number, topic: string, dynamic: boolean, packageId: string): OperationFact {
  const declarationId = asyncDeclarationId(action, path, line, topic);
  return {
    id: `operation:${declarationId}`,
    kind: action === "schedule" ? "schedule" : "queue",
    owner: packageId,
    action,
    ...(action === "schedule" ? { schedule: "time.NewTicker", jobOwner: path } : { topic }),
    declarationIds: [declarationId],
    evidenceIds: [parserEvidence(path, line, `ast:go-async:${action}`, "runtime-call").id],
    targetKind: "queue",
    resolution: dynamic ? "dynamic" : "static",
    callSite: `${path}:${line}`,
  } as OperationFact;
}

function channelExpressions(line: string) {
  const index = line.indexOf("<-");
  if (index < 0) return { send: undefined, receive: undefined };
  const before = line.slice(0, index).trim();
  const after = line.slice(index + 2).trim().replace(/[:;]$/, "").replace(/}$/, "").trim();
  if (/^chan\b/.test(after)) return { send: undefined, receive: undefined };
  const send = before.replace(/^case\b\s*/, "").match(/([A-Za-z_][\w.[\]()]*)$/)?.[1];
  const assignment = /=|:=|\breturn\b/.test(before.replace(/^case\b\s*/, ""));
  if (send && !assignment) return { send, receive: undefined };
  return { send: undefined, receive: after || undefined };
}

function independentDeclarations(snapshot: SourceSnapshot) {
  const result = emptyAsyncExtraction();
  for (const file of snapshot.files) {
    if (file.language !== "go" || file.role !== "source") continue;
    const raw = snapshot.rawText(file.path);
    if (!raw) continue;
    raw.split("\n").forEach((line, index) => {
      const channel = line.match(/\b([A-Za-z_]\w*)\s*(?::=|=)\s*make\s*\(\s*chan\s+/);
      if (channel) result.declarations.push({ id: asyncDeclarationId("declare", file.path, index + 1, channel[1]), path: file.path, line: index + 1 });
      const { send, receive } = channelExpressions(line);
      if (send) result.declarations.push({ id: asyncDeclarationId("enqueue", file.path, index + 1, send), path: file.path, line: index + 1 });
      if (receive) result.declarations.push({ id: asyncDeclarationId("consume", file.path, index + 1, receive), path: file.path, line: index + 1 });
      if (/\btime\.(?:NewTicker|Tick)\s*\(/.test(line)) result.declarations.push({ id: asyncDeclarationId("schedule", file.path, index + 1, "time.NewTicker"), path: file.path, line: index + 1 });
      for (const match of line.matchAll(/\b\w+\.(Publish|Subscribe)\s*\(\s*[^,]+,\s*["']([^"']+)["']/g)) {
        const action = match[1].toLowerCase() === "publish" ? "publish" : "subscribe";
        result.declarations.push({ id: asyncDeclarationId(action, file.path, index + 1, match[2]), path: file.path, line: index + 1 });
      }
    });
  }
  return result.declarations;
}

export function analyzeGoAsync(input: { snapshot: SourceSnapshot; context: BuildContext; enabled?: boolean }): AsyncExtraction {
  const result = emptyAsyncExtraction();
  result.declarations = independentDeclarations(input.snapshot);
  if (input.enabled === false) {
    result.omissions.push(irOmissionSchema.parse({
      id: "omission:go-async:parser-unavailable",
      owner: "go-async-extractor",
      reason: "parser-unavailable",
      detail: "Go async operation extraction was not run",
      declarationIds: result.declarations.map((declaration) => declaration.id),
      evidenceIds: [],
      affectedViews: ["protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
    return result;
  }
  const analysis = analyzeGoSnapshot(input.snapshot, input.context);
  if (analysis.parser.status === "unavailable") {
    result.omissions.push(irOmissionSchema.parse({
      id: "omission:go-async:grammar-unavailable",
      owner: "go-async-extractor",
      reason: "parser-unavailable",
      detail: analysis.parser.detail,
      declarationIds: result.declarations.map((declaration) => declaration.id),
      evidenceIds: [],
      affectedViews: ["protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
    return result;
  }
  for (const file of analysis.files) {
    for (const async of file.parsed.asyncOperations) {
      result.operations.push(operation(async.kind === "send" ? "enqueue" : "consume", file.path, async.line, async.channel, false, file.packageId));
    }
    for (const call of file.parsed.calls) {
      const name = call.name.split(".").at(-1);
      if (name === "NewTicker" || name === "Tick") result.operations.push(operation("schedule", file.path, call.line, "time.NewTicker", false, file.packageId));
      if (name === "Publish" || name === "Subscribe") {
        const argument = call.arguments[1];
        const topic = argument ? argument.text.replace(/^["`]|["`]$/g, "") : "dynamic";
        result.operations.push(operation(name.toLowerCase() === "publish" ? "publish" : "subscribe", file.path, call.line, topic, !argument || !["interpreted_string_literal", "raw_string_literal"].includes(argument.type), file.packageId));
      }
    }
    const raw = input.snapshot.rawText(file.path) ?? "";
    raw.split("\n").forEach((line, index) => {
      const channel = line.match(/\b([A-Za-z_]\w*)\s*(?::=|=)\s*make\s*\(\s*chan\s+/);
      if (channel && file.parsed.calls.some((call) => call.line === index + 1 && call.name === "make")) {
        result.operations.push(operation("declare", file.path, index + 1, channel[1], false, file.packageId));
      }
    });
  }
  result.evidenceRecords = result.operations.map((operation) => {
    const [path, line] = (operation.callSite ?? "unknown:1").split(/:(\d+)$/);
    return parserEvidence(path, Number(line), `ast:go-async:${operation.action}`, "runtime-call");
  });
  return result;
}
