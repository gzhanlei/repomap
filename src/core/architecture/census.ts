import { z } from "zod";
import { posix } from "node:path";
import {
  classifySourcePath, detectSourceLanguage, excludedDirectoryRules, manifestManager,
  rawEntryStatusSchema, sourceFileRoleSchema,
} from "./file-roles.js";
import { capabilityGaps } from "./scope.js";
import type { EvidenceIndex } from "./evidence-index.js";
import type { DeclarationInventory } from "./declarations.js";

/** One entry from the raw local tree or archive stream, before source filtering. */
export interface RepositoryFileEntry {
  path: string;
  size: number;
  entryKind: "file" | "symlink" | "gitlink" | "directory";
  selected: boolean;
}

export const defaultRawBudgets = { maxRawEntries: 200_000, maxRawBytes: 2_000_000_000, maxRawEntryBytes: 200_000_000 };

export const rawEntryRecordSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  entryKind: z.enum(["file", "symlink", "gitlink", "directory"]),
  language: z.string().min(1),
  role: sourceFileRoleSchema,
  packageId: z.string().min(1),
  status: rawEntryStatusSchema,
  reason: z.string().min(1),
  parser: z.string().min(1),
  declarationIds: z.array(z.string().min(1)),
  evidenceIds: z.array(z.string().min(1)),
  omissionIds: z.array(z.string().min(1)),
}).strict();
export type RawEntryRecord = z.infer<typeof rawEntryRecordSchema>;

const censusOmissionSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  reason: z.string().min(1),
  blocking: z.boolean(),
  affectedViews: z.array(z.string().min(1)),
}).strict();

export const sourceCensusSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  totals: z.object({
    rawEntries: z.number().int().nonnegative(),
    rawBytes: z.number().int().nonnegative(),
    selected: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    inventoried: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    parseErrors: z.number().int().nonnegative(),
    directoriesExcluded: z.number().int().nonnegative(),
  }).strict(),
  budgets: z.object({ maxRawEntries: z.number().int().positive(), maxRawBytes: z.number().int().positive(), maxRawEntryBytes: z.number().int().positive() }).strict(),
  rawBudgetExceeded: z.boolean(),
  byRole: z.record(z.string(), z.number().int().nonnegative()),
  byStatus: z.record(z.string(), z.number().int().nonnegative()),
  byReason: z.record(z.string(), z.number().int().nonnegative()),
  packages: z.array(z.object({
    id: z.string().min(1), root: z.string(), manifests: z.array(z.string()),
    managers: z.array(z.string()), fileCount: z.number().int().nonnegative(),
  }).strict()),
  exclusions: z.array(z.object({ rule: z.string(), reason: z.string(), count: z.number().int().nonnegative(), paths: z.array(z.string()) }).strict()),
  files: z.array(rawEntryRecordSchema),
  omissions: z.array(censusOmissionSchema),
  capabilityGaps: z.array(z.string().min(1)),
  reconciled: z.boolean(),
}).strict();
export type SourceCensus = z.infer<typeof sourceCensusSchema>;

interface PackageDraft { id: string; root: string; manifests: string[]; managers: string[]; fileCount: number }

function packageId(root: string) { return `package:${root === "." ? "root" : root}`; }

