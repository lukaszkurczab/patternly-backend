import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { RetentionPurgeService } from "../src/modules/retention-purge/service.js";

type Arguments = Readonly<{ project: string; database: string; execute: boolean; pageSize: number | undefined; maxDeletes: number | undefined }>;

async function main(): Promise<void> {
  try {
    const arguments_ = parseArguments(process.argv.slice(2));
    const app = getApps()[0] ?? initializeApp({ projectId: arguments_.project });
    const db = getFirestore(app, arguments_.database);
    const result = await new RetentionPurgeService(db).run({ execute: arguments_.execute, ...(arguments_.pageSize === undefined ? {} : { pageSize: arguments_.pageSize }), ...(arguments_.maxDeletes === undefined ? {} : { maxDeletes: arguments_.maxDeletes }) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    await db.terminate();
  } catch {
    process.stdout.write(`${JSON.stringify({ error: "retention_purge_failed" })}\n`);
    process.exitCode = 1;
  }
}

function parseArguments(values: readonly string[]): Arguments {
  let project: string | undefined;
  let database: string | undefined;
  let execute = false;
  let pageSize: number | undefined;
  let maxDeletes: number | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--execute") { execute = true; continue; }
    if (value === "--project") { project = values[++index]; continue; }
    if (value === "--database") { database = values[++index]; continue; }
    if (value === "--page-size") { pageSize = Number(values[++index]); continue; }
    if (value === "--max-deletes") { maxDeletes = Number(values[++index]); continue; }
    throw new Error("retention_purge_argument_invalid");
  }
  if (!project || !/^[a-z0-9-]+$/u.test(project) || !database || !(/^[A-Za-z0-9_-]+$/u.test(database) || database === "(default)")) throw new Error("retention_purge_target_required");
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000)) throw new Error("retention_purge_page_size_invalid");
  if (maxDeletes !== undefined && (!Number.isInteger(maxDeletes) || maxDeletes < 1 || maxDeletes > 1_000)) throw new Error("retention_purge_max_deletes_invalid");
  return Object.freeze({ project, database, execute, pageSize, maxDeletes });
}

void main();
