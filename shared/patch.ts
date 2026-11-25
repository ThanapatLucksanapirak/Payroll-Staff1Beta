// Partial updates with zod 4. In zod 4, `.partial()` still fills in each
// field's `.default()`, so a patch like `{ name }` would also reset every
// defaulted field (for example an employee's `active` flag). parsePatch keeps
// only the keys the caller actually sent.
import type { z } from "zod";

export function parsePatch<S extends z.ZodObject<any>>(schema: S, raw: unknown): Partial<z.infer<S>> {
  const parsed = schema.partial().parse(raw ?? {}) as Record<string, unknown>;
  const sent = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => Object.prototype.hasOwnProperty.call(sent, k) && sent[k] !== undefined)) as Partial<z.infer<S>>;
}
