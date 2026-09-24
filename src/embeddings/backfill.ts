import crypto from "node:crypto";
import { pool } from "../db/pool";
import type { Embedder } from "./embedder";

export interface BackfillSummary {
  model: string;
  /** Passages of ready documents, i.e. everything that should have an embedding. */
  eligible: number;
  /** Newly embedded passages. */
  embedded: number;
  /** Passages re-embedded because their text changed since they were embedded. */
  refreshed: number;
  /** Passages whose stored embedding is already current. */
  unchanged: number;
}

interface CandidateRow {
  id: string;
  text: string;
  stored_sha256: string | null;
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Embeds every passage of a ready document that has no current embedding for
 * `embedder.modelId`. Idempotent: an up-to-date passage is skipped, and a
 * passage whose text hash changed is re-embedded. Passages are embedded one
 * at a time, in id order, and are never modified.
 */
export async function embedMissingPassages(
  embedder: Embedder,
  onProgress?: (done: number, total: number) => void
): Promise<BackfillSummary> {
  const { rows } = await pool.query<CandidateRow>(
    `SELECT p.id, p.text, e.text_sha256 AS stored_sha256
     FROM passages p
     JOIN documents d ON d.id = p.document_id
     LEFT JOIN passage_embeddings e ON e.passage_id = p.id AND e.model = $1
     WHERE d.status = 'ready'
     ORDER BY p.id`,
    [embedder.modelId]
  );

  const summary: BackfillSummary = { model: embedder.modelId, eligible: rows.length, embedded: 0, refreshed: 0, unchanged: 0 };
  const pending = rows.filter((row) => row.stored_sha256 !== sha256(row.text));
  summary.unchanged = rows.length - pending.length;

  for (const [index, row] of pending.entries()) {
    const embedding = await embedder.embedDocument(row.text);
    if (embedding.length !== embedder.dimensions) {
      throw new Error(`passage ${row.id}: expected ${embedder.dimensions} dimensions, got ${embedding.length}`);
    }
    await pool.query(
      `INSERT INTO passage_embeddings (passage_id, model, dimensions, embedding, text_sha256)
       VALUES ($1, $2, $3, $4::real[], $5)
       ON CONFLICT (passage_id, model) DO UPDATE
         SET dimensions = EXCLUDED.dimensions,
             embedding = EXCLUDED.embedding,
             text_sha256 = EXCLUDED.text_sha256,
             created_at = now()`,
      [row.id, embedder.modelId, embedder.dimensions, embedding, sha256(row.text)]
    );
    if (row.stored_sha256 === null) summary.embedded++;
    else summary.refreshed++;
    onProgress?.(index + 1, pending.length);
  }

  return summary;
}
