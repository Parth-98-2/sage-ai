import type { DocumentRow, PassageRow, SourceRow } from "../ingestion/types";

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_QUERY_LENGTH = 500;

/** Unvalidated input, as received from the query string. */
export interface RawSearchParams {
  q?: unknown;
  limit?: unknown;
  personId?: unknown;
  sourceId?: unknown;
}

export interface SearchParams {
  q: string;
  limit: number;
  personId: string | null;
  sourceId: string | null;
}

export interface SearchResultPerson {
  id: string;
  name: string;
  role: string;
}

export interface SearchResult {
  passage: Pick<PassageRow, "id" | "ordinal" | "text" | "char_start" | "char_end" | "token_count">;
  snippet: string;
  score: number;
  document: Pick<DocumentRow, "id" | "ingestion_method" | "original_filename" | "source_url" | "created_at">;
  source: Pick<SourceRow, "id" | "title" | "source_type" | "external_url" | "published_at">;
  people: SearchResultPerson[];
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

/**
 * A retrieval strategy returns passages ranked best-first. Full-text search
 * is the only implementation in V1; a semantic retriever can later satisfy
 * the same contract and be fused with it.
 */
export type Retriever = (params: SearchParams) => Promise<SearchResult[]>;
