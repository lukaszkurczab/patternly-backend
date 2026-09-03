import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord, isRecord } from "../../infrastructure/firestore/values.js";
import { ADMIN_CONTENT_RELEASE_ID_PATTERN } from "../../config/environment.js";

const CONTENT_TRACK_LIMIT = 100;
const CATALOG_CACHE_TTL_MS = 30_000;
const MAX_RELEASE_BYTES = 64 * 1024 * 1024;
const SOURCE_REPOSITORY_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
type QuestionBankReason = "canonical_package_inspection_not_configured" | "configured_release_unavailable" | "configured_release_invalid";

export type AdminOverview = Readonly<{
  observedAt: string;
  content: Readonly<{
    publishedTracks: number;
    tracks: readonly Readonly<{ trackId: string; version: string; questionCount: number }>[];
    questionCount: number | null;
  }>;
  questionBank: Readonly<{ status: "available"; releaseId: string } | { status: "unavailable"; reason: QuestionBankReason }>;
  usage: Readonly<{
    accounts: number;
    progressRecords: number;
    trainingAttempts: number;
    reviewQueueEntries: number;
  }>;
  reports: Readonly<{ open: number; in_review: number; resolved: number; closed: number }>;
}>;

export interface AdminStore {
  readOverview(): Promise<AdminOverview>;
  listQuestions(input: Readonly<{ trackId?: string; query?: string; page: number; pageSize: number }>): Promise<AdminQuestions | AdminQuestionInspectionUnavailable>;
}

export type AdminQuestions = Readonly<{ questions: readonly Readonly<Record<string, unknown>>[]; total: number; page: number; pageSize: number; trackId: string | null }>;
export type AdminQuestionInspectionUnavailable = Readonly<{ unavailable: true; reason: QuestionBankReason }>;

function aggregateCount(snapshot: Readonly<{ data(): Readonly<{ count: number }> }>): number {
  return snapshot.data().count;
}

export class FirestoreAdminStore implements AdminStore {
  private cachedCatalog: Readonly<{ readAt: number; result: CatalogResult }> | undefined;
  private catalogLoadPromise: Promise<CatalogResult> | undefined;
  public constructor(private readonly db: Firestore, private readonly contentRoot: string | undefined, private readonly releaseId: string | undefined) {}

  public async readOverview(): Promise<AdminOverview> {
    const currentVersions = this.db.collection(COLLECTIONS.contentVersions).where("isCurrent", "==", true);
    const progress = this.db.collectionGroup("progress");
    const reports = this.db.collection(COLLECTIONS.contentReports);
    const [
      trackSnapshot,
      publishedTrackCount,
      accounts,
      progressRecords,
      trainingAttempts,
      reviewQueueEntries,
      openReports,
      inReviewReports,
      resolvedReports,
      closedReports,
    ] = await Promise.all([
      currentVersions.limit(CONTENT_TRACK_LIMIT).get(),
      currentVersions.count().get(),
      this.db.collection(COLLECTIONS.users).count().get(),
      progress.count().get(),
      progress.where("recordType", "==", "training_attempt").count().get(),
      progress.where("recordType", "==", "review_queue_entry").count().get(),
      reports.where("status", "==", "open").count().get(),
      reports.where("status", "==", "in_review").count().get(),
      reports.where("status", "==", "resolved").count().get(),
      reports.where("status", "==", "closed").count().get(),
    ]);
    trackSnapshot.docs.forEach((document) => { const row = asRecord(document.data(), "content_version"); if (typeof row.trackId !== "string" || typeof row.version !== "string") throw new Error("content_version_record_invalid"); asIsoString(row.publishedAt, "content_version_published_at"); });
    const catalogResult = await this.readPublishedCatalog();
    const catalog = catalogResult.catalog;
    return Object.freeze({
      observedAt: new Date().toISOString(),
      content: Object.freeze({
        publishedTracks: aggregateCount(publishedTrackCount),
        tracks: Object.freeze((catalog ?? []).map((artifact) => Object.freeze({ trackId: artifact.trackId, version: artifact.contentVersion, questionCount: artifact.items.length })).sort((left, right) => left.trackId.localeCompare(right.trackId))),
        questionCount: catalog === null ? null : catalog.reduce((sum, artifact) => sum + artifact.items.length, 0),
      }),
      questionBank: catalog === null ? Object.freeze({ status: "unavailable", reason: catalogResult.reason! }) : Object.freeze({ status: "available", releaseId: this.releaseId! }),
      usage: Object.freeze({
        accounts: aggregateCount(accounts),
        progressRecords: aggregateCount(progressRecords),
        trainingAttempts: aggregateCount(trainingAttempts),
        reviewQueueEntries: aggregateCount(reviewQueueEntries),
      }),
      reports: Object.freeze({
        open: aggregateCount(openReports),
        in_review: aggregateCount(inReviewReports),
        resolved: aggregateCount(resolvedReports),
        closed: aggregateCount(closedReports),
      }),
    });
  }