function discoverPackages(entries: RepositoryFileEntry[]): PackageDraft[] {
  const drafts = new Map<string, PackageDraft>();
  for (const manifest of entries.filter((entry) => manifestManager(entry.path) !== undefined).sort((a, b) => a.path.localeCompare(b.path))) {
    const root = posix.dirname(manifest.path);
    const id = packageId(root);
    const draft = drafts.get(id) ?? { id, root, manifests: [], managers: [], fileCount: 0 };
    draft.manifests.push(manifest.path);
    draft.managers.push(manifestManager(manifest.path) as string);
    drafts.set(id, draft);
  }
  if (drafts.size === 0) drafts.set("package:root", { id: "package:root", root: ".", manifests: [], managers: ["unknown"], fileCount: 0 });
  return [...drafts.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function ownerFor(path: string, packages: PackageDraft[]) {
  return packages.filter((entry) => entry.root === "." || path.startsWith(`${entry.root}/`)).sort((a, b) => b.root.length - a.root.length)[0]?.id ?? packages[0].id;
}

function globMatches(path: string, pattern: string) {
  const normalized = pattern.replace(/^\.\//, "");
  if (normalized === "**" || normalized === "*") return true;
  const base = normalized.replace(/\/\*\*$/, "");
  if (normalized.endsWith("/**") && path === base) return true;
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\0/g, ".*");
  return new RegExp(`^${regex}$`).test(path);
}

function userExcluded(path: string, patterns: string[], include: string[]) {
  return patterns.some((pattern) => globMatches(path, pattern)) || (include.length > 0 && !include.some((pattern) => globMatches(path, pattern)));
}

const excludedReasons: Partial<Record<ReturnType<typeof classifySourcePath>, string>> = {
  lockfile: "lockfile", test: "test-only", fixture: "fixture", generated: "generated",
  vendored: "vendored", documentation: "documentation", binary: "binary",
};

function disposition(entry: RepositoryFileEntry, excludedByUser: boolean): { role: ReturnType<typeof classifySourcePath>; status: z.infer<typeof rawEntryStatusSchema>; reason: string; parser: string } {
  const role = classifySourcePath(entry.path);
  if (excludedByUser) return { role, status: "excluded", reason: "out-of-scope", parser: "none" };
  if (entry.entryKind !== "file") return { role, status: "inventoried", reason: entry.entryKind === "gitlink" ? "submodule-gitlink" : `${entry.entryKind}-not-followed`, parser: "none" };
  if (detectSourceLanguage(entry.path) === "unknown") return { role, status: "unsupported", reason: "unsupported-language", parser: "none" };
  const reason = excludedReasons[role];
  if (reason) return { role, status: "excluded", reason, parser: "none" };
  if (!entry.selected) return { role, status: "excluded", reason: "not-runtime-source", parser: "none" };
  // Source selection and AST parsing are separate states. "selected" means
  // selected for deterministic analysis, not that an AST parser succeeded.
  if (role === "asset") return { role, status: "selected", reason: "asset-module", parser: "asset" };
  return { role, status: "selected", reason: "selected-for-line-scan", parser: "regex-line-scan@1" };
}

function tally(values: string[]) {
  return Object.fromEntries([...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())].sort((a, b) => a[0].localeCompare(b[0])));
}

export interface BuildSourceCensusInput {
  revision: string;
  inventory: RepositoryFileEntry[];
  userExclusions?: string[];
  exclude?: string[];
  include?: string[];
  budgets?: Partial<typeof defaultRawBudgets>;
}

export function buildSourceCensus(input: BuildSourceCensusInput): SourceCensus {
  const budgets = { ...defaultRawBudgets, ...input.budgets };
  const unique = new Map(input.inventory.map((entry) => [entry.path, entry]));
  const entries = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
  const packages = discoverPackages(entries);
  const exclusionsByUser = [...new Set([...(input.userExclusions ?? []), ...(input.exclude ?? [])])].sort();
  const include = input.include ?? [];
  const omissions: SourceCensus["omissions"] = [];
  const rawBytes = input.inventory.reduce((total, entry) => total + entry.size, 0);
  const rawBudgetExceeded = input.inventory.length > budgets.maxRawEntries || rawBytes > budgets.maxRawBytes || input.inventory.some((entry) => entry.size > budgets.maxRawEntryBytes);
  const files: RawEntryRecord[] = entries.map((entry) => {
    const result = disposition(entry, userExcluded(entry.path, exclusionsByUser, include));
    const omissionIds: string[] = [];
    if (result.status === "unsupported" || result.status === "parse-error" || result.reason === "submodule-gitlink") {
      const id = `census:${result.reason}:${entry.path}`;
      omissionIds.push(id);
      omissions.push({
        id, path: entry.path, reason: result.reason,
        blocking: result.reason === "submodule-gitlink",
        affectedViews: result.reason === "submodule-gitlink" ? ["runtime-overview", "module-architecture", "full-declared-scope"] : ["module-architecture"],
      });
    }
    return {
      path: entry.path, size: entry.size, entryKind: entry.entryKind,
      language: detectSourceLanguage(entry.path), role: result.role,
      packageId: ownerFor(entry.path, packages), status: result.status,
      reason: result.reason, parser: result.parser,
      declarationIds: [], evidenceIds: [], omissionIds,
    };
  });
  for (const file of files) {
    const owner = packages.find((entry) => entry.id === file.packageId);
    if (owner) owner.fileCount += 1;
  }
  if (rawBudgetExceeded) {
    omissions.push({ id: "census:budget-exceeded", path: "(repository)", reason: "budget-exceeded", blocking: true, affectedViews: ["system-context", "runtime-overview", "module-architecture", "protocol-flows", "full-declared-scope"] });
  }
  const byReason = tally(files.map((file) => file.reason));
  const reasonRules = Object.entries(byReason).filter(([reason]) => reason !== "selected-for-line-scan").map(([reason, count]) => ({
    rule: `disposition:${reason}`, reason, count,
    paths: files.filter((file) => file.reason === reason).map((file) => file.path),
  }));
  const directoryRules = excludedDirectoryRules.map((directory) => {
    const paths = files.filter((file) => file.path === directory || file.path.startsWith(`${directory}/`)).map((file) => file.path);
    return { rule: `${directory}/**`, reason: "runtime-source-directory-excluded", count: paths.length, paths };
  });
  if (exclusionsByUser.length > 0) {
    directoryRules.push({ rule: exclusionsByUser.join(","), reason: "user-exclusion", count: files.filter((file) => file.reason === "out-of-scope").length, paths: files.filter((file) => file.reason === "out-of-scope").map((file) => file.path) });
  }
  if (include.length > 0) {
    directoryRules.push({ rule: include.join(","), reason: "user-inclusion", count: files.filter((file) => file.reason === "out-of-scope").length, paths: files.filter((file) => file.reason === "out-of-scope").map((file) => file.path) });
  }
  return sourceCensusSchema.parse({
    version: 1,
    revision: input.revision,
    totals: {
      rawEntries: files.length, rawBytes,
      selected: files.filter((file) => file.status === "selected").length,
      excluded: files.filter((file) => file.status === "excluded").length,
      inventoried: files.filter((file) => file.status === "inventoried").length,
      unsupported: files.filter((file) => file.status === "unsupported").length,
      parseErrors: files.filter((file) => file.status === "parse-error").length,
      directoriesExcluded: excludedDirectoryRules.length,
    },
    budgets,
    rawBudgetExceeded,
    byRole: tally(files.map((file) => file.role)),
    byStatus: tally(files.map((file) => file.status)),
    byReason,
    packages: packages.map((entry) => ({ ...entry, managers: [...new Set(entry.managers)].sort() })),
    exclusions: [...directoryRules, ...reasonRules],
    files, omissions,
    capabilityGaps: capabilityGaps(),
    reconciled: unique.size === input.inventory.length && files.length === entries.length && new Set(files.map((file) => file.path)).size === entries.length && files.every((file) => file.status.length > 0 && file.reason.length > 0),
  });
}

export function censusFromSources(revision: string, sources: { path: string }[]): SourceCensus {
  return buildSourceCensus({ revision, inventory: sources.map((source) => ({ path: source.path, size: 0, entryKind: "file" as const, selected: true })) });
}

export function assertSourceCensusReconciled(census: SourceCensus) {
  if (!census.reconciled || census.files.length !== census.totals.rawEntries || new Set(census.files.map((file) => file.path)).size !== census.files.length) {
    throw new Error("Source census cannot reconcile with the raw repository entry inventory");
  }
  if (census.files.some((file) => !file.packageId || !file.status || !file.reason)) throw new Error("Source census has entries without a disposition");
}

export function linkCensusEvidence(census: SourceCensus, index: EvidenceIndex): SourceCensus {
  const byPath = new Map<string, Set<string>>();
  for (const record of index.records) {
    const ids = byPath.get(record.path) ?? new Set<string>();
    ids.add(record.id);
    byPath.set(record.path, ids);
  }
  return sourceCensusSchema.parse({ ...census, files: census.files.map((file) => ({ ...file, evidenceIds: [...(byPath.get(file.path) ?? [])].sort() })) });
}

export function linkCensusDeclarations(census: SourceCensus, declarations: DeclarationInventory): SourceCensus {
  const byPath = new Map<string, Set<string>>();
  for (const declaration of declarations.declarations) {
    const ids = byPath.get(declaration.sourcePath) ?? new Set<string>();
    ids.add(declaration.declarationId);
    byPath.set(declaration.sourcePath, ids);
  }
  return sourceCensusSchema.parse({ ...census, files: census.files.map((file) => ({ ...file, declarationIds: [...(byPath.get(file.path) ?? [])].sort() })) });
}
