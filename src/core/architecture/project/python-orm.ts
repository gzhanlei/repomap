import { createHash } from "node:crypto";
import type { ProjectPreparation } from "./adapter.js";
import type { SourceSnapshot } from "./snapshot.js";
import { importBindingAt, parsePythonSource, pythonParserStatus, type PythonParsedFile, type PythonParsedImport } from "./python-parser.js";
import { type AsyncDeclaration, type AsyncExtraction } from "./async-graph.js";
import { pythonCodeLines } from "./python-source.js";
import { evidenceRecord } from "../evidence-index.js";
import type { ArchitectureEvidence } from "../facts.js";
import { irOmissionSchema, type IrOmission, type OperationFact } from "../ir.js";

export type OrmExtraction = AsyncExtraction & { migrationDeclarations: AsyncDeclaration[] };

/** The facts-level evidence of an ORM call; `evidenceRecord` derives its role (runtime-call, or migration in a migration module). */
function ormEvidence(path: string, line: number, action: string): ArchitectureEvidence {
  return { path, line, detector: `ast:python-orm-call:${action}` };
}

// What a Django manager or queryset call has done by the time it returns. A
// chain is classified by its terminal method. The lazy methods only build the
// query, so they are recorded as the read they declare; where that query is
// evaluated is not visible at the call site.
const writeMethods = new Set(["create", "bulk_create", "bulk_update", "update", "delete"]);
const readWriteMethods = new Set(["get_or_create", "update_or_create"]);
const readMethods = new Set(["get", "first", "last", "earliest", "latest", "count", "exists", "aggregate", "in_bulk", "iterator", "explain", "raw"]);
const lazyMethods = new Set(["all", "filter", "exclude", "annotate", "alias", "order_by", "values", "values_list", "dates", "datetimes", "distinct", "using", "only", "defer", "select_related", "prefetch_related", "none", "reverse", "union", "intersection", "difference", "extra", "select_for_update"]);
// Django's own abstract model bases (django.contrib.auth.models).
const djangoModelBases = new Set(["AbstractUser", "AbstractBaseUser", "PermissionsMixin"]);