  public async listQuestions(input: Readonly<{ trackId?: string; query?: string; page: number; pageSize: number }>): Promise<AdminQuestions | AdminQuestionInspectionUnavailable> {
    const catalogResult = await this.readPublishedCatalog();
    const catalog = catalogResult.catalog;
    if (catalog === null) return Object.freeze({ unavailable: true, reason: catalogResult.reason! });
    const needle = input.query?.trim().toLocaleLowerCase();
    const matching = catalog.flatMap((artifact) => artifact.items.map((item) => ({ ...item, id: String(item.id), trackId: artifact.trackId, contentVersion: artifact.contentVersion })))
      .filter((item) => (input.trackId === undefined || item.trackId === input.trackId) && (needle === undefined || JSON.stringify(item).toLocaleLowerCase().includes(needle)))
      .sort((left, right) => `${left.trackId}:${left.id}`.localeCompare(`${right.trackId}:${right.id}`));
    const offset = (input.page - 1) * input.pageSize;
    return Object.freeze({ questions: Object.freeze(matching.slice(offset, offset + input.pageSize)), total: matching.length, page: input.page, pageSize: input.pageSize, trackId: input.trackId ?? null });
  }

  private async readPublishedCatalog(): Promise<CatalogResult> {
    if (this.cachedCatalog && Date.now() - this.cachedCatalog.readAt < CATALOG_CACHE_TTL_MS) return this.cachedCatalog.result;
    if (this.catalogLoadPromise) return this.catalogLoadPromise;
    const loadPromise = this.loadPublishedCatalog().then((result) => {
      this.cachedCatalog = Object.freeze({ readAt: Date.now(), result });
      return result;
    });
    this.catalogLoadPromise = loadPromise;
    try {
      return await loadPromise;
    } finally {
      if (this.catalogLoadPromise === loadPromise) this.catalogLoadPromise = undefined;
    }
  }

  private async loadPublishedCatalog(): Promise<CatalogResult> {
    if (!this.contentRoot || !this.releaseId) return unavailable("canonical_package_inspection_not_configured");
    if (!ADMIN_CONTENT_RELEASE_ID_PATTERN.test(this.releaseId)) return unavailable("configured_release_invalid");
    let releasesRoot: string;
    try {
      const root = await realpath(this.contentRoot);
      releasesRoot = await realpath(join(root, "releases"));
      if (!(await stat(releasesRoot)).isDirectory()) return unavailable("configured_release_invalid");
    } catch { return unavailable("configured_release_unavailable"); }
    let resolvedReleaseDirectory: string;
    try {
      resolvedReleaseDirectory = await realpath(join(releasesRoot, this.releaseId));
      if (!(await stat(resolvedReleaseDirectory)).isDirectory()) return unavailable("configured_release_invalid");
    } catch { return unavailable("configured_release_unavailable"); }
    if (!isWithin(releasesRoot, resolvedReleaseDirectory)) return unavailable("configured_release_invalid");
    let resolvedRelease: string;
    try { resolvedRelease = await realpath(join(resolvedReleaseDirectory, "release.json")); } catch { return unavailable("configured_release_unavailable"); }
    if (!isWithin(releasesRoot, resolvedRelease)) return unavailable("configured_release_invalid");
    try {
      const releaseStat = await stat(resolvedRelease);
      if (!releaseStat.isFile() || releaseStat.size > MAX_RELEASE_BYTES) return unavailable("configured_release_invalid");
      const release = parsePublishedRelease(JSON.parse(await readFile(resolvedRelease, "utf8")), this.releaseId);
      if (!release) return unavailable("configured_release_invalid");
      const verified: PublishedArtifact[] = [];
      for (let index = 0; index < release.artifacts.length; index += 1) {
        const artifact = parsePublishedArtifact(release.artifacts[index], release.sourceRepositoryCommit);
        release.artifacts[index] = undefined;
        if (!artifact) return unavailable("configured_release_invalid");
        verified.push(artifact);
      }
      if (new Set(verified.map((artifact) => artifact.trackId)).size !== verified.length) return unavailable("configured_release_invalid");
      return Object.freeze({ catalog: Object.freeze(verified) });
    } catch { return unavailable("configured_release_invalid"); }
  }
}

