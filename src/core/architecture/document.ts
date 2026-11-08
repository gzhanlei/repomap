import { z } from "zod";

export const architectureDraftInputSchema = z.object({
  productName: z.string().min(1),
  productSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  owner: z.string().min(1),
  provider: z.literal("github").default("github"),
  name: z.string().min(1),
  revision: z.string().regex(/^[a-fA-F0-9]{40}$/),
  locale: z.enum(["en", "zh-CN"]).default("en"),
  sources: z.array(z.object({ path: z.string(), content: z.string() })),
});

export type ArchitectureDraftInput = z.input<typeof architectureDraftInputSchema>;

const sourceSchema = z.object({ path: z.string(), line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional(), label: z.string().optional() });
const componentSchema = z.object({
  id: z.string(),
  type: z.enum(["frontend", "backend", "database", "cloud", "security", "messagebus", "external"]),
  label: z.string(),
  sublabel: z.string().optional(),
  tag: z.string().optional(),
  sources: z.array(sourceSchema).max(3).optional(),
  pos: z.tuple([z.number(), z.number()]),
  size: z.tuple([z.number(), z.number()]),
});
const connectionSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  variant: z.enum(["default", "emphasis", "security", "dashed"]).optional(),
  fromSide: z.enum(["left", "right", "top", "bottom"]).optional(),
  toSide: z.enum(["left", "right", "top", "bottom"]).optional(),
  route: z.enum(["auto", "straight", "orthogonal-h", "orthogonal-v"]).optional(),
  via: z.array(z.tuple([z.number(), z.number()])).optional(),
  labelAt: z.tuple([z.number(), z.number()]).optional(),
  labelDy: z.number().optional(),
});

export const architectureDocumentSchema = z.object({
  schema_version: z.literal(1),
  diagram_type: z.literal("architecture"),
  meta: z.object({
    title: z.string(),
    output: z.string(),
    locale: z.enum(["en", "zh-CN"]),
    quality_profile: z.enum(["standard", "showcase"]),
    repository: z.object({ url: z.string().url(), provider: z.literal("github"), revision: z.string() }).optional(),
    viewBox: z.tuple([z.number(), z.number()]),
  }),
  components: z.array(componentSchema).min(2),
  connections: z.array(connectionSchema),
});

export type ArchitectureDocument = z.infer<typeof architectureDocumentSchema>;
