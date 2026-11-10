import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";

async function chunk(stream: WriteStream, value: string) {
  if (!stream.write(value)) await new Promise<void>((resolve, reject) => {
    const drain = () => { cleanup(); resolve(); };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const cleanup = () => { stream.off("drain", drain); stream.off("error", error); };
    stream.once("drain", drain);
    stream.once("error", error);
  });
}

function indentation(depth: number) {
  return "  ".repeat(depth);
}

async function value(stream: WriteStream, input: unknown, depth: number): Promise<void> {
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    await chunk(stream, JSON.stringify(input));
    return;
  }
  if (typeof input === "number") {
    await chunk(stream, Number.isFinite(input) ? JSON.stringify(input) : "null");
    return;
  }
  if (input === undefined) {
    await chunk(stream, "null");
    return;
  }
  if (Array.isArray(input)) {
    await chunk(stream, "[");
    for (let index = 0; index < input.length; index += 1) {
      if (index > 0) await chunk(stream, ",");
      if (input.length > 0) await chunk(stream, `\n${indentation(depth + 1)}`);
      await value(stream, input[index], depth + 1);
    }
    if (input.length > 0) await chunk(stream, `\n${indentation(depth)}`);
    await chunk(stream, "]");
    return;
  }
  if (typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>).filter(([, entry]) => entry !== undefined);
    await chunk(stream, "{");
    for (let index = 0; index < entries.length; index += 1) {
      const [key, entry] = entries[index];
      if (index > 0) await chunk(stream, ",");
      if (entries.length > 0) await chunk(stream, `\n${indentation(depth + 1)}${JSON.stringify(key)}: `);
      await value(stream, entry, depth + 1);
    }
    if (entries.length > 0) await chunk(stream, `\n${indentation(depth)}`);
    await chunk(stream, "}");
    return;
  }
  throw new Error(`Unsupported JSON value: ${typeof input}`);
}

/** Stream JSON with backpressure and atomically replace the destination. */
export async function writeJsonAtomic(path: string, input: unknown) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const stream = createWriteStream(temporary, { mode: 0o600 });
  try {
    await value(stream, input, 0);
    await chunk(stream, "\n");
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => { if (error) reject(error); else resolve(); });
    });
    await rename(temporary, path);
  } catch (error) {
    stream.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}
