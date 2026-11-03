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
  /** 开了翻译时, 还有多少条可以翻 (按钮上的数字)。 */
  pendingTranslation: number;
  /** 已翻译 / 待翻译; 没开翻译时为 null。 */
  translation: { translated: number; pending: number } | null;
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
  counts: {
    added: number;
    updated: number;
    unchanged: number;
    removed: number;
    unparsed: number;
    nfoPending: number;
    retyped: number;
  };
  durationMs: number;
}

interface KuraItem {
  number: string;
  key: string;
  /** 已缓存封面的本地 URL (kura-res://...); 没缓存为 null。 */
  coverUrl?: string | null;
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
  summary: { move: number; writeNfo: number; copyImage: number; skip: number };
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

interface KuraNfoSyncEntry {
  number: string;
  path: string;
  nfoPath: string;
  action: "import" | "write" | "create" | "skip";
  reason?: string;
  changed: string[];
  ok?: boolean;
  error?: string;
}

interface KuraTaskFailure {
  key: string;
  error: string;
  index: number;
}

interface KuraNfoSyncReport {
  dryRun: boolean;
  scanned: number;
  imported: number;
  written: number;
  created: number;
  skipped: number;
  errors: number;
  cancelled: boolean;
  entries: KuraNfoSyncEntry[];
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
  startedAt: number | null;
  finishedAt: number | null;
}

interface KuraBridge {
  info(): Promise<KuraAppInfo>;
  libraries(): Promise<KuraLibrary[]>;
  addLibrary(): Promise<KuraLibrary | null>;
  scan(libraryId: number, options?: { force?: boolean }): Promise<KuraScanReport>;
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
  translatePending(limit?: number): Promise<{
    count: number;
    cancelled: boolean;
    translated: number;
    failed: number;
    skipped: number;
    repaired?: number;
    reports: { key: string; translated: string[]; error?: string }[];
  }>;
  translateItems(keys: string[]): Promise<{
    count: number;
    cancelled: boolean;
    translated: number;
    failed: number;
    skipped: number;
    reports: { key: string; translated: string[]; error?: string }[];
  }>;
  cancelTranslate(): Promise<{ cancelled: boolean }>;
  onTranslateProgress(callback: (progress: { index: number; total: number; key: string; translated: string[]; error?: string }) => void): () => void;
  items(params?: {
    limit?: number;
    offset?: number;
    type?: string;
    actor?: string;
    libraryId?: number;
    q?: string;
    studio?: string;
    label?: string;
    series?: string;
    director?: string;
    tag?: string;
    state?: "unscraped" | "scraped" | "exhausted";
    sort?: { field: "updated" | "number" | "title" | "release" | "studio" | "duration"; desc?: boolean };
  }): Promise<{
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
  proxyTest(): Promise<{ configured: string; effective: string; reachable: string[] }>;
  itemFiles(key: string): Promise<{ path: string; size: number }[]>;
  retypeItem(
    key: string,
    contentType: string,
  ): Promise<{ from: string; to: string; item: KuraItem | null }>;
  retypeDetect(
    apply?: boolean,
  ): Promise<{ applied: boolean; changes: { number: string; from: string; to: string; hasTitle: boolean }[] }>;
  openDataDir(): Promise<{ dir: string }>;
  tasks(limit?: number): Promise<KuraTask[]>;
  retryTask(id: number, onlyFailed?: boolean): Promise<{ taskId: number; type: string; count: number }>;
  taskFailures(id: number, limit?: number): Promise<{ key: string; error: string; index: number }[]>;
  syncNfo(input?: {
    libraryId?: number;
    number?: string;
    numbers?: string[];
    apply?: boolean;
    includeUnscraped?: boolean;
    writeOnly?: boolean;
  }): Promise<KuraNfoSyncReport>;
  onNfoProgress(callback: (progress: { index: number; total: number; key: string; action: string }) => void): () => void;
  updateItem(input: { key: string; pin?: string[]; unpin?: string[] }): Promise<KuraItem>;
  scrapeKeys(keys: string[]): Promise<{
    taskId: number;
    total: number;
    cancelled: boolean;
    reports: { key: string; ok: boolean; filled: number; error?: string }[];
  }>;
  fetchPoster(key: string): Promise<{
    key: string;
    saved: string[];
    saveErrors: string[];
    poster: { path: string; size: number } | null;
    thumb: { path: string; size: number } | null;
  }>;
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
  testLlm(): Promise<{ ok: boolean; model: string; endpoint: string; sample: string }>;
  onScanEvent(callback: (event: KuraScanEvent) => void): () => void;
}

// 这个文件不是模块 (没有 import/export), 所以直接用顶层 interface 合并即可;
// 用 declare global 需要文件本身是模块, 否则整个声明会被静默忽略。
interface Window {
  kura: KuraBridge;
}
