import type { SourceSnapshot } from "./snapshot.js";
import { parsePythonSource, type PythonParsedCall, type PythonParsedDecorator } from "./python-parser.js";
import { pythonParserStatus } from "./python-parser.js";
import { asyncDeclarationId, emptyAsyncExtraction, type AsyncExtraction } from "./async-graph.js";
import { parserEvidence } from "./route-graph.js";
import { pythonCodeLines } from "./python-source.js";
import { irOmissionSchema, type OperationFact } from "../ir.js";

function literal(argument?: { text: string; type: string }) {
  if (!argument || argument.type !== "string") return undefined;
  const text = argument.text.trim();
  if (/^[fF]/.test(text)) return undefined;
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return undefined;
}

function operation(action: string, path: string, line: number, topic: string, dynamic: boolean, packageId: string): OperationFact {
  const declarationId = asyncDeclarationId(action, path, line, topic);
  return {
    id: `operation:${declarationId}`,
    kind: action === "schedule" ? "schedule" : "queue",
    owner: packageId,
    action,
    ...(action === "schedule" ? { schedule: topic, jobOwner: path } : { topic }),
    declarationIds: [declarationId],
    evidenceIds: [parserEvidence(path, line, `ast:python-async:${action}`, "runtime-call").id],
    targetKind: "queue",
    resolution: dynamic ? "dynamic" : "static",
    callSite: `${path}:${line}`,
  } as OperationFact;
}