type PublishedArtifact = Readonly<{ trackId: string; contentVersion: string; items: readonly Readonly<Record<string, unknown>>[] }>;
type CatalogResult = Readonly<{ catalog: readonly PublishedArtifact[]; reason?: never } | { catalog: null; reason: QuestionBankReason }>;
function unavailable(reason: QuestionBankReason): CatalogResult { return Object.freeze({ catalog: null, reason }); }
function isWithin(root: string, candidate: string): boolean { const path = relative(root, candidate); return path !== "" && path !== ".." && !path.startsWith(`..${sep}`); }
function parsePublishedRelease(value: unknown, expectedReleaseId: string): Readonly<{ sourceRepositoryCommit: string; artifacts: unknown[] }> | null {
  if (!isRecord(value) || !isRecord(value.manifest) || !Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > CONTENT_TRACK_LIMIT) return null;
  const manifest = value.manifest;
  if (manifest.envelopeVersion !== 1 || manifest.releaseId !== expectedReleaseId || typeof manifest.sourceRepositoryCommit !== "string" || !SOURCE_REPOSITORY_COMMIT_PATTERN.test(manifest.sourceRepositoryCommit)) return null;
  return Object.freeze({ sourceRepositoryCommit: manifest.sourceRepositoryCommit, artifacts: value.artifacts });
}
function parsePublishedArtifact(raw: unknown, expectedSourceRepositoryCommit: string): PublishedArtifact | null {
  try {
    if (!isRecord(raw) || raw.sourceRepositoryCommit !== expectedSourceRepositoryCommit) return null;
    const { artifactBytes, checksumSha256, trackId, contentVersion } = raw;
    if (typeof artifactBytes !== "string" || typeof checksumSha256 !== "string" || typeof trackId !== "string" || typeof contentVersion !== "string" || !/^[a-f0-9]{64}$/u.test(checksumSha256) || createHash("sha256").update(artifactBytes, "utf8").digest("hex") !== checksumSha256) return null;
    const envelope = JSON.parse(artifactBytes) as unknown;
    if (!isRecord(envelope)) return null;
    const bank = envelope.bank;
    if (envelope.envelopeVersion !== 1 || envelope.schemaVersion !== "published-bank-v1" || envelope.contentVersion !== contentVersion || !isRecord(bank) || bank.trackId !== trackId || !Array.isArray(bank.items)) return null;
    if (!bank.items.every(isInspectableItem)) return null;
    const items = bank.items.map((item) => toInspectableItem(item as Record<string, unknown>));
    return Object.freeze({ trackId, contentVersion, items: Object.freeze(items) });
  } catch { return null; }
}
function isInspectableItem(item: unknown): item is Record<string, unknown> {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string") return false;
  if (typeof record.prompt === "string") {
    if (!record.interaction || typeof record.interaction !== "object" || Array.isArray(record.interaction)) return false;
    const interaction = record.interaction as Record<string, unknown>;
    return interaction.type !== "choice" && interaction.options === undefined || validOptions(interaction.options, interaction.acceptedOptionIds);
  }
  return typeof record.question === "string" && validOptions(record.options, record.correctOptionIds);
}
function toInspectableItem(item: Record<string, unknown>): Readonly<Record<string, unknown>> {
  if (typeof item.prompt === "string") return Object.freeze({ ...item });
  return Object.freeze({ ...item, prompt: item.question, interaction: { type: "choice", options: item.options, acceptedOptionIds: item.correctOptionIds } });
}

function validOptions(options: unknown, accepted: unknown): boolean {
  if (!Array.isArray(options) || options.length === 0 || !Array.isArray(accepted) || accepted.length === 0) return false;
  if (!options.every((option) => option && typeof option === "object" && typeof option.id === "string" && typeof option.text === "string")) return false;
  const ids = new Set(options.map((option) => option.id as string));
  return ids.size === options.length && accepted.every((id) => typeof id === "string" && ids.has(id));
}
