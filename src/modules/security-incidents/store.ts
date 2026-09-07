import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Timestamp, type Firestore, type Transaction } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { asRecord, asTimestamp } from "../../infrastructure/firestore/values.js";
import { incidentArtifactExpiry, incidentDeadline, incidentRetentionExpiry, type AuthorityDeliveryStatus, type IncidentClassification, type IncidentDecision, type SecurityIncidentAction, type SubjectNotificationStatus } from "./contracts.js";

type EncryptedValue = Readonly<{ ciphertext: string; iv: string; tag: string }>;
const LIST_LIMIT = 100;
const REMINDER_HOURS = [24, 48, 60, 70] as const;
const DELIVERY_PENDING_TIMEOUT_MS = 15 * 60 * 1_000;

export type SecurityIncidentListItem = Readonly<{
  incidentId: string; classification: IncidentClassification; authorityDecision: IncidentDecision;
  authorityDeliveryStatus: AuthorityDeliveryStatus; subjectDecision: IncidentDecision; subjectNotificationStatus: SubjectNotificationStatus;
  awarenessAt: string | null; authorityDeadlineAt: string | null; closedAt: string | null; revision: number; legalHold: boolean;
  nextAction: "acknowledge_awareness" | "classify" | "decide_authority" | "prepare_authority_export" | "record_authority_submission" | "decide_subject" | "prepare_subject_notification" | "resolve_subject_notification_unknown" | "send_subject_notification" | "close" | "none";
}>;

export type SecurityIncidentDetails = SecurityIncidentListItem & Readonly<{
  title: string; details: string; assessment: Readonly<Record<string, unknown>>; createdAt: string; updatedAt: string; authorityExportVersion: number | null; assessmentVersion: number; authorityReason: string | null; subjectReason: string | null;
  authoritySubmissionReference: string | null; subjectNotifications: readonly Readonly<{ recipientPseudonym: string; snapshotVersion: number; status: "pending" | "sent" | "failed" | "unknown" | "superseded"; deliveryId: string }> [];
  preparedRecipients: readonly Readonly<{ recipientPseudonym: string; snapshotVersion: number }> [];
  auditHistory: readonly Readonly<{ event: string; actorPseudonym: string; at: string; revision: number | null; assessmentVersion: number | null; snapshot: Record<string, unknown> | null }> [];
}>;

export interface SecurityIncidentEmailSender {
  send(input: Readonly<{ recipient: string; incidentId: string; snapshotVersion: number; subject: string; text: string }>): Promise<void>;
}

export interface SecurityIncidentStore {
  create(actorId: string, input: Readonly<Record<string, unknown>>): Promise<SecurityIncidentDetails>;
  listAdmin(): Promise<readonly SecurityIncidentListItem[]>;
  readAdmin(incidentId: string, actorId: string): Promise<SecurityIncidentDetails | null>;
  readAuthorityExport(incidentId: string, version: number, actorId: string): Promise<Readonly<{ payload: string; digest: string; version: number }> | null>;
  act(incidentId: string, actorId: string, action: SecurityIncidentAction, sender: SecurityIncidentEmailSender | null): Promise<SecurityIncidentDetails>;
}

export class FirestoreSecurityIncidentStore implements SecurityIncidentStore {
  private readonly key: Buffer;
  public constructor(private readonly db: Firestore, encryptionKeyBase64: string, private readonly auditHmacSecret: string) {
    this.key = Buffer.from(encryptionKeyBase64, "base64");
    if (this.key.length !== 32) throw new Error("security_incident_key_invalid");
    if (Buffer.byteLength(auditHmacSecret, "utf8") < 32) throw new Error("security_incident_audit_secret_invalid");
  }

  public async create(actorId: string, input: Readonly<Record<string, unknown>>): Promise<SecurityIncidentDetails> {
    const incidentId = `si_${randomUUID()}`;
    const now = new Date();
    const record = { classification: "triage", authorityDecision: "undecided", authorityDeliveryStatus: "not_started", subjectDecision: "undecided", subjectNotificationStatus: "not_started", awarenessAt: null, authorityDeadlineAt: null, closedAt: null, revision: 0, assessmentVersion: 1, legalHold: false, createdAt: Timestamp.fromDate(now), updatedAt: Timestamp.fromDate(now) };
    await this.db.runTransaction(async (tx) => {
      tx.create(this.incidentRef(incidentId), record);
      tx.create(this.secretRef(incidentId), { payload: this.encrypt(JSON.stringify({ ...input, assessments: [{ version: 1, ...input, createdAt: now.toISOString() }] })), createdAt: Timestamp.fromDate(now), expiresAt: null });
      this.audit(tx, incidentId, actorId, "incident_created", now);
    });
    return (await this.readAdmin(incidentId, actorId))!;
  }

