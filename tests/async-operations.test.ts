import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { createUnavailableAdapter } from "../src/core/architecture/project/adapter.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };

describe("M4 async operations", () => {
  it("keeps TypeScript queue, pub/sub and scheduler directions", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"scripts":{"start":"node jobs.js"},"dependencies":{"bullmq":"5.0.0"}}' },
      { path: "src/jobs/render.ts", content: 'const queue = new Queue("render");\nqueue.add("render", data);\nconst worker = new Worker("render", async job => work(job));\nchannel.publish("news", payload);\nchannel.subscribe("news", handler);\nsetInterval(poll, 1000);' },
    ]);
    const operations = analysis.asyncGraph.operations;
    expect(operations.map((operation) => operation.action)).toEqual(expect.arrayContaining(["declare", "enqueue", "consume", "publish", "subscribe", "schedule"]));
    expect(operations.every((operation) => operation.targetKind === "queue")).toBe(true);
    expect(operations.every((operation) => operation.evidenceIds.length > 0)).toBe(true);
    expect(analysis.ir.operations.some((operation) => operation.kind === "queue" && operation.action === "enqueue" && operation.topic === "render")).toBe(true);
    expect(analysis.ir.operations.some((operation) => operation.kind === "schedule")).toBe(true);
  });

  it("keeps Go channel send/receive, pub/sub and ticker directions", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/jobs" },
      { path: "jobs.go", content: 'package jobs\nvar jobs = make(chan Job)\nfunc produce() { jobs <- job }\nfunc consume() { job := <-jobs }\nfunc after() <-chan time.Time { return time.After(d) }\nfunc release() { select { case jobs <- job: default: } }\nvar ticker = time.NewTicker(time.Minute)\nvar publisher = rdb.Publish(ctx, "news", payload)\nvar subscriber = rdb.Subscribe(ctx, "news")' },
    ]);
    const operations = analysis.asyncGraph.operations;
    expect(operations.map((operation) => operation.action)).toEqual(expect.arrayContaining(["declare", "enqueue", "consume", "publish", "subscribe", "schedule"]));
    expect(operations.every((operation) => operation.targetKind === "queue")).toBe(true);
    expect(operations.every((operation) => operation.evidenceIds.length > 0)).toBe(true);
    expect(operations.filter((operation) => operation.kind === "queue").every((operation) => operation.topic !== "chan time.Time")).toBe(true);
    expect(analysis.asyncGraph.coverage.missing).toEqual([]);
  });

  it("does not turn CI schedules into runtime async operations", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: ".github/workflows/ci.yml", content: 'on:\n  schedule:\n    - cron: "*/5 * * * *"' },
    ]);
    expect(analysis.asyncGraph.operations).toEqual([]);
    expect(analysis.asyncGraph.declarations).toEqual([]);
  });

  it("retains independent declarations and blocks dependent views when the parser is unavailable", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "package.json", content: '{"scripts":{"start":"node jobs.js"}}' },
      { path: "src/jobs/render.ts", content: 'const queue = new Queue("render");\nqueue.add("render", data);' },
    ], { adapters: [createUnavailableAdapter("ast-typescript", ["typescript", "javascript"], "simulated missing parser")] });
    expect(analysis.asyncGraph.coverage.expected).toBeGreaterThan(0);
    expect(analysis.asyncGraph.coverage.missing.length).toBeGreaterThan(0);
    expect(analysis.asyncGraph.gates.blockedViews).toContain("full-declared-scope");
    expect(analysis.asyncGraph.gates.runtimeOverviewUnaffected).toBe(true);
  });
});
