import assert from "node:assert/strict";
import test from "node:test";
import { createSmtpPrivacyEmailSender, createSmtpPurchaseReceiptEmailSender, createSmtpLegalRequestEmailSender } from "../src/infrastructure/email/smtpPrivacyEmailSender.js";
import { LegalRequestConfirmationRejectedError } from "../src/modules/legal-requests/store.js";
import { loadEnvironment } from "../src/config/environment.js";

const configuration = Object.freeze({
  host: "smtp-relay.gmail.com",
  port: 465 as const,
  username: "sender@example.com",
  password: "secret-value",
  fromEmail: "privacy@example.com",
  fromName: "Patternly",
  replyTo: "privacy@example.com",
});

test("SMTP privacy sender emits bounded plain-text messages for every DSAR purpose", async () => {
  const messages: Record<string, unknown>[] = [];
  const sender = createSmtpPrivacyEmailSender(configuration, { sendMail: async (message) => {
    messages.push(message as Record<string, unknown>);
    return { accepted: [String(message.to)], rejected: [] } as never;
  } });
  const code = `pr_75347222-8b93-4d78-9232-36b053107c46.${"s".repeat(43)}`;
  await sender.send({ recipient: "person@example.com", purpose: "verify", requestId: "pr_75347222-8b93-4d78-9232-36b053107c46", code });
  await sender.send({ recipient: "person@example.com", purpose: "extension", requestId: "pr_75347222-8b93-4d78-9232-36b053107c46", code, extensionReason: "Sprawa wymaga porównania kilku źródeł." });
  await sender.send({ recipient: "person@example.com", purpose: "response", requestId: "pr_75347222-8b93-4d78-9232-36b053107c46", code });

  assert.equal(messages.length, 3);
  for (const message of messages) {
    assert.deepEqual(message.from, { name: "Patternly", address: "privacy@example.com" });
    assert.equal(message.to, "person@example.com");
    assert.equal(message.replyTo, "privacy@example.com");
    assert.equal(typeof message.subject, "string");
    assert.equal(typeof message.text, "string");
    assert.equal("html" in message, false);
    assert.ok(String(message.text).includes(code));
    assert.doesNotMatch(JSON.stringify(message), /secret-value/u);
  }
  assert.match(String(messages[1]?.text), /Sprawa wymaga porównania kilku źródeł/u);
  assert.doesNotMatch(String(messages[0]?.text), /istnieje konto|konto istnieje/iu);
});

test("SMTP privacy sender fails when the provider does not accept the recipient", async () => {
  const sender = createSmtpPrivacyEmailSender(configuration, { sendMail: async () => ({ accepted: [], rejected: ["person@example.com"] }) as never });
  await assert.rejects(sender.send({ recipient: "person@example.com", purpose: "response", requestId: "pr_fixture", code: "pr_fixture.token" }), /privacy_email_rejected/u);
});

test("SMTP purchase receipt is plain text and contains the durable transaction evidence", async () => {
  const messages: Record<string, unknown>[] = [];
  const sender = createSmtpPurchaseReceiptEmailSender(configuration, { sendMail: async (message) => {
    messages.push(message as Record<string, unknown>);
    return { accepted: [String(message.to)], rejected: [] } as never;
  } });
  await sender.send({ userId: "user-1", receiptId: "receipt-1", deliveryClaimId: "claim-1", recipient: "person@example.com", transactionId: "tx-123", confirmationId: "confirmation-1", productIdentifier: "monthly", storefrontPrice: "29,99 zł", locale: "pl", termsVersion: "2026-09-01", immediateStartRequested: true });
  assert.equal(messages.length, 1);
  assert.equal("html" in messages[0]!, false);
  assert.match(String(messages[0]!.text), /tx-123/u);
  assert.match(String(messages[0]!.text), /29,99 zł/u);
  assert.match(String(messages[0]!.text), /automatyczne/u);
  assert.match(String(messages[0]!.text), /natychmiast/u);
  assert.equal(messages[0]!.messageId, "<patternly-receipt-receipt-1@example.com>");
});