function independentDeclarations(snapshot: SourceSnapshot) {
  const result = emptyAsyncExtraction();
  for (const file of snapshot.files) {
    if (file.language !== "python" || file.role !== "source" || !file.path.endsWith(".py")) continue;
    const raw = snapshot.rawText(file.path);
    if (!raw) continue;
    const queueReceivers = new Set<string>();
    const celeryContext = celeryReceivers(raw);
    for (const match of raw.matchAll(/([A-Za-z_]\w*)\s*=\s*(?:asyncio|queue)\.Queue\s*\(/g)) queueReceivers.add(match[1]);
    const lines = pythonCodeLines(raw);
    lines.forEach((line, index) => {
      const queue = line.match(/([A-Za-z_]\w*)\s*=\s*(?:asyncio|queue)\.Queue\s*\(/);
      if (queue) result.declarations.push({ id: asyncDeclarationId("declare", file.path, index + 1, queue[1]), path: file.path, line: index + 1 });
      const queueCall = line.match(/([A-Za-z_]\w*)\.(put_nowait|put|get_nowait|get)\s*\(/);
      if (queueCall && queueReceivers.has(queueCall[1])) {
        const action = queueCall[2].startsWith("put") ? "enqueue" : "consume";
        result.declarations.push({ id: asyncDeclarationId(action, file.path, index + 1, queueCall[1]), path: file.path, line: index + 1 });
      }
      if (/\basyncio\.(create_task|gather)\s*\(/.test(line)) result.declarations.push({ id: asyncDeclarationId("consume", file.path, index + 1, line.match(/asyncio\.(create_task|gather)/)?.[1] ?? "create_task"), path: file.path, line: index + 1 });
      if (/\basyncio\.sleep\s*\(|\bthreading\.Timer\s*\(|\bschedule\.every\s*\(/.test(line)) result.declarations.push({ id: asyncDeclarationId("schedule", file.path, index + 1, line.includes("threading.Timer") ? "threading.Timer" : line.includes("schedule.every") ? "schedule.every" : "asyncio.sleep"), path: file.path, line: index + 1 });
      if (isCeleryDecorator(line, celeryContext)) {
        const handler = lines.slice(index, index + 5).join("\n").match(/def\s+([A-Za-z_]\w*)/)?.[1] ?? "celery";
        result.declarations.push({ id: asyncDeclarationId("consume", file.path, index + 1, handler), path: file.path, line: index + 1 });
      }
      for (const match of line.matchAll(/\b([A-Za-z_]\w*)\.(publish|subscribe)\s*\(\s*([^)]*)/g)) {
        if (!hasPubSubReceiver(match[1], raw)) continue;
        const topic = match[3].trim().match(/^["']([^"']+)["']/)?.[1] ?? "dynamic";
        result.declarations.push({ id: asyncDeclarationId(match[2], file.path, index + 1, topic), path: file.path, line: index + 1 });
      }
    });
  }
  return result.declarations;
}

function topicForCall(call: PythonParsedCall) {
  return call.receiver ?? call.name.split(".")[0];
}

function decoratorTopic(decorator: PythonParsedDecorator) {
  return decorator.handler ?? "celery";
}

function celeryReceivers(raw: string) {
  const receivers = new Set<string>();
  let hasConstructor = false;
  for (const line of pythonCodeLines(raw)) {
    const from = line.match(/^\s*from\s+(celery(?:\.[\w.]+)?)\s+import\s+(.+)/);
    if (from) {
      for (const part of from[2].split(",")) {
        const [original, alias] = part.trim().split(/\s+as\s+/);
        if (original === "Celery") hasConstructor = true;
        if (original === "task" || original === "shared_task") receivers.add(alias ?? original);
      }
    }
    const module = line.match(/^\s*import\s+(celery)(?:\s+as\s+([A-Za-z_]\w*))?/);
    if (module) receivers.add(module[2] ?? module[1]);
    const assignment = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*Celery\s*\(/);
    if (assignment && hasConstructor) receivers.add(assignment[1]);
  }
  return receivers;
}

function isCeleryDecorator(statement: string, receivers: Set<string>) {
  const match = statement.match(/^\s*@([A-Za-z_]\w*)(?:\.(task|shared_task))?\b/);
  return Boolean(match && receivers.has(match[1]) && (match[2] || match[1] === "task" || match[1] === "shared_task"));
}

function explicitImportSource(raw: string, receiver: string) {
  for (const line of pythonCodeLines(raw)) {
    const from = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/);
    if (from) {
      for (const part of from[2].split(",")) {
        const [original, alias] = part.trim().split(/\s+as\s+/);
        if ((alias ?? original) === receiver) return from[1];
      }
    }
    const module = line.match(/^\s*import\s+(.+)/);
    if (module) {
      for (const part of module[1].split(",")) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if ((alias ?? name.split(".")[0]) === receiver) return name;
      }
    }
  }
  return undefined;
}

function hasPubSubReceiver(receiver: string, raw: string) {
  const imported = explicitImportSource(raw, receiver);
  if (imported) return /^(?:redis|aioredis|kombu|pika)(?:\.|$)/.test(imported);
  if (/(?:redis|pubsub|broker|channel|queue|bus|publisher|subscriber)/i.test(receiver)) return true;
  return /(?:from|import)\s+(?:redis|aioredis|kombu|pika)\b/.test(pythonCodeLines(raw).join("\n"));
}

export function analyzePythonAsync(input: { snapshot: SourceSnapshot; enabled?: boolean }): AsyncExtraction {
  const result = emptyAsyncExtraction();
  result.declarations = independentDeclarations(input.snapshot);
  if (input.enabled === false || pythonParserStatus().status === "unavailable") {
    result.omissions.push(irOmissionSchema.parse({
      id: "omission:python-async:parser-unavailable",
      owner: "python-async-extractor",
      reason: "parser-unavailable",
      detail: "Python async operation extraction was not run because the parser is unavailable",
      declarationIds: result.declarations.map((declaration) => declaration.id),
      evidenceIds: [],
      affectedViews: ["protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
    return result;
  }
  for (const file of input.snapshot.files) {
    if (file.language !== "python" || file.role !== "source" || !file.path.endsWith(".py")) continue;
    const raw = input.snapshot.rawText(file.path);
    if (!raw) continue;
    const parsed = parsePythonSource(raw);
    if (!parsed) continue;
    const queueReceivers = new Set(parsed.calls.filter((call) => call.name === "asyncio.Queue" || call.name === "queue.Queue").map((call) => call.receiver ?? call.name.split(".")[0]));
    const celeryContext = celeryReceivers(raw);
    for (const call of parsed.calls) {
      const name = call.name.split(".").at(-1);
      const receiver = call.name.split(".")[0];
      if (call.name === "asyncio.Queue" || call.name === "queue.Queue") result.operations.push(operation("declare", file.path, call.line, topicForCall(call), false, file.packageId));
      if ((name === "put" || name === "put_nowait") && queueReceivers.has(receiver)) result.operations.push(operation("enqueue", file.path, call.line, topicForCall(call), false, file.packageId));
      if ((name === "get" || name === "get_nowait") && queueReceivers.has(receiver)) result.operations.push(operation("consume", file.path, call.line, topicForCall(call), false, file.packageId));
      if (call.name === "asyncio.create_task" || call.name === "asyncio.gather") result.operations.push(operation("consume", file.path, call.line, name ?? "create_task", false, file.packageId));
      if (call.name === "asyncio.sleep" || call.name === "threading.Timer" || call.name === "schedule.every") result.operations.push(operation("schedule", file.path, call.line, name === "Timer" ? "threading.Timer" : name === "every" ? "schedule.every" : "asyncio.sleep", false, file.packageId));
      if ((name === "publish" || name === "subscribe") && hasPubSubReceiver(receiver, raw)) {
        const topic = literal(call.arguments[0]);
        const current = operation(name, file.path, call.line, topic ?? "dynamic", topic === undefined, file.packageId);
        result.operations.push(current);
        if (topic === undefined) result.omissions.push(irOmissionSchema.parse({
          id: `omission:python-async-topic:${file.path}:${call.line}`,
          owner: current.id,
          reason: "unknown-identity",
          detail: `Python ${name} topic is dynamic at ${file.path}:${call.line}`,
          declarationIds: current.declarationIds,
          evidenceIds: current.evidenceIds,
          affectedViews: ["protocol-flows", "full-declared-scope"],
          blocking: true,
        }));
      }
    }
    for (const decorator of parsed.decorators) {
      if (isCeleryDecorator(`@${decorator.name}`, celeryContext)) result.operations.push(operation("consume", file.path, decorator.line, decoratorTopic(decorator), false, file.packageId));
    }
  }
  result.evidenceRecords = result.operations.map((operation) => {
    const [path, line] = (operation.callSite ?? "unknown:1").split(/:(\d+)$/);
    return parserEvidence(path, Number(line), `ast:python-async:${operation.action}`, "runtime-call");
  });
  return result;
}
