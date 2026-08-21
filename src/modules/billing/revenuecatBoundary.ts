import type { RevenueCatReconciler } from "../../infrastructure/revenuecat/client.js";

export type BillingReconciliationRequest = Readonly<{ externalCustomerId: string }>;

export interface BillingService {
  reconcile(userId: string, input: BillingReconciliationRequest): Promise<Readonly<{ status: string; expiresAt: string | null }>>;
}

export class RevenueCatBillingService implements BillingService {
  public constructor(private readonly reconciler: RevenueCatReconciler) {}

  public reconcile(userId: string, input: BillingReconciliationRequest) {
    return this.reconciler.reconcile(userId, input.externalCustomerId);
  }
}
