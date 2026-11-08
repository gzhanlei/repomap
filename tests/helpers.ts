import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const revision = "13157624fb0d8b63e5072049c94824d4b6d2e609";

export async function nextFixture() {
  const root = await mkdtemp(join(tmpdir(), "repomap-fixture-"));
  await mkdir(join(root, "app/api/products"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" }, scripts: { start: "next start" } }));
  await writeFile(join(root, "app/page.tsx"), "export default function Page() {}\n");
  await writeFile(join(root, "app/api/products/route.ts"), "export async function POST() {}\n");
  return root;
}
