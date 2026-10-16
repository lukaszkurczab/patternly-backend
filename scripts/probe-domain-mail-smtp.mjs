// DOMAIN-MAIL-01: one explicitly approved SMTP probe, not a product mail route.
// Default: config-only preflight. --send consumes one persistent private ledger.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import nodemailer from "nodemailer";

const project = "patternly-app-sandbox";
const service = "patternly-backend-sandbox";
const region = "europe-central2";
const from = "contact@patternly.it";
const recipient = "lukasz.kurczab@gmail.com";
let stage = "arguments";
let receiptPath;
let receipt;
let transport;
let sendStarted = false;

function gcloud(args) {
  return execFileSync("gcloud", args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
}
function persist() {
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

try {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const index = args.indexOf("--evidence-dir");
  const directory = args[index + 1];
  if (index !== 0 || !directory || args.length !== (send ? 3 : 2)
    || (send && args[2] !== "--send") || !isAbsolute(directory)) throw new Error("invalid_arguments");
  const canonical = realpathSync(directory);
  if (canonical !== resolve(directory) || !canonical.startsWith("/private/tmp/patternly-domain-mail39-")
    || !statSync(canonical).isDirectory() || (statSync(canonical).mode & 0o077) !== 0) throw new Error("unsafe_evidence_directory");
  receiptPath = join(canonical, "brevo-smtp-attempt.json");
  const approvedConfig = JSON.parse(readFileSync(join(canonical, "brevo-transport-account-check.json"), "utf8"));

  stage = "config_read";
  const config = JSON.parse(gcloud(["run", "services", "describe", service,
    `--project=${project}`, `--region=${region}`, "--format=json"]));
  const env = new Map(config.spec.template.spec.containers[0].env.map(entry => [entry.name, entry]));
  const host = env.get("SMTP_HOST")?.value;
  const port = Number(env.get("SMTP_PORT")?.value);
  const username = env.get("SMTP_USERNAME")?.value;
  const secret = env.get("SMTP_PASSWORD")?.valueFrom?.secretKeyRef;
  if (host !== "smtp-relay.brevo.com" || port !== 587 || !username
    || !approvedConfig.login_matches_connected_brevo_account
    || approvedConfig.project !== project || approvedConfig.service !== service
    || config.status.latestReadyRevisionName !== approvedConfig.ready_revision
    || config.status.latestCreatedRevisionName !== config.status.latestReadyRevisionName
    || !/^[A-Za-z0-9_-]+$/.test(secret?.name ?? "")
    || !/^(latest|[0-9]+)$/.test(secret?.key ?? "")
    || env.get("SMTP_PASSWORD")?.value) throw new Error("config_changed_or_unsupported");
  if (!send) {
    console.log(JSON.stringify({ result: "PREFLIGHT_OK", sends: 0, secretValuesRead: false }));
  } else {
    stage = "reserve_once";
    const attemptId = randomUUID();
    receipt = { attemptId, createdAt: new Date().toISOString(), project, service, region,
      revision: approvedConfig.ready_revision, from, to: recipient, replyTo: from,
      subject: `Patternly DOMAIN-MAIL-01 Brevo ${attemptId}`,
      messageId: `<patternly-domain-mail-${attemptId}@patternly.it>`,
      result: "RESERVED_NO_SEND", sendInvocations: 0 };
    // Exclusive creation is the retry/concurrency guard; never remove it to resend.
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });

    stage = "credential_read";
    const password = gcloud(["secrets", "versions", "access", secret.key,
      `--secret=${secret.name}`, `--project=${project}`]).trimEnd();
    if (!password) throw new Error("credential_unavailable");
    transport = nodemailer.createTransport({ host, port, secure: false, requireTLS: true,
      auth: { user: username, pass: password }, tls: { minVersion: "TLSv1.2", servername: host },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
    stage = "smtp_send";
    receipt.result = "SEND_STARTED_UNKNOWN";
    receipt.sendInvocations = 1;
    persist();
    sendStarted = true;
    const result = await transport.sendMail({ from: { name: "Patternly", address: from },
      to: recipient, replyTo: from, subject: receipt.subject, messageId: receipt.messageId,
      text: "Kontrolowany test dostawy Brevo dla Patternly" });
    receipt.acceptedExpectedRecipient = result.accepted?.map(String).includes(recipient) ?? false;
    receipt.rejectedExpectedRecipient = result.rejected?.map(String).includes(recipient) ?? false;
    receipt.result = receipt.acceptedExpectedRecipient ? "SMTP_ACCEPTED_PENDING_DELIVERY" : "UNKNOWN_CHECK_PROVIDER";
    receipt.completedAt = new Date().toISOString();
    persist();
    console.log(JSON.stringify({ result: receipt.result, sends: 1, receipt: receiptPath }));
  }
} catch (error) {
  // Never log error.message/stack, provider responses, credential values or gcloud output.
  const result = sendStarted ? "UNKNOWN_CHECK_PROVIDER_NO_RETRY" : "STOPPED_BEFORE_SEND";
  const code = ["EEXIST", "EAUTH", "ECONNECTION", "ESOCKET", "ETIMEDOUT", "EENVELOPE", "EMESSAGE"]
    .includes(error?.code) ? error.code : "UNCLASSIFIED";
  // An existing ledger belongs to the previous invocation; do not overwrite it.
  if (receipt && stage !== "reserve_once") {
    receipt.result = result;
    receipt.failureStage = stage;
    receipt.failureCode = code;
    try { persist(); } catch { /* Preserve any prior SEND_STARTED record. */ }
  }
  console.error(JSON.stringify({ result, stage, code, sends: sendStarted ? 1 : 0 }));
  process.exitCode = 1;
} finally {
  transport?.close();
}
