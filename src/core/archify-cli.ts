import { z } from "zod";
import { prepareArchify } from "./archify-runtime.js";
import { execCommand, type CommandRunner } from "./process.js";

const receiptSchema = z.object({
  ok: z.boolean(),
  command: z.string().optional(),
  error: z.string().optional(),
  diagnostics: z.array(z.object({ code: z.string(), message: z.string() }).passthrough()).optional(),
}).passthrough();

export type ArchifyReceipt = z.infer<typeof receiptSchema>;

function receiptMessage(receipt: ArchifyReceipt) {
  return receipt.diagnostics?.[0]?.message || receipt.error || "Archify command failed";
}

export class ArchifyCommandError extends Error {
  constructor(public receipt: ArchifyReceipt) {
    super(receiptMessage(receipt));
  }
}

function parseReceipt(stdout: string) {
  return receiptSchema.parse(JSON.parse(stdout));
}

function failureReceipt(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const stdout = Reflect.get(error, "stdout") as unknown;
  if (typeof stdout !== "string") return undefined;
  try {
    return parseReceipt(stdout);
  } catch {
    return undefined;
  }
}

async function runArchify(args: string[], runner: CommandRunner, timeout: number) {
  try {
    const { stdout } = await runner(process.execPath, args, { shell: false, timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" });
    const receipt = parseReceipt(stdout);
    if (!receipt.ok) throw new ArchifyCommandError(receipt);
    return receipt;
  } catch (error) {
    if (error instanceof ArchifyCommandError) throw error;
    const receipt = failureReceipt(error);
    if (receipt) throw new ArchifyCommandError(receipt);
    throw error;
  }
}

interface ArchifyCall {
  bin?: string;
  timeoutMs?: number;
}

export interface DeliverArchifyInput extends ArchifyCall {
  type: "architecture";
  input: string;
  output: string;
  repoRoot?: string;
  quality?: "standard" | "showcase";
}

async function archifyBin(bin?: string) {
  return bin || prepareArchify();
}

export async function deliverArchify(input: DeliverArchifyInput, runner: CommandRunner = execCommand) {
  const bin = await archifyBin(input.bin);
  const args = [bin, "deliver", input.type, input.input, input.output];
  if (input.repoRoot) args.push("--repo-root", input.repoRoot);
  const quality = input.quality === undefined ? "showcase" : input.quality;
  args.push("--quality", quality, "--json");
  return runArchify(args, runner, input.timeoutMs ?? 180_000);
}

export async function visualCheckArchify(input: ArchifyCall & { artifact: string }, runner: CommandRunner = execCommand) {
  const bin = await archifyBin(input.bin);
  return runArchify([bin, "visual-check", input.artifact, "--json"], runner, input.timeoutMs ?? 300_000);
}

export interface FinalizeExplainerInput extends ArchifyCall {
  input: string;
  output: string;
  repoRoot?: string;
  browserCheck?: boolean;
  outDir?: string;
}

export async function finalizeExplainer(input: FinalizeExplainerInput, runner: CommandRunner = execCommand) {
  const bin = await archifyBin(input.bin);
  const args = [bin, "finalize", "explainer", input.input, input.output];
  if (input.repoRoot) args.push("--repo-root", input.repoRoot);
  if (input.browserCheck) args.push("--browser-check");
  if (input.outDir) args.push("--out-dir", input.outDir);
  args.push("--json");
  return runArchify(args, runner, input.timeoutMs ?? 300_000);
}
