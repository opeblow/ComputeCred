import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const JOB_STATUS = {
  DETECTED: 'detected',
  AWAITING_ATTESTATION: 'awaiting_attestation',
  PROOF_READY: 'proof_ready',
  SUBMITTING: 'submitting',
  SUBMITTED: 'submitted',
  CONFIRMED: 'confirmed',
  RETRYABLE_FAILURE: 'retryable_failure',
  TERMINAL_FAILURE: 'terminal_failure',
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export interface SettlementRow {
  chainKey: number;
  contractAddress: string;
  txHash: string;
  logIndex: number;
  jobId: string;
  operator: string;
  buyer: string;
  gross: string;
  completedAt: string;
  blockNumber: number;
}

export interface JobRecord {
  id: number;
  chainKey: number;
  contractAddress: string;
  txHash: string;
  logIndex: number;
  jobId: string;
  operator: string;
  buyer: string;
  gross: string;
  completedAt: string;
  blockNumber: number;
  status: JobStatus;
  proof: string | null;
  retries: number;
  lastError: string | null;
  destTxHash: string | null;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_key INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  operator TEXT NOT NULL,
  buyer TEXT NOT NULL,
  gross TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'detected',
  proof TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dest_tx_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chain_key, contract_address, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_operator ON jobs(status, operator, id);
CREATE INDEX IF NOT EXISTS idx_jobs_job_id ON jobs(job_id);
CREATE TABLE IF NOT EXISTS checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chain_key INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  from_block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class Store {
  private db: DatabaseSync;

  constructor(private readonly path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------------------------------------------------------------- scanning

  getCheckpoint(): { fromBlock: number } | null {
    const row = this.db.prepare('SELECT from_block, chain_key, contract_address FROM checkpoint WHERE id = 1').get() as
      | { from_block: number; chain_key: number; contract_address: string }
      | undefined;
    if (!row) return null;
    return { fromBlock: row.from_block };
  }

  /** Stores a scan chunk AND advances the durable checkpoint atomically. The checkpoint only ever
   * moves past blocks whose events are safely persisted, so a crash never loses a JobSettled
   * event — and a failed scan chunk leaves the checkpoint behind for the next poll to rescan
   * (INSERT OR IGNORE makes re-detection idempotent). */
  commitScan(rows: SettlementRow[], toBlock: number): void {
    this.tx(() => {
      this.insertSettlementsUnsafe(rows);
      this.db
        .prepare(
          `INSERT INTO checkpoint (id, chain_key, contract_address, from_block, updated_at)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET from_block = excluded.from_block, updated_at = excluded.updated_at`
        )
        .run(rows[0]?.chainKey ?? 0, rows[0]?.contractAddress ?? '', toBlock + 1, Date.now());
    });
  }

  private insertSettlementsUnsafe(rows: SettlementRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO jobs
         (chain_key, contract_address, tx_hash, log_index, block_number, job_id, operator, buyer,
          gross, completed_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'detected', ?, ?)`
    );
    const now = Date.now();
    for (const r of rows) {
      stmt.run(
        r.chainKey,
        r.contractAddress.toLowerCase(),
        r.txHash.toLowerCase(),
        r.logIndex,
        r.blockNumber,
        r.jobId.toLowerCase(),
        r.operator.toLowerCase(),
        r.buyer.toLowerCase(),
        r.gross,
        r.completedAt,
        now,
        now
      );
    }
  }

  // ---------------------------------------------------------------- state machine

  private cas(id: number, from: JobStatus, to: JobStatus, extra?: Partial<{ error: string | null; retries: number; dest: string | null }>): boolean {
    const fields = ['status = ?', 'updated_at = ?'];
    const values: Array<string | number | null> = [to, Date.now()];
    if (extra?.error !== undefined) {
      fields.push('last_error = ?');
      values.push(extra.error);
    }
    if (extra?.retries !== undefined) {
      fields.push('retries = ?');
      values.push(extra.retries);
    }
    if (extra?.dest !== undefined) {
      fields.push('dest_tx_hash = ?');
      values.push(extra.dest);
    }
    values.push(id, from);
    const res = this.db
      .prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ? AND status = ?`)
      .run(...values);
    return Number(res.changes) > 0;
  }

  claimToAwaiting(id: number): boolean {
    // Fresh detection OR reawakening a proof failure after its attestation window elapsed.
    if (this.cas(id, JOB_STATUS.DETECTED, JOB_STATUS.AWAITING_ATTESTATION)) return true;
    return this.cas(id, JOB_STATUS.RETRYABLE_FAILURE, JOB_STATUS.AWAITING_ATTESTATION);
  }

  claimToSubmitting(id: number): boolean {
    return this.cas(id, JOB_STATUS.PROOF_READY, JOB_STATUS.SUBMITTING);
  }

  setProofReady(id: number, proofJson: string): void {
    this.db
      .prepare('UPDATE jobs SET status = ?, proof = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(JOB_STATUS.PROOF_READY, proofJson, Date.now(), id, JOB_STATUS.AWAITING_ATTESTATION);
  }

  setSubmittingDest(id: number, destTxHash: string): void {
    this.cas(id, JOB_STATUS.SUBMITTING, JOB_STATUS.SUBMITTED, { dest: destTxHash });
  }

  /** Reconciliation found the on-chain result of a SUBMITTED job (revert or dropped tx): send it
   * back to proof_ready or park it. */
  resubmitJob(id: number, error: string, next: JobStatus): void {
    const row = this.db.prepare('SELECT retries FROM jobs WHERE id = ?').get(id) as { retries: number } | undefined;
    this.cas(id, JOB_STATUS.SUBMITTED, next, {
      error,
      retries: (row?.retries ?? 0) + 1,
    });
  }

  /** A broadcast failed. `next` is decided by the caller: proof_ready = resubmit later (transient),
   * retryable_failure / terminal_failure = park the job with the error for the operator + API. */
  submitFailed(id: number, error: string, next: JobStatus): void {
    const row = this.db.prepare('SELECT retries FROM jobs WHERE id = ?').get(id) as { retries: number } | undefined;
    this.cas(id, JOB_STATUS.SUBMITTING, next, {
      error,
      retries: (row?.retries ?? 0) + 1,
    });
  }

  markRetryable(id: number, error: string): void {
    const row = this.db.prepare('SELECT retries FROM jobs WHERE id = ?').get(id) as { retries: number } | undefined;
    this.cas(id, JOB_STATUS.AWAITING_ATTESTATION, JOB_STATUS.RETRYABLE_FAILURE, {
      error,
      retries: (row?.retries ?? 0) + 1,
    });
  }

  markTerminal(id: number, error: string): void {
    const row = this.db.prepare('SELECT retries FROM jobs WHERE id = ?').get(id) as { retries: number } | undefined;
    this.cas(id, JOB_STATUS.AWAITING_ATTESTATION, JOB_STATUS.TERMINAL_FAILURE, {
      error,
      retries: (row?.retries ?? 0) + 1,
    });
  }

  markConfirmed(id: number): void {
    this.db.prepare('UPDATE jobs SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?').run(
      JOB_STATUS.CONFIRMED,
      Date.now(),
      id
    );
  }

  /** Releases jobs stuck after a crash: a `submitting` job never reached a broadcast (no dest tx),
   * and a `submitted` job whose tx left the mempool is re-proved. */
  releaseStale(nowTs: number): number {
    const released = this.db
      .prepare("UPDATE jobs SET status = 'proof_ready', updated_at = ? WHERE status = 'submitting' AND dest_tx_hash IS NULL")
      .run(nowTs);
    const dropped = this.db
      .prepare("UPDATE jobs SET status = 'proof_ready', updated_at = ? WHERE status = 'submitted' AND dest_tx_hash IS NULL")
      .run(nowTs);
    return Number(released.changes) + Number(dropped.changes);
  }

  // ---------------------------------------------------------------- queries

  jobs(
    opts: { status?: JobStatus | JobStatus[]; operator?: string; limit?: number; offset?: number } = {}
  ): JobRecord[] {
    const statuses = opts.status ? (Array.isArray(opts.status) ? opts.status : [opts.status]) : null;
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (statuses && statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (opts.operator) {
      where.push('operator = ?');
      params.push(opts.operator.toLowerCase());
    }
    const limit = `${opts.limit ?? 50}`;
    const offset = `${opts.offset ?? 0}`;
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`;
    const rows = this.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as {
      status: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  /** Claims job rows for the given operator that still need proofs. */
  claimForProofing(operator: string, limit: number): number {
    return this.tx(() => {
      const rows = this.db
        .prepare(`SELECT id FROM jobs WHERE status = 'detected' AND operator = ? ORDER BY id ASC LIMIT ?`)
        .all(operator.toLowerCase(), limit) as { id: number }[];
      let n = 0;
      for (const r of rows) {
        if (this.claimToAwaiting(r.id)) n += 1;
      }
      return n;
    });
  }
}

function mapRow(r: Record<string, unknown>): JobRecord {
  return {
    id: Number(r.id),
    chainKey: Number(r.chain_key),
    contractAddress: String(r.contract_address),
    txHash: String(r.tx_hash),
    logIndex: Number(r.log_index),
    jobId: String(r.job_id),
    operator: String(r.operator),
    buyer: String(r.buyer),
    gross: String(r.gross),
    completedAt: String(r.completed_at),
    blockNumber: Number(r.block_number),
    status: r.status as JobStatus,
    proof: r.proof == null ? null : String(r.proof),
    retries: Number(r.retries),
    lastError: r.last_error == null ? null : String(r.last_error),
    destTxHash: r.dest_tx_hash == null ? null : String(r.dest_tx_hash),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function createStore(path: string): Store {
  return new Store(path);
}