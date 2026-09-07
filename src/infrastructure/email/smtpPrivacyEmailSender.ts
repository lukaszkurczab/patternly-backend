import nodemailer, { type Transporter } from "nodemailer";
import type { PrivacyRequestEmailSender } from "../../modules/privacy-requests/store.js";
import type { SecurityIncidentEmailSender } from "../../modules/security-incidents/store.js";
import type { LegalRequestEmailSender } from "../../modules/legal-requests/store.js";
import type { PurchaseReceiptDelivery } from "../../modules/billing/revenuecatWebhookStore.js";

export interface PurchaseReceiptEmailSender {
  send(input: PurchaseReceiptDelivery): Promise<void>;
}

export type SmtpPrivacyEmailConfiguration = Readonly<{
  host: string;
  port: 465 | 587;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | undefined;
}>;

type MailTransport = Pick<Transporter, "sendMail">;

export function createSmtpPrivacyEmailSender(
  configuration: SmtpPrivacyEmailConfiguration,
  transport: MailTransport = nodemailer.createTransport({
    host: configuration.host,
    port: configuration.port,
    secure: configuration.port === 465,
    requireTLS: true,
    auth: { user: configuration.username, pass: configuration.password },
    tls: { minVersion: "TLSv1.2", servername: configuration.host },
    disableFileAccess: true,
    disableUrlAccess: true,
  }),
): PrivacyRequestEmailSender {
  const from = { name: configuration.fromName, address: configuration.fromEmail };
  return Object.freeze({
    async send(input: Parameters<PrivacyRequestEmailSender["send"]>[0]) {
      const content = privacyMessage(input);
      const result = await transport.sendMail({
        from,
        to: input.recipient,
        ...(configuration.replyTo ? { replyTo: configuration.replyTo } : {}),
        subject: content.subject,
        text: content.text,
      });
      const accepted = Array.isArray(result.accepted) ? result.accepted.map(String) : [];
      if (!accepted.includes(input.recipient)) throw new Error("privacy_email_rejected");
    },
  });
}

/** A deliberately separate purpose: incident notices are never mixed with DSAR mail. */
export function createSmtpSecurityIncidentEmailSender(
  configuration: SmtpPrivacyEmailConfiguration,
  transport: MailTransport = nodemailer.createTransport({
    host: configuration.host,
    port: configuration.port,
    secure: configuration.port === 465,
    requireTLS: true,
    auth: { user: configuration.username, pass: configuration.password },
    tls: { minVersion: "TLSv1.2", servername: configuration.host },
    disableFileAccess: true,
    disableUrlAccess: true,
  }),
): SecurityIncidentEmailSender {
  if (isPlaceholderAddress(configuration.fromEmail) || !configuration.replyTo || isPlaceholderAddress(configuration.replyTo)) throw new Error("security_incident_email_placeholder");
  const from = { name: configuration.fromName, address: configuration.fromEmail };
  return Object.freeze({
    async send(input: Parameters<SecurityIncidentEmailSender["send"]>[0]) {
      const result = await transport.sendMail({ from, to: input.recipient, ...(configuration.replyTo ? { replyTo: configuration.replyTo } : {}), subject: input.subject, text: input.text });
      const accepted = Array.isArray(result.accepted) ? result.accepted.map(String) : [];
      if (!accepted.includes(input.recipient)) throw new Error("security_incident_email_rejected");
    },
  });
}

/** Consumer cases share the SMTP transport but keep a separate bounded message purpose. */
export function createSmtpLegalRequestEmailSender(
  configuration: SmtpPrivacyEmailConfiguration,
  transport: MailTransport = nodemailer.createTransport({
    host: configuration.host,
    port: configuration.port,
    secure: configuration.port === 465,
    requireTLS: true,
    auth: { user: configuration.username, pass: configuration.password },
    tls: { minVersion: "TLSv1.2", servername: configuration.host },
    disableFileAccess: true,
    disableUrlAccess: true,
  }),
): LegalRequestEmailSender {
  const from = { name: configuration.fromName, address: configuration.fromEmail };
  return Object.freeze({
    async send(input: Parameters<LegalRequestEmailSender["send"]>[0]) {
      const kind = legalRequestKindLabel(input.kind);
      const subject = input.purpose === "received" ? `Patternly — potwierdzenie przyjęcia: ${kind}` : `Patternly — odpowiedź: ${kind}`;
      const text = input.purpose === "received"
        ? `Przyjęliśmy Twoje zgłoszenie (${kind}).\n\nNumer sprawy: ${input.requestId}\n\nNie wysyłaj hasła ani kodów odzyskiwania w odpowiedzi. Zachowaj tę wiadomość jako potwierdzenie na trwałym nośniku.`
        : `Odpowiedź w sprawie ${input.requestId} (${kind}):\n\n${input.response ?? ""}\n\nZachowaj tę wiadomość jako odpowiedź na trwałym nośniku.`;
      const result = await transport.sendMail({ from, to: input.recipient, ...(configuration.replyTo ? { replyTo: configuration.replyTo } : {}), subject, text });
      const accepted = Array.isArray(result.accepted) ? result.accepted.map(String) : [];
      if (!accepted.includes(input.recipient)) throw new Error("legal_request_email_rejected");
    },
  });
}

