import { FirestoreAccountLifecycleStore } from "../src/modules/account-lifecycle/store.js";
import type { RevenueCatDeletionRuntime } from "../src/modules/account-lifecycle/store.js";

/** Existing lifecycle tests explicitly model an account with no RC customer.
 * Provider errors/effects are tested by rcCustomerDeletion.emulator.ts. */
export const absentRevenueCatCustomerFixture: RevenueCatDeletionRuntime = Object.freeze({
  projectId: "projtest",
  client: { projectId: "projtest", deleteCustomer: async () => ({ status: "absent" as const }) },
});

export class FixtureAccountLifecycleStore extends FirestoreAccountLifecycleStore {
  public constructor(...args: ConstructorParameters<typeof FirestoreAccountLifecycleStore>) {
    super(args[0], args[1], args[2], args[3] ?? absentRevenueCatCustomerFixture);
  }
}
