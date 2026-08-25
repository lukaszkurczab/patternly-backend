import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, deviceDocumentId } from "../../infrastructure/firestore/paths.js";
import { now } from "../../infrastructure/firestore/values.js";

export interface DeviceStore {
  touch(userId: string, input: Readonly<{ deviceKey: string; platform: string; appVersion: string }>): Promise<string>;
}

export class FirestoreDeviceStore implements DeviceStore {
  public constructor(private readonly db: Firestore) {}

  public async touch(userId: string, input: Readonly<{ deviceKey: string; platform: string; appVersion: string }>): Promise<string> {
    const deviceId = deviceDocumentId(input.deviceKey);
    const deviceRef = this.db.collection(COLLECTIONS.users).doc(userId).collection("devices").doc(deviceId);
    const timestamp = now();
    await deviceRef.set({ deviceKey: input.deviceKey, platform: input.platform, appVersion: input.appVersion, lastSeenAt: timestamp, updatedAt: timestamp }, { merge: true });
    return deviceId;
  }
}
