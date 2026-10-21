import assert from "node:assert/strict";
import test from "node:test";
import {
  createRevenueCatCustomerDeletionClient,
  RevenueCatCustomerDeletionError,
  type RevenueCatCustomerDeletionFetch,
} from "../src/infrastructure/revenuecat/customerDeletion.js";

const baseUrl = "https://api.revenuecat.test";
const projectId = "projFixture123";
const appUserId = "patternly-account-1";
const customerId = appUserId;
const config = { baseUrl, apiKey: "secret-for-test", projectId };

function response(payload: unknown, status = 200, options: { redirected?: boolean; url?: string } = {}): Response {
  return { ok: status >= 200 && status < 300, status, redirected: options.redirected ?? false, url: options.url ?? "", json: async () => payload } as Response;
}

function search(items: readonly Record<string, unknown>[], next_page?: unknown): Record<string, unknown> {
  return { object: "list", items, ...(next_page === undefined ? {} : { next_page }) };
}

function customer(id = customerId, project = projectId): Record<string, unknown> {
  return { object: "customer", id, project_id: project };
}

function aliasesPage(ids: readonly string[], next_page?: unknown): Record<string, unknown> {
  return { object: "list", items: ids.map((id) => ({ object: "customer.alias", id, created_at: 1 })), ...(next_page === undefined ? {} : { next_page }) };
}

function makeFetch(options: {
  searchItems?: readonly Record<string, unknown>[];
  aliasPages?: readonly Record<string, unknown>[];
  deleteResponse?: Response;
  onRequest?: (url: string, init?: RequestInit) => Response | Promise<Response>;
} = {}): { fetch: RevenueCatCustomerDeletionFetch; requests: Array<{ url: string; init?: RequestInit }> } {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let aliasPage = 0;
  const fetch: RevenueCatCustomerDeletionFetch = async (input, init) => {
    const url = String(input);
    requests.push(init === undefined ? { url } : { url, init });
    if (options.onRequest) return options.onRequest(url, init);
    if (url.includes("/aliases")) return response(options.aliasPages?.[aliasPage++] ?? aliasesPage([appUserId]));
    if (init?.method === "DELETE") return options.deleteResponse ?? response({ object: "customer", id: customerId, deleted_at: 123 });
    return response(search(options.searchItems ?? [customer()]));
  };
  return { fetch, requests };
}

function create(fetch: RevenueCatCustomerDeletionFetch, extra: Record<string, unknown> = {}) {
  return createRevenueCatCustomerDeletionClient(config, { fetch, allowTestFixtures: true, ...extra });
}

test("searches exact App User ID, reads aliases, and deletes one resolved V2 customer", async () => {
  const { fetch, requests } = makeFetch({ aliasPages: [aliasesPage([appUserId, "$RCAnonymousID:device-1"])] });
  let fenced = false;
  const result = await create(fetch).deleteCustomer(appUserId, async () => { fenced = true; });
  assert.deepEqual(result, { status: "accepted" });
  assert.equal(fenced, true);
  assert.equal(requests.length, 3);
  const searchUrl = new URL(requests[0]!.url);
  assert.equal(searchUrl.pathname, `/v2/projects/${projectId}/customers`);
  assert.equal(searchUrl.searchParams.get("search"), appUserId);
  assert.equal(requests[0]!.init?.method, "GET");
  assert.equal(new URL(requests[1]!.url).pathname, `/v2/projects/${projectId}/customers/${customerId}/aliases`);
  assert.equal(requests[2]!.init?.method, "DELETE");
  assert.equal(new URL(requests[2]!.url).pathname, `/v2/projects/${projectId}/customers/${customerId}`);
  assert.equal((requests[2]!.init?.headers as Record<string, string>).authorization, "Bearer secret-for-test");
  assert.equal(requests[2]!.init?.redirect, "error");
});

test("supports a canonical anonymous customer only when its complete aliases include the account ID", async () => {
  const anonymous = "$RCAnonymousID:original";
  const { fetch, requests } = makeFetch({
    searchItems: [customer(anonymous)],
    aliasPages: [aliasesPage([anonymous], `${baseUrl}/v2/projects/${projectId}/customers/${encodeURIComponent(anonymous)}/aliases?starting_after=page2&limit=100`), aliasesPage([appUserId])],
    deleteResponse: response({ object: "customer", id: anonymous, deleted_at: 123 }),
  });
  const result = await create(fetch).deleteCustomer(appUserId);
  assert.deepEqual(result, { status: "accepted" });
  assert.equal(new URL(requests[2]!.url).pathname, `/v2/projects/${projectId}/customers/${encodeURIComponent(anonymous)}/aliases`);
  assert.equal(new URL(requests[3]!.url).pathname, `/v2/projects/${projectId}/customers/${encodeURIComponent(anonymous)}`);
});

test("does not treat an anonymous canonical ID or self-alias as proof of the requested account ID", async () => {
  const anonymous = "$RCAnonymousID:original";
  const { fetch, requests } = makeFetch({ searchItems: [customer(anonymous)], aliasPages: [aliasesPage([anonymous])] });
  await assert.rejects(create(fetch).deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "aliases" && error.kind === "identity_conflict");
  assert.equal(requests.some(({ init }) => init?.method === "DELETE"), false);
});