  public async listAdmin(): Promise<readonly SecurityIncidentListItem[]> {
    const snapshot = await this.db.collection(COLLECTIONS.securityIncidents).orderBy("createdAt", "desc").limit(LIST_LIMIT).get();
    await Promise.all(snapshot.docs.map((doc) => this.materializeReminders(doc.id)));
    return Object.freeze(snapshot.docs.map((doc) => this.toList(doc.id, asRecord(doc.data(), "security_incident"))));
  }

  public async readAdmin(incidentId: string, actorId: string): Promise<SecurityIncidentDetails | null> {
    await this.materializeReminders(incidentId);
    const [incident, secret] = await Promise.all([this.incidentRef(incidentId).get(), this.secretRef(incidentId).get()]);
    if (!incident.exists || !secret.exists) return null;
    const data = asRecord(incident.data(), "security_incident");
    const decrypted = JSON.parse(this.decrypt(asRecord(asRecord(secret.data(), "security_incident_secret").payload, "security_incident_payload"))) as { title?: unknown; details?: unknown; assessments?: unknown };
    const [notifications, preparedSnapshot, auditDocs] = await Promise.all([
      this.db.collection(COLLECTIONS.securityIncidentDeliveries).where("incidentId", "==", incidentId).limit(500).get(),
      typeof data.subjectNotificationVersion === "number" ? this.artifactRef(`subject_snapshot_${incidentId}_${Number(data.subjectNotificationVersion)}`).get() : Promise.resolve(null),
      this.incidentRef(incidentId).collection("audit").orderBy("at", "asc").limit(500).get(),
    ]);
    const prepared = preparedSnapshot?.exists ? JSON.parse(this.decrypt(asRecord(asRecord(preparedSnapshot.data(), "security_incident_snapshot").payload, "security_incident_snapshot_payload"))) as { recipients?: unknown } : null;
    const recipients = Array.isArray(prepared?.recipients) ? prepared.recipients.filter((value): value is string => typeof value === "string") : [];
    const now = new Date();
    await this.db.runTransaction(async (tx) => this.audit(tx, incidentId, actorId, "details_read", now, undefined, undefined, undefined, data.closedAt ? (data.legalHold ? null : Timestamp.fromDate(incidentRetentionExpiry(asTimestamp(data.closedAt, "closed_at").toDate()))) : undefined));
    const assessment = this.currentAssessment(decrypted);
    return Object.freeze({ ...this.toList(incidentId, data), title: typeof decrypted.title === "string" ? decrypted.title : "", details: typeof assessment.details === "string" ? assessment.details : "", assessment: Object.freeze(assessment), createdAt: asTimestamp(data.createdAt, "created_at").toDate().toISOString(), updatedAt: asTimestamp(data.updatedAt, "updated_at").toDate().toISOString(), authorityExportVersion: typeof data.authorityExportVersion === "number" ? data.authorityExportVersion : null, assessmentVersion: Number(data.assessmentVersion), authorityReason: this.decryptOptional(data.authorityReason), subjectReason: this.decryptOptional(data.subjectReason), authoritySubmissionReference: this.decryptOptional(data.authoritySubmissionReference), preparedRecipients: Object.freeze(recipients.map((email) => Object.freeze({ recipientPseudonym: this.recipientPseudonym(incidentId, email), snapshotVersion: Number(data.subjectNotificationVersion) }))), auditHistory: Object.freeze(auditDocs.docs.map((doc) => { const item = asRecord(doc.data(), "audit"); return Object.freeze({ event: String(item.event), actorPseudonym: String(item.actorPseudonym), at: asTimestamp(item.at, "audit_at").toDate().toISOString(), revision: typeof item.revision === "number" ? item.revision : null, assessmentVersion: typeof item.assessmentVersion === "number" ? item.assessmentVersion : null, snapshot: item.snapshot && typeof item.snapshot === "object" ? asRecord(item.snapshot, "audit_snapshot") : null }); })), subjectNotifications: Object.freeze(notifications.docs.map((doc) => {
      const value = asRecord(doc.data(), "security_incident_delivery");
      return Object.freeze({ recipientPseudonym: String(value.recipientPseudonym), snapshotVersion: Number(value.snapshotVersion), status: value.status as "pending" | "sent" | "failed" | "unknown" | "superseded", deliveryId: doc.id });
    })) });
  }

