import { pool } from "../db/pool";
import type { Retriever, SearchResult, SearchResultPerson } from "./types";

interface SearchRow {
  passage_id: string;
  passage_ordinal: number;
  passage_text: string;
  passage_char_start: number;
  passage_char_end: number;
  passage_token_count: number;
  score: number;
  snippet: string;
  document_id: string;
  document_ingestion_method: string;
  document_original_filename: string | null;
  document_source_url: string | null;
  document_created_at: string;
  source_id: string;
  source_title: string;
  source_type: string;
  source_external_url: string | null;
  source_published_at: string | null;
  people: SearchResultPerson[];
}

/**
 * Lexical retrieval over passages.
 *
 * The question is reduced to its stemmed, stopword-free lexemes, which are
 * OR-ed together so a passage matching any of them is a candidate and
 * ts_rank_cd favours passages with more matches. Each lexeme is quoted
 * (doubling quotes and backslashes, chr(92)) and cast directly to tsquery, so
 * it is neither re-stemmed nor interpreted as a tsquery operator. A
 * stopword-only question yields a NULL tsquery, which matches nothing.
 */
const SEARCH_SQL = `
WITH query AS (
  SELECT CASE
           WHEN cardinality(lexemes) = 0 THEN NULL
           ELSE array_to_string(
                  ARRAY(
                    SELECT '''' || replace(replace(lexeme, chr(92), chr(92) || chr(92)), '''', '''''') || ''''
                    FROM unnest(lexemes) AS lexeme
                  ),
                  ' | '
                )::tsquery
         END AS tsq
  FROM (SELECT tsvector_to_array(to_tsvector('english', $1)) AS lexemes) AS parsed
),
ranked AS (
  SELECT p.id, p.document_id, p.source_id, p.ordinal, p.text, p.char_start, p.char_end, p.token_count,
         ts_rank_cd(p.search_vector, query.tsq) AS score
  FROM passages p
  CROSS JOIN query
  JOIN documents d ON d.id = p.document_id
  WHERE p.search_vector @@ query.tsq
    AND d.status = 'ready'
    AND ($3::uuid IS NULL OR p.source_id = $3::uuid)
    AND ($2::uuid IS NULL OR EXISTS (
          SELECT 1 FROM source_people sp
          WHERE sp.source_id = p.source_id AND sp.person_id = $2::uuid
        ))
  ORDER BY score DESC, p.id ASC
  LIMIT $4
)
SELECT r.id AS passage_id,
       r.ordinal AS passage_ordinal,
       r.text AS passage_text,
       r.char_start AS passage_char_start,
       r.char_end AS passage_char_end,
       r.token_count AS passage_token_count,
       r.score,
       ts_headline('english', r.text, query.tsq,
                   'MaxFragments=2, MinWords=10, MaxWords=30, StartSel=**, StopSel=**') AS snippet,
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
CROSS JOIN query
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

function toSearchResult(row: SearchRow): SearchResult {
  return {
    passage: {
      id: row.passage_id,
      ordinal: row.passage_ordinal,
      text: row.passage_text,
      char_start: row.passage_char_start,
      char_end: row.passage_char_end,
      token_count: row.passage_token_count,
    },
    snippet: row.snippet,
    score: row.score,
    document: {
      id: row.document_id,
      ingestion_method: row.document_ingestion_method,
      original_filename: row.document_original_filename,
      source_url: row.document_source_url,
      created_at: row.document_created_at,
    },
    source: {
      id: row.source_id,
      title: row.source_title,
      source_type: row.source_type,
      external_url: row.source_external_url,
      published_at: row.source_published_at,
    },
    people: row.people,
  };
}

export const searchPassagesFullText: Retriever = async (params) => {
  const result = await pool.query<SearchRow>(SEARCH_SQL, [
    params.q,
    params.personId,
    params.sourceId,
    params.limit,
  ]);
  return result.rows.map(toSearchResult);
};
