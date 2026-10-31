/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

interface KuraSourceInfo {
  id: string;
  label: string;
  status: "ready" | "todo";
  missing: string[];
}

interface KuraAppInfo {
  version: string;
  dataDir: string;
  dbRuntime: "bun" | "node";
  schemaVersion: number;
  libraries: number;
  items: number;
  mediaFiles: number;
  fixturesDir: string | null;
  dmmConfigured: boolean;
  llmConfigured: boolean;
  translate: boolean;
  dimensions: { id: string; label: string; template: string; note?: string }[];
  sources: KuraSourceInfo[];
}

interface KuraLibrary {
  id: number;
  name: string;
  root: string;
  template: string;
  /** false = 只索引, 不允许移动/改名/写 NFO。 */
  organizeEnabled?: boolean;
}

interface KuraScanEvent {
  type: "file.added" | "file.updated" | "file.unchanged" | "file.removed" | "file.unparsed";
  path: string;
  number?: string | null;
}

interface KuraScanReport {
  libraryId: number;
  root: string;
  dryRun: boolean;
  counts: { added: number; updated: number; unchanged: number; removed: number; unparsed: number };
  durationMs: number;
}

interface KuraItem {
  number: string;
  key: string;
  content_type?: string;
  contentType: string;
  title?: string;
  plot?: string;
  release_date?: string;
  duration_min?: number;
  studio?: string;
  label?: string;
  series?: string;
  directors?: string[];
  actors?: string[];
  tags?: string[];
  poster_urls?: string[];
  fieldSources: Record<string, string>;
  pinned: string[];
}

interface KuraPlanEntry {
  action: "move" | "write-nfo" | "skip";
  from?: string;
  to?: string;
  reason?: string;
}

interface KuraPlan {
  libraryId: number;
  libraryRoot: string;
  entries: KuraPlanEntry[];
  summary: { move: number; writeNfo: number; skip: number };
}

interface KuraOrganizeReport {
  plan: KuraPlan;
  applied: { ok: boolean; error?: string }[] | null;
}

interface KuraScrapeBatch {
  count: number;
  reports: { key: string; ok: boolean; filled: number; error?: string }[];
}

interface KuraConfig {
  path: string;
  settings: {
    dmm: { apiId: string; affiliateId: string };
    llm: { baseUrl: string; apiKey: string; model: string };
    translate: boolean;
    proxy: string;
  };
  dmmConfigured: boolean;
  dmmFromEnv: boolean;
}

interface KuraDmmTest {
  ok: boolean;
  status: string;
  probe?: string;
  fields?: string[];
  missing?: string[];
  error?: string;
}

interface KuraTask {
  id: number;
  type: string;
  status: string;
  total: number;
  processed: number;
  failed: number;
  error: string | null;
  createdAt: number;
}

interface KuraBridge {
  info(): Promise<KuraAppInfo>;
  libraries(): Promise<KuraLibrary[]>;
  addLibrary(): Promise<KuraLibrary | null>;
  scan(libraryId: number): Promise<KuraScanReport>;
  renameLibrary(libraryId: number, name: string): Promise<KuraLibrary>;
  setLibraryTemplate(libraryId: number, dimension: string): Promise<KuraLibrary>;
  setLibraryOrganize(libraryId: number, enabled: boolean): Promise<KuraLibrary>;
  scrapePending(limit?: number): Promise<{
    total: number;
    cancelled: boolean;
    reports: { index: number; total: number; key: string; ok: boolean; filled: number; error?: string }[];
  }>;
  cancelScrape(): Promise<{ cancelled: boolean }>;
  onScrapeProgress(callback: (progress: { index: number; total: number; key: string; ok: boolean; filled: number; error?: string }) => void): () => void;
  items(params?: { limit?: number; offset?: number; type?: string; actor?: string }): Promise<{
    items: KuraItem[];
    total: number;
    pending: number;
    exhausted: number;
  }>;
  item(number: string): Promise<KuraItem | null>;
  unparsedFiles(params?: { libraryId?: number; limit?: number; offset?: number }): Promise<{
    files: { path: string; number: string | null; libraryId: number; size: number }[];
    total: number;
  }>;
  revealFile(path: string): Promise<boolean>;
  tasks(limit?: number): Promise<KuraTask[]>;
  retryTask(id: number): Promise<KuraTask>;
  updateItem(input: { key: string; pin?: string[]; unpin?: string[] }): Promise<KuraItem>;
  scrapeKeys(keys: string[]): Promise<{ count: number; results: { key: string; ok: boolean; filled: number; error?: string }[] }>;
  fetchPoster(key: string): Promise<{ key: string; path: string; size: number }>;
  organizePreview(libraryId: number): Promise<KuraOrganizeReport>;
  organizeApply(libraryId: number): Promise<KuraOrganizeReport>;
  configGet(): Promise<KuraConfig>;
  configSet(patch: {
    apiId?: string;
    affiliateId?: string;
    proxy?: string;
    llmBaseUrl?: string;
    llmApiKey?: string;
    llmModel?: string;
    translate?: boolean;
  }): Promise<{ settings: KuraConfig["settings"]; dmmConfigured: boolean }>;
  testDmm(probe?: string): Promise<KuraDmmTest>;
  onScanEvent(callback: (event: KuraScanEvent) => void): () => void;
}

declare global {
  interface Window {
    kura: KuraBridge;
  }
}
