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
  sources: KuraSourceInfo[];
}

interface KuraLibrary {
  id: number;
  name: string;
  root: string;
  template: string;
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
  settings: { dmm: { apiId: string; affiliateId: string } };
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

interface KuraBridge {
  info(): Promise<KuraAppInfo>;
  libraries(): Promise<KuraLibrary[]>;
  addLibrary(): Promise<KuraLibrary | null>;
  scan(libraryId: number): Promise<KuraScanReport>;
  scrapePending(limit?: number): Promise<KuraScrapeBatch>;
  items(limit?: number): Promise<KuraItem[]>;
  item(number: string): Promise<KuraItem | null>;
  organizePreview(libraryId: number): Promise<KuraOrganizeReport>;
  organizeApply(libraryId: number): Promise<KuraOrganizeReport>;
  configGet(): Promise<KuraConfig>;
  configSet(patch: { apiId?: string; affiliateId?: string }): Promise<{ settings: KuraConfig["settings"]; dmmConfigured: boolean }>;
  testDmm(probe?: string): Promise<KuraDmmTest>;
  onScanEvent(callback: (event: KuraScanEvent) => void): () => void;
}

declare global {
  interface Window {
    kura: KuraBridge;
  }
}