  public async readAuthorityExport(incidentId: string, version: number, actorId: string): Promise<Readonly<{ payload: string; digest: string; version: number }> | null> {
    const [snapshot, incident] = await Promise.all([this.artifactRef(`authority_${incidentId}_${version}`).get(), this.incidentRef(incidentId).get()]);
    if (!snapshot.exists || !incident.exists) return null;
    const data = asRecord(snapshot.data(), "security_incident_export");
    if (data.incidentId !== incidentId || data.kind !== "authority_export") return null;
    const payload = this.decrypt(asRecord(data.payload, "security_incident_export_payload"));
    const incidentData = asRecord(incident.data(), "incident");
    await this.db.runTransaction(async (tx) => this.audit(tx, incidentId, actorId, "authority_export_read", new Date(), undefined, undefined, undefined, incidentData.closedAt ? (incidentData.legalHold ? null : Timestamp.fromDate(incidentRetentionExpiry(asTimestamp(incidentData.closedAt, "closed_at").toDate()))) : undefined));
    return Object.freeze({ payload, digest: String(data.digest), version });
  }

  public async act(incidentId: string, actorId: string, action: SecurityIncidentAction, sender: SecurityIncidentEmailSender | null): Promise<SecurityIncidentDetails> {
    if (action.action === "send_subject_notification") await this.sendSubjectNotification(incidentId, actorId, action, sender);
    else await this.db.runTransaction(async (tx) => this.applyAction(tx, incidentId, actorId, action));
    const result = await this.readAdmin(incidentId, actorId);
    if (!result) throw new Error("security_incident_not_found");
    return result;
  }

