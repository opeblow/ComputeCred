import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

export interface SettlementRecord {
  id: number;
  chainKey: number;
  contractAddress: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  jobId: string;
  operator: string;
  buyer: string;
  gross: string;
  completedAt: string;
  status: string;
  retries: number;
  lastError: string | null;
  destTxHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProofStatusRow {
  status: string;
  count: number;
}

export class ReadStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (!existsSync(dbPath)) {
      throw new Error(`worker database not found at ${dbPath}`);
    }
    this.db = new DatabaseSync(dbPath, { readOnly: true });
  }

  close(): void {
    this.db.close();
  }

  health(): { settled: number; confirmed: number } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS settled,
           SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
         FROM jobs`
      )
      .get() as { settled: number; confirmed: number };
    return { settled: Number(row.settled), confirmed: Number(row.confirmed) };
  }

  settlements(
    opts: { operator?: string; status?: string; cursor?: number; limit?: number } = {}
  ): { records: SettlementRecord[]; nextCursor: number | null } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.operator) {
      where.push('operator = ?');
      params.push(opts.operator.toLowerCase());
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.cursor) {
      where.push('id < ?');
      params.push(opts.cursor);
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY id DESC LIMIT ${limit + 1}`;
    const rows = this.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const records = rows.slice(0, limit).map(mapRow);
    const nextCursor = hasMore && records.length > 0 ? records[records.length - 1]!.id : null;
    return { records, nextCursor };
  }

  proofStatus(opts: { operator?: string } = {}): ProofStatusRow[] {
    const where = opts.operator ? 'WHERE operator = ?' : '';
    const params = opts.operator ? [opts.operator.toLowerCase()] : [];
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM jobs ${where} GROUP BY status ORDER BY n DESC`)
      .all(...params) as unknown as Array<{ status: string; n: number }>;
    return rows.map((r) => ({ status: r.status, count: Number(r.n) }));
  }

  recentActivity(opts: { operator?: string; limit?: number } = {}): SettlementRecord[] {
    const where = opts.operator ? 'WHERE operator = ?' : '';
    const params = opts.operator ? [opts.operator.toLowerCase()] : [];
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY id DESC LIMIT ${limit}`)
      .all(...params) as unknown as Record<string, unknown>[];
    return rows.map(mapRow);
  }
}

function mapRow(r: Record<string, unknown>): SettlementRecord {
  return {
    id: Number(r.id),
    chainKey: Number(r.chain_key),
    contractAddress: String(r.contract_address),
    txHash: String(r.tx_hash),
    logIndex: Number(r.log_index),
    blockNumber: Number(r.block_number),
    jobId: String(r.job_id),
    operator: String(r.operator),
    buyer: String(r.buyer),
    gross: String(r.gross),
    completedAt: String(r.completed_at),
    status: String(r.status),
    retries: Number(r.retries),
    lastError: r.last_error == null ? null : String(r.last_error),
    destTxHash: r.dest_tx_hash == null ? null : String(r.dest_tx_hash),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}