import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { chunkText } from "./chunker";
import { normalizeText } from "./textNormalization";
import { DEFAULT_SPONSORS, planTranscript, type RemovedRange } from "./transcript";
import {
  ALLOWED_INGESTION_METHODS,
  ALLOWED_PERSON_ROLES,
  ALLOWED_SOURCE_TYPES,
  ValidationError,
  type DocumentRow,
  type IngestResult,
  type IngestTextInput,
  type IngestTranscriptInput,
  type PassageRow,
  type PersonRow,
  type SourceRow,
} from "./types";

interface ValidatedInput {
  rawText: string;
  personRole: string;
  externalUrl?: string;
  publishedAt?: string;
}

const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Treats a missing or blank optional field as absent. */
function optionalField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validatePublishedAt(value: string | undefined): string | undefined {
  const publishedAt = optionalField(value);
  if (publishedAt === undefined) return undefined;

  const match = DATE_REGEX.exec(publishedAt);
  const [year, month, day] = match ? match.slice(1).map(Number) : [];
  const date = match ? new Date(Date.UTC(year, month - 1, day)) : null;
  if (
    !date ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ValidationError("publishedAt must be a valid date in YYYY-MM-DD format");
  }
  return publishedAt;
}

function validateExternalUrl(value: string | undefined): string | undefined {
  const externalUrl = optionalField(value);
  if (externalUrl === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(externalUrl);
  } catch {
    throw new ValidationError("externalUrl must be a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("externalUrl must be a valid http(s) URL");
  }
  return externalUrl;
}

function validate(input: IngestTextInput): ValidatedInput {
  const rawText = normalizeText(input.rawText ?? "");
  if (rawText.trim().length === 0) {
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
  return {
    rawText,
    personRole,
    externalUrl: validateExternalUrl(input.externalUrl),
    publishedAt: validatePublishedAt(input.publishedAt),
  };
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

/**
 * Serialises ingestion of the same text into the same source for the rest of
 * the transaction, so concurrent identical uploads cannot both miss the
 * duplicate check and insert two documents.
 */
async function lockSourceChecksum(client: PoolClient, sourceId: string, checksum: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
    sourceId,
    checksum,
  ]);
}

async function findDocumentByChecksum(
  client: PoolClient,
  sourceId: string,
  checksum: string
): Promise<DocumentRow | null> {
  const result = await client.query<DocumentRow>(
    `SELECT id, source_id, ingestion_method, original_filename, original_file_path, source_url,
            mime_type, raw_text, checksum, status, error_message, created_at, updated_at
     FROM documents
     WHERE source_id = $1 AND checksum = $2
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [sourceId, checksum]
  );
  return result.rows[0] ?? null;
}

/** Serialises ingestion of the same text into any source, for content that is deduplicated across sources. */
async function lockChecksum(client: PoolClient, checksum: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('checksum:' || $1, 0))`, [checksum]);
}

/** The earliest document with this checksum in any source: the canonical ingestion of that text. */
async function findCanonicalDocument(client: PoolClient, checksum: string): Promise<DocumentRow | null> {
  const result = await client.query<DocumentRow>(
    `SELECT id, source_id, ingestion_method, original_filename, original_file_path, source_url,
            mime_type, raw_text, checksum, status, error_message, created_at, updated_at
     FROM documents
     WHERE checksum = $1
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [checksum]
  );
  return result.rows[0] ?? null;
}

async function getSource(client: PoolClient, sourceId: string): Promise<SourceRow> {
  const result = await client.query<SourceRow>(
    `SELECT id, title, source_type, external_url, published_at, metadata, created_at FROM sources WHERE id = $1`,
    [sourceId]
  );
  return result.rows[0];
}

/**
 * The person to report for an existing source without linking anyone new:
 * the requested person if already linked, otherwise the source's first
 * person with the requested role, otherwise its first person.
 */
async function existingSourcePerson(client: PoolClient, sourceId: string, name: string, role: string): Promise<PersonRow | null> {
  const result = await client.query<PersonRow>(
    `SELECT p.id, p.name, p.bio, p.aliases, p.created_at
     FROM source_people sp JOIN people p ON p.id = sp.person_id
     WHERE sp.source_id = $1
     ORDER BY (p.name = $2) DESC, (sp.role = $3) DESC, sp.role ASC, p.name ASC
     LIMIT 1`,
    [sourceId, name, role]
  );
  return result.rows[0] ?? null;
}

async function listPassages(client: PoolClient, documentId: string): Promise<PassageRow[]> {
  const result = await client.query<PassageRow>(
    `SELECT id, document_id, source_id, ordinal, text, char_start, char_end, token_count, metadata, created_at
     FROM passages WHERE document_id = $1 ORDER BY ordinal ASC`,
    [documentId]
  );
  return result.rows;
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

/** A passage to store: an exact slice of the document's raw_text, with optional metadata (e.g. transcript times). */
type PlannedPassage = ReturnType<typeof chunkText>[number] & { metadata?: Record<string, unknown> };

async function createPassages(
  client: PoolClient,
  documentId: string,
  sourceId: string,
  chunks: PlannedPassage[]
): Promise<PassageRow[]> {
  const rows: PassageRow[] = [];
  for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
    const chunk = chunks[ordinal];
    const result = await client.query<PassageRow>(
      `INSERT INTO passages (document_id, source_id, ordinal, text, char_start, char_end, token_count, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, document_id, source_id, ordinal, text, char_start, char_end, token_count, metadata, created_at`,
      [documentId, sourceId, ordinal, chunk.text, chunk.charStart, chunk.charEnd, chunk.tokenCount, JSON.stringify(chunk.metadata ?? {})]
    );
    rows.push(result.rows[0]);
  }
  return rows;
}

interface AdditionalPerson {
  name: string;
  role: string;
}

function validateAdditionalPeople(people: AdditionalPerson[] | undefined): AdditionalPerson[] {
  return (people ?? []).map(({ name, role }) => {
    if (!name || name.trim().length === 0) throw new ValidationError("every additional person needs a name");
    if (!(ALLOWED_PERSON_ROLES as readonly string[]).includes(role)) {
      throw new ValidationError(`personRole must be one of: ${ALLOWED_PERSON_ROLES.join(", ")}`);
    }
    return { name: name.trim(), role };
  });
}

/**
 * The shared ingestion transaction: resolves people and the source, then
 * stores the document and the passages `planPassages` cuts from its
 * normalised raw_text, idempotently per source: if the source already has a
 * document with the same checksum, that document and its passages are
 * returned with duplicate=true and nothing new is created. People links are
 * recorded either way.
 *
 * With dedupeAcrossSources, the checksum identifies the content wherever it
 * was stored: if any other source already has a document with it, that
 * original ingestion is returned unchanged (its title, metadata and people
 * links kept, nothing new created or linked) with duplicate=true.
 */
async function ingestDocument(
  input: IngestTextInput,
  additionalPeople: AdditionalPerson[],
  planPassages: (rawText: string) => PlannedPassage[],
  options: { dedupeAcrossSources?: boolean } = {}
): Promise<IngestResult> {
  const { rawText, personRole, externalUrl, publishedAt } = validate(input);
  const checksum = crypto.createHash("sha256").update(rawText).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (options.dedupeAcrossSources) {
      await lockChecksum(client, checksum);
      const canonical = await findCanonicalDocument(client, checksum);
      if (canonical) {
        const source = await getSource(client, canonical.source_id);
        // The same title and type is the same source: the per-source path below handles it as before.
        if (source.title !== input.suggestedTitle.trim() || source.source_type !== input.sourceType) {
          const person =
            (await existingSourcePerson(client, source.id, input.personName.trim(), personRole)) ??
            (await resolvePerson(client, input.personName.trim()));
          const passages = await listPassages(client, canonical.id);
          await client.query("COMMIT");
          return { person, source, document: canonical, passages, duplicate: true };
        }
      }
    }

    const person = await resolvePerson(client, input.personName.trim());
    const source = await resolveSource(
      client,
      input.suggestedTitle.trim(),
      input.sourceType,
      externalUrl,
      publishedAt
    );
    await linkSourcePerson(client, source.id, person.id, personRole);
    for (const extra of additionalPeople) {
      await linkSourcePerson(client, source.id, (await resolvePerson(client, extra.name)).id, extra.role);
    }

    await lockSourceChecksum(client, source.id, checksum);

    const existing = await findDocumentByChecksum(client, source.id, checksum);
    if (existing) {
      const passages = await listPassages(client, existing.id);
      await client.query("COMMIT");
      return { person, source, document: existing, passages, duplicate: true };
    }

    const document = await createDocument(client, {
      sourceId: source.id,
      ingestionMethod: input.ingestionMethod,
      rawText,
      checksum,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
    });

    const passages = await createPassages(client, document.id, source.id, planPassages(rawText));

    await client.query("COMMIT");
    return { person, source, document, passages, duplicate: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Ingests text idempotently per source (see ingestDocument), cutting passages with the standard chunker. */
export async function ingestText(input: IngestTextInput): Promise<IngestResult> {
  return ingestDocument(input, [], (rawText) => chunkText(rawText));
}

/**
 * Ingests a Founders-style podcast transcript (see transcript.ts). The whole
 * raw transcript, sponsor reads included, is stored as the document's
 * raw_text; passages cover only episode content, each with the transcript
 * times it spans in its metadata.
 *
 * The raw transcript's checksum is its identity: ingesting a transcript that
 * is already stored, under any title, returns the original ingestion with
 * duplicate=true and creates nothing (see ingestDocument).
 */
export async function ingestTranscript(input: IngestTranscriptInput): Promise<IngestResult & { removed: RemovedRange[] }> {
  const additionalPeople = validateAdditionalPeople(input.additionalPeople);
  const sponsors = input.sponsors ?? DEFAULT_SPONSORS;
  let removed: RemovedRange[] = [];
  const result = await ingestDocument(
    input,
    additionalPeople,
    (rawText) => {
      const plan = planTranscript(rawText, sponsors);
      removed = plan.removed;
      return plan.passages;
    },
    { dedupeAcrossSources: true }
  );
  // A duplicate was planned when first ingested; report what these rules remove from it now.
  if (result.duplicate) removed = planTranscript(result.document.raw_text, sponsors).removed;
  return { ...result, removed };
}
