import { describe, expect, it } from "vitest";
import {
  corpusGoldSetSchema,
  evaluateCorpusGold,
  type CorpusGoldArtifacts,
  type CorpusGoldSet,
} from "../src/core/architecture/corpus-gold.js";

const revision = "a".repeat(40);

function route(id: string, overrides: Record<string, unknown> = {}) {
  return { id, framework: "fastapi", method: "GET", path: `/api/v1/${id}`, sourcePath: "backend/app/api/routes/items.py", line: 10, packageId: "package:backend", evidenceIds: ["ev:route-1"], ...overrides };
}

function sqlOperation(id: string, overrides: Record<string, unknown> = {}) {
  return { kind: "sql", action: "read", driver: "postgres", callSite: "backend/app/crud/items.py:20", id, owner: "python:backend/app", declarationIds: [], evidenceIds: ["ev:sql-1"], targetKind: "database", resolution: "static", ...overrides };
}

function artifacts(overrides: Partial<CorpusGoldArtifacts> = {}): CorpusGoldArtifacts {
  return {
    revision,
    routes: [route("route:get-items")],
    routeHandlers: [{ id: "handler:1", sourcePath: "backend/app/api/routes/items.py", line: 20, evidenceIds: ["ev:handler-1"] }],
    routeEdges: [{ id: "route-edge:1", from: "route:get-items", to: "handler:1", kind: "routes-to", evidenceIds: ["ev:edge-1"] }],
    sqlOperations: [sqlOperation("operation:sql:1")],
    asyncOperations: [],
    declarations: [],
    evidencePathsById: new Map([["ev:route-1", "backend/app/api/routes/items.py"], ["ev:handler-1", "backend/app/api/routes/items.py"], ["ev:edge-1", "backend/app/api/routes/items.py"], ["ev:sql-1", "backend/app/crud/items.py"]]),
    omissions: { routeGraph: 0, asyncGraph: 0, ir: 0 },
    ...overrides,
  };
}

const goldDefaults: CorpusGoldSet = {
  version: 1,
  corpusId: "fastapi-template",
  revision,
  auditedBy: "human",
  auditedAt: "2026-11-11",
  facts: [],
  precisionScopes: [],
};

function gold(overrides: Partial<CorpusGoldSet> = {}): CorpusGoldSet {
  return { ...goldDefaults, ...overrides };
}

describe("corpus gold schema", () => {
  it("rejects a route fact without method/path/sourcePath", () => {
    expect(() =>
      corpusGoldSetSchema.parse({ ...goldDefaults, facts: [{ id: "bad", kind: "route", sourcePath: "x.py" }] }),
    ).toThrow();
  });

  it("rejects unknown kinds and unknown fields", () => {
    expect(() => corpusGoldSetSchema.parse({ ...goldDefaults, facts: [{ id: "bad", kind: "magic" }] })).toThrow();
    expect(() =>
      corpusGoldSetSchema.parse({ ...goldDefaults, facts: [{ id: "bad", kind: "route", method: "GET", path: "/x", sourcePath: "x.py", extra: 1 }] }),
    ).toThrow();
  });

  it("rejects a revision that is not a 40-char hex", () => {
    expect(() => corpusGoldSetSchema.parse({ ...goldDefaults, revision: "short" })).toThrow();
  });
});

