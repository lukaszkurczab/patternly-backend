import { z } from "zod";

export const OPERATOR_ACTIONS = [
  "content_reports:read",
  "content_reports:transition",
  "privacy_requests:read",
  "privacy_requests:action",
  "legal_requests:read",
  "legal_requests:action",
  "security_incidents:create",
  "security_incidents:read",
  "security_incidents:action",
] as const;

export const operatorActionSchema = z.enum(OPERATOR_ACTIONS);
export type OperatorAction = z.infer<typeof operatorActionSchema>;

const operatorEntrySchema = z.object({
  subject: z.string().trim().min(1).max(512),
  role: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  actions: z.array(operatorActionSchema).min(1).max(OPERATOR_ACTIONS.length),
}).strict().superRefine((entry, context) => {
  if (new Set(entry.actions).size !== entry.actions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "operator_actions_duplicate" });
  }
});

const operatorAllowlistSchema = z.array(operatorEntrySchema).min(1).max(100).superRefine((entries, context) => {
  const subjects = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (subjects.has(entry.subject)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "subject"], message: "operator_subject_duplicate" });
    subjects.add(entry.subject);
  }
});

export type OperatorAllowlistEntry = Readonly<{
  subject: string;
  role: string;
  actions: readonly OperatorAction[];
}>;

export function parseOperatorAllowlist(value: string): readonly OperatorAllowlistEntry[] {
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { throw new Error("invalid_operator_allowlist"); }
  const parsed = operatorAllowlistSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("invalid_operator_allowlist");
  return Object.freeze(parsed.data.map((entry) => Object.freeze({ ...entry, actions: Object.freeze([...entry.actions]) })));
}
