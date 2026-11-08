import type { ArchitectureEvidence, NodeFact } from "./facts.js";
import type { ArchitectureSignal } from "./signals.js";

export interface ArchitectureSource {
  path: string;
  content: string;
}

export interface ArchitectureRepositorySourceReceipt {
  scope: "repository";
  directories: number;
  files: number;
  bytes: number;
}

const runtimeSourcePattern = /\.(?:go|ts|tsx|js|jsx|php|json|sql|prisma|java|kt|kts|py|rs|cs|csproj|xml|ya?ml|toml|gradle|properties)$/i;
const nonRuntimePathPattern = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|\.)|\.(?:test|spec|d)\.[a-z]+$|_test\.(?:go|py)$/i;
const generatedArtifactPathPattern = /(?:^|\/)(?:vendor|third_party|node_modules|bower_components|dist|build|out|coverage)(?:\/|$)|(?:^|\/)(?:static|public|assets)\/(?:.*\/)?(?:mathjax|katex|plotly|monaco|codemirror|ckeditor|tinymce)(?:\/|$)|(?:^|\/)(?:static|public|assets)\/.*-full\.js$/i;

export function isArchitectureSourcePath(path: string) {
  return !generatedArtifactPathPattern.test(path) && (path.endsWith("go.mod") || runtimeSourcePattern.test(path)) && !nonRuntimePathPattern.test(path) && !path.endsWith(".min.js");
}

export function architectureLineNumber(line: string, index: number) {
  const match = line.match(/^\s*(\d+):\s?/);
  return match ? Number(match[1]) : index + 1;
}

export function architectureCallContext(lines: string[], index: number) {
  const previous = index > 0 ? lines[index - 1] : "";
  return `${previous}\n${lines[index]}`;
}

export function findAllArchitectureEvidence(source: ArchitectureSource, markers: string[], detector: string, lineFilter?: (line: string, index: number, lines: string[]) => boolean): ArchitectureEvidence[] {
  const lines = source.content.split("\n");
  return lines.flatMap((line, index) => {
    const code = line.replace(/^\s*\d+:\s?/, "").trim();
    const comment = ["//", "#", "*", "--", "/*", "<!--"].some((prefix) => code.startsWith(prefix));
    const detectorDeclaration = /\b(?:markers|callers)\s*:/.test(code);
    const matches = markers.length === 0 || markers.some((marker) => line.toLowerCase().includes(marker.toLowerCase()));
    return !comment && !detectorDeclaration && matches && (lineFilter === undefined || lineFilter(line, index, lines)) ? [{ path: source.path, line: architectureLineNumber(line, index), detector }] : [];
  });
}

export function findArchitectureEvidence(source: ArchitectureSource, markers: string[], detector: string, lineFilter?: (line: string, index: number, lines: string[]) => boolean): ArchitectureEvidence | undefined {
  return findAllArchitectureEvidence(source, markers, detector, lineFilter)[0];
}

export function architectureRuntimeSources(node: NodeFact, sources: ArchitectureSource[]) {
  const ownedPaths = node.sourcePaths === undefined ? [] : node.sourcePaths;
  const paths = new Set([...ownedPaths, ...node.evidence.map((item) => item.path)]);
  return sources.filter((source) => paths.has(source.path));
}

export function signalIdsForPaths(signals: ArchitectureSignal[], paths: Iterable<string>) {
  const accepted = new Set(paths);
  return signals.filter((signal) => accepted.has(signal.evidence.path)).map((signal) => signal.id).sort();
}

export function signalIdsForEvidence(signals: ArchitectureSignal[], evidence: ArchitectureEvidence[]) {
  const accepted = new Set(evidence.map((item) => `${item.path}:${item.line}`));
  return signals.filter((signal) => accepted.has(`${signal.evidence.path}:${signal.evidence.line}`)).map((signal) => signal.id).sort();
}

export function uniqueEvidence(evidence: ArchitectureEvidence[]) {
  const values = new Map(evidence.map((item) => [`${item.path}:${item.line}:${item.detector}`, item]));
  return [...values.values()].sort((a, b) => `${a.path}:${a.line}:${a.detector}`.localeCompare(`${b.path}:${b.line}:${b.detector}`));
}