/** Durable post-purchase confirmation, kept separate from legal-case and privacy mail. */
export function createSmtpPurchaseReceiptEmailSender(
  configuration: SmtpPrivacyEmailConfiguration,
  transport: MailTransport = nodemailer.createTransport({
    host: configuration.host,
    port: configuration.port,
    secure: configuration.port === 465,
    requireTLS: true,
    auth: { user: configuration.username, pass: configuration.password },
    tls: { minVersion: "TLSv1.2", servername: configuration.host },
    disableFileAccess: true,
    disableUrlAccess: true,
  }),
): PurchaseReceiptEmailSender {
  const from = { name: configuration.fromName, address: configuration.fromEmail };
  return Object.freeze({
    async send(input: PurchaseReceiptDelivery) {
      const polish = input.locale === "pl";
      const subject = polish ? "Patternly — potwierdzenie zakupu" : "Patternly — purchase confirmation";
      const text = polish
        ? `Potwierdzenie zakupu usługi Patternly Premium\n\nCena wyświetlona w App Store: ${input.storefrontPrice}\nOkres rozliczeniowy: miesiąc\nOdnowienie: automatyczne do chwili anulowania w ustawieniach App Store\nIdentyfikator produktu: ${input.productIdentifier}\nIdentyfikator transakcji: ${input.transactionId}\nWersja zaakceptowanego Regulaminu: ${input.termsVersion}\n\nNa Twoje wyraźne żądanie dostęp do usługi cyfrowej rozpoczął się natychmiast po zakupie.`
        : `Patternly Premium purchase confirmation\n\nPrice shown in the App Store: ${input.storefrontPrice}\nBilling period: monthly\nRenewal: automatic until cancelled in App Store settings\nProduct identifier: ${input.productIdentifier}\nTransaction identifier: ${input.transactionId}\nAccepted Terms version: ${input.termsVersion}\n\nAt your express request, access to the digital service started immediately after purchase.`;
      const messageIdDomain = configuration.fromEmail.split("@")[1] ?? "patternly.invalid";
      const result = await transport.sendMail({ from, to: input.recipient, ...(configuration.replyTo ? { replyTo: configuration.replyTo } : {}), messageId: `<patternly-receipt-${input.receiptId}@${messageIdDomain}>`, subject, text });
      const accepted = Array.isArray(result.accepted) ? result.accepted.map(String) : [];
      if (!accepted.includes(input.recipient)) throw new Error("purchase_receipt_email_rejected");
    },
  });
}

function legalRequestKindLabel(kind: Parameters<LegalRequestEmailSender["send"]>[0]["kind"]): string {
  if (kind === "complaint") return "reklamacja";
  if (kind === "withdrawal") return "odstąpienie od umowy";
  if (kind === "data_recovery") return "odzyskanie danych nieosobowych";
  return "odwołanie od zawieszenia";
}

function isPlaceholderAddress(address: string): boolean {
  return /(?:docelowa-domena|example\.(?:com|org|net)|placeholder)/iu.test(address);
}

function privacyMessage(input: Parameters<PrivacyRequestEmailSender["send"]>[0]): Readonly<{ subject: string; text: string }> {
  if (input.purpose === "verify") return Object.freeze({
    subject: "Potwierdź wniosek dotyczący danych w Patternly",
    text: `Otrzymaliśmy wniosek dotyczący danych. Aby potwierdzić dostęp do tego adresu e-mail, otwórz bezpieczny link w ciągu 24 godzin:\n\n${input.link}\n\nJeśli nie składałeś tego wniosku, zignoruj tę wiadomość. Wiadomość nie potwierdza, czy Patternly posiada dane powiązane z tym adresem.`,
  });
  if (input.purpose === "extension") return Object.freeze({
    subject: "Termin odpowiedzi na wniosek dotyczący danych",
    text: `Termin odpowiedzi na Twój wniosek został przedłużony maksymalnie o dwa miesiące.\n\nPowód: ${input.extensionReason ?? "złożoność lub liczba obsługiwanych wniosków"}\n\nAktualny status sprawdzisz przez bezpieczny link ważny przez 24 godziny:\n\n${input.link}`,
  });
  return Object.freeze({
    subject: "Odpowiedź na wniosek dotyczący danych w Patternly",
    text: `Odpowiedź na Twój wniosek jest gotowa. Ze względów bezpieczeństwa nie umieszczamy jej w wiadomości e-mail. Otwórz bezpieczny link w ciągu 24 godzin:\n\n${input.link}`,
  });
}
