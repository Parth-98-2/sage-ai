import { pool } from "../db/pool";
import { getEmbedder } from "../embeddings/embedder";
import { toSearchResult, type SearchRow } from "./repository";
import type { Retriever } from "./types";

const SNIPPET_WORDS = 40;

/**
 * Semantic retrieval over passages.
 *
 * Passages are ranked by exact cosine similarity between the query embedding
 * and each stored passage embedding for the current model. Both vectors are
 * L2-normalised, so cosine similarity is the dot product, summed in double
 * precision. Passages without an embedding for the model are not searched.
 * Filters and provenance match lexical retrieval.
 */
const SEMANTIC_SQL = `
WITH ranked AS (
  SELECT p.id, p.document_id, p.source_id, p.ordinal, p.text, p.char_start, p.char_end, p.token_count,
         (SELECT sum(a::float8 * b::float8) FROM unnest(e.embedding, $1::real[]) AS t(a, b)) AS score
  FROM passage_embeddings e
  JOIN passages p ON p.id = e.passage_id
  JOIN documents d ON d.id = p.document_id
  WHERE e.model = $2
    AND e.dimensions = cardinality($1::real[])
    AND d.status = 'ready'
    AND ($4::uuid IS NULL OR p.source_id = $4::uuid)
    AND ($3::uuid IS NULL OR EXISTS (
          SELECT 1 FROM source_people sp
          WHERE sp.source_id = p.source_id AND sp.person_id = $3::uuid
        ))
  ORDER BY score DESC, p.id ASC
  LIMIT $5
)
SELECT r.id AS passage_id,
       r.ordinal AS passage_ordinal,
       r.text AS passage_text,
       r.char_start AS passage_char_start,
       r.char_end AS passage_char_end,
       r.token_count AS passage_token_count,
       r.score,
       '' AS snippet,
       d.id AS document_id,
       d.ingestion_method AS document_ingestion_method,
       d.original_filename AS document_original_filename,
       d.source_url AS document_source_url,
       d.created_at AS document_created_at,
       s.id AS source_id,
       s.title AS source_title,
       s.source_type,
       s.external_url AS source_external_url,
       s.published_at AS source_published_at,
       people.people
FROM ranked r
JOIN documents d ON d.id = r.document_id
JOIN sources s ON s.id = r.source_id
CROSS JOIN LATERAL (
  SELECT COALESCE(
           json_agg(json_build_object('id', pe.id, 'name', pe.name, 'role', sp.role) ORDER BY sp.role, pe.name),
           '[]'::json
         ) AS people
  FROM source_people sp
  JOIN people pe ON pe.id = sp.person_id
  WHERE sp.source_id = r.source_id
) AS people
ORDER BY r.score DESC, r.id ASC
`;

/** Semantic matches have no highlighted terms, so the snippet is the passage's opening words. */
function leadingWords(text: string): string {
  const words = text.trim().split(/\s+/);
  const lead = words.slice(0, SNIPPET_WORDS).join(" ");
  return words.length > SNIPPET_WORDS ? `${lead} …` : lead;
}

export const searchPassagesSemantic: Retriever = async (params) => {
  const embedder = getEmbedder();
  const queryEmbedding = await embedder.embedQuery(params.q);

  const result = await pool.query<SearchRow>(SEMANTIC_SQL, [
    queryEmbedding,
    embedder.modelId,
    params.personId,
    params.sourceId,
    params.limit,
  ]);
  return result.rows.map((row) => ({ ...toSearchResult(row), snippet: leadingWords(row.passage_text) }));
};
