export interface RevenueCatReconciler {
  reconcile(userId: string, externalCustomerId: string): Promise<Readonly<{ status: "active" | "expired" | "revoked"; expiresAt: string | null }>>;
}

export function createUnavailableRevenueCatReconciler(): RevenueCatReconciler {
  return Object.freeze({
    async reconcile(): Promise<Readonly<{ status: "active" | "expired" | "revoked"; expiresAt: string | null }>> {
      throw new Error("revenuecat_not_composed");
    },
  });
}
