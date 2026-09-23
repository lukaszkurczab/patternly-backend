import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getFirestore } from "firebase-admin/firestore";
import { TEST_APP_CHECK_TOKEN, createEmulatorContext } from "./support.js";

test("verification delivery failure stays pending and existing resend can deliver the same request", async () => {
  const context = createEmulatorContext({ projectId: `patternly-aud09-${randomUUID()}` });
  try {
    const payload = { clientRequestId: randomUUID(), email: "guest@example.com", right: "access" as const, reportSubmissionIds: [] as string[] };
    const requestId = await context.stores.privacyRequests.createGuest({ ...payload, rateLimitKey: "delivery-failure-test" }, {
      send: async () => { throw new Error("mail_down"); },
    });
    const storedAfterFailure = await getFirestore().collection("privacyRequests").doc(requestId).get();
    assert.equal(storedAfterFailure.data()?.status, "identity_verification_required");
    assert.equal(storedAfterFailure.data()?.deliveryFailure, "verification_email_failed");
    assert.equal(context.privacyLinks.length, 0);

    const headers = { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
    const repeatedCreate = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests", headers, payload });
    assert.equal(repeatedCreate.statusCode, 202);
    assert.deepEqual(repeatedCreate.json(), { status: "pending_verification", requestId });

    const missingResend = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/pr_00000000-0000-4000-8000-000000000000/resend", headers, payload: { email: payload.email } });
    const wrongEmailResend = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/resend`, headers, payload: { email: "wrong@example.com" } });
    assert.equal(missingResend.statusCode, 202);
    assert.deepEqual(missingResend.json(), wrongEmailResend.json());
    assert.equal(context.privacyLinks.length, 0);

    const resend = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/resend`, headers, payload: { email: payload.email } });
    assert.equal(resend.statusCode, 202);
    assert.deepEqual(resend.json(), { status: "pending_verification" });
    assert.equal(context.privacyLinks.length, 1);
    const deliveredCode = context.privacyLinks[0]!.code;
    assert.match(deliveredCode, new RegExp(`^${requestId}\\.[A-Za-z0-9_-]{43}$`, "u"));
    const storedAfterResend = await getFirestore().collection("privacyRequests").doc(requestId).get();
    assert.equal(storedAfterResend.data()?.status, "identity_verification_required");
    assert.equal(storedAfterResend.data()?.deliveryFailure, null);
    assert.equal((await getFirestore().collection("privacyRequests").get()).size, 1);

    const verified = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers, payload: { code: deliveredCode } });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.json().requestId, requestId);
  } finally {
    await context.close();
  }
});