const djangoImport = /(?:^|\n)\s*(?:from\s+django(?:\.[\w.]+)?\s+import\b|import\s+django(?:\.[\w.]+)*\b)/;
// `Model.objects.<method>(`: the default manager reached on a class name. The
// owner must be a capitalized identifier, so a dict attribute such as
// self.objects.get(...) is not a declaration.
const managerCall = /\b([A-Z][A-Za-z0-9_]*)\.objects\.([A-Za-z_]\w*)\s*\(/g;
// `migrations.<Operation>(`: a Django migration operation in its canonical textual form.
const migrationCall = /\bmigrations\.([A-Z][A-Za-z0-9_]*)\s*\(/g;
const djangoMigrations = "django.db.migrations";
const engineLiteral = /["']ENGINE["']\s*:\s*["']django\.db\.backends\.([a-z0-9_]+)["']/g;
const engineAlias = /["']([A-Za-z_]\w*)["']\s*:\s*\{[^{}]*?["']ENGINE["']\s*:\s*["']django\.db\.backends\.([a-z0-9_]+)["']/gs;
const identifier = /^[A-Za-z_]\w*$/;
const stringLiteral = /(["'])(?:\\.|(?!\1)[^\\])*\1/g;
const migrationPath = /(?:^|\/)migrations?\//;

interface OrmFile {
  path: string;
  packageId: string;
  raw: string;
  code: string[];
  parsed?: PythonParsedFile;
}
interface ClassRef {
  module: string;
  name: string;
}
type ResolvedClass = ClassRef | "external-django";
type ResolveClass = (file: OrmFile, name: string, line: number) => ResolvedClass | undefined;
interface ManagerDeclaration {
  id: string;
  path: string;
  line: number;
  model: string;
}
interface Driver {
  value: string;
  resolution: "static" | "configured" | "dynamic" | "unknown";
  /** Why the driver is not a single known engine, when it is not. */
  omission?: string;
}

function shortHash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function ormOmission(id: string, owner: string, reason: IrOmission["reason"], detail: string, declarationIds: string[], evidenceIds: string[]): IrOmission {
  return irOmissionSchema.parse({ id, owner, reason, detail, declarationIds, evidenceIds, affectedViews: ["protocol-flows", "full-declared-scope"], blocking: true });
}

function directoryOf(module: string) {
  return module.replace(/(^|\/)__init__\.py$/, "").replace(/\.py$/, "");
}

function submoduleFile(paths: Set<string>, directory: string, name: string) {
  const base = directory ? `${directory}/${name}` : name;
  if (paths.has(`${base}.py`)) return `${base}.py`;
  if (paths.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
  return undefined;
}

/** `import a.b.c [as m]` binds the module path itself; `from source import name [as head]` binds one attribute of it. */
function qualifiedName(text: string, binding: PythonParsedImport | undefined) {
  if (!binding) return text;
  const head = text.split(".")[0];
  const rest = text.slice(head.length);
  if (binding.importedNames.length === 0) return binding.bindings[head] === head ? text : `${binding.source}${rest}`;
  return `${binding.source}.${binding.bindings[head]}${rest}`;
}

function isDjangoModule(binding: PythonParsedImport) {
  return binding.source === "django" || binding.source.startsWith("django.");
}

/** Where a dotted class name used at `line` is defined: a class of the snapshot, or a class imported from django itself. */
function resolveClass(file: OrmFile, name: string, line: number, imports: ProjectPreparation["imports"], modulePaths: Set<string>): ResolvedClass | undefined {
  const parsed = file.parsed;
  if (!parsed) return undefined;
  const segments = name.split(".");
  const head = segments[0];
  const binding = importBindingAt(parsed, head, line);
  // A bare name is the class it was imported as, not the local alias.
  const className = segments.length === 1 ? (binding ? binding.bindings[head] : head) : segments.at(-1)!;
  if (!binding) {
    return segments.length === 1 && parsed.symbols.some((symbol) => symbol.kind === "class" && symbol.name === className) ? { module: file.path, name: className } : undefined;
  }
  const refs = imports.filter((item) => item.path === file.path && item.line === binding.line && item.source === binding.source);
  const resolved = refs.find((item) => item.resolvedPath !== undefined);
  if (!resolved?.resolvedPath) {
    return segments.length === 1 && refs.some((item) => item.resolution === "external") && isDjangoModule(binding) ? "external-django" : undefined;
  }
  // `from package import module` may resolve to the package __init__ while the
  // imported name is the submodule that owns the class.
  const module = submoduleFile(modulePaths, directoryOf(resolved.resolvedPath), binding.bindings[head]) ?? resolved.resolvedPath;
  const middle = segments.slice(1, -1);
  // For `import a.b.c` the name spells the full path: the segments between
  // must be the tail of the resolved module path.
  if (middle.length > 0 && directoryOf(module).split("/").slice(-middle.length).join("/") !== middle.join("/")) return undefined;
  return { module, name: className };
}

function modelClasses(files: OrmFile[], resolve: ResolveClass) {
  const classes = files.flatMap((file) => (file.parsed?.symbols ?? []).filter((symbol) => symbol.kind === "class" && (symbol.bases?.length ?? 0) > 0).map((symbol) => ({ file, symbol })));
  const models = new Set<string>();
  // Inheritance makes this a fixpoint: a subclass of a model is a model.
  for (let pass = 0; pass <= classes.length; pass += 1) {
    const before = models.size;
    for (const { file, symbol } of classes) {
      const key = `${file.path}|${symbol.name}`;
      if (models.has(key)) continue;
      const isModelBase = (base: string) => {
        const name = base.replace(/\[.*$/s, "");
        const binding = importBindingAt(file.parsed!, name.split(".")[0], symbol.line);
        const qualified = qualifiedName(name, binding);
        if (qualified === "django.db.models.Model") return true;
        if (qualified.startsWith("django.contrib.") && djangoModelBases.has(qualified.slice(qualified.lastIndexOf(".") + 1))) return true;
        const ref = resolve(file, name, symbol.line);
        return ref !== undefined && ref !== "external-django" && models.has(`${ref.module}|${ref.name}`);
      };
      if (symbol.bases!.some(isModelBase)) models.add(key);
    }
    if (models.size === before) break;
  }
  return models;
}

function engineFamily(engine: string) {
  if (engine.startsWith("postgresql")) return "postgres";
  if (engine === "mysql" || engine === "mariadb") return "mysql";
  return engine.startsWith("sqlite") ? "sqlite" : engine;
}

/** A data migration gets its models from the app registry: `Check = apps.get_model("api", "Check")`.
 *  The name holds from its assignment on, inside the function that assigns it. */
function historicalModelAt(file: OrmFile, name: string, line: number) {
  if (!migrationPath.test(file.path) || !file.parsed) return false;
  return file.parsed.calls.some((call) => {
    if (!call.name.endsWith(".get_model") || call.receiver !== name || call.line > line) return false;
    const scope = file.parsed!.symbols.find((symbol) => symbol.kind === "function" && symbol.line <= call.line && call.line <= (symbol.endLine ?? symbol.line));
    return scope === undefined || line <= (scope.endLine ?? scope.line);
  });
}

/** The driver of an ORM call is the engine Django is configured with, taken from the ENGINE literals of the snapshot. */
function databaseDriver(files: OrmFile[]): Driver {
  const engines = new Set<string>();
  const aliases = new Set<string>();
  for (const file of files) {
    const text = file.code.join("\n");
    for (const match of text.matchAll(engineLiteral)) engines.add(engineFamily(match[1]));
    for (const match of text.matchAll(engineAlias)) aliases.add(match[1]);
  }
  const families = [...engines].sort();
  if (families.length === 1) return { value: families[0], resolution: "static" };
  if (families.length === 0) return { value: "unknown", resolution: "unknown", omission: "No Django database engine (django.db.backends.*) is declared in the snapshot" };
  // One alias whose engine is selected by configuration is a configured
  // identity: the call names its candidate engines instead of guessing one.
  if (aliases.size <= 1) return { value: families.join("|"), resolution: "configured" };
  return { value: families.join("|"), resolution: "dynamic", omission: `Django database alias is not unique in a multi-database project: ${[...aliases].sort().join(", ")}` };
}

/** Independent denominator: every manager call line, found without the parser. */
function independentDeclarations(files: OrmFile[]) {
  const declarations: ManagerDeclaration[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    file.code.forEach((line, index) => {
      // String literals are not code: a marker table quoting "Model.objects.get(" is not a declaration.
      for (const match of line.replace(stringLiteral, "''").matchAll(managerCall)) {
        const id = `orm:${shortHash(`${file.path}|${index + 1}|${match[1]}`)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        declarations.push({ id, path: file.path, line: index + 1, model: match[1] });
      }
    });
  }
  return declarations;
}

/** Independent denominator for migrations: every canonical `migrations.<Operation>(` line, found without the parser. */
function independentMigrationDeclarations(files: OrmFile[]) {
  const declarations: ManagerDeclaration[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    file.code.forEach((line, index) => {
      for (const match of line.replace(stringLiteral, "''").matchAll(migrationCall)) {
        const id = `django-migration:${shortHash(`${file.path}|${index + 1}|${match[1]}`)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        declarations.push({ id, path: file.path, line: index + 1, model: match[1] });
      }
    });
  }
  return declarations;
}

/** The migration operations called in `files`, each bound to django.db.migrations through the file's imports. */
function migrationOperations(files: OrmFile[]) {
  const bound: Array<{ file: OrmFile; path: string; line: number; operation: string }> = [];
  const unbound: Array<{ path: string; line: number; operation: string }> = [];
  const order = (left: { path: string; line: number }, right: { path: string; line: number }) => left.path.localeCompare(right.path) || left.line - right.line;
  const calls = files.flatMap((file) => (file.parsed?.calls ?? []).flatMap((call) => {
    const segments = call.name.split(".");
    const operation = segments.at(-1) ?? "";
    const receiver = segments.slice(0, -1).join(".");
    if (segments.length < 2 || !/^[A-Z]/.test(operation)) return [];
    return [{ file, path: file.path, line: call.line, operation, receiver }];
  })).sort(order);
  for (const call of calls) {
    const binding = importBindingAt(call.file.parsed!, call.receiver.split(".")[0], call.line);
    if (qualifiedName(call.receiver, binding) === djangoMigrations) bound.push(call);
    // The textual `migrations.<Operation>(` form is a declaration even when the
    // receiver is some other module: it fails closed. Any other alias that does
    // not resolve to Django's module is just some other call.
    else if (call.receiver === "migrations" || call.receiver.endsWith(".migrations")) unbound.push(call);
  }
  return { bound, unbound };
}

export function analyzePythonDjangoOrm(input: { snapshot: SourceSnapshot; project: ProjectPreparation; enabled?: boolean }): OrmExtraction {
  const result: OrmExtraction = { operations: [], declarations: [], omissions: [], evidenceRecords: [], migrationDeclarations: [] };
  const files: OrmFile[] = input.snapshot.files
    .filter((file) => file.language === "python" && file.role === "source" && file.path.endsWith(".py"))
    .map((file) => {
      const raw = (input.snapshot.rawText(file.path) ?? "").replace(/\r\n?/g, "\n");
      return { path: file.path, packageId: file.packageId, raw, code: pythonCodeLines(raw) };
    });
  // Manager access only means Django ORM in a project that imports Django.
  if (!files.some((file) => djangoImport.test(file.code.join("\n")))) return result;
  const declared = independentDeclarations(files);
  result.declarations = declared.map(({ id, path, line }) => ({ id, path, line }));
  const declaredMigrations = independentMigrationDeclarations(files);
  result.migrationDeclarations = declaredMigrations.map(({ id, path, line }) => ({ id, path, line }));
  if (input.enabled === false || pythonParserStatus().status === "unavailable") {
    result.omissions.push(ormOmission("omission:python-orm:parser-unavailable", "python-orm-extractor", "parser-unavailable", "Django ORM operation extraction was not run because the parser is unavailable", declared.map((declaration) => declaration.id), []));
    result.omissions.push(ormOmission("omission:python-django-migration:parser-unavailable", "python-django-migration-extractor", "parser-unavailable", "Django migration operation extraction was not run because the parser is unavailable", declaredMigrations.map((declaration) => declaration.id), []));
    return result;
  }
  for (const file of files) file.parsed = parsePythonSource(file.raw) ?? undefined;
  const modulePaths = new Set(files.map((file) => file.path));
  const resolve: ResolveClass = (file, name, line) => resolveClass(file, name, line, input.project.imports, modulePaths);
  const models = modelClasses(files, resolve);
  const driver = databaseDriver(files);

  // One statement per manager-rooted expression: the outermost call of a
  // chain, classified by its terminal method.
  const statements = files.flatMap((file) => (file.parsed?.calls ?? []).filter((call) => !call.chained).flatMap((call) => {
    const segments = call.name.split(".");
    const manager = segments.indexOf("objects");
    const method = segments.at(-1) ?? "";
    if (manager < 1 || manager > segments.length - 2 || !/^[A-Z]/.test(segments[manager - 1]) || !identifier.test(method)) return [];
    return [{ file, path: file.path, line: call.line, root: segments.slice(0, manager).join("."), model: segments[manager - 1], method }];
  })).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.model.localeCompare(b.model));
  const declaredByKey = new Map(declared.map((declaration) => [`${declaration.path}:${declaration.line}:${declaration.model}`, declaration]));
  const parsedDeclarations = new Set<string>();
  for (const statement of statements) {
    const declaration = declaredByKey.get(`${statement.path}:${statement.line}:${statement.model}`);
    const declarationIds = declaration ? [declaration.id] : [];
    if (declaration) parsedDeclarations.add(declaration.id);
    const site = `${statement.path}:${statement.line}`;
    const ref = resolve(statement.file, statement.root, statement.line);
    if ((ref === undefined || (ref !== "external-django" && !models.has(`${ref.module}|${ref.name}`))) && !historicalModelAt(statement.file, statement.model, statement.line)) {
      result.omissions.push(ormOmission(`omission:python-orm-model:${site}:${statement.model}`, `python-orm:${site}:${statement.model}`, "unknown-identity", `Django manager access is rooted on a class that is not a Django model at ${site}`, declarationIds, []));
      continue;
    }
    const action = writeMethods.has(statement.method) ? "write"
      : readWriteMethods.has(statement.method) ? "read-write"
        : readMethods.has(statement.method) || lazyMethods.has(statement.method) ? "read"
          : undefined;
    const record = evidenceRecord(ormEvidence(statement.path, statement.line, action ?? "unknown"));
    const current = {
      id: `operation:orm:${shortHash(`${statement.path}|${statement.line}|${statement.model}|${statement.method}`)}`,
      kind: "sql",
      owner: statement.file.packageId,
      declarationIds,
      evidenceIds: [record.id],
      targetKind: "database",
      resolution: driver.resolution,
      action: action ?? "unknown",
      driver: driver.value,
      callSite: site,
    } as OperationFact;
    result.operations.push(current);
    result.evidenceRecords.push(record);
    if (action === undefined) {
      result.omissions.push(ormOmission(`omission:python-orm-method:${site}:${statement.model}`, current.id, "uncertain-direction", `Django manager method ${statement.method} on ${statement.model}.objects is not a classified queryset method at ${site}`, current.declarationIds, current.evidenceIds));
    }
    if (driver.omission) {
      result.omissions.push(ormOmission(`omission:python-orm-driver:${site}:${statement.model}`, current.id, "unknown-identity", `${driver.omission}: ${site}`, current.declarationIds, current.evidenceIds));
    }
  }
  // A declaration the parser produced no call for is neither counted nor dropped.
  for (const declaration of declared) {
    if (parsedDeclarations.has(declaration.id)) continue;
    const site = `${declaration.path}:${declaration.line}`;
    const parsedFile = files.find((file) => file.path === declaration.path);
    result.omissions.push(ormOmission(`omission:python-orm-unparsed:${site}:${declaration.model}`, `python-orm:${site}:${declaration.model}`, parsedFile?.parsed ? "unsupported-syntax" : "parse-error", `Django ORM declaration has no parsed call at ${site}`, [declaration.id], []));
  }
  // Migration operations: every call on django.db.migrations is one operation,
  // whether it changes schema, data or both.
  const { bound, unbound } = migrationOperations(files);
  const migrationDeclaredByKey = new Map(declaredMigrations.map((declaration) => [`${declaration.path}:${declaration.line}:${declaration.model}`, declaration]));
  const migrationParsed = new Set<string>();
  const occurrence = new Map<string, number>();
  const nextIndex = (key: string) => {
    const index = occurrence.get(key) ?? 0;
    occurrence.set(key, index + 1);
    return index;
  };
  for (const call of bound) {
    const site = `${call.path}:${call.line}`;
    const key = `${site}:${call.operation}`;
    const index = nextIndex(key);
    const declaration = migrationDeclaredByKey.get(key);
    if (declaration) migrationParsed.add(declaration.id);
    const record = evidenceRecord({ path: call.path, line: call.line, detector: `ast:python-django-migration:${call.operation}` });
    const current = {
      id: `operation:django-migration:${shortHash(`${key}|${index}`)}`,
      kind: "sql",
      owner: call.file.packageId,
      declarationIds: declaration ? [declaration.id] : [],
      evidenceIds: [record.id],
      targetKind: "database",
      resolution: driver.resolution,
      action: "migration",
      driver: driver.value,
      callSite: site,
    } as OperationFact;
    result.operations.push(current);
    result.evidenceRecords.push(record);
    if (driver.omission) {
      result.omissions.push(ormOmission(`omission:python-django-migration-driver:${key}:${index}`, current.id, "unknown-identity", `${driver.omission}: ${site}`, current.declarationIds, current.evidenceIds));
    }
  }
  for (const call of unbound) {
    const site = `${call.path}:${call.line}`;
    const key = `${site}:${call.operation}`;
    const index = nextIndex(key);
    const declaration = migrationDeclaredByKey.get(key);
    if (declaration) migrationParsed.add(declaration.id);
    result.omissions.push(ormOmission(`omission:python-django-migration-binding:${key}:${index}`, `python-django-migration:${key}`, "unknown-identity", `Django migration operation is not bound to ${djangoMigrations} at ${site}`, declaration ? [declaration.id] : [], []));
  }
  // A migration declaration the parser produced no call for is neither counted nor dropped.
  for (const declaration of declaredMigrations) {
    if (migrationParsed.has(declaration.id)) continue;
    const site = `${declaration.path}:${declaration.line}`;
    const parsedFile = files.find((file) => file.path === declaration.path);
    result.omissions.push(ormOmission(`omission:python-django-migration-unparsed:${site}:${declaration.model}`, `python-django-migration:${site}:${declaration.model}`, parsedFile?.parsed ? "unsupported-syntax" : "parse-error", `Django migration declaration has no parsed call at ${site}`, [declaration.id], []));
  }
  result.operations.sort((a, b) => a.id.localeCompare(b.id));
  result.omissions.sort((a, b) => a.id.localeCompare(b.id));
  result.evidenceRecords = [...new Map(result.evidenceRecords.map((record) => [record.id, record])).values()].sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
