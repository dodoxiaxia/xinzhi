export type VerificationStatus = 'verified' | 'unverified' | 'not_applicable';
export type Quartile = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export interface JournalInput { journal?: string; cleanJournal?: string; name?: string; journalId?: string; issn?: string; eissn?: string; issns?: string[]; }
export interface OfficialMetricSource { label: string; url: string; kind: 'publisher_public' | 'clarivate_public' | 'authorized_jcr_export'; verifiedAt: string; }
export interface HistoricalReferenceSource { label: string; url: null; kind: 'user_reference'; checkedAt: string; status: 'historical_reference_unverified'; dataYear: number; releaseYear: number; scope: 'matched_site_journals_only'; }
export type MetricSource = OfficialMetricSource | HistoricalReferenceSource;
export interface HistoricalJournalReference { journalId: string; dataYear: number; releaseYear: number; category: string; quartile: Quartile; sources: string[]; checkedAt: string; status: 'historical_reference_unverified'; categoryCoverage: 'reference_single_category'; }
export interface JournalCategory { name: string; quartile: Quartile | null; rank: number | null; total: number | null; sources: string[]; verifiedAt: string; }
export interface JournalRecord {
  id: string; name: string; aliases: string[]; issns: string[]; identitySources: string[];
  kind: 'journal' | 'preprint' | 'conference' | 'news' | 'blog' | 'book' | 'collection' | 'unknown';
  jif: {status: VerificationStatus; value: number | null; year: number | null; sources: string[]; verifiedAt: string | null; reason: string};
  jcr: {status: VerificationStatus; dataYear: number | null; releaseYear: number | null; editionSources: string[]; categories: JournalCategory[]; categoryCoverage: 'complete' | 'publisher_reported' | 'unverified' | 'not_applicable'; reason: string};
}
export interface JournalRegistry {schemaVersion: 1; verifiedAt: string; notice: string; sources: Record<string, MetricSource>; journals: JournalRecord[]; historicalReferences?: HistoricalJournalReference[];}
export interface JournalMetricsAPI {
  resolve(input: string | JournalInput): JournalRecord | (Omit<JournalRecord, 'id' | 'aliases'> & {id: null});
  historicalReferences(input: string | JournalInput): HistoricalJournalReference[];
  compactText(input: string | JournalInput): string;
  detailText(input: string | JournalInput): string;
  renderBadge(input: string | JournalInput): string;
  renderDetails(input: string | JournalInput): string;
  create(registry?: JournalRegistry): JournalMetricsAPI;
}
declare global {interface Window {JOURNAL_METRICS: JournalRegistry; JournalMetrics: JournalMetricsAPI;}}
