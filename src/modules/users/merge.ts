import { createHash } from "node:crypto";
import { z } from "zod";
import { legacySyncableRecordTypeSchema, syncableRecordTypeSchema, type ProgressRecord, type SyncableRecordType } from "../progress/contracts.js";
import { MAX_SERIALIZED_JSON_UTF16_CODE_UNITS } from "../progress/serializedJsonLimits.js";
import { canonicalJson as canonicalJsonV3 } from "../../infrastructure/identity/canonicalJson.js";

const uuid = z.string().uuid();
const id = z.string().min(1).max(256);
const trackId = z.string().min(1).max(128);
const revision = z.number().int().positive();
const stateSchema = z.record(z.unknown()).refine((value) => JSON.stringify(value).length <= MAX_SERIALIZED_JSON_UTF16_CODE_UNITS, "merge_state_too_large");
const days = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const goalSchema = z.object({
  goalType: z.enum(["prepare_for_an_interview", "prepare_for_a_certification", "build_foundations", "refresh_and_maintain_skills", "learn_at_own_pace"]),
  preferredDays: z.array(days).min(1).max(7), status: z.enum(["active", "paused"]),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(), trackId, weeklySessionTarget: z.number().int().min(1).max(7),
}).strict().superRefine((value, context) => {
  if (new Set(value.preferredDays).size !== value.preferredDays.length || value.weeklySessionTarget !== value.preferredDays.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "goal_days_invalid" });
  if (value.targetDate) { const [y, m, d] = value.targetDate.split("-").map(Number); const date = new Date(Date.UTC(y!, m! - 1, d)); if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m! - 1 || date.getUTCDate() !== d) context.addIssue({ code: z.ZodIssueCode.custom, message: "goal_target_date_invalid" }); }
});
const pinSchema = z.object({ packageIdentity: z.string().min(1), packageVersion: z.string().min(1), contentReleaseId: z.string().min(1) }).strict();
const planSchema = z.object({
  schemaVersion: z.literal(1), planId: z.string().min(1), trackId, goalRevision: revision,
  status: z.enum(["accepted", "paused", "completed"]), timezone: z.string().min(1), contentVersion: z.string().min(1), contentPackagePin: pinSchema,
  acceptedTarget: z.object({ meaning: z.enum(["event", "deadline", "checkpoint", "none"]), targetDate: z.string().nullable() }).strict(),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }), planRevision: revision, commandId: z.string().min(1),
  slots: z.array(z.object({ slotId: z.string().min(1), day: days, localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u), sessionLength: z.number().int().positive() }).strict()).min(1).max(7),
}).strict();
const goalStateSchema = z.object({ schemaVersion: z.literal(1), revision, record: goalSchema }).strict();
const planStateSchema = z.object({ schemaVersion: z.literal(1), revision, plan: planSchema }).strict();
const tombstoneSchema = z.object({ deleted: z.literal(true) }).strict();