test("returns absent for a successful empty search without running the delete fence", async () => {
  const { fetch, requests } = makeFetch({ searchItems: [] });
  let fenced = false;
  assert.deepEqual(await create(fetch).deleteCustomer(appUserId, async () => { fenced = true; }), { status: "absent" });
  assert.equal(requests.length, 1);
  assert.equal(fenced, false);
});

test("rechecks absence after DELETE 404 and treats only a successful empty search as absent", async () => {
  let searches = 0;
  const { fetch } = makeFetch({ onRequest: async (url, init) => {
    if (url.includes("/aliases")) return response(aliasesPage([appUserId]));
    if (init?.method === "DELETE") return response({ message: "not exposed" }, 404);
    searches += 1;
    return response(search(searches === 1 ? [customer()] : []));
  } });
  assert.deepEqual(await create(fetch).deleteCustomer(appUserId), { status: "absent" });

  const stillPresent = makeFetch({ onRequest: async (url, init) => {
    if (url.includes("/aliases")) return response(aliasesPage([appUserId]));
    if (init?.method === "DELETE") return response({}, 404);
    return response(search([customer()]));
  } });
  await assert.rejects(create(stillPresent.fetch).deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "delete" && error.status === 404);
});

test("rejects bad project binding, multiple customers, foreign canonical IDs, and foreign aliases", async () => {
  const mismatchedProject = makeFetch({ searchItems: [customer(customerId, "projOther")] });
  await assert.rejects(create(mismatchedProject.fetch).deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "search");
  const multiple = makeFetch({ searchItems: [customer(), customer("customer-internal-2")] });
  await assert.rejects(create(multiple.fetch).deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.kind === "identity_conflict");
  const foreignCanonical = makeFetch({ searchItems: [customer("another-account")] });
  await assert.rejects(create(foreignCanonical.fetch).deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.kind === "identity_conflict");
  const foreignAlias = makeFetch({ aliasPages: [aliasesPage([appUserId, "another-account"])] });
  await assert.rejects(create(foreignAlias.fetch).deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "aliases" && error.kind === "identity_conflict");
  assert.equal(foreignAlias.requests.some(({ init }) => init?.method === "DELETE"), false);
});

test("follows all aliases pages and rejects unsafe or incomplete pagination", async () => {
  const second = `${baseUrl}/v2/projects/${projectId}/customers/${customerId}/aliases?starting_after=page2&limit=100`;
  const pages = makeFetch({ aliasPages: [aliasesPage(["$RCAnonymousID:device-1"], second), aliasesPage([appUserId])] });
  assert.deepEqual(await create(pages.fetch).deleteCustomer(appUserId), { status: "accepted" });
  assert.equal(pages.requests.length, 4);
  const foreignPage = makeFetch({ aliasPages: [aliasesPage([appUserId], "https://evil.example/page")] });
  await assert.rejects(create(foreignPage.fetch).deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "aliases");
  const missingTarget = makeFetch({ searchItems: [customer("$RCAnonymousID:device-1")], aliasPages: [aliasesPage(["$RCAnonymousID:device-1"])] });
  await assert.rejects(create(missingTarget.fetch).deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.kind === "identity_conflict");
});

test("does not issue DELETE after fence failure while alias reads are in flight", async () => {
  const { fetch, requests } = makeFetch();
  await assert.rejects(create(fetch).deleteCustomer(appUserId, async () => { throw new Error("stale fence"); }), /stale fence/u);
  assert.equal(requests.some(({ init }) => init?.method === "DELETE"), false);
});

test("classifies provider errors without copying response bodies", async () => {
  for (const status of [401, 403, 429, 503]) {
    const failing = makeFetch({ onRequest: async () => response({ secret: "do-not-leak" }, status) });
    await assert.rejects(create(failing.fetch).deleteCustomer(appUserId), (error: unknown) => {
      assert.ok(error instanceof RevenueCatCustomerDeletionError);
      assert.equal(error.stage, "search");
      assert.equal(error.status, status);
      assert.equal(error.message.includes("do-not-leak"), false);
      return true;
    });
  }
  const network = create(async () => { throw new Error("credential URL secret"); });
  await assert.rejects(network.deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.kind === "network" && !error.message.includes("secret"));
  const malformed = makeFetch({ onRequest: async () => response({ object: "not-list", items: [] }) });
  await assert.rejects(create(malformed.fetch).deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.kind === "invalid_response");
  const redirected = makeFetch({ onRequest: async () => response({}, 200, { redirected: true, url: "https://evil.example/" }) });
  await assert.rejects(create(redirected.fetch).deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.kind === "invalid_response");
});

test("rejects malformed delete acknowledgements and timeout safely", async () => {
  for (const body of [{ object: "customer", id: "other", deleted_at: 123 }, { object: "customer", id: customerId, deleted_at: "later" }]) {
    const bad = makeFetch({ deleteResponse: response(body) });
    await assert.rejects(create(bad.fetch).deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "delete" && error.kind === "invalid_response");
  }
  const never = create(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), { timeoutMs: 1 });
  await assert.rejects(never.deleteCustomer(appUserId), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.kind === "timeout");
});