  private async applyAction(tx: Transaction, incidentId: string, actorId: string, action: Exclude<SecurityIncidentAction, { action: "send_subject_notification" }>): Promise<void> {
    const ref = this.incidentRef(incidentId);
    const [snapshot, secretSnapshot] = await tx.getAll(ref, this.secretRef(incidentId));
    if (!snapshot?.exists || !secretSnapshot?.exists) throw new Error("security_incident_not_found");
    const data = asRecord(snapshot.data(), "security_incident");
    if (Number(data.revision) !== action.expectedRevision) throw new Error("security_incident_revision_conflict");
    if (data.closedAt && action.action !== "set_legal_hold" && action.action !== "release_legal_hold") throw new Error("security_incident_closed");
    const now = new Date();
    const update: Record<string, unknown> = { revision: action.expectedRevision + 1, updatedAt: Timestamp.fromDate(now) };
    const secretData = asRecord(secretSnapshot.data(), "security_incident_secret");
    const decrypted = JSON.parse(this.decrypt(asRecord(secretData.payload, "security_incident_payload"))) as Record<string, unknown>;
    const classification = data.classification as IncidentClassification;
    const authorityDecision = data.authorityDecision as IncidentDecision;
    const subjectDecision = data.subjectDecision as IncidentDecision;
    const event = action.action;
    if (action.action === "acknowledge_awareness") {
      if (data.awarenessAt) throw new Error("security_incident_awareness_immutable");
      update.awarenessAt = Timestamp.fromDate(now); update.authorityDeadlineAt = Timestamp.fromDate(incidentDeadline(now));
    } else if (action.action === "classify") {
      update.classification = action.classification; update.classificationReason = this.encrypt(action.reason);
    } else if (action.action === "correct_assessment") {
      const nextVersion = Number(data.assessmentVersion) + 1;
      update.assessmentVersion = nextVersion; update.assessmentCorrectionReason = this.encrypt(action.reason);
      const assessments = Array.isArray(decrypted.assessments) ? decrypted.assessments : [];
      Object.assign(decrypted, action); decrypted.assessments = [...assessments, { version: nextVersion, ...action, createdAt: now.toISOString() }];
      tx.set(this.secretRef(incidentId), { payload: this.encrypt(JSON.stringify(decrypted)) }, { merge: true });
    } else if (action.action === "decide_authority") {
      update.authorityDecision = action.decision; update.authorityReason = this.encrypt(action.reason); update.authorityLegalException = action.legalException ? this.encrypt(action.legalException) : null;
    } else if (action.action === "prepare_authority_export") {
      if (authorityDecision !== "required") throw new Error("security_incident_authority_decision_required");
      const version = Number(data.authorityExportVersion ?? 0) + 1;
      const artifactId = `authority_${incidentId}_${version}`;
      const exportPayload = { schemaVersion: 1, incidentId, revision: action.expectedRevision, evaluationVersion: Number(data.assessmentVersion), generatedAt: now.toISOString(), assessment: decrypted, operatorSummary: action.payload };
      tx.set(this.artifactRef(artifactId), { incidentId, kind: "authority_export", version, payload: this.encrypt(JSON.stringify(exportPayload)), digest: this.digest(JSON.stringify(exportPayload)), createdAt: Timestamp.fromDate(now), ...(data.legalHold ? { expiresAt: null } : { expiresAt: Timestamp.fromDate(incidentArtifactExpiry(now)) }) });
      update.authorityExportVersion = version;
    } else if (action.action === "record_authority_submission") {
      if (authorityDecision !== "required" || !data.authorityExportVersion) throw new Error("security_incident_authority_export_required");
      if (data.authorityDeadlineAt && now > asTimestamp(data.authorityDeadlineAt, "authority_deadline").toDate() && !action.delayReason) throw new Error("security_incident_delay_reason_required");
      update.authorityDeliveryStatus = action.supplementary ? "supplemented" : "submitted"; update.authoritySubmittedAt = Timestamp.fromDate(now); update.authoritySubmissionReference = this.encrypt(action.reference); update.authorityDelayReason = action.delayReason ? this.encrypt(action.delayReason) : null;
      const artifactId = `authority_evidence_${incidentId}_${randomUUID()}`;
      tx.create(this.artifactRef(artifactId), { incidentId, kind: "authority_submission_evidence", channel: action.channel, payload: this.encrypt(action.evidence), createdAt: Timestamp.fromDate(now), ...(data.legalHold ? { expiresAt: null } : { expiresAt: Timestamp.fromDate(incidentArtifactExpiry(now)) }) });
    } else if (action.action === "decide_subject") {
      update.subjectDecision = action.decision; update.subjectReason = this.encrypt(action.reason); update.subjectLegalException = action.legalException ? this.encrypt(action.legalException) : null;
    } else if (action.action === "prepare_subject_notification") {
      if (subjectDecision !== "required") throw new Error("security_incident_subject_decision_required");
      const version = Number(data.subjectNotificationVersion ?? 0) + 1;
      tx.create(this.artifactRef(`subject_snapshot_${incidentId}_${version}`), { incidentId, kind: "subject_notification_snapshot", version, payload: this.encrypt(JSON.stringify({ recipients: action.recipients, subject: action.subject, text: action.text })), digest: this.digest(`${action.subject}\n${action.text}`), createdAt: Timestamp.fromDate(now), ...(data.legalHold ? { expiresAt: null } : { expiresAt: Timestamp.fromDate(incidentArtifactExpiry(now)) }) });
      update.subjectNotificationVersion = version; update.subjectNotificationStatus = "prepared";
    } else if (action.action === "reconcile_subject_notifications") {
      const deliveries = await tx.get(this.db.collection(COLLECTIONS.securityIncidentDeliveries).where("incidentId", "==", incidentId).where("snapshotVersion", "==", Number(data.subjectNotificationVersion ?? 0)));
      const cutoff = now.getTime() - DELIVERY_PENDING_TIMEOUT_MS;
      for (const delivery of deliveries.docs) { const item = asRecord(delivery.data(), "delivery"); if (item.status === "pending" && asTimestamp(item.createdAt, "delivery_created").toMillis() <= cutoff) tx.set(delivery.ref, { status: "unknown", reconciledAt: Timestamp.fromDate(now) }, { merge: true }); }
      update.subjectNotificationStatus = "unknown";
    } else if (action.action === "resolve_subject_notification_unknown") {
      const delivery = await tx.get(this.deliveryRef(action.deliveryId));
      if (!delivery.exists || asRecord(delivery.data(), "security_incident_delivery").incidentId !== incidentId || asRecord(delivery.data(), "security_incident_delivery").status !== "unknown") throw new Error("security_incident_delivery_resolution_invalid");
      tx.set(this.deliveryRef(action.deliveryId), { status: action.outcome, resolutionReason: this.encrypt(action.reason), resolvedAt: Timestamp.fromDate(now) }, { merge: true });
      update.subjectNotificationStatus = action.outcome;
    } else if (action.action === "set_legal_hold") {
      if (data.legalHold) throw new Error("security_incident_hold_invalid");
      update.legalHold = true; update.legalHoldReason = this.encrypt(action.reason); update.expiresAt = null;
      await this.setArtifactsHold(tx, incidentId, true, now, data.closedAt ? asTimestamp(data.closedAt, "closed_at").toDate() : null);
    } else if (action.action === "release_legal_hold") {
      if (!data.legalHold) throw new Error("security_incident_hold_invalid");
      update.legalHold = false; update.legalHoldReleaseReason = this.encrypt(action.reason); update.expiresAt = data.closedAt ? Timestamp.fromDate(incidentRetentionExpiry(asTimestamp(data.closedAt, "closed_at").toDate())) : null;
      await this.setArtifactsHold(tx, incidentId, false, now, data.closedAt ? asTimestamp(data.closedAt, "closed_at").toDate() : null);
    } else if (action.action === "close") {
      if (!data.awarenessAt || classification === "triage" || authorityDecision === "undecided" || subjectDecision === "undecided" || typeof decrypted.containedAt !== "string" || typeof decrypted.containment !== "string" || typeof decrypted.remediation !== "string" || typeof decrypted.postmortem !== "string") throw new Error("security_incident_close_incomplete");
      const authorityComplete = authorityDecision === "not_required" ? Boolean(data.authorityLegalException && typeof data.authorityLegalException === "object") : ["submitted", "supplemented"].includes(data.authorityDeliveryStatus as string);
      let subjectComplete = subjectDecision === "not_required" && Boolean(data.subjectLegalException && typeof data.subjectLegalException === "object");
      if (subjectDecision === "required") {
        const version = Number(data.subjectNotificationVersion ?? 0);
        const [snapshot, deliveries] = await Promise.all([tx.get(this.artifactRef(`subject_snapshot_${incidentId}_${version}`)), tx.get(this.db.collection(COLLECTIONS.securityIncidentDeliveries).where("incidentId", "==", incidentId).where("snapshotVersion", "==", version))]);
        const notification = snapshot.exists ? JSON.parse(this.decrypt(asRecord(asRecord(snapshot.data(), "snapshot").payload, "snapshot_payload"))) as { recipients?: unknown } : null;
        const count = Array.isArray(notification?.recipients) ? notification.recipients.length : 0;
        subjectComplete = count > 0 && deliveries.docs.length === count && deliveries.docs.every((doc) => asRecord(doc.data(), "delivery").status === "sent");
      }
      if (!authorityComplete || !subjectComplete) throw new Error("security_incident_close_incomplete");
      update.closedAt = Timestamp.fromDate(now); if (!data.legalHold) update.expiresAt = Timestamp.fromDate(incidentRetentionExpiry(now));
      await this.setRetentionOnClose(tx, incidentId, now, data.legalHold === true);
    }
    tx.set(ref, update, { merge: true });
    const auditExpiry = action.action === "close" ? (data.legalHold ? null : Timestamp.fromDate(incidentRetentionExpiry(now))) : data.closedAt ? ((action.action === "set_legal_hold") ? null : Timestamp.fromDate(incidentRetentionExpiry(asTimestamp(data.closedAt, "closed_at").toDate()))) : undefined;
    this.audit(tx, incidentId, actorId, event, now, action.expectedRevision + 1, Number(data.assessmentVersion), { classification: update.classification ?? data.classification, authorityDecision: update.authorityDecision ?? data.authorityDecision, subjectDecision: update.subjectDecision ?? data.subjectDecision }, auditExpiry);
  }

