import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeSources } from "../src/core/analyze.js";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { analyzePythonAsync } from "../src/core/architecture/project/python-async.js";
import { analyzePythonRoutes } from "../src/core/architecture/project/python-routes.js";
import { createUnavailableAdapter } from "../src/core/architecture/project/adapter.js";
import { buildSourceCensus } from "../src/core/architecture/census.js";
import { prepareProjects } from "../src/core/architecture/project/prepare.js";
import { createSourceSnapshot, numberedText } from "../src/core/architecture/project/snapshot.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };
function source(path: string, raw: string) {
  return { path, content: numberedText(raw), rawText: () => raw };
}
function analyze(files: Record<string, string>) {
  return analyzeArchitectureFacts(scope, Object.entries(files).map(([path, raw]) => source(path, raw)));
}

describe("M8 Python protocols", () => {
  it("resolves FastAPI routes and APIRouter prefixes", () => {
    const analysis = analyze({
      "app/main.py": [
        "from fastapi import FastAPI, APIRouter",
        "app = FastAPI()",
        "router = APIRouter(prefix='/v1')",
        "@app.get('/items/{item_id}')",
        "def read_item(item_id: int): return {'id': item_id}",
        "@app.post('/items')",
        "def create_item(): return {'ok': True}",
        "@router.get('/health')",
        "def health(): return {'ok': True}",
        "app.include_router(router)",
      ].join("\n"),
    });
    expect(analysis.routeGraph.routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /items/{item_id}", "GET /v1/health", "POST /items",
    ]);
    expect(analysis.routeGraph.coverage.missing).toHaveLength(0);
    expect(analysis.routeGraph.handlers.every((handler) => handler.resolution === "local")).toBe(true);
    expect(analysis.ir.operations.filter((operation) => operation.kind === "http").length).toBe(3);
  });

  it("resolves Flask route methods", () => {
    const analysis = analyze({
      "app/main.py": [
        "from flask import Flask",
        "app = Flask(__name__)",
        "@app.route('/users', methods=['GET', 'POST'])",
        "def users(): return {'users': []}",
      ].join("\n"),
    });
    expect(analysis.routeGraph.routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(["GET /users", "POST /users"]);
    expect(analysis.routeGraph.coverage.missing).toHaveLength(0);
  });

  it("extracts SQLite reads, writes and transactions", () => {
    const analysis = analyze({
      "app/__main__.py": "from . import db\nif __name__ == '__main__': db.conn.commit()\n",
      "app/db.py": [
        "import sqlite3",
        "conn = sqlite3.connect('app.db')",
        "cursor = conn.cursor()",
        "cursor.execute('SELECT * FROM users')",
        "cursor.execute('INSERT INTO users VALUES (1)')",
        "conn.commit()",
      ].join("\n"),
    });
    expect(analysis.facts.nodes.some((node) => node.id === "store:sqlite" && node.kind === "database")).toBe(true);
    const operations = analysis.ir.operations.filter((operation) => operation.kind === "sql");
    expect(operations.map((operation) => operation.action)).toEqual(expect.arrayContaining(["read", "write", "transaction"]));
    expect(operations.every((operation) => operation.driver === "sqlite")).toBe(true);
  });

  it("extracts SQLModel reads without turning engine construction into an operation", () => {
    const analysis = analyze({
      "app/main.py": [
        "from fastapi import FastAPI",
        "from sqlmodel import Session, select",
        "from sqlalchemy import create_engine",
        "app = FastAPI()",
        "engine = create_engine('sqlite:///app.db')",
        "@app.get('/items')",
        "def list_items():",
        "    session.exec(",
        "        select(Item)",
        "    ).first()",
        "    session.get(Item, 1)",
        "    return {'items': []}",
      ].join("\n"),
    });
    const operations = analysis.ir.operations.filter((operation) => operation.kind === "sql");
    expect(operations.filter((operation) => operation.action === "read").length).toBeGreaterThanOrEqual(2);
    expect(operations.some((operation) => operation.callSite?.endsWith("main.py:6"))).toBe(false);
  });

  it("blocks ambiguous Python SQL driver ownership in multi-store projects", () => {
    const analysis = analyze({
      "app/main.py": [
        "import sqlite3",
        "import psycopg",
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "@app.get('/items')",
        "def list_items():",
        "    session.execute('SELECT * FROM items')",
        "    return {'items': []}",
      ].join("\n"),
    });
    expect(analysis.facts.nodes.some((node) => node.id === "store:sqlite")).toBe(true);
    expect(analysis.facts.nodes.some((node) => node.id === "store:postgres")).toBe(true);
    expect(analysis.ir.omissions.some((omission) => omission.reason === "unknown-identity" && omission.owner.startsWith("python-sql:"))).toBe(true);
    expect(analysis.ir.operations.filter((operation) => operation.kind === "sql" && operation.callSite?.endsWith("main.py:7"))).toHaveLength(0);
  });

  it("does not count object stores when resolving a single SQL driver", () => {
    const analysis = analyze({
      "app/main.py": [
        "from fastapi import FastAPI",
        "from sqlalchemy import create_engine",
        "app = FastAPI()",
        "engine = create_engine('postgresql://localhost/app')",
        "@app.get('/items')",
        "def list_items():",
        "    session.get(Item, 1)",
        "    return {'items': []}",
      ].join("\n"),
      "cache.php": "<?php\nfile_get_contents('cache.txt');\n",
    });
    expect(analysis.facts.nodes.some((node) => node.id === "store:file-cache")).toBe(true);
    expect(analysis.ir.operations.some((operation) => operation.kind === "sql" && operation.action === "read")).toBe(true);
    expect(analysis.ir.omissions.some((omission) => omission.owner.startsWith("python-sql:"))).toBe(false);
  });

  it("extracts asyncio queue and schedule operations", () => {
    const analysis = analyze({
      "app/jobs.py": [
        "import asyncio",
        "queue = asyncio.Queue()",
        "async def worker():",
        "    await queue.get()",
        "async def produce():",
        "    await queue.put(1)",
        "asyncio.create_task(worker())",
        "asyncio.sleep(1)",
      ].join("\n"),
    });
    const operations = analysis.asyncGraph.operations;
    expect(operations.map((operation) => operation.action)).toEqual(expect.arrayContaining(["declare", "enqueue", "consume", "schedule"]));
    expect(analysis.asyncGraph.coverage.missing).toHaveLength(0);
  });

  it("passes full with route, SQL, async and static external HTTP facts", async () => {
    const sources = Object.entries({
      "app/main.py": [
        "import asyncio",
        "import sqlite3",
        "import requests",
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "queue = asyncio.Queue()",
        "@app.get('/items')",
        "def list_items():",
        "    conn = sqlite3.connect('app.db')",
        "    cursor = conn.cursor()",
        "    cursor.execute('SELECT * FROM items')",
        "    conn.commit()",
        "    asyncio.create_task(queue.put(1))",
        "    requests.get('https://api.example.com/items')",
        "    return {'items': []}",
      ].join("\n"),
    }).map(([path, raw]) => source(path, raw));
    const outDir = await mkdtemp(join(tmpdir(), "repomap-python-full-protocol-"));
    const receipt = await analyzeSources({
      identity: { kind: "local", owner: "local", repo: "demo", revision },
      sources,
      sourceReceipt: { scope: "repository", directories: 2, files: sources.length, bytes: 100 },
      outDir,
      requestedViews: ["full"],
      render: false,
      deliver: vi.fn(),
    });
    expect(receipt.status).toBe("facts-ready");
    expect(receipt.fullArchitecture).toBe(true);
    expect(receipt.delivery.views.every((view: { status: string }) => view.status !== "failed")).toBe(true);
    expect(receipt.aiRequests).toBe(0);
  });

  it("includes Alembic migration evidence and operation ownership", () => {
    const analysis = analyze({
      "app/__main__.py": "if __name__ == '__main__': print('ok')\n",
      "app/alembic/env.py": "from alembic import context\nfrom sqlalchemy import create_engine\nengine = create_engine('postgresql://localhost/app')\n",
      "app/alembic/versions/v1.py": "op.execute('CREATE TABLE users (id INTEGER)')\n",
    });
    expect(analysis.facts.nodes.find((node) => node.id === "store:postgres")?.evidence.some((item) => item.path === "app/alembic/versions/v1.py")).toBe(true);
    expect(analysis.ir.operations.some((operation) => operation.kind === "sql" && operation.action === "migration" && operation.owner === "python:app")).toBe(true);
    expect(analysis.ir.operations.some((operation) => operation.kind === "sql" && operation.callSite?.includes("env.py:2"))).toBe(false);
  });

  it("extracts Celery task workers and configured external targets", () => {
    const analysis = analyze({
      "app/jobs.py": [
        "import os",
        "import requests",
        "from celery import shared_task",
        "@shared_task",
        "def sync_items():",
        "    return requests.get(os.getenv('PAYMENTS_API_URL'))",
      ].join("\n"),
    });
    expect(analysis.asyncGraph.operations.some((operation) => operation.action === "consume")).toBe(true);
    const candidate = analysis.candidates.find((item) => item.identity === "payments");
    expect(candidate?.target).toMatchObject({ kind: "service", resolution: "configured", configKey: "PAYMENTS_API_URL" });
  });

  it("does not treat router, ORM, dict or HTTP methods as queue operations", () => {
    const analysis = analyze({
      "app/main.py": [
        "from fastapi import FastAPI",
        "import requests",
        "app = FastAPI()",
        "@app.get('/items')",
        "def list_items():",
        "    session.get(Item, 1)",
        "    data.get('key')",
        "    requests.get('https://api.example.com/items')",
        "    return {'items': []}",
      ].join("\n"),
    });
    expect(analysis.asyncGraph.operations).toHaveLength(0);
  });

  it("does not treat unrelated constructors, sleeps or task-like calls as async protocols", () => {
    const analysis = analyze({
      "app/main.py": [
        "import multiprocessing",
        "import time",
        "import other",
        "queue = multiprocessing.Queue()",
        "time.sleep(1)",
        "other.create_task(work)",
        "other.task",
      ].join("\n"),
    });
    expect(analysis.asyncGraph.operations).toHaveLength(0);
  });

  it("requires broker evidence for pubsub and Celery decorators", () => {
    const unknown = analyze({
      "app/jobs.py": [
        "import celery",
        "import other",
        "import redis",
        "from metrics import client",
        "@shared_task",
        "def local_job(): pass",
        "@other.task",
        "def not_celery(): pass",
        "client.publish('events')",
      ].join("\n"),
    });
    expect(unknown.asyncGraph.operations).toHaveLength(0);
    const broker = analyze({
      "app/jobs.py": [
        "import redis",
        "client.publish('events')",
      ].join("\n"),
    });
    expect(broker.asyncGraph.operations.some((operation) => operation.action === "publish")).toBe(true);
  });

  it("resolves bare Celery decorators without mistaking HTTP calls", () => {
    const analysis = analyze({
      "app/jobs.py": [
        "from celery import shared_task",
        "@shared_task",
        "def sync_items(): pass",
      ].join("\n"),
    });
    expect(analysis.asyncGraph.operations.some((operation) => operation.action === "consume")).toBe(true);
    expect(analysis.asyncGraph.coverage.missing).toHaveLength(0);
  });

  it("preserves Flask method declarations when the parser is disabled", () => {
    const sources = [source("app/main.py", "from flask import Flask\napp = Flask(__name__)\n@app.route('/users', methods=['GET', 'POST'])\ndef users(): return {}\n")];
    const census = buildSourceCensus({ revision, inventory: sources.map((item) => ({ path: item.path, size: 0, entryKind: "file" as const, selected: true })) });
    const snapshot = createSourceSnapshot({ revision, sources, census });
    const project = prepareProjects({ revision, snapshot, census, adapters: [createUnavailableAdapter("ast-python", ["python"], "disabled")] });
    const extraction = analyzePythonRoutes({ snapshot, project, enabled: false });
    expect(extraction.declarations).toHaveLength(2);
    expect(extraction.omissions[0]?.declarationIds).toHaveLength(2);
  });

  it("preserves async declarations when the parser is disabled", () => {
    const sources = [source("app/jobs.py", "import asyncio\nqueue = asyncio.Queue()\nasyncio.sleep(1)\n")];
    const census = buildSourceCensus({ revision, inventory: sources.map((item) => ({ path: item.path, size: 0, entryKind: "file" as const, selected: true })) });
    const snapshot = createSourceSnapshot({ revision, sources, census });
    const project = prepareProjects({ revision, snapshot, census, adapters: [createUnavailableAdapter("ast-python", ["python"], "disabled")] });
    const extraction = analyzePythonAsync({ snapshot, enabled: false });
    expect(project.units.some((unit) => unit.status === "parser-unavailable")).toBe(true);
    expect(extraction.declarations.length).toBeGreaterThan(0);
    expect(extraction.omissions[0]?.declarationIds.length).toBeGreaterThan(0);
  });

  it("assigns nested Python files to the nearest runtime entrypoint", () => {
    const analysis = analyze({
      "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      "workers/__main__.py": "if __name__ == '__main__': print('worker')\n",
      "workers/client.py": "import requests\nrequests.get('https://worker.example.com/job')\n",
    });
    const parent = analysis.facts.nodes.find((node) => node.id === "python:root");
    const worker = analysis.facts.nodes.find((node) => node.id === "python:workers");
    expect(parent?.sourcePaths).not.toContain("workers/client.py");
    expect(worker?.sourcePaths).toContain("workers/client.py");
    expect(analysis.facts.edges.filter((edge) => edge.to === "external:worker.example.com").map((edge) => edge.from)).toEqual(["python:workers"]);
  });

  it("resolves cross-file APIRouter prefixes", () => {
    const analysis = analyze({
      "app/main.py": [
        "from fastapi import FastAPI",
        "from app.api.main import api_router",
        "app = FastAPI()",
        "app.include_router(api_router, prefix='/api/v1')",
      ].join("\n"),
      "app/api/main.py": [
        "from fastapi import APIRouter",
        "from app.api.routes import items",
        "api_router = APIRouter()",
        "api_router.include_router(items.router)",
      ].join("\n"),
      "app/api/routes/items.py": [
        "from fastapi import APIRouter",
        "router = APIRouter(prefix='/items')",
        "@router.get('/')",
        "def list_items(): return {'items': []}",
      ].join("\n"),
    });
    expect(analysis.routeGraph.routes.map((route) => route.path)).toContain("/api/v1/items/");
    expect(analysis.routeGraph.coverage.missing).toHaveLength(0);
  });

  it("keeps static and configured external identities at their own call sites", () => {
    const analysis = analyze({
      "app/jobs.py": [
        "import os",
        "import requests",
        "PAYMENTS = 'https://payments.example.com/v1'",
        "requests.get(PAYMENTS)",
        "PAYMENTS = 'https://other.example.com/v2'",
        "requests.get(PAYMENTS)",
        "requests.get(os.getenv('SEARCH_API_URL', 'https://search.example.com'))",
        "URL = 'https://old.example.com'",
        "URL = os.getenv('PAYMENTS_API_URL')",
        "requests.get(URL)",
        "requests.get(os.getenv('API_URL', 'https://api.example.com'))",
      ].join("\n"),
    });
    expect(analysis.candidates.filter((candidate) => candidate.identity === "payments.example.com")).toHaveLength(1);
    expect(analysis.candidates.filter((candidate) => candidate.identity === "other.example.com")).toHaveLength(1);
    expect(analysis.candidates.find((candidate) => candidate.identity === "search")?.target).toMatchObject({ kind: "service", resolution: "configured", configKey: "SEARCH_API_URL" });
    expect(analysis.candidates.find((candidate) => candidate.identity === "payments" && candidate.evidence.line === 10)?.target).toMatchObject({ kind: "service", resolution: "configured", configKey: "PAYMENTS_API_URL" });
    expect(analysis.candidates.find((candidate) => candidate.identity === "api")?.target).toMatchObject({ kind: "service", resolution: "configured", configKey: "API_URL" });
  });

  it("ignores include_router on non-router objects", () => {
    const analysis = analyze({
      "app/main.py": [
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "composer.include_router(value)",
        "@app.get('/health')",
        "def health(): return {'ok': True}",
      ].join("\n"),
    });
    expect(analysis.routeGraph.coverage.missing).toHaveLength(0);
    expect(analysis.ir.omissions.some((omission) => omission.reason === "unresolved-import" && omission.owner.includes("composer"))).toBe(false);
  });

  it("fails closed for dynamic route paths and unresolved router composition", () => {
    const dynamic = analyze({
      "app/main.py": [
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "path = '/items'",
        "@app.get(path)",
        "def list_items(): return {'items': []}",
      ].join("\n"),
    });
    expect(dynamic.ir.omissions.some((omission) => omission.reason === "unsupported-syntax")).toBe(true);
    const dynamicMethods = analyze({
      "app/main.py": [
        "from flask import Flask",
        "app = Flask(__name__)",
        "METHODS = ['GET']",
        "@app.route('/items', methods=METHODS)",
        "def list_items(): return {'items': []}",
      ].join("\n"),
    });
    expect(dynamicMethods.routeGraph.routes.some((route) => route.method.startsWith("dynamic:"))).toBe(true);
    expect(dynamicMethods.ir.omissions.some((omission) => omission.reason === "unsupported-syntax")).toBe(true);
    const unresolvedFactory = analyze({
      "app/main.py": [
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "app.include_router(get_router())",
      ].join("\n"),
    });
    expect(unresolvedFactory.ir.omissions.some((omission) => omission.reason === "unresolved-import")).toBe(true);
    const unresolvedIndex = analyze({
      "app/main.py": [
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "app.include_router(routers[name])",
      ].join("\n"),
    });
    expect(unresolvedIndex.ir.omissions.some((omission) => omission.reason === "unresolved-import")).toBe(true);
    const unresolved = analyze({
      "app/main.py": [
        "from fastapi import FastAPI",
        "from external import api_router",
        "app = FastAPI()",
        "app.include_router(api_router)",
      ].join("\n"),
    });
    expect(unresolved.ir.omissions.some((omission) => omission.reason === "unresolved-import")).toBe(true);
  });

  it("fails closed for dynamic external identities", () => {
    const analysis = analyze({
      "app/main.py": [
        "import requests",
        "def call(endpoint):",
        "    return requests.get(endpoint)",
      ].join("\n"),
    });
    expect(analysis.candidates.some((candidate) => candidate.status === "omitted" && candidate.identity === "unknown")).toBe(true);
    expect(analysis.coverage.publishable).toBe(false);
  });

  it("resolves a single relative-import blueprint without a false unresolved omission", () => {
    const analysis = analyze({
      "task_app/__init__.py": [
        "from flask import Flask",
        "def create_app():",
        "    app = Flask(__name__)",
        "    from . import views",
        "    app.register_blueprint(views.bp)",
        "    return app",
      ].join("\n"),
      "task_app/views.py": [
        "from flask import Blueprint",
        "bp = Blueprint('tasks', __name__, url_prefix='/tasks')",
        "@bp.get('/result/<id>')",
        "def result(id): return {}",
      ].join("\n"),
    });
    expect(analysis.routeGraph.routes.map((route) => `${route.method} ${route.path}`)).toEqual(["GET /tasks/result/<id>"]);
    expect(analysis.routeGraph.coverage.missing).toHaveLength(0);
    expect(analysis.omissions.filter((omission) => omission.detail.includes("router"))).toHaveLength(0);
  });

  it("resolves Flask blueprint routes with url_prefix composition, overrides and add_url_rule fail-closed", () => {
    const analysis = analyze({
      "app/__init__.py": [
        "from flask import Flask",
        "def create_app():",
        "    app = Flask(__name__)",
        "    from . import auth",
        "    from . import blog",
        "    app.register_blueprint(auth.bp)",
        "    app.register_blueprint(blog.bp, url_prefix='/posts')",
        "    app.add_url_rule('/', endpoint='index')",
        "    return app",
      ].join("\n"),
      "app/auth.py": [
        "from flask import Blueprint",
        "bp = Blueprint('auth', __name__, url_prefix='/auth')",
        "@bp.route('/register', methods=('GET', 'POST'))",
        "def register(): return {'ok': True}",
        "@bp.route('/logout')",
        "def logout(): return {'ok': True}",
      ].join("\n"),
      "app/blog.py": [
        "from flask import Blueprint",
        "bp = Blueprint('blog', __name__)",
        "@bp.route('/')",
        "def index(): return {'ok': True}",
        "@bp.route('/create', methods=('GET', 'POST'))",
        "def create(): return {'ok': True}",
      ].join("\n"),
      "app/plain.py": [
        "class Registry:",
        "    pass",
        "registry = Registry()",
        "helper = object()",
        "registry.register_blueprint(helper)",
      ].join("\n"),
    });
    // auth keeps its own url_prefix; blog is overridden to /posts by
    // register_blueprint; add_url_rule is an omission, not a route.
    expect(analysis.routeGraph.routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /auth/logout", "GET /auth/register", "GET /posts/", "GET /posts/create",
      "POST /auth/register", "POST /posts/create",
    ]);
    expect(analysis.routeGraph.coverage.missing).toHaveLength(0);
    // add_url_rule endpoint indirection is unsupported and must fail closed
    // with a blocking omission instead of disappearing silently.
    expect(analysis.omissions.some((omission) => omission.detail.includes("add_url_rule"))).toBe(true);
    // A plain object's register_blueprint is not Flask and must not emit routes or omissions.
    expect(analysis.routeGraph.routes.every((route) => route.sourcePath !== "app/plain.py")).toBe(true);
  });
});