describe("corpus gold recall", () => {
  it("covers a route fact matching method, path and sourcePath", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      facts: [{ id: "items-get", kind: "route", method: "GET", path: "/api/v1/route:get-items", sourcePath: "backend/app/api/routes/items.py" }],
    }));
    expect(result.recall.missing).toEqual([]);
    expect(result.recall.byKind.route.covered).toBe(1);
  });

  it("reports a missing route fact when the path differs", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      facts: [{ id: "items-get", kind: "route", method: "GET", path: "/api/v1/nope", sourcePath: "backend/app/api/routes/items.py" }],
    }));
    expect(result.recall.missing.map((m) => m.id)).toEqual(["items-get"]);
    expect(result.passed).toBe(false);
  });

  it("requires a route-handler fact to find the routes-to edge direction", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      facts: [{ id: "items-handler", kind: "route-handler", method: "GET", path: "/api/v1/route:get-items", handlerSourcePath: "backend/app/api/routes/items.py" }],
    }));
    expect(result.recall.missing).toEqual([]);
    expect(result.recall.dimensions.edge.covered).toBe(1);
    expect(result.recall.dimensions.direction.covered).toBe(1);
  });

  it("reports a route-handler fact as missing when no matching edge exists", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      facts: [{ id: "items-handler", kind: "route-handler", method: "GET", path: "/api/v1/route:get-items", handlerSourcePath: "backend/app/api/routes/other.py" }],
    }));
    expect(result.recall.missing.map((m) => m.id)).toEqual(["items-handler"]);
    expect(result.recall.dimensions.direction.missing).toBe(1);
  });

  it("matches sql operation facts by action and call site", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      facts: [{ id: "items-read", kind: "sql-operation", action: "read", callSite: "backend/app/crud/items.py:20" }],
    }));
    expect(result.recall.missing).toEqual([]);
  });

  it("rejects a sql fact when the driver does not match", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      facts: [{ id: "items-read", kind: "sql-operation", action: "read", callSite: "backend/app/crud/items.py:20", driver: "mysql" }],
    }));
    expect(result.recall.missing.map((m) => m.id)).toEqual(["items-read"]);
  });
});

describe("corpus gold precision scopes", () => {
  it("reports no suspected false positives when every scoped record is explained by a gold fact", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      facts: [{ id: "items-get", kind: "route", method: "GET", path: "/api/v1/route:get-items", sourcePath: "backend/app/api/routes/items.py" }],
      precisionScopes: [{ id: "scope-items", kind: "route", sourcePathPrefix: "backend/app/api/routes/items.py" }],
    }));
    expect(result.precision.suspectedFalsePositives).toEqual([]);
    expect(result.precision.scopes[0].outputRecords).toBe(1);
  });

  it("reports an unmatched output record inside a scope as a suspected false positive", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      precisionScopes: [{ id: "scope-items", kind: "route", sourcePathPrefix: "backend/app/api/routes/items.py" }],
    }));
    expect(result.precision.suspectedFalsePositives).toEqual(["route:get-items"]);
    expect(result.passed).toBe(false);
  });

  it("leaves records outside declared scopes out of precision accounting", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      precisionScopes: [{ id: "scope-other", kind: "route", sourcePathPrefix: "backend/app/api/routes/other.py" }],
    }));
    expect(result.precision.scopes[0].outputRecords).toBe(0);
    expect(result.precision.suspectedFalsePositives).toEqual([]);
  });
});

describe("corpus gold evidence and false-positive/negative independence", () => {
  it("flags an evidence path that no matched record carries", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      facts: [{ id: "items-get", kind: "route", method: "GET", path: "/api/v1/route:get-items", sourcePath: "backend/app/api/routes/items.py", evidencePath: "backend/app/other.py" }],
    }));
    expect(result.recall.missing).toEqual([]);
    expect(result.evidence.invalid.map((e) => e.factId)).toEqual(["items-get"]);
    expect(result.passed).toBe(false);
  });

  it("reports false positives and false negatives together without cancelling", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      facts: [{ id: "missing-fact", kind: "route", method: "GET", path: "/api/v1/nope", sourcePath: "backend/app/api/routes/items.py" }],
      precisionScopes: [{ id: "scope-items", kind: "route", sourcePathPrefix: "backend/app/api/routes/items.py" }],
    }));
    expect(result.recall.missing.length).toBe(1);
    expect(result.precision.suspectedFalsePositives.length).toBe(1);
  });

  it("reports omissions separately and never counts them as coverage", () => {
    const result = evaluateCorpusGold(artifacts({ omissions: { routeGraph: 2, asyncGraph: 1, ir: 3 } }), gold({
      facts: [{ id: "items-get", kind: "route", method: "GET", path: "/api/v1/route:get-items", sourcePath: "backend/app/api/routes/items.py" }],
    }));
    expect(result.omissions).toEqual({ routeGraph: 2, asyncGraph: 1, ir: 3 });
    expect(result.recall.missing).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails when the gold revision does not match the artifacts", () => {
    const result = evaluateCorpusGold(artifacts(), gold({
      revision: "b".repeat(40),
      facts: [{ id: "items-get", kind: "route", method: "GET", path: "/api/v1/route:get-items", sourcePath: "backend/app/api/routes/items.py" }],
    }));
    expect(result.passed).toBe(false);
    expect(result.recall.missing.map((m) => m.id)).toEqual(["items-get"]);
  });
});