  private async sendSubjectNotification(incidentId: string, actorId: string, action: Extract<SecurityIncidentAction, { action: "send_subject_notification" }>, sender: SecurityIncidentEmailSender | null): Promise<void> {
    if (!sender) throw new Error("security_incident_email_unavailable");
    const deliveryId = randomUUID();
    let email = ""; let subject = ""; let text = "";
    await this.db.runTransaction(async (tx) => {
      const [incident, artifact] = await tx.getAll(this.incidentRef(incidentId), this.artifactRef(`subject_snapshot_${incidentId}_${action.snapshotVersion}`));
      if (!incident?.exists || !artifact?.exists) throw new Error("security_incident_notification_snapshot_not_found");
      const data = asRecord(incident.data(), "security_incident");
      if (Number(data.revision) !== action.expectedRevision) throw new Error("security_incident_revision_conflict");
      if (data.subjectDecision !== "required") throw new Error("security_incident_subject_decision_required");
      if (data.closedAt || Number(data.subjectNotificationVersion) !== action.snapshotVersion) throw new Error("security_incident_notification_snapshot_stale");
      const snapshot = JSON.parse(this.decrypt(asRecord(asRecord(artifact.data(), "security_incident_artifact").payload, "security_incident_artifact_payload"))) as { recipients?: unknown; subject?: unknown; text?: unknown };
      const recipients = Array.isArray(snapshot.recipients) ? snapshot.recipients.filter((value): value is string => typeof value === "string") : [];
      email = recipients.find((value) => this.recipientPseudonym(incidentId, value) === action.recipientPseudonym) ?? "";
      subject = typeof snapshot.subject === "string" ? snapshot.subject : ""; text = typeof snapshot.text === "string" ? snapshot.text : "";
      if (!email || !subject || !text) throw new Error("security_incident_recipient_not_found");
      const existing = await tx.get(this.deliveryByKeyRef(this.deliveryKey(incidentId, action.recipientPseudonym, action.snapshotVersion)));
      if (existing.exists) {
        const status = asRecord(existing.data(), "security_incident_delivery").status;
        if (status === "unknown") throw new Error("security_incident_delivery_unknown_resolution_required");
        throw new Error("security_incident_delivery_already_attempted");
      }
      const now = new Date();
      tx.create(this.deliveryRef(deliveryId), { incidentId, recipientPseudonym: action.recipientPseudonym, snapshotVersion: action.snapshotVersion, startRevision: Number(data.revision), startSubjectDecision: data.subjectDecision, notificationGeneration: action.snapshotVersion, idempotencyKey: this.deliveryKey(incidentId, action.recipientPseudonym, action.snapshotVersion), status: "pending", createdAt: Timestamp.fromDate(now), ...(data.legalHold ? { expiresAt: null } : { expiresAt: Timestamp.fromDate(incidentArtifactExpiry(now)) }) });
      tx.create(this.deliveryByKeyRef(this.deliveryKey(incidentId, action.recipientPseudonym, action.snapshotVersion)), { deliveryId, incidentId, createdAt: Timestamp.fromDate(now), ...(data.legalHold ? { expiresAt: null } : { expiresAt: Timestamp.fromDate(incidentArtifactExpiry(now)) }) });
      tx.set(this.incidentRef(incidentId), { subjectNotificationStatus: "pending", revision: action.expectedRevision + 1, updatedAt: Timestamp.fromDate(now) }, { merge: true }); this.audit(tx, incidentId, actorId, "subject_notification_pending", now);
    });
    try {
      await sender.send({ recipient: email, incidentId, snapshotVersion: action.snapshotVersion, subject, text });
      await this.finishDelivery(incidentId, deliveryId, actorId, "sent");
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const terminal = code === "security_incident_email_rejected" || code === "security_incident_email_placeholder";
      await this.finishDelivery(incidentId, deliveryId, actorId, terminal ? "failed" : "unknown");
      throw terminal ? new Error("security_incident_email_rejected") : new Error("security_incident_email_unavailable");
    }
  }

