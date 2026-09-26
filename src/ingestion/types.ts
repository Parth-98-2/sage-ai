export interface PersonRow {
  id: string;
  name: string;
  bio: string | null;
  aliases: string[] | null;
  created_at: string;
}

export interface SourceRow {
  id: string;
  title: string;
  source_type: string;
  external_url: string | null;
  published_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DocumentRow {
  id: string;
  source_id: string;
  ingestion_method: string;
  original_filename: string | null;
  original_file_path: string | null;
  source_url: string | null;
  mime_type: string | null;
  raw_text: string;
  checksum: string;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface PassageRow {
  id: string;
  document_id: string;
  source_id: string;
  ordinal: number;
  text: string;
  char_start: number;
  char_end: number;
  token_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export const ALLOWED_SOURCE_TYPES = [
  "book",
  "podcast",
  "essay",
  "interview",
  "article",
  "transcript",
  "other",
] as const;

export const ALLOWED_PERSON_ROLES = [
  "author",
  "host",
  "guest",
  "interviewee",
  "subject",
  "translator",
  "other",
] as const;

export const ALLOWED_INGESTION_METHODS = [
  "pdf_upload",
  "text_upload",
  "paste",
  "url_import",
] as const;

export interface IngestTextInput {
  rawText: string;
  suggestedTitle: string;
  sourceType: string;
  personName: string;
  personRole?: string;
  externalUrl?: string;
  publishedAt?: string;
  ingestionMethod: string;
  originalFilename?: string;
  mimeType?: string;
}

export interface IngestTranscriptInput extends IngestTextInput {
  /** People linked to the source besides personName, e.g. the episode's subject. */
  additionalPeople?: Array<{ name: string; role: string }>;
  /** Sponsor names whose reads are removed from passages; defaults to DEFAULT_SPONSORS. */
  sponsors?: string[];
}

export interface IngestResult {
  person: PersonRow;
  source: SourceRow;
  document: DocumentRow;
  passages: PassageRow[];
  /** True when an identical document already existed for the source and was returned instead. */
  duplicate: boolean;
}

export class ValidationError extends Error {}
