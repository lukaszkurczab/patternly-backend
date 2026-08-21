import { and, eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { devices } from "../../infrastructure/database/schema.js";

export interface DeviceStore {
  touch(userId: string, input: Readonly<{ deviceKey: string; platform: string; appVersion: string }>): Promise<string>;
}

export class DrizzleDeviceStore implements DeviceStore {
  public constructor(private readonly db: Database) {}

  public async touch(userId: string, input: Readonly<{ deviceKey: string; platform: string; appVersion: string }>): Promise<string> {
    const current = await this.db.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, userId), eq(devices.deviceKey, input.deviceKey))).limit(1);
    if (current[0]) {
      await this.db.update(devices).set({ platform: input.platform, appVersion: input.appVersion, lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(devices.id, current[0].id));
      return current[0].id;
    }
    const [created] = await this.db.insert(devices).values({ userId, deviceKey: input.deviceKey, platform: input.platform, appVersion: input.appVersion }).returning({ id: devices.id });
    if (!created) throw new Error("device_insert_failed");
    return created.id;
  }
}
