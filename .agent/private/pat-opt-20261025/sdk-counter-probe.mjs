import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
const db = new Firestore({ projectId: 'demo-patternly-pat-opt-probe' });
const ref = db.collection('probe').doc(randomUUID());
let get = 0, getAll = 0, documents = 0;
try {
  await db.runTransaction(async transaction => {
    const observed = new Proxy(transaction, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'get' || property === 'getAll') return (...refs) => {
        if (property === 'get') get++; else { getAll++; documents += refs.length; }
        return Reflect.apply(value, target, refs);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.equal((await observed.get(ref)).exists, false);
    assert.equal((await observed.getAll(ref)).length, 1);
  });
  assert.deepEqual({ get, getAll, documents }, { get: 1, getAll: 1, documents: 1 });
  console.log(JSON.stringify({ stage: 'public-sdk-counter-probe', get, getAll, documents }));
} finally { await db.terminate(); }
