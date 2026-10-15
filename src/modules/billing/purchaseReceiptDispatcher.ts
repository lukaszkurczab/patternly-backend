import { PurchaseReceiptEmailRejectedError, type PurchaseReceiptEmailSender } from "../../infrastructure/email/smtpPrivacyEmailSender.js";
import type { RevenueCatWebhookResult, RevenueCatWebhookStore } from "./revenuecatWebhookStore.js";

/** Every entry point uses a durable M10 claim before SMTP and exact finalization after it. */
export async function dispatchPurchaseReceipt(store: RevenueCatWebhookStore, result: Pick<RevenueCatWebhookResult, "receipt" | "receiptDeliveryState">, sender?: PurchaseReceiptEmailSender | null): Promise<string | null> {
  if (result.receiptDeliveryState) return result.receiptDeliveryState === "contact_required" ? "receipt_contact_required" : result.receiptDeliveryState === "unknown" ? "purchase_receipt_reconciliation_required" : "purchase_receipt_delivery_pending";
  if (!result.receipt) return null;
  const receipt = result.receipt;
  const mark = (status: "sent" | "failed" | "unknown") => store.markReceiptDelivery(receipt.userId, receipt.receiptId, receipt.deliveryClaimId, status);
  const uncertainty = async () => { try { await mark("unknown"); } catch { /* The durable claim remains the resend fence. */ } };
  if (!sender) return await mark("failed") ? "purchase_receipt_delivery_unavailable" : "purchase_receipt_reconciliation_required";
  try { await sender.send(receipt); }
  catch (error) {
    if (error instanceof PurchaseReceiptEmailRejectedError) return await mark("failed") ? "purchase_receipt_delivery_failed" : "purchase_receipt_reconciliation_required";
    await uncertainty();
    return "purchase_receipt_reconciliation_required";
  }
  try { if (await mark("sent")) return null; } catch { /* Do not infer rejection after an uncertain commit. */ }
  await uncertainty();
  return "purchase_receipt_reconciliation_required";
}
