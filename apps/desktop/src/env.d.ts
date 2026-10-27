/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

interface KuraAppInfo {
  version: string;
  dataDir: string;
  dbFile: string;
  dbRuntime: "bun" | "node";
  schemaVersion: number;
  itemCount: number;
  electron: string;
  node: string;
}

interface KuraScanEvent {
  type: "file.added" | "file.updated" | "file.unchanged" | "file.removed";
  path: string;
  size?: number;
}

interface KuraScanReport {
  root: string;
  dryRun: boolean;
  counts: { added: number; updated: number; unchanged: number; removed: number };
  durationMs: number;
}

interface KuraBridge {
  info(): Promise<KuraAppInfo>;
  pickDir(): Promise<string | null>;
  scan(root: string, dryRun: boolean): Promise<KuraScanReport>;
  onScanEvent(callback: (event: KuraScanEvent) => void): () => void;
}

declare global {
  interface Window {
    kura: KuraBridge;
  }
}