test("SMTP runtime configuration is all-or-nothing and production requires it", () => {
  const base = {
    NODE_ENV: "production",
    FIREBASE_PROJECT_ID: "patternly-app-sandbox",
    FIREBASE_AUTH_ISSUER: "https://securetoken.google.com/patternly-app-sandbox",
    ADMINISTRATOR_EMAIL: "admin@example.com",
    REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
    DELETION_PSEUDONYM_KEYS_JSON: JSON.stringify([{ version: "test-v1", status: "active", keyBase64: Buffer.alloc(32, 7).toString("base64") }]),
    PRIVACY_RESPONSE_KEY_BASE64: Buffer.alloc(32, 11).toString("base64"),
    PRIVACY_AUDIT_HMAC_SECRET: "test-only-privacy-audit-hmac-secret-0123456789",
    REVENUECAT_WEBHOOK_SECRET: "Bearer test-revenuecat-secret",
    REVENUECAT_PROJECT_ID: "proj8ae78267",
    REVENUECAT_APP_ID: "app7b06e9a4c1",
    REVENUECAT_ENTITLEMENT_ID: "premium",
    REVENUECAT_PRODUCT_ID: "prod8d07384c8c",
    REVENUECAT_WEBHOOK_ENVIRONMENT: "PRODUCTION",
  };
  assert.throws(() => loadEnvironment(base), { message: "production_smtp_config_required" });
  assert.throws(() => loadEnvironment({ ...base, SMTP_HOST: "smtp-relay.gmail.com" }), { message: "invalid_smtp_config" });
  const environment = loadEnvironment({ ...base, SMTP_HOST: configuration.host, SMTP_PORT: String(configuration.port), SMTP_USERNAME: configuration.username, SMTP_PASSWORD: configuration.password, SMTP_FROM_EMAIL: configuration.fromEmail, SMTP_FROM_NAME: configuration.fromName, SMTP_REPLY_TO: configuration.replyTo });
  assert.deepEqual(environment.smtp, configuration);
});

test("SMTP received legal notice distinguishes explicit refusal from uncertain or conflicting outcomes", async () => {
  const recipient = "person@example.com";
  const input = { recipient, purpose: "received", requestId: "lr_fixture", kind: "complaint" } as const;
  const vectors = [
    { result: { accepted: [recipient] }, outcome: "sent" },
    { result: { rejected: [recipient] }, outcome: "failed" },
    { result: { accepted: [recipient], rejected: [recipient] }, outcome: "unknown" },
    { result: {}, outcome: "unknown" },
    { result: { accepted: "invalid", rejected: [] }, outcome: "unknown" },
    { error: new Error("550 rejected after DATA maybe"), outcome: "unknown" },
    { error: Object.assign(new Error("disconnect"), { code: "ETIMEDOUT" }), outcome: "unknown" },
    { error: { responseCode: "550", command: "DATA" }, outcome: "unknown" },
    { error: { responseCode: 550, command: "CONN" }, outcome: "unknown" },
    ...["MAIL FROM", "RCPT TO", "DATA"].map((command) => ({ error: { responseCode: 550, command }, outcome: "failed" })),
  ];
  for (const vector of vectors) {
    let calls = 0;
    const sender = createSmtpLegalRequestEmailSender(configuration, { sendMail: async (message) => {
      calls += 1;
      assert.equal("html" in message, false);
      assert.match(String(message.text), /lr_fixture/u);
      if ("error" in vector) throw vector.error;
      return vector.result as never;
    } });
    if (vector.outcome === "sent") await sender.send(input);
    else if (vector.outcome === "failed") await assert.rejects(sender.send(input), LegalRequestConfirmationRejectedError);
    else await assert.rejects(sender.send(input), { message: "legal_request_email_unknown" });
    assert.equal(calls, 1);
  }
});

test("SMTP dormant answered and purchase acceptance policies remain purpose specific", async () => {
  const recipient = "person@example.com";
  const transport = { sendMail: async () => ({ accepted: [recipient], rejected: [recipient] }) as never };
  await createSmtpLegalRequestEmailSender(configuration, transport).send({ recipient, purpose: "answered", requestId: "lr_fixture", kind: "complaint", response: "Answer" });
  await createSmtpPurchaseReceiptEmailSender(configuration, transport).send({ userId: "user-1", receiptId: "receipt-1", deliveryClaimId: "claim-1", recipient, transactionId: "tx-123", confirmationId: "confirmation-1", productIdentifier: "monthly", storefrontPrice: "29,99 zł", locale: "pl", termsVersion: "2026-09-01", immediateStartRequested: true });
  await assert.rejects(createSmtpLegalRequestEmailSender(configuration, { sendMail: async () => ({ rejected: [recipient] }) as never }).send({ recipient, purpose: "answered", requestId: "lr_fixture", kind: "complaint" }), { message: "legal_request_email_rejected" });
});