const recordShape = { fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), recordId: id, state: stateSchema, trackId, version: z.number().int().nonnegative() } as const;
export const legacyGuestMergeRecordSchema = z.object({ ...recordShape, recordType: legacySyncableRecordTypeSchema }).strict();
export const guestMergeRecordSchema = z.object({ ...recordShape, recordType: syncableRecordTypeSchema }).strict();
const snapshotShape = { guestSnapshotVersion: z.number().int().nonnegative(), guestUserId: uuid, activeSession: z.boolean(), pendingJournal: z.boolean() } as const;
const snapshotV1 = z.object({ ...snapshotShape, protocolVersion: z.literal(1).optional().default(1), records: z.array(legacyGuestMergeRecordSchema).max(1_000) }).strict();
const snapshotV2 = z.object({ ...snapshotShape, protocolVersion: z.literal(2), records: z.array(guestMergeRecordSchema).max(1_000) }).strict();
export const guestMergeSnapshotSchema = z.union([snapshotV2, snapshotV1]);
export const guestMergeConflictSchema = z.object({ accountVersion: z.number().int().nonnegative(), conflictId: z.string().min(1).max(768), guestVersion: z.number().int().nonnegative(), recordId: id, recordType: syncableRecordTypeSchema }).strict();
export const goalPlanConflictGroupSchema = z.object({ groupId: z.string().regex(/^track:.+/u).max(192), trackId, localRecordIds: z.array(z.string()).max(2), accountRecordIds: z.array(z.string()).max(2) }).strict();
const previewShape = { accountSnapshotVersion: z.number().int().nonnegative(), accountUserId: uuid, conflicts: z.array(guestMergeConflictSchema).max(1_000), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), guestSnapshotVersion: z.number().int().nonnegative(), guestUserId: uuid, operationId: uuid } as const;
const previewV1 = z.object({ ...previewShape, protocolVersion: z.literal(1) }).strict();
const previewV2 = z.object({ ...previewShape, protocolVersion: z.literal(2), goalPlanConflictGroups: z.array(goalPlanConflictGroupSchema).max(1_000) }).strict();
export const guestMergePreviewSchema = z.union([previewV2, previewV1]).superRefine((value, context) => { if (value.guestUserId === value.accountUserId) context.addIssue({ code: z.ZodIssueCode.custom, message: "guest_and_account_must_differ" }); });
export const guestMergeResolutionSchema = z.object({ conflictId: z.string().min(1).max(768), resolution: z.enum(["keep_guest", "keep_account", "manual_required"]) }).strict();
export const goalPlanGroupChoiceSchema = z.object({ groupId: z.string().regex(/^track:.+/u).max(192), resolution: z.enum(["keep_guest", "keep_account"]) }).strict();
const confirmationShape = { operationId: uuid, previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), resolutions: z.array(guestMergeResolutionSchema).max(1_000) } as const;
const confirmationV1 = z.object({ ...confirmationShape, protocolVersion: z.literal(1) }).strict();
const confirmationV2 = z.object({ ...confirmationShape, protocolVersion: z.literal(2), groupChoices: z.array(goalPlanGroupChoiceSchema).max(1_000) }).strict();
export const guestMergeConfirmationSchema = z.union([confirmationV2, confirmationV1]);

export type GuestMergePreview = z.infer<typeof guestMergePreviewSchema>;
export type GuestMergeConfirmation = z.infer<typeof guestMergeConfirmationSchema>;
export type GuestMergeRecord = z.infer<typeof guestMergeRecordSchema>;
export type GuestMergeSnapshot = z.input<typeof guestMergeSnapshotSchema>;
export type ParsedGuestMergeSnapshot = z.output<typeof guestMergeSnapshotSchema>;
export type GoalPlanConflictGroup = z.infer<typeof goalPlanConflictGroupSchema>;
export type AdoptionPlan = Readonly<{ caseId: "emptyLocalEmptyRemote" | "populatedLocalEmptyRemote" | "emptyLocalPopulatedRemote" | "populatedLocalPopulatedRemote" | "divergentRecord" | "blocked"; localRecordCount: number; remoteRecordCount: number; uploadRecordIds: readonly string[]; restoreRecordIds: readonly string[]; deduplicatedRecordIds: readonly string[]; conflictRecordIds: readonly string[]; blockingReason: "active_session" | "journal_recovery" | null }>;
export type AdoptionPreview = Readonly<{ preview: GuestMergePreview; plan: AdoptionPlan; remoteRecords: readonly GuestMergeRecord[] }>;
export type AdoptionExecution = Readonly<{ accountRevision: number; operationId: string; mutationIds: readonly string[]; records: readonly GuestMergeRecord[] }>;
export type ReadyGuestMerge = Readonly<{ confirmation: GuestMergeConfirmation; preview: GuestMergePreview; status: "ready_to_execute" }>;

export type MergeIdentityMode = "legacy" | "full";

