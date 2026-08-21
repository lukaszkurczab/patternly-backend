import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("Cloud Run container contract is immutable-image and non-root", async () => {
  const dockerfile = await readFile(resolve(process.cwd(), "Dockerfile"), "utf8");
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS build/u);
  assert.match(dockerfile, /npm ci --omit=dev/u);
  assert.match(dockerfile, /USER node/u);
  assert.match(dockerfile, /CMD \["node", "dist\/index\.js"\]/u);
  const cloudbuild = await readFile(resolve(process.cwd(), "cloudbuild.yaml"), "utf8");
  assert.match(cloudbuild, /\$\{COMMIT_SHA\}/u);
  assert.match(cloudbuild, /CLOUD_LOGGING_ONLY/u);
});
