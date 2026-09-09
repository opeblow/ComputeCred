import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { createStore, JOB_STATUS, type SettlementRow } from './store';

const row = (i: number, opts: Partial<SettlementRow> = {}): SettlementRow => ({
  chainKey: 1,
  contractAddress: `0x00000000000000000000000000000000000000${(i % 10).toString(16)}`,
  txHash: `0x${i.toString(16).padStart(64, '0')}`,
  logIndex: 1,
  jobId: `0x${i.toString(16).padStart(64, '0')}`,
  operator: `0x${'11'.repeat(20)}`,
  buyer: `0x${'22'.repeat(20)}`,
  gross: '1000000',
  completedAt: '1700000000',
  blockNumber: 1000 + i,
  ...opts,
});

test('store: deduplicates scans by (chain, contract, tx, logIndex)', () => {
  const store = createStore(':memory:');
  store.commitScan([row(1), row(2)], 1001);
  store.commitScan([row(2), row(3)], 1002); // row(2) is a rescan dup
  assert.equal(store.jobs({}).length, 3);
  store.close();
});

test('store: checkpoint only advances with a persisted scan chunk', () => {
  const store = createStore(':memory:');
  store.commitScan([row(1)], 1000);
  assert.equal(store.getCheckpoint()!.fromBlock, 1001);
  assert.equal(store.jobs({}).length, 1);
  store.close();
});

test('store: state machine transitions atomically (CAS protects double claims)', () => {
  const store = createStore(':memory:');
  store.commitScan([row(1)], 1000);
  const job = store.jobs({})[0]!;
  assert.equal(job.status, JOB_STATUS.DETECTED);

  assert.equal(store.claimToAwaiting(job.id), true);
  assert.equal(store.claimToAwaiting(job.id), false); // already claimed
  assert.equal(store.jobs({})[0]!.status, JOB_STATUS.AWAITING_ATTESTATION);

  store.setProofReady(job.id, '{"root":"0x"}');
  assert.equal(store.jobs({})[0]!.status, JOB_STATUS.PROOF_READY);

  assert.equal(store.claimToSubmitting(job.id), true);
  store.setSubmittingDest(job.id, `0x${'ab'.repeat(32)}`);
  assert.equal(store.jobs({})[0]!.status, JOB_STATUS.SUBMITTED);

  store.resubmitJob(job.id, 'dropped', JOB_STATUS.PROOF_READY);
  assert.equal(store.jobs({})[0]!.status, JOB_STATUS.PROOF_READY);
  assert.equal(store.jobs({})[0]!.retries, 1);
  store.close();
});

test('store: proof failures park with retry accounting and reawaken within budget', () => {
  const store = createStore(':memory:');
  store.commitScan([row(1)], 1000);
  const job = store.jobs({})[0]!;
  store.claimToAwaiting(job.id);
  store.markRetryable(job.id, 'attestation not ready');
  let j = store.jobs({})[0]!;
  assert.equal(j.status, JOB_STATUS.RETRYABLE_FAILURE);
  assert.equal(j.retries, 1);
  assert.equal(j.lastError, 'attestation not ready');

  store.claimToAwaiting(job.id); // reawaken
  store.markTerminal(job.id, 'permanent');
  j = store.jobs({})[0]!;
  assert.equal(j.status, JOB_STATUS.TERMINAL_FAILURE);
  assert.equal(j.retries, 2);
  store.close();
});

test('store: restart simulation loses nothing (events durably persisted, checkpoint intact)', () => {
  const dbPath = join(tmpdir(), `computecred-store-${Date.now()}.sqlite`);
  let store = createStore(dbPath);
  store.commitScan([row(1), row(2)], 2000);
  const job = store.jobs({})[0]!;
  store.claimToAwaiting(job.id);
  store.close();

  // Simulated restart: a fresh Store reads the same durable file.
  store = createStore(dbPath);
  assert.equal(store.jobs({}).length, 2);
  assert.equal(store.jobs({})[0]!.status, JOB_STATUS.AWAITING_ATTESTATION);
  assert.equal(store.getCheckpoint()!.fromBlock, 2001);
  store.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      // best-effort temp cleanup
    }
  }
});