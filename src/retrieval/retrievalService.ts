import { ValidationError } from "../ingestion/types";
import { isUuid } from "../utils/uuid";
import { searchPassagesFullText } from "./repository";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_QUERY_LENGTH,
  MAX_SEARCH_LIMIT,
  type RawSearchParams,
  type SearchParams,
  type SearchResponse,
} from "./types";

function validateQuery(q: unknown): string {
  if (typeof q !== "string" || q.trim().length === 0) {
    throw new ValidationError("q is required");
  }
  const trimmed = q.trim();
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new ValidationError(`q must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  return trimmed;
}

function validateLimit(limit: unknown): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  const value = typeof limit === "string" && /^\d+$/.test(limit) ? Number(limit) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > MAX_SEARCH_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`);
  }
  return value;
}

function validateOptionalUuid(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !isUuid(value)) {
    throw new ValidationError(`${name} must be a valid UUID`);
  }
  return value;
}

function validate(raw: RawSearchParams): SearchParams {
  return {
    q: validateQuery(raw.q),
    limit: validateLimit(raw.limit),
    personId: validateOptionalUuid(raw.personId, "personId"),
    sourceId: validateOptionalUuid(raw.sourceId, "sourceId"),
  };
}

export async function searchPassages(raw: RawSearchParams): Promise<SearchResponse> {
  const params = validate(raw);
  const results = await searchPassagesFullText(params);
  return { query: params.q, results };
}