export function buildGuestMergePreview(input: Readonly<{ accountUserId: string; accountSnapshotVersion: number; guestSnapshot: GuestMergeSnapshot; remoteRecords: readonly GuestMergeRecord[]; identityMode?: MergeIdentityMode }>): AdoptionPreview {
  const guestSnapshot = guestMergeSnapshotSchema.parse(input.guestSnapshot);
  const protocolVersion = guestSnapshot.protocolVersion;
  const identityMode = input.identityMode ?? "legacy";
  const remoteRecords = input.remoteRecords.filter((record) => protocolVersion === 2 || isLegacy(record));
  for (const record of [...guestSnapshot.records, ...remoteRecords]) assertIntegrity(record);
  if (protocolVersion === 2) { assertGoalPlanBundles(guestSnapshot.records); assertGoalPlanBundles(remoteRecords); }
  const localByKey = new Map(guestSnapshot.records.map((record) => [mergeRecordKey(record, identityMode), record]));
  const remoteByKey = new Map(remoteRecords.map((record) => [mergeRecordKey(record, identityMode), record]));
  const groups = protocolVersion === 2 ? buildGroups(guestSnapshot.records, remoteRecords, identityMode) : [];
  const groupedKeys = new Set(groups.flatMap((group) => [...group.localRecordIds, ...group.accountRecordIds]));
  const upload: string[] = [], restore: string[] = [], dedup: string[] = [], conflictIds: string[] = [];
  const conflicts: Array<z.infer<typeof guestMergeConflictSchema>> = [];
  for (const record of guestSnapshot.records) {
    const key = mergeRecordKey(record, identityMode); if (groupedKeys.has(key)) continue;
    const remote = remoteByKey.get(key);
    if (!remote) upload.push(key);
    else if (remote.fingerprint === record.fingerprint) dedup.push(key);
    else { conflictIds.push(key); conflicts.push({ accountVersion: remote.version, conflictId: key, guestVersion: record.version, recordId: record.recordId, recordType: record.recordType }); }
  }
  for (const record of remoteRecords) { const key = mergeRecordKey(record, identityMode); if (!groupedKeys.has(key) && !localByKey.has(key)) restore.push(key); }
  const blockingReason = guestSnapshot.activeSession ? "active_session" : guestSnapshot.pendingJournal ? "journal_recovery" : null;
  const hasConflict = conflicts.length > 0 || groups.length > 0;
  const caseId = blockingReason ? "blocked" : guestSnapshot.records.length === 0 && remoteRecords.length === 0 ? "emptyLocalEmptyRemote" : guestSnapshot.records.length > 0 && remoteRecords.length === 0 ? "populatedLocalEmptyRemote" : guestSnapshot.records.length === 0 && remoteRecords.length > 0 ? "emptyLocalPopulatedRemote" : hasConflict ? "divergentRecord" : "populatedLocalPopulatedRemote";
  const plan = Object.freeze({ caseId, localRecordCount: guestSnapshot.records.length, remoteRecordCount: remoteRecords.length, uploadRecordIds: Object.freeze(upload), restoreRecordIds: Object.freeze(restore), deduplicatedRecordIds: Object.freeze(dedup), conflictRecordIds: Object.freeze(conflictIds), blockingReason });
  const base = { accountSnapshotVersion: input.accountSnapshotVersion, accountUserId: input.accountUserId, conflicts: conflicts.sort((a, b) => a.conflictId.localeCompare(b.conflictId)), guestSnapshotVersion: guestSnapshot.guestSnapshotVersion, guestUserId: guestSnapshot.guestUserId, protocolVersion };
  const fingerprint = sha256(canonicalJson({ preview: base, ...(protocolVersion === 2 ? { goalPlanConflictGroups: groups } : {}), plan, localRecords: guestSnapshot.records, remoteRecords }));
  const common = { ...base, fingerprint, operationId: operationId(fingerprint) };
  const preview: GuestMergePreview = protocolVersion === 2 ? { ...common, protocolVersion: 2, goalPlanConflictGroups: groups } : { ...common, protocolVersion: 1 };
  return Object.freeze({ preview: Object.freeze(preview), plan, remoteRecords: Object.freeze(remoteRecords) });
}

