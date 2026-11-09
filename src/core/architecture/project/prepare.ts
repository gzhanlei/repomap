import { irOmissionSchema, type IrOmission } from "../ir.js";
import { capabilitySchema, type ArchitectureView, type Capability } from "../scope.js";
import type { SourceCensus } from "../census.js";
import {
  AdapterRegistry, adapterStatus, buildContextSchema, createUnavailableAdapter, projectUnitSchema,
  type AdapterCapability, type ImportRef, type LanguageAdapter, type ProjectUnit,
} from "./adapter.js";
import type { SourceSnapshot } from "./snapshot.js";
import { createTypeScriptAdapter } from "./typescript.js";
import { projectPreparationSchema, type ProjectPreparation } from "./adapter.js";

/** The shipped adapter set for this slice. Go is declared, not faked. */
export function defaultProjectAdapters(): LanguageAdapter[] {
  return [
    createTypeScriptAdapter(),
    createUnavailableAdapter("ast-go", ["go"], "Package-aware Go AST helper is not shipped in the project-preparation slice; go-module-graph owns it"),
  ];
}

/** go.work use / go.mod replace directives are read from the snapshot, not from the host. */
function explicitWorkspaceContext(snapshot: SourceSnapshot) {
  const workspaces = new Set<string>();
  const replaces = new Set<string>();
  for (const file of snapshot.files.filter((entry) => /(?:^|\/)go\.(?:work|mod)$/.test(entry.path))) {
    const text = snapshot.rawText(file.path) ?? "";
    for (const line of text.split("\n")) {
      const use = line.match(/^\s*use\s+(?:\(\s*)?(\S+)/);
      if (use) workspaces.add(`${file.path}:use:${use[1]}`);
      const replace = line.match(/^\s*replace\s+(\S+)\s*=>\s*(\S+)/);
      if (replace) replaces.add(`${file.path}:${replace[1]}=>${replace[2]}`);
    }
  }
  return { workspaces: [...workspaces].sort(), replaces: [...replaces].sort() };
}

export interface PrepareProjectsInput {
  revision: string;
  snapshot: SourceSnapshot;
  census: SourceCensus;
  buildContext?: { goos: string; goarch: string; buildTags: string[] };
  adapters?: LanguageAdapter[];
  distribution?: ProjectPreparation["distribution"];
}

const parserDependentViews: ArchitectureView[] = ["module-architecture", "protocol-flows", "full-declared-scope"];

export function prepareProjects(input: PrepareProjectsInput): ProjectPreparation {
  const adapters = input.adapters ?? defaultProjectAdapters();
  const registry = new AdapterRegistry(adapters);
  const explicit = explicitWorkspaceContext(input.snapshot);
  const buildContext = buildContextSchema.parse({
    goos: input.buildContext?.goos ?? "linux",
    goarch: input.buildContext?.goarch ?? "amd64",
    buildTags: input.buildContext?.buildTags ?? [],
    workspaces: [...new Set([...input.census.packages.map((entry) => entry.id), ...explicit.workspaces])].sort(),
    replaces: explicit.replaces,
  });
  const distribution = input.distribution ?? {
    engine: "node" as const,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    parserVersions: Object.fromEntries(adapters.map((adapter) => [adapter.id, adapter.version])),
  };

  const languagePaths = new Map<string, string[]>();
  const packageOf = new Map(input.snapshot.files.map((file) => [file.path, file.packageId]));
  for (const file of input.snapshot.files) {
    if (file.role !== "source" || file.language === "unknown") continue;
    const paths = languagePaths.get(file.language) ?? [];
    paths.push(file.path);
    languagePaths.set(file.language, paths);
  }

  const units: ProjectUnit[] = [];
  const omissions: IrOmission[] = [];
  const runnable = new Map<string, LanguageAdapter>();
  const reasons: string[] = [];

  for (const [language, paths] of [...languagePaths.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const adapter = registry.forLanguage(language);
    if (!adapter) {
      const groups = new Map<string, string[]>();
      for (const path of paths) {
        const packageId = packageOf.get(path) ?? "package:root";
        groups.set(packageId, [...(groups.get(packageId) ?? []), path]);
      }
      for (const [packageId, files] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const unit = projectUnitSchema.parse({
          id: `unit:${packageId}:${language}:no-adapter`,
          language, packageId, root: packageId === "package:root" ? "." : packageId.replace(/^package:/, ""),
          adapterId: "none", files: files.sort(), manifests: [], status: "no-adapter",
        });
        units.push(unit);
        omissions.push(irOmissionSchema.parse({
          id: `omission:preparation:${unit.id}`,
          owner: unit.id,
          reason: "unsupported-language",
          detail: `No LanguageAdapter is registered for ${language}; ${files.length} source files were not parsed`,
          declarationIds: [], evidenceIds: [], affectedViews: parserDependentViews, blocking: true,
        }));
      }
      reasons.push(`no adapter for language ${language}`);
      continue;
    }
    runnable.set(adapter.id, adapter);
    if (adapterStatus(adapter) === "unavailable") reasons.push(`parser unavailable: ${adapter.id}`);
  }

  let imports: ImportRef[] = [];
  let symbols: ProjectPreparation["symbols"] = [];
  let entrypoints: ProjectPreparation["entrypoints"] = [];
  let parseErrors: ProjectPreparation["parseErrors"] = [];
  let declarations: ProjectPreparation["declarations"] = [];
  const capabilities: AdapterCapability[] = [];

  for (const adapter of runnable.values()) {
    capabilities.push(...adapter.capabilities());
    const prepared = adapter.prepareProject(input.snapshot, buildContext);
    for (const unit of prepared) {
      units.push(unit);
      if (unit.status !== "prepared" || adapterStatus(adapter) === "unavailable") {
        omissions.push(irOmissionSchema.parse({
          id: `omission:preparation:${unit.id}`,
          owner: unit.id,
          reason: "parser-unavailable",
          detail: `${adapter.id} cannot parse ${unit.files.length} files in ${unit.packageId}: ${adapter.capabilities().find((capability) => capability.status === "unavailable")?.detail ?? "parser unavailable"}`,
          declarationIds: [], evidenceIds: [], affectedViews: parserDependentViews, blocking: true,
        }));
        continue;
      }
      imports = imports.concat(adapter.imports(unit));
      symbols = symbols.concat(adapter.symbols(unit));
      entrypoints = entrypoints.concat(adapter.entrypoints(unit));
      declarations = declarations.concat(adapter.declarations(unit));
      parseErrors = parseErrors.concat(adapter.parseProject(unit).parseErrors);
    }
  }

  const parsers: Capability[] = [
    capabilitySchema.parse({ id: "regex-line-scan", version: "1", status: "partial" }),
    ...adapters.map((adapter) => capabilitySchema.parse({ id: adapter.id, version: adapter.version, status: adapterStatus(adapter) })),
  ];
  const blocked = parsers.some((parser) => parser.status === "unavailable") || units.some((unit) => unit.status !== "prepared");
  if (blocked) reasons.push("parser-dependent views remain blocked; runtime-overview still uses the independent regex line scan");

  const unresolvedImports = imports.filter((item) => item.unresolvedReason !== undefined);
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  return projectPreparationSchema.parse({
    version: 1,
    revision: input.revision,
    snapshotId: input.snapshot.snapshotId,
    buildContext,
    distribution,
    units: units.sort((a, b) => a.id.localeCompare(b.id)),
    imports: imports.sort((a, b) => `${a.path}:${a.line}:${a.source}`.localeCompare(`${b.path}:${b.line}:${b.source}`)),
    symbols: symbols.sort((a, b) => `${a.path}:${a.line}:${a.name}`.localeCompare(`${b.path}:${b.line}:${b.name}`)),
    entrypoints: entrypoints.sort((a, b) => `${a.path}:${a.kind}`.localeCompare(`${b.path}:${b.kind}`)),
    parseErrors: parseErrors.sort((a, b) => `${a.path}:${a.line}`.localeCompare(`${b.path}:${b.line}`)),
    declarations: declarations.sort((a, b) => a.declarationId.localeCompare(b.declarationId)),
    unresolvedImports,
    parsers,
    capabilities: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    omissions: omissions.sort((a, b) => a.id.localeCompare(b.id)),
    gates: {
      blockedViews: blocked ? parserDependentViews : [],
      runtimeOverviewUnaffected: true,
      reasons,
    },
    statistics: {
      units: units.length,
      files: units.reduce((total, unit) => total + unit.files.length, 0),
      imports: imports.length,
      unresolvedImports: unresolvedImports.length,
      symbols: symbols.length,
      entrypoints: entrypoints.length,
      parseErrors: parseErrors.length,
    },
  });
}

export function viewsBlockedByPreparation(preparation: ProjectPreparation): readonly ArchitectureView[] {
  return preparation.gates.blockedViews;
}
