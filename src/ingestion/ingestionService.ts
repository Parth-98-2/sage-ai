import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { chunkText } from "./chunker";
import {
  ALLOWED_INGESTION_METHODS,
  ALLOWED_PERSON_ROLES,
  ALLOWED_SOURCE_TYPES,
  ValidationError,
  type DocumentRow,
  type IngestResult,
  type IngestTextInput,
  type PassageRow,
  type PersonRow,
  type SourceRow,
} from "./types";

function validate(input: IngestTextInput): { personRole: string } {
  if (!input.rawText || input.rawText.trim().length === 0) {
    throw new ValidationError("rawText must not be empty");
  }
  if (!input.personName || input.personName.trim().length === 0) {
    throw new ValidationError("personName is required");
  }
  if (!input.suggestedTitle || input.suggestedTitle.trim().length === 0) {
    throw new ValidationError("suggestedTitle is required");
  }
  if (!(ALLOWED_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) {
    throw new ValidationError(`sourceType must be one of: ${ALLOWED_SOURCE_TYPES.join(", ")}`);
  }
  const personRole = input.personRole ?? "author";
  if (!(ALLOWED_PERSON_ROLES as readonly string[]).includes(personRole)) {
    throw new ValidationError(`personRole must be one of: ${ALLOWED_PERSON_ROLES.join(", ")}`);
  }
  if (!(ALLOWED_INGESTION_METHODS as readonly string[]).includes(input.ingestionMethod)) {
    throw new ValidationError(`ingestionMethod must be one of: ${ALLOWED_INGESTION_METHODS.join(", ")}`);
  }
  return { personRole };
}

async function resolvePerson(client: PoolClient, name: string): Promise<PersonRow> {
  const result = await client.query<PersonRow>(
    `INSERT INTO people (name)
     VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, bio, aliases, created_at`,
    [name]
  );
  return result.rows[0];
}

async function resolveSource(
  client: PoolClient,
  title: string,
  sourceType: string,
  externalUrl: string | undefined,
  publishedAt: string | undefined
): Promise<SourceRow> {
  const result = await client.query<SourceRow>(
    `INSERT INTO sources (title, source_type, external_url, published_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (title, source_type) DO UPDATE SET title = EXCLUDED.title
     RETURNING id, title, source_type, external_url, published_at, metadata, created_at`,
    [title, sourceType, externalUrl ?? null, publishedAt ?? null]
  );
  return result.rows[0];
}

async function linkSourcePerson(
  client: PoolClient,
  sourceId: string,
  personId: string,
  role: string
): Promise<void> {
  await client.query(
    `INSERT INTO source_people (source_id, person_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (source_id, person_id, role) DO NOTHING`,
    [sourceId, personId, role]
  );
}

async function createDocument(
  client: PoolClient,
  params: {
    sourceId: string;
    ingestionMethod: string;
    rawText: string;
    checksum: string;
    originalFilename?: string;
    mimeType?: string;
  }
): Promise<DocumentRow> {
  const result = await client.query<DocumentRow>(
    `INSERT INTO documents (source_id, ingestion_method, original_filename, mime_type, raw_text, checksum, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'ready')
     RETURNING id, source_id, ingestion_method, original_filename, original_file_path, source_url,
               mime_type, raw_text, checksum, status, error_message, created_at, updated_at`,
    [
      params.sourceId,
      params.ingestionMethod,
      params.originalFilename ?? null,
      params.mimeType ?? null,
      params.rawText,
      params.checksum,
    ]
  );
  return result.rows[0];
}

async function createPassages(
  client: PoolClient,
  documentId: string,
  sourceId: string,
  chunks: ReturnType<typeof chunkText>
): Promise<PassageRow[]> {
  const rows: PassageRow[] = [];
  for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
    const chunk = chunks[ordinal];
    const result = await client.query<PassageRow>(
      `INSERT INTO passages (document_id, source_id, ordinal, text, char_start, char_end, token_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, document_id, source_id, ordinal, text, char_start, char_end, token_count, metadata, created_at`,
      [documentId, sourceId, ordinal, chunk.text, chunk.charStart, chunk.charEnd, chunk.tokenCount]
    );
    rows.push(result.rows[0]);
  }
  return rows;
}

export async function ingestText(input: IngestTextInput): Promise<IngestResult> {
  const { personRole } = validate(input);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const person = await resolvePerson(client, input.personName.trim());
    const source = await resolveSource(
      client,
      input.suggestedTitle.trim(),
      input.sourceType,
      input.externalUrl,
      input.publishedAt
    );
    await linkSourcePerson(client, source.id, person.id, personRole);

    const checksum = crypto.createHash("sha256").update(input.rawText).digest("hex");
    const document = await createDocument(client, {
      sourceId: source.id,
      ingestionMethod: input.ingestionMethod,
      rawText: input.rawText,
      checksum,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
    });

    const chunks = chunkText(input.rawText);
    const passages = await createPassages(client, document.id, source.id, chunks);

    await client.query("COMMIT");
    return { person, source, document, passages };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