test("does not allow live network traffic to fixture origins", async () => {
  assert.throws(() => createRevenueCatCustomerDeletionClient({ ...config, baseUrl }, {}), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "configuration");
  assert.throws(() => createRevenueCatCustomerDeletionClient({ ...config, baseUrl }, { allowTestFixtures: true }), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "configuration");
  assert.throws(() => createRevenueCatCustomerDeletionClient({ ...config, apiKey: " secret " }, { fetch: async () => response({}), allowTestFixtures: true }), (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "configuration");
});


test("keeps null as a compatible terminal value for search, aliases, and 404 verification", async () => {
  let searches = 0;
  const fixture = makeFetch({ onRequest: async (url, init) => {
    if (url.includes("/aliases")) return response(aliasesPage([appUserId], null));
    if (init?.method === "DELETE") return response({}, 404);
    return response(search(++searches === 1 ? [customer()] : [], null));
  } });
  assert.deepEqual(await create(fixture.fetch).deleteCustomer(appUserId), { status: "absent" });
  assert.equal(fixture.requests.length, 4);
});

test("rejects present malformed or active search pagination before the delete fence", async () => {
  for (const next_page of [undefined, false, 0, {}, [], "", `${baseUrl}/v2/projects/${projectId}/customers?starting_after=next`]) {
    const fixture = makeFetch({ onRequest: async () => response({ object: "list", items: [], next_page }) });
    let fenced = false;
    await assert.rejects(create(fixture.fetch).deleteCustomer(appUserId, async () => { fenced = true; }),
      (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "search" && error.kind === "invalid_response");
    assert.equal(fixture.requests.length, 1);
    assert.equal(fenced, false);
  }
});

test("rejects malformed alias pagination and a foreign alias on the terminal omitted-field page", async () => {
  const path = `/v2/projects/${projectId}/customers/${customerId}/aliases`;
  const second = `${baseUrl}${path}?starting_after=page2&limit=100`;
  const unsafe = [undefined, false, 0, {}, [], "", "https://evil.example/page", `${baseUrl}/v2/projects/projOther/customers/${customerId}/aliases?starting_after=next`, `${baseUrl}${path}?foreign=next`, `${baseUrl}${path}#fragment`];
  for (const next_page of unsafe) {
    const fixture = makeFetch({ aliasPages: [{ object: "list", items: [{ object: "customer.alias", id: appUserId }], next_page }] });
    let fenced = false;
    await assert.rejects(create(fixture.fetch).deleteCustomer(appUserId, async () => { fenced = true; }),
      (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "aliases" && error.kind === "invalid_response");
    assert.equal(fenced, false);
    assert.equal(fixture.requests.some(({ init }) => init?.method === "DELETE"), false);
  }
  const foreign = makeFetch({ aliasPages: [aliasesPage([appUserId], second), aliasesPage(["another-account"])] });
  let fenced = false;
  await assert.rejects(create(foreign.fetch).deleteCustomer(appUserId, async () => { fenced = true; }),
    (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "aliases" && error.kind === "identity_conflict");
  assert.equal(foreign.requests.length, 3);
  assert.equal(fenced, false);
  assert.equal(foreign.requests.some(({ init }) => init?.method === "DELETE"), false);
});

test("rejects alias loops and excessive pages before deletion", async () => {
  const path = `${baseUrl}/v2/projects/${projectId}/customers/${customerId}/aliases`;
  for (const loop of [true, false]) {
    let page = 0;
    const fixture = makeFetch({ onRequest: async (url) => {
      if (!url.includes("/aliases")) return response(search([customer()]));
      page++;
      return response(aliasesPage([appUserId], `${path}?starting_after=${loop ? "loop" : page}&limit=100`));
    } });
    await assert.rejects(create(fixture.fetch).deleteCustomer(appUserId),
      (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "aliases" && error.kind === "invalid_response");
    assert.equal(page, loop ? 2 : 500);
    assert.equal(fixture.requests.some(({ init }) => init?.method === "DELETE"), false);
  }
});

test("never confirms absence after 404 from a malformed or incomplete verification page", async () => {
  for (const payload of [{ object: "list", items: [], next_page: false }, search([], "?starting_after=next"), { items: [] }]) {
    let searches = 0;
    const fixture = makeFetch({ onRequest: async (url, init) => {
      if (url.includes("/aliases")) return response(aliasesPage([appUserId]));
      if (init?.method === "DELETE") return response({}, 404);
      return response(++searches === 1 ? search([customer()]) : payload);
    } });
    await assert.rejects(create(fixture.fetch).deleteCustomer(appUserId),
      (error: unknown) => error instanceof RevenueCatCustomerDeletionError && error.stage === "verify_absence" && error.kind === "invalid_response");
    assert.equal(fixture.requests.filter(({ init }) => init?.method === "DELETE").length, 1);
  }
});
