import assert from "node:assert/strict";
import test from "node:test";
import { createSmtpPrivacyEmailSender, createSmtpPurchaseReceiptEmailSender } from "../src/infrastructure/email/smtpPrivacyEmailSender.js";
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
  const link = "https://patternly.example/privacy-request/pr_fixture#token=secret-token";
  await sender.send({ recipient: "person@example.com", purpose: "verify", requestId: "pr_fixture", link });
  await sender.send({ recipient: "person@example.com", purpose: "extension", requestId: "pr_fixture", link, extensionReason: "Sprawa wymaga porównania kilku źródeł." });
  await sender.send({ recipient: "person@example.com", purpose: "response", requestId: "pr_fixture", link });

  assert.equal(messages.length, 3);
  for (const message of messages) {
    assert.deepEqual(message.from, { name: "Patternly", address: "privacy@example.com" });
    assert.equal(message.to, "person@example.com");
    assert.equal(message.replyTo, "privacy@example.com");
    assert.equal(typeof message.subject, "string");
    assert.equal(typeof message.text, "string");
    assert.equal("html" in message, false);
    assert.match(String(message.text), /#token=secret-token/u);
    assert.doesNotMatch(JSON.stringify(message), /secret-value/u);
  }
  assert.match(String(messages[1]?.text), /Sprawa wymaga porównania kilku źródeł/u);
  assert.doesNotMatch(String(messages[0]?.text), /istnieje konto|konto istnieje/iu);
});

test("SMTP privacy sender fails when the provider does not accept the recipient", async () => {
  const sender = createSmtpPrivacyEmailSender(configuration, { sendMail: async () => ({ accepted: [], rejected: ["person@example.com"] }) as never });
  await assert.rejects(sender.send({ recipient: "person@example.com", purpose: "response", requestId: "pr_fixture", link: "https://patternly.example/#token=token" }), /privacy_email_rejected/u);
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
    ADMIN_WEB_ORIGIN: "https://admin.example.com",
    PUBLIC_PRIVACY_ORIGIN: "https://privacy.example.com",
    REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
    DELETION_PSEUDONYM_KEYS_JSON: JSON.stringify([{ version: "test-v1", status: "active", keyBase64: Buffer.alloc(32, 7).toString("base64") }]),
    PRIVACY_RESPONSE_KEY_BASE64: Buffer.alloc(32, 11).toString("base64"),
    PRIVACY_AUDIT_HMAC_SECRET: "test-only-privacy-audit-hmac-secret-0123456789",
    REVENUECAT_WEBHOOK_SECRET: "Bearer test-revenuecat-secret",
    REVENUECAT_APP_ID: "app-1",
    REVENUECAT_ENTITLEMENT_ID: "premium",
    REVENUECAT_PRODUCT_ID: "monthly",
    REVENUECAT_WEBHOOK_ENVIRONMENT: "PRODUCTION",
  };
  assert.throws(() => loadEnvironment(base), { message: "production_smtp_config_required" });
  assert.throws(() => loadEnvironment({ ...base, SMTP_HOST: "smtp-relay.gmail.com" }), { message: "invalid_smtp_config" });
  const environment = loadEnvironment({ ...base, SMTP_HOST: configuration.host, SMTP_PORT: String(configuration.port), SMTP_USERNAME: configuration.username, SMTP_PASSWORD: configuration.password, SMTP_FROM_EMAIL: configuration.fromEmail, SMTP_FROM_NAME: configuration.fromName, SMTP_REPLY_TO: configuration.replyTo });
  assert.deepEqual(environment.smtp, configuration);
});
