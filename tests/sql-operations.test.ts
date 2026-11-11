import { describe, expect, it } from "vitest";
import { analyzeArchitectureFacts } from "../src/core/architecture/extract.js";
import { revision } from "./helpers.js";

const scope = { revision, scope: "repository" as const };

describe("M4 SQL operations", () => {
  it("separates reads, writes, transactions and migration ownership", () => {
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "go.mod", content: "module example.com/app" },
      { path: "cmd/app/main.go", content: 'package main\nimport "example.com/app"\nfunc main() { app.Serve() }' },
      { path: "app.go", content: 'package app\nimport "database/sql"\nfunc init() {\n db, _ = sql.Open("postgres", "dsn")\n db.Query("SELECT id FROM users")\n db.Exec("INSERT INTO users VALUES (1)")\n db.Begin()\n db.Commit()\n}' },
      { path: "internal/storage/migrations/postgres/V0001.up.sql", content: 'CREATE TABLE users (id TEXT PRIMARY KEY);' },
    ]);
    const operations = analysis.ir.operations.filter((operation) => operation.kind === "sql");
    expect(operations.map((operation) => operation.action)).toEqual(expect.arrayContaining(["read", "write", "transaction", "migration"]));
    expect(operations.every((operation) => operation.targetKind === "database" && operation.driver === "postgres")).toBe(true);
    expect(operations.filter((operation) => operation.action !== "migration").every((operation) => operation.owner === "go:cmd/app")).toBe(true);
    expect(operations.filter((operation) => operation.action === "migration").every((operation) => operation.owner === "store:postgres")).toBe(true);
    expect(operations.every((operation) => operation.evidenceIds.length > 0)).toBe(true);
    const evidenceIds = new Set(analysis.evidence.records.map((record) => record.id));
    expect(operations.every((operation) => operation.evidenceIds.every((id) => evidenceIds.has(id)))).toBe(true);
  });

  it("emits a migration operation for every alembic op.* statement, including multi-line calls", () => {
    const migration = [
      "from alembic import op",
      "import sqlalchemy as sa",
      "",
      "def upgrade():",
      "    op.alter_column('user', 'email',",
      "        existing_type=sa.String(length=255),",
      "        nullable=False)",
      "    op.create_index(op.f('ix_user_email'), 'user', ['email'],",
      "        unique=True)",
      "    op.create_foreign_key('item_owner_fkey', 'item', 'user', ['owner_id'], ['id'],",
      "        ondelete='CASCADE')",
      "",
      "def downgrade():",
      "    op.drop_constraint('item_owner_fkey', 'item',",
      "        type_='foreignkey')",
      "    op.drop_index(op.f('ix_user_email'), table_name='user')",
      "    op.create_primary_key('user_pkey', 'user', ['id'])",
      "    op.alter_column('user', 'email',",
      "        existing_type=sa.String(length=255),",
      "        nullable=True)",
    ].join("\n");
    const analysis = analyzeArchitectureFacts(scope, [
      { path: "backend/pyproject.toml", content: '[project]\nname = "backend"\nversion = "0.1.0"\n' },
      { path: "backend/app/__init__.py", content: "" },
      { path: "backend/app/main.py", content: 'from fastapi import FastAPI\nfrom sqlalchemy.orm import Session\napp = FastAPI()\n@app.get("/ping")\ndef ping(session: Session):\n    session.commit()\n    return {"ok": True}\n' },
      { path: "backend/app/alembic/env.py", content: 'from alembic import context\nurl = "postgresql://user:pass@db/app"\n' },
      { path: "backend/app/alembic/versions/001_multi.py", content: migration },
    ]);
    const migrations = analysis.ir.operations.filter((operation) => operation.kind === "sql" && operation.action === "migration");
    const callSites = new Set(migrations.map((operation) => operation.callSite ?? ""));
    const file = "backend/app/alembic/versions/001_multi.py";
    const expectedLines = new Set([5, 8, 10, 14, 16, 17, 18]);
    const actualLines = new Set([...callSites].filter((site) => site.startsWith(`${file}:`)).map((site) => Number(site.split(":")[1])));
    expect(migrations.filter((operation) => (operation.callSite ?? "").startsWith(file)).length).toBe(7);
    expect(actualLines).toEqual(expectedLines);
    expect(migrations.every((operation) => operation.evidenceIds.length > 0)).toBe(true);
  });
});