  private async finishDelivery(incidentId: string, deliveryId: string, actorId: string, status: "sent" | "failed" | "unknown"): Promise<void> {
    await this.db.runTransaction(async (tx) => { const [delivery, incident] = await tx.getAll(this.deliveryRef(deliveryId), this.incidentRef(incidentId)); if (!delivery?.exists || !incident?.exists) return; const deliveryData = asRecord(delivery.data(), "security_incident_delivery"); const incidentData = asRecord(incident.data(), "security_incident"); const deliveries = await tx.get(this.db.collection(COLLECTIONS.securityIncidentDeliveries).where("incidentId", "==", incidentId).where("snapshotVersion", "==", Number(deliveryData.snapshotVersion))); const current = incidentData.subjectDecision === "required" && !incidentData.closedAt && Number(incidentData.subjectNotificationVersion) === Number(deliveryData.snapshotVersion) && Number(deliveryData.notificationGeneration) === Number(deliveryData.snapshotVersion); const now = new Date(); if (deliveryData.status !== "pending") return; if (!current) { tx.set(delivery.ref, { status: "superseded", completedAt: Timestamp.fromDate(now) }, { merge: true }); this.audit(tx, incidentId, actorId, "subject_notification_superseded", now); return; } const states = deliveries.docs.map((doc) => doc.id === deliveryId ? status : asRecord(doc.data(), "delivery").status); const aggregate = states.includes("unknown") ? "unknown" : states.includes("failed") ? "failed" : states.every((value) => value === "sent") ? "sent" : "pending"; tx.set(delivery.ref, { status, completedAt: Timestamp.fromDate(now) }, { merge: true }); tx.set(incident.ref, { subjectNotificationStatus: aggregate, revision: Number(incidentData.revision) + 1, updatedAt: Timestamp.fromDate(now) }, { merge: true }); this.audit(tx, incidentId, actorId, `subject_notification_${status}`, now, Number(incidentData.revision) + 1, Number(incidentData.assessmentVersion)); });
  }