export function validateGuestMergeConfirmation(preview: GuestMergePreview, confirmation: GuestMergeConfirmation): ReadyGuestMerge {
  if (confirmation.protocolVersion !== preview.protocolVersion || confirmation.operationId !== preview.operationId || confirmation.previewFingerprint !== preview.fingerprint) throw new Error("merge_preview_mismatch");
  const expected = new Set(preview.conflicts.map((item) => item.conflictId)); const resolved = new Set<string>();
  if (confirmation.resolutions.length !== expected.size) throw new Error("merge_resolution_incomplete");
  for (const item of confirmation.resolutions) { if (!expected.has(item.conflictId) || resolved.has(item.conflictId)) throw new Error("merge_resolution_mismatch"); if (item.resolution === "manual_required") throw new Error("merge_conflict_requires_manual_resolution"); resolved.add(item.conflictId); }
  if (preview.protocolVersion === 2) {
    if (confirmation.protocolVersion !== 2 || confirmation.groupChoices.length !== preview.goalPlanConflictGroups.length) throw new Error("merge_group_choice_incomplete");
    const expectedGroups = new Set(preview.goalPlanConflictGroups.map((group) => group.groupId)); const chosen = new Set<string>();
    for (const item of confirmation.groupChoices) { if (!expectedGroups.has(item.groupId) || chosen.has(item.groupId)) throw new Error("merge_group_choice_mismatch"); chosen.add(item.groupId); }
  }
  return { confirmation, preview, status: "ready_to_execute" };
}

export function mergeRecordKey(record: Pick<GuestMergeRecord, "recordType" | "recordId" | "trackId">, identityMode: MergeIdentityMode = "legacy"): string {
  return identityMode === "full" ? canonicalJsonV3({ recordId: record.recordId, recordType: record.recordType, trackId: record.trackId }) : `${record.recordType}:${record.recordId}`;
}
export function progressRecordToMergeRecord(record: ProgressRecord): GuestMergeRecord { return Object.freeze({ fingerprint: record.fingerprint, recordId: record.targetId, recordType: record.recordType, state: record.state, trackId: record.trackId, version: record.version }); }
export function createMergeRecordFingerprint(record: Readonly<{ recordId: string; recordType: SyncableRecordType; state: Readonly<Record<string, unknown>>; trackId: string }>): string { return sha256(canonicalJson({ recordId: record.recordId, recordType: record.recordType, state: record.state, trackId: record.trackId })); }
export function assertGoalPlanBundles(records: readonly GuestMergeRecord[]): void {
  assertGoalPlanRecordShapes(records);
  const seen = new Set<string>();
  for (const record of records.filter(isGoalPlan)) {
    const key = mergeRecordKey(record); if (seen.has(key)) throw new Error("goal_plan_bundle_invalid"); seen.add(key);
  }
  for (const id of new Set(records.filter(isGoalPlan).map((record) => record.trackId))) {
    const goal = live(records.find((record) => record.recordType === "goal" && record.trackId === id)); const plan = live(records.find((record) => record.recordType === "learning_plan" && record.trackId === id));
    if (plan) { if (!goal) throw new Error("goal_plan_bundle_invalid"); const goalState = goalStateSchema.parse(goal.state); const planState = planStateSchema.parse(plan.state); if (planState.plan.goalRevision > goalState.revision) throw new Error("goal_plan_bundle_invalid"); }
  }
}

