import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { createStore as createWorkerStore, JOB_STATUS, type SettlementRow } from '../../worker/src/store';
import { ReadStore } from './store';

const OPERATOR = `0x${'11'.repeat(20)}`;
const OTHER = `0x${'22'.repeat(20)}`;

const row = (i: number, opts: Partial<SettlementRow> = {}): SettlementRow => ({
  chainKey: 1,
  contractAddress: `0x${'33'.repeat(20)}`,
  txHash: `0x${i.toString(16).padStart(64, '0')}`,
  logIndex: 0,
  jobId: `0x${i.toString(16).padStart(64, '0')}`,
  operator: i % 2 === 0 ? OPERATOR : OTHER,
  buyer: `0x${'44'.repeat(20)}`,
  gross: '1000000',
  completedAt: '1700000000',
  blockNumber: 1000 + i,
  ...opts,
});

function seed(file: string, n: number): void {
  const store = createWorkerStore(file);
  store.commitScan(Array.from({ length: n }, (_, i) => row(i)), 1000 + n);
  const ours = store.jobs({ operator: OPERATOR })[0]!;
  if (ours) store.markConfirmed(ours.id);
  store.close();
}

test('read store: filters settlements by operator and paginates by id cursor', () => {
  const file = join(tmpdir(), `cc-api-${Date.now()}.sqlite`);
  seed(file, 10);
  const store = new ReadStore(file);
  const mine = store.settlements({ operator: OPERATOR, cursor: undefined, limit: 50 });
  assert.equal(mine.records.length, 5);
  assert.ok(mine.records.every((r) => r.operator === OPERATOR));

  const page = store.settlements({ operator: OPERATOR, limit: 2 });
  assert.equal(page.records.length, 2);
  assert.ok(page.nextCursor !== null);
  const page2 = store.settlements({ operator: OPERATOR, cursor: page.nextCursor ?? undefined, limit: 50 });
  assert.equal(page2.records.length, 3);
  assert.equal(page2.nextCursor, null);
  store.close();
  cleanup(file);
});

test('read store: groups proof lifecycle statuses', () => {
  const file = join(tmpdir(), `cc-api-${Date.now()}.sqlite`);
  seed(file, 8);
  const store = new ReadStore(file);
  const counts = store.proofStatus({ operator: OPERATOR }).reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = r.count;
    return acc;
  }, {});
  assert.equal(counts[JOB_STATUS.DETECTED], 3); // 1 of 4 even-indexed confirmed
  assert.equal(counts[JOB_STATUS.CONFIRMED], 1);
  store.close();
  cleanup(file);
});

test('read store: health aggregates totals', () => {
  const file = join(tmpdir(), `cc-api-${Date.now()}.sqlite`);
  seed(file, 8);
  const store = new ReadStore(file);
  const h = store.health();
  assert.equal(h.settled, 8);
  assert.equal(h.confirmed, 1);
  store.close();
  cleanup(file);
});

function cleanup(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(file + suffix);
    } catch {
      // best-effort
    }
  }
}