  private async materializeReminders(incidentId: string): Promise<void> {
    await this.db.runTransaction(async (tx) => { const incident = await tx.get(this.incidentRef(incidentId)); if (!incident.exists) return; const data = asRecord(incident.data(), "security_incident"); if (!data.awarenessAt || data.closedAt) return; const awareness = asTimestamp(data.awarenessAt, "awareness_at").toDate(); const now = new Date(); for (const hours of REMINDER_HOURS) { const dueAt = new Date(awareness.getTime() + hours * 60 * 60 * 1_000); if (now >= dueAt) { const ref = this.reminderRef(incidentId, hours); const existing = await tx.get(ref); if (!existing.exists) tx.create(ref, { incidentId, thresholdHours: hours, dueAt: Timestamp.fromDate(dueAt), createdAt: Timestamp.fromDate(now), expiresAt: data.legalHold ? null : Timestamp.fromDate(incidentArtifactExpiry(now)) }); } } });
  }

  private async setArtifactsHold(tx: Transaction, incidentId: string, hold: boolean, now: Date, closedAt: Date | null): Promise<void> {
    const groups = [COLLECTIONS.securityIncidentArtifacts, COLLECTIONS.securityIncidentDeliveries, COLLECTIONS.securityIncidentReminders, COLLECTIONS.securityIncidentDeliveryKeys];
    const [snapshots, ...queries] = await Promise.all([tx.getAll(this.secretRef(incidentId)), ...groups.map((collection) => tx.get(this.db.collection(collection).where("incidentId", "==", incidentId))), tx.get(this.incidentRef(incidentId).collection("audit"))]);
    const audits = queries.pop()!;
    for (const snapshot of snapshots) if (snapshot.exists) { const raw = asRecord(snapshot.data(), "secret"); tx.set(snapshot.ref, { expiresAt: hold ? null : (raw.closedAt ? Timestamp.fromDate(incidentRetentionExpiry(asTimestamp(raw.closedAt, "closed_at").toDate())) : null) }, { merge: true }); }
    for (const query of queries) for (const document of query.docs) { const raw = asRecord(document.data(), "incident_artifact"); const created = raw.createdAt ? asTimestamp(raw.createdAt, "created_at").toDate() : now; tx.set(document.ref, { expiresAt: hold ? null : Timestamp.fromDate(incidentArtifactExpiry(created)) }, { merge: true }); }
    for (const document of audits.docs) tx.set(document.ref, { ...(closedAt ? { closedAt: Timestamp.fromDate(closedAt) } : {}), expiresAt: hold ? null : (closedAt ? Timestamp.fromDate(incidentRetentionExpiry(closedAt)) : null) }, { merge: true });
  }

  private async setRetentionOnClose(tx: Transaction, incidentId: string, closedAt: Date, hold: boolean): Promise<void> {
    const expiry = hold ? null : Timestamp.fromDate(incidentRetentionExpiry(closedAt));
    const audits = await tx.get(this.incidentRef(incidentId).collection("audit"));
    tx.set(this.secretRef(incidentId), { closedAt: Timestamp.fromDate(closedAt), expiresAt: expiry }, { merge: true });
    for (const document of audits.docs) tx.set(document.ref, { closedAt: Timestamp.fromDate(closedAt), expiresAt: expiry }, { merge: true });
  }