export function assertGoalPlanRecordShapes(records: readonly GuestMergeRecord[]): void {
  for (const record of records.filter(isGoalPlan)) {
    if (record.recordId !== record.trackId) throw new Error("goal_plan_bundle_invalid");
    if (record.state.deleted === true) { if (!tombstoneSchema.safeParse(record.state).success) throw new Error("goal_plan_bundle_invalid"); }
    else if (record.recordType === "goal") { const parsed = goalStateSchema.safeParse(record.state); if (!parsed.success || parsed.data.record.trackId !== record.trackId) throw new Error("goal_plan_bundle_invalid"); }
    else { const parsed = planStateSchema.safeParse(record.state); if (!parsed.success || parsed.data.plan.trackId !== record.trackId) throw new Error("goal_plan_bundle_invalid"); }
  }
}

function buildGroups(local: readonly GuestMergeRecord[], account: readonly GuestMergeRecord[], identityMode: MergeIdentityMode): GoalPlanConflictGroup[] {
  const tracks = new Set([...local.filter(isGoalPlan).map((record) => record.trackId), ...account.filter(isGoalPlan).map((record) => record.trackId)]); const groups: GoalPlanConflictGroup[] = [];
  for (const id of [...tracks].sort()) {
    const a = local.filter((record) => isGoalPlan(record) && record.trackId === id); const b = account.filter((record) => isGoalPlan(record) && record.trackId === id);
    if (!a.length || !b.length) continue;
    const byA = new Map(a.map((record) => [record.recordType, record])); const byB = new Map(b.map((record) => [record.recordType, record]));
    if ((["goal", "learning_plan"] as const).every((type) => byA.get(type)?.fingerprint === byB.get(type)?.fingerprint)) continue;
    groups.push({ groupId: `track:${id}`, trackId: id, localRecordIds: a.map((record) => mergeRecordKey(record, identityMode)).sort(), accountRecordIds: b.map((record) => mergeRecordKey(record, identityMode)).sort() });
  }
  return groups;
}
function isLegacy(record: GuestMergeRecord): boolean { return legacySyncableRecordTypeSchema.safeParse(record.recordType).success; }
function isGoalPlan(record: GuestMergeRecord): boolean { return record.recordType === "goal" || record.recordType === "learning_plan"; }
function live(record: GuestMergeRecord | undefined): GuestMergeRecord | undefined { return record?.state.deleted === true ? undefined : record; }
function assertIntegrity(record: GuestMergeRecord): void { if (createMergeRecordFingerprint(record) !== record.fingerprint) throw new Error("progress_fingerprint_mismatch"); }
function canonicalJson(value: unknown): string { if (value === null || ["string", "boolean", "number"].includes(typeof value)) return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (typeof value !== "object") throw new Error("merge_value_not_serializable"); return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`; }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function operationId(fingerprint: string): string { const hex = sha256(`adoption:${fingerprint}`).slice(0, 32); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`; }

// Protocol-v3 staging primitives live in their own module so the legacy
// preview/fingerprint contract above remains byte-for-byte compatible.
export {
  ADOPTION_TRANSFER_STATES,
  adoptionTransferChunkSchema,
  adoptionTransferDecisionSchema,
  adoptionTransferIdentitySchema,
  adoptionTransferRecordSchema,
  adoptionTransferStateSchema,
  adoptionTransferRecordKey,
  addAdoptionDecision,
  appendAdoptionResultChunk,
  appendAdoptionTransferChunk,
  appendAdoptionTransferRecord,
  beginAdoptionApply,
  beginAdoptionResultBuild,
  buildAdoptionResultChunks,
  compareAndSwapAdoptionGeneration,
  completeAdoptionTransfer,
  createAdoptionSnapshotSeal,
  createAdoptionTransferChunkFingerprint,
  createAdoptionTransfer,
  failAdoptionTransfer,
  markAdoptionPreviewReady,
  sealAdoptionTransfer,
} from "./adoptionTransfer.js";
export type {
  AdoptionTransfer,
  AdoptionTransferChunk,
  AdoptionTransferDecision,
  AdoptionTransferIdentity,
  AdoptionTransferRecord,
  AdoptionTransferResultChunk,
  AdoptionTransferStateName,
} from "./adoptionTransfer.js";
