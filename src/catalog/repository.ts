import { pool } from "../db/pool";
import type { PersonRow, SourceRow } from "../ingestion/types";
import type {
  DocumentSummaryRow,
  PersonWithRole,
  PersonWithSources,
  SourceWithDetails,
  SourceWithRole,
} from "./types";

async function getPersonById(personId: string): Promise<PersonRow | null> {
  const result = await pool.query<PersonRow>(
    `SELECT id, name, bio, aliases, created_at FROM people WHERE id = $1`,
    [personId]
  );
  return result.rows[0] ?? null;
}

async function listSourcesForPerson(personId: string): Promise<SourceWithRole[]> {
  const result = await pool.query<SourceWithRole>(
    `SELECT s.id, s.title, s.source_type, s.external_url, s.published_at, s.metadata, s.created_at, sp.role
     FROM sources s
     JOIN source_people sp ON sp.source_id = s.id
     WHERE sp.person_id = $1
     ORDER BY s.created_at DESC, s.title ASC`,
    [personId]
  );
  return result.rows;
}

export async function getPersonWithSources(personId: string): Promise<PersonWithSources | null> {
  const person = await getPersonById(personId);
  if (!person) return null;

  const sources = await listSourcesForPerson(personId);
  return { person, sources };
}

export async function getSourceById(sourceId: string): Promise<SourceRow | null> {
  const result = await pool.query<SourceRow>(
    `SELECT id, title, source_type, external_url, published_at, metadata, created_at
     FROM sources WHERE id = $1`,
    [sourceId]
  );
  return result.rows[0] ?? null;
}

async function listPeopleForSource(sourceId: string): Promise<PersonWithRole[]> {
  const result = await pool.query<PersonWithRole>(
    `SELECT p.id, p.name, p.bio, p.aliases, p.created_at, sp.role
     FROM people p
     JOIN source_people sp ON sp.person_id = p.id
     WHERE sp.source_id = $1
     ORDER BY sp.role ASC, p.name ASC`,
    [sourceId]
  );
  return result.rows;
}

export async function listDocumentSummariesForSource(sourceId: string): Promise<DocumentSummaryRow[]> {
  const result = await pool.query<DocumentSummaryRow>(
    `SELECT d.id, d.source_id, d.ingestion_method, d.original_filename, d.original_file_path,
            d.source_url, d.mime_type, d.checksum, d.status, d.error_message,
            d.created_at, d.updated_at,
            COUNT(p.id)::int AS passage_count
     FROM documents d
     LEFT JOIN passages p ON p.document_id = d.id
     WHERE d.source_id = $1
     GROUP BY d.id
     ORDER BY d.created_at DESC`,
    [sourceId]
  );
  return result.rows;
}

export async function getSourceWithDetails(sourceId: string): Promise<SourceWithDetails | null> {
  const source = await getSourceById(sourceId);
  if (!source) return null;

  const [people, documents] = await Promise.all([
    listPeopleForSource(sourceId),
    listDocumentSummariesForSource(sourceId),
  ]);

  return { source, people, documents };
}