  private currentAssessment(value: Record<string, unknown>): Record<string, unknown> { const { assessments: _assessments, ...current } = value; return current; }
  private nextAction(data: Record<string, unknown>): SecurityIncidentListItem["nextAction"] { if (data.closedAt) return "none"; if (!data.awarenessAt) return "acknowledge_awareness"; if (data.classification === "triage") return "classify"; if (data.authorityDecision === "undecided") return "decide_authority"; if (data.authorityDecision === "required" && !data.authorityExportVersion) return "prepare_authority_export"; if (data.authorityDecision === "required" && data.authorityDeliveryStatus === "not_started") return "record_authority_submission"; if (data.subjectDecision === "undecided") return "decide_subject"; if (data.subjectDecision === "required" && !data.subjectNotificationVersion) return "prepare_subject_notification"; if (data.subjectNotificationStatus === "unknown") return "resolve_subject_notification_unknown"; if (data.subjectDecision === "required" && data.subjectNotificationStatus !== "sent") return "send_subject_notification"; return "close"; }
  private toList(incidentId: string, data: Record<string, unknown>): SecurityIncidentListItem { return Object.freeze({ incidentId, classification: data.classification as IncidentClassification, authorityDecision: data.authorityDecision as IncidentDecision, authorityDeliveryStatus: data.authorityDeliveryStatus as AuthorityDeliveryStatus, subjectDecision: data.subjectDecision as IncidentDecision, subjectNotificationStatus: data.subjectNotificationStatus as SubjectNotificationStatus, awarenessAt: data.awarenessAt ? asTimestamp(data.awarenessAt, "awareness_at").toDate().toISOString() : null, authorityDeadlineAt: data.authorityDeadlineAt ? asTimestamp(data.authorityDeadlineAt, "authority_deadline").toDate().toISOString() : null, closedAt: data.closedAt ? asTimestamp(data.closedAt, "closed_at").toDate().toISOString() : null, revision: Number(data.revision), legalHold: data.legalHold === true, nextAction: this.nextAction(data) }); }
  private encrypt(value: string): EncryptedValue { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, iv); const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Object.freeze({ ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") }); }
  private decrypt(value: Record<string, unknown>): string { const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(String(value.iv), "base64")); decipher.setAuthTag(Buffer.from(String(value.tag), "base64")); return Buffer.concat([decipher.update(Buffer.from(String(value.ciphertext), "base64")), decipher.final()]).toString("utf8"); }
  private decryptOptional(value: unknown): string | null { return value && typeof value === "object" ? this.decrypt(asRecord(value, "encrypted")) : null; }
  private digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("base64url"); }
  private recipientPseudonym(incidentId: string, email: string): string { return createHmac("sha256", this.auditHmacSecret).update(`${incidentId}:${email.trim().toLowerCase()}`, "utf8").digest("base64url"); }
  private audit(tx: Transaction, incidentId: string, actorId: string, event: string, now: Date, revision?: number, assessmentVersion?: number, snapshot?: Record<string, unknown>, expiresAt?: Timestamp | null): void { tx.create(this.auditRef(incidentId, randomUUID()), { event, actorPseudonym: createHmac("sha256", this.auditHmacSecret).update(actorId, "utf8").digest("base64url"), at: Timestamp.fromDate(now), ...(revision === undefined ? {} : { revision }), ...(assessmentVersion === undefined ? {} : { assessmentVersion }), ...(snapshot === undefined ? {} : { snapshot }), ...(expiresAt === undefined ? {} : { expiresAt }) }); }
  private incidentRef(id: string) { return this.db.collection(COLLECTIONS.securityIncidents).doc(id); }
  private secretRef(id: string) { return this.db.collection(COLLECTIONS.securityIncidentSecrets).doc(id); }
  private artifactRef(id: string) { return this.db.collection(COLLECTIONS.securityIncidentArtifacts).doc(id); }
  private deliveryRef(id: string) { return this.db.collection(COLLECTIONS.securityIncidentDeliveries).doc(id); }
  private deliveryByKeyRef(id: string) { return this.db.collection(COLLECTIONS.securityIncidentDeliveryKeys).doc(id); }
  private reminderRef(incidentId: string, hours: number) { return this.db.collection(COLLECTIONS.securityIncidentReminders).doc(`${incidentId}_${hours}`); }
  private auditRef(incidentId: string, id: string) { return this.incidentRef(incidentId).collection("audit").doc(id); }
  private deliveryKey(incidentId: string, pseudonym: string, version: number): string { return createHash("sha256").update(`${incidentId}:${pseudonym}:${version}`, "utf8").digest("base64url"); }
}
