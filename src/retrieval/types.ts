import type { DocumentRow, PassageRow, SourceRow } from "../ingestion/types";

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_QUERY_LENGTH = 500;

export const SEARCH_MODES = ["lexical", "semantic", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
export const DEFAULT_SEARCH_MODE: SearchMode = "lexical";

/** Unvalidated input, as received from the query string. */
export interface RawSearchParams {
  q?: unknown;
  limit?: unknown;
  personId?: unknown;
  sourceId?: unknown;
  /** Several sources: a comma-separated string or an array of UUIDs. Exclusive with sourceId. */
  sourceIds?: unknown;
  mode?: unknown;
}

export interface SearchParams {
  q: string;
  limit: number;
  personId: string | null;
  /** Restricts results to these sources (from sourceId or sourceIds); null means every source. */
  sourceIds: string[] | null;
  mode: SearchMode;
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
 * A retrieval strategy returns passages ranked best-first. Lexical
 * (full-text), semantic (embedding) and hybrid (fused) retrieval all satisfy
 * this contract; `score` is only comparable within one strategy.
 */
export type Retriever = (params: SearchParams) => Promise<SearchResult[]>;
