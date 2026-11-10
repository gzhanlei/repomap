import ts from "typescript";
import type { SourceSnapshot } from "./snapshot.js";
import { createTypeScriptProgramBundle, typeScriptFileName } from "./typescript.js";
import { asyncDeclarationId, emptyAsyncExtraction, type AsyncExtraction } from "./async-graph.js";
import { parserEvidence } from "./route-graph.js";
import { irOmissionSchema } from "../ir.js";
import type { OperationFact } from "../ir.js";

function literalTopic(node: ts.Expression | undefined, sourceFile: ts.SourceFile) {
  if (!node) return { topic: "unknown", dynamic: true };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { topic: node.text, dynamic: false };
  return { topic: node.getText(sourceFile), dynamic: true };
}

function operation(action: string, path: string, line: number, topic: string, dynamic: boolean, packageId: string): OperationFact {
  const declarationId = asyncDeclarationId(action, path, line, topic);
  return {
    id: `operation:${declarationId}`,
    kind: action === "schedule" ? "schedule" : "queue",
    owner: packageId,
    action,
    ...(action === "schedule" ? { schedule: "setInterval", jobOwner: path } : { topic }),
    declarationIds: [declarationId],
    evidenceIds: [parserEvidence(path, line, `ast:ts-async:${action}`, "runtime-call").id],
    targetKind: "queue",
    resolution: dynamic ? "dynamic" : "static",
    callSite: `${path}:${line}`,
  } as OperationFact;
}

function independentDeclarations(snapshot: SourceSnapshot) {
  const result = emptyAsyncExtraction();
  for (const file of snapshot.files) {
    if (file.role !== "source" || !/\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(file.path)) continue;
    const raw = snapshot.rawText(file.path);
    if (!raw) continue;
    const queueAliases = new Set([...raw.matchAll(/([A-Za-z_]\w*)\s*=\s*new\s+Queue\s*\(/g)].map((match) => match[1]));
    raw.split("\n").forEach((line, index) => {
      const patterns: { regex: RegExp; action: string }[] = [
        { regex: /\bnew\s+Queue\s*\(/, action: "declare" },
        { regex: /\bnew\s+Worker\s*\(/, action: "consume" },
        { regex: /\bsetInterval\s*\(/, action: "schedule" },
        { regex: /\b\w+\.publish\s*\(/, action: "publish" },
        { regex: /\b\w+\.subscribe\s*\(/, action: "subscribe" },
      ];
      for (const pattern of patterns) {
        if (!pattern.regex.test(line)) continue;
        const topic = line.match(/["']([^"']+)["']/)?.[1] ?? (pattern.action === "schedule" ? "setInterval" : "dynamic");
        result.declarations.push({ id: asyncDeclarationId(pattern.action, file.path, index + 1, topic), path: file.path, line: index + 1 });
      }
      for (const alias of queueAliases) {
        for (const [action, method] of [["enqueue", "add"], ["consume", "process"]] as const) {
          const match = line.match(new RegExp(`\\b${alias}\\.${method}\\s*\\(\\s*["']([^"']+)["']`));
          if (match) result.declarations.push({ id: asyncDeclarationId(action, file.path, index + 1, match[1]), path: file.path, line: index + 1 });
        }
      }
    });
  }
  return result.declarations;
}

export function analyzeTypeScriptAsync(snapshot: SourceSnapshot, enabled = true): AsyncExtraction {
  const result = emptyAsyncExtraction();
  result.declarations = independentDeclarations(snapshot);
  if (!enabled) {
    result.omissions.push(irOmissionSchema.parse({
      id: "omission:ts-async:parser-unavailable",
      owner: "typescript-async-extractor",
      reason: "parser-unavailable",
      detail: "TypeScript async operation extraction was not run",
      declarationIds: result.declarations.map((declaration) => declaration.id),
      evidenceIds: [],
      affectedViews: ["protocol-flows", "full-declared-scope"],
      blocking: true,
    }));
    return result;
  }
  const bundle = createTypeScriptProgramBundle(snapshot);
  for (const file of snapshot.files) {
    if (file.role !== "source" || !/\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(file.path)) continue;
    const sourceFile = bundle.program.getSourceFile(typeScriptFileName(file.path));
    if (!sourceFile) continue;
    const lineAt = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["Queue", "Worker"].includes(node.expression.text)) {
        const action = node.expression.text === "Queue" ? "declare" : "consume";
        const { topic, dynamic } = literalTopic(node.arguments?.[0], sourceFile);
        result.operations.push(operation(action, file.path, lineAt(node), topic, dynamic, file.packageId));
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(sourceFile);
        const method = expression.split(".").at(-1);
        if (["publish", "subscribe", "add", "process", "setInterval"].includes(method ?? "")) {
          const action = method === "setInterval" ? "schedule" : method === "add" ? "enqueue" : method === "process" ? "consume" : method as string;
          const { topic, dynamic } = method === "setInterval" ? { topic: "setInterval", dynamic: false } : literalTopic(node.arguments[0], sourceFile);
          result.operations.push(operation(action, file.path, lineAt(node), topic, dynamic, file.packageId));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  result.evidenceRecords = result.operations.map((operation) => {
    const [path, line] = (operation.callSite ?? "unknown:1").split(/:(\d+)$/);
    return parserEvidence(path, Number(line), `ast:ts-async:${operation.action}`, "runtime-call");
  });
  return result;
}
