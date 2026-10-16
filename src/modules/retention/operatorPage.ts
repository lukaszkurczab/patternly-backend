import { FieldPath, type CollectionReference, type DocumentData, type QueryDocumentSnapshot } from "firebase-admin/firestore";

export type OperatorPageOptions = Readonly<{ cursor?: string | undefined; dueOnly?: boolean }>;
export type OperatorPageResult = Readonly<{ documents: readonly QueryDocumentSnapshot[]; truncated: boolean; nextCursor: string | null }>;

export function validateOperatorCursor(cursor: string | undefined, collection: string, dueOnly = false): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Object.keys(value).sort().join(",") !== "collection,dueOnly,id,v" || value.v !== 1 || value.collection !== collection || value.dueOnly !== dueOnly || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(value.id)) throw new Error();
    return value.id;
  } catch { throw new Error("operator_cursor_invalid"); }
}

/** Immutable document-ID order; bounded scans also continue through pages containing only expired records. */
export async function readOperatorPage(collection: CollectionReference, include: (data: DocumentData) => boolean, options: OperatorPageOptions = {}): Promise<OperatorPageResult> {
  let after = validateOperatorCursor(options.cursor, collection.id, options.dueOnly);
  const documents: QueryDocumentSnapshot[] = [];
  let scanned = 0;
  while (scanned < 500 && documents.length < 100) {
    let query = collection.orderBy(FieldPath.documentId()).limit(Math.min(100, 500 - scanned));
    if (after) query = query.startAfter(after);
    const page = await query.get();
    if (page.empty) return { documents, truncated: false, nextCursor: null };
    for (const document of page.docs) {
      after = document.id;
      scanned += 1;
      if (include(document.data())) documents.push(document);
      if (documents.length === 100) break;
    }
    if (page.size < 100 && after === page.docs.at(-1)?.id) return { documents, truncated: false, nextCursor: null };
  }
  const remaining = await collection.orderBy(FieldPath.documentId()).startAfter(after!).limit(1).get();
  const nextCursor = remaining.empty ? null : Buffer.from(JSON.stringify({ v: 1, collection: collection.id, dueOnly: options.dueOnly ?? false, id: after })).toString("base64url");
  return { documents, truncated: nextCursor !== null, nextCursor };
}
