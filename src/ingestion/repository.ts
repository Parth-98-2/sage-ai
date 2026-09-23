import { pool } from "../db/pool";
import type { DocumentRow, PassageRow } from "./types";

export interface DocumentWithPassages {
  document: DocumentRow;
  passages: PassageRow[];
}

export async function getDocumentWithPassages(documentId: string): Promise<DocumentWithPassages | null> {
  const documentResult = await pool.query<DocumentRow>(`SELECT * FROM documents WHERE id = $1`, [documentId]);
  const document = documentResult.rows[0];
  if (!document) return null;

  const passagesResult = await pool.query<PassageRow>(
    `SELECT id, document_id, source_id, ordinal, text, char_start, char_end, token_count, metadata, created_at
     FROM passages WHERE document_id = $1 ORDER BY ordinal ASC`,
    [documentId]
  );

  return { document, passages: passagesResult.rows };
}
