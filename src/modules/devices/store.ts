import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, deviceDocumentId } from "../../infrastructure/firestore/paths.js";
import { asRecord, now } from "../../infrastructure/firestore/values.js";

export interface DeviceStore {
  touch(userId: string, input: Readonly<{ deviceKey: string; platform: string; appVersion: string }>): Promise<string>;
}

export class FirestoreDeviceStore implements DeviceStore {
  public constructor(private readonly db: Firestore) {}

  public async touch(userId: string, input: Readonly<{ deviceKey: string; platform: string; appVersion: string }>): Promise<string> {
    const deviceId = deviceDocumentId(input.deviceKey);
    const deviceRef = this.db.collection(COLLECTIONS.users).doc(userId).collection("devices").doc(deviceId);
    const timestamp = now();
    await this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(this.db.collection(COLLECTIONS.users).doc(userId));
      if (!user.exists || asRecord(user.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
      transaction.set(deviceRef, { deviceKey: input.deviceKey, platform: input.platform, appVersion: input.appVersion, lastSeenAt: timestamp, updatedAt: timestamp }, { merge: true });
    });
    return deviceId;
  }
}
