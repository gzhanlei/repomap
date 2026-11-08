import { z } from "zod";
import { architectureEvidenceSchema, type ArchitectureEvidence } from "./facts.js";

export const externalCandidateSchema = z.object({
  id: z.string().min(1),
  identity: z.string().min(1),
  dynamic: z.boolean(),
  protocol: z.enum(["http", "graphql"]),
  operation: z.object({
    name: z.string().min(1),
    kind: z.enum(["query", "mutation", "subscription", "http"]),
  }).optional(),
  status: z.enum(["resolved", "omitted"]),
  reason: z.string().min(1).optional(),
  evidence: architectureEvidenceSchema,
}).strict();

export const externalCandidateSetSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  candidates: z.array(externalCandidateSchema),
}).strict();

export type ExternalCandidate = z.infer<typeof externalCandidateSchema>;
export type ExternalCandidateSet = z.infer<typeof externalCandidateSetSchema>;
export type { ArchitectureEvidence };
