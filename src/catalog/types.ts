import type { DocumentRow, PersonRow, SourceRow } from "../ingestion/types";

export interface SourceWithRole extends SourceRow {
  role: string;
}

export interface PersonWithRole extends PersonRow {
  role: string;
}

export type DocumentSummaryRow = Omit<DocumentRow, "raw_text"> & {
  passage_count: number;
};

export interface PersonWithSources {
  person: PersonRow;
  sources: SourceWithRole[];
}

export interface SourceWithDetails {
  source: SourceRow;
  people: PersonWithRole[];
  documents: DocumentSummaryRow[];
}
