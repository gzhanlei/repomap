import { describe, expect, it } from "vitest";
import { analyzeRepositoryArchitecture } from "../src/core/architecture/repository.js";
import { revision } from "./helpers.js";

describe("Prisma and optional external-service evidence", () => {
  it("links Next.js runtime closures to a MySQL Prisma client without treating disabled OpenAI config as a call", () => {
    const sources = [
      { path: "package.json", content: "1: {\"scripts\":{\"start\":\"next start\"},\"dependencies\":{\"next\":\"16.0.0\",\"mysql2\":\"3.0.0\"}}" },
      { path: "app/page.tsx", content: "1: export default function Page() {}" },
      { path: "app/api/projects/route.ts", content: "1: import { prisma } from '../../../lib/db'\n2: export async function GET() { return Response.json(await prisma.project.findMany()) }" },
      { path: "lib/db.ts", content: "1: import { PrismaClient } from '@prisma/client'\n2: export const prisma = new PrismaClient()" },
      { path: "prisma/schema.prisma", content: "1: datasource db {\n2: provider = \"mysql\"\n3: }" },
      { path: "TextbookAnalysis/config.yaml", content: "1: api:\n2: provider: none\n3: env_key: \"OPENAI_API_KEY\"\n4: use_for_grouping: false" },
    ];
    const analysis = analyzeRepositoryArchitecture({ revision, sources, sourceReceipt: { scope: "repository", directories: 4, files: sources.length, bytes: 1000 } });
    expect(analysis.facts.edges.some((edge) => edge.from === "next:root:api" && edge.to === "store:mysql" && edge.kind === "sql")).toBe(true);
    expect(analysis.inventory.signals.some((signal) => signal.evidence.path === "TextbookAnalysis/config.yaml")).toBe(false);
    expect(analysis.coverage.unclassifiedCriticalSignals).toEqual([]);
    expect(analysis.coverage.unreachableRuntimeUnits).toEqual([]);
    expect(analysis.coverage.publishable).toBe(true);
  });
});
