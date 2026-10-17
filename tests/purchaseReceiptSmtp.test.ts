import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import nodemailer from "nodemailer";
import { createSmtpPurchaseReceiptEmailSender, PurchaseReceiptEmailRejectedError } from "../src/infrastructure/email/smtpPrivacyEmailSender.js";
import type { PurchaseReceiptDelivery } from "../src/modules/billing/revenuecatWebhookStore.js";

const configuration = { host: "unused.invalid", port: 465 as const, username: "fixture", password: "private-fixture", fromEmail: "sender@example.com", fromName: "Patternly", replyTo: undefined };
const input: PurchaseReceiptDelivery = { userId: "user", receiptId: "receipt", deliveryClaimId: "claim", recipient: "recipient@example.com", transactionId: "transaction", confirmationId: "confirmation", productIdentifier: "monthly", storefrontPrice: "29.99 PLN", locale: "en", termsVersion: "v1", immediateStartRequested: true };

for (const store of [undefined, "APP_STORE", "PLAY_STORE"] as const) {
  for (const locale of ["en", "pl"] as const) {
    test(`receipt copy names its actual store: ${store ?? "legacy Apple"}/${locale}`, async () => {
      let body = "";
      const sender = createSmtpPurchaseReceiptEmailSender(configuration, { sendMail: async (message) => {
        body = String(message.text);
        return { accepted: [input.recipient], envelope: { from: configuration.fromEmail, to: [input.recipient] }, messageId: "fixture-message" };
      } });
      await sender.send({ ...input, locale, ...(store === undefined ? {} : { store }) });
      assert.ok(body.includes(store === "PLAY_STORE" ? "Google Play" : "App Store"));
      assert.ok(!body.includes(store === "PLAY_STORE" ? "App Store" : "Google Play"));
      assert.ok(body.includes(input.productIdentifier));
    });
  }
}

// A real local SMTP boundary exercises the installed Nodemailer contract. No relay, TLS, auth or external traffic.
for (const result of ["accepted", "rcpt_refused", "data_refused", "disconnect_after_data"] as const) {
  test(`real loopback SMTP ${result}: classify acceptance, refusal and ambiguity`, async () => {
    const sockets = new Set<Socket>();
    let completeMessages = 0;
    const server = createServer(socket => {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket));
      socket.setEncoding("utf8");
      let buffer = ""; let data = false;
      socket.write("220 local fixture\r\n");
      socket.on("data", chunk => {
        buffer += chunk;
        while (buffer.includes("\r\n")) {
          const end = buffer.indexOf("\r\n");
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (data) {
            if (line === ".") {
              completeMessages++; data = false;
              if (result === "disconnect_after_data") socket.destroy();
              else socket.write(result === "data_refused" ? "550 Message refused\r\n" : "250 Queued\r\n");
            }
          } else if (/^(EHLO|HELO)/u.test(line)) socket.write("250 localhost\r\n");
          else if (line.startsWith("MAIL FROM")) socket.write("250 OK\r\n");
          else if (line.startsWith("RCPT TO")) socket.write(result === "rcpt_refused" ? "550 Recipient refused\r\n" : "250 OK\r\n");
          else if (line === "DATA") { data = true; socket.write("354 Send message\r\n"); }
          else if (line === "QUIT") socket.end("221 Goodbye\r\n");
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: address.port, secure: false, ignoreTLS: true, connectionTimeout: 2000, greetingTimeout: 2000, socketTimeout: 2000 });
    try {
      const sender = createSmtpPurchaseReceiptEmailSender(configuration, transport);
      if (result === "accepted") await sender.send(input);
      else if (result === "disconnect_after_data") await assert.rejects(sender.send(input), error => error instanceof Error && !(error instanceof PurchaseReceiptEmailRejectedError) && error.message === "purchase_receipt_email_unknown");
      else await assert.rejects(sender.send(input), PurchaseReceiptEmailRejectedError);
      assert.equal(completeMessages, result === "rcpt_refused" ? 0 : 1);
    } finally {
      transport.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}

test("missing provider outcome and unrecognized errors remain unknown; provider details stay private", async () => {
  for (const value of [{ accepted: [], rejected: [] }, new Error("private-provider-details"), { command: "QUIT", responseCode: 550 }]) {
    const sender = createSmtpPurchaseReceiptEmailSender(configuration, { sendMail: async () => {
      if ("accepted" in value) return value as never;
      throw value;
    } });
    await assert.rejects(sender.send(input), error => error instanceof Error && error.message === "purchase_receipt_email_unknown");
  }
});

test("an explicit rejected-recipient result is typed as a definite refusal", async () => {
  const sender = createSmtpPurchaseReceiptEmailSender(configuration, { sendMail: async () => ({ accepted: [], rejected: [input.recipient] }) as never });
  await assert.rejects(sender.send(input), PurchaseReceiptEmailRejectedError);
});
