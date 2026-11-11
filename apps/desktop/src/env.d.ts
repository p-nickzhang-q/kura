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
  /** av = 番号制, video = 影视(剧集/动画/综艺/电影)。建库时落定, 不可改。 */
  domain: "av" | "video";
  /** false = 只索引, 不允许移动/改名/写 NFO。 */
  organizeEnabled?: boolean;
  /** 库根所在卷的指纹; null = 老库还没绑定, 下次扫描时补记。 */
  volumeId?: string | null;
  /** 库根目录当前打不开(盘拔了 / 换了盘 / 目录改名)。 */
  rootMissing?: boolean;
}

/** 影视条目: 集数角标 (声明/盘上)。 */
interface KuraEpisodeStats {
  declared: number;
  bound: number;
}

interface KuraEpisode {
  season: number;
  episode: number;
  title: string | null;
  airDate: string | null;
  runtimeMin: number | null;
  hasFile: boolean;
  /** 盘上有这一集, 但来源的集列表里没有 → 集号可能对不上。 */
  undeclared?: boolean;
}

/** 未识别页里"待绑定的目录" (一个目录 = 一部剧的候选)。 */
interface KuraBindableDir {
  /** 剧集 → 剧目录; 电影 → 那一个文件的路径。 */
  dir: string;
  name: string;
  files: number;
  parsed: number;
  seasons: number[];
  kind: "tv" | "movie" | "unknown";
  /** 绑定时会动到的文件。 */
  paths: string[];
  /** 来自"多文件无集号"的目录, 且名字像同一部剧的散集 —— 提示补集号而不是绑成电影。 */
  suspectSeries?: boolean;
}

/** 待办页: 便宜的那一批 (纯 SQL 计数)。 */
interface KuraTodoCounts {
  unparsedDirs: number;
  unparsedFiles: number;
  pendingScrape: number;
  pendingTranslate: number;
  organizeLibraries: number;
}

/** 待办页: 要读磁盘的那一批, 界面先画空再补。 */
interface KuraTodoPlans {
  organize: { move: number; writeNfo: number; copyImage: number; skip: number } | null;
  nfo: { created: number; written: number } | null;
  /** 盘上的 nfo 能直接给出身份、但库里还没绑定 —— 换电脑/换盘时不用重新刮。 */
  nfoRecover: { shows: number; movies: number; files: number } | null;
}

interface KuraUnrecognizedFile {
  path: string;
  name: string;
  season: number | null;
  episode: number | null;
  size: number;
}

/** 影视库未识别页的树节点: 一个目录 = 一部剧/一部电影/一个合集。 */
interface KuraUnrecognizedDir {
  dir: string;
  name: string;
  files: KuraUnrecognizedFile[];
  parsed: number;
  seasons: number[];
  kind: "tv" | "movie";
  year: string | null;
}

interface KuraBindingSuggestion {
  dir: string;
  name: string;
  files: number;
  parsed: number;
  kind: "tv" | "movie" | "unknown";
  paths: string[];
  query: string;
  year: string | null;
  hit: { key: string; title: string; year: string | null; id: number } | null;
  confidence: "high" | "medium" | "low" | "none";
  error?: string;
  /** 这条建议是按别名找到的(原搜索词 0 命中), 值是命中的那个别名。 */
  viaAlias?: string;
}

interface KuraBindManyResult {
  dir: string;
  key: string;
  ok: boolean;
  bound?: number;
  episodes?: number;
  stillUnparsed?: number;
  declared?: number;
  missing?: number;
  error?: string;
}

interface KuraTmdbHit {
  id: number;
  key: string;
  title: string;
  year: string | null;
  overview: string | null;
  score: number;
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
    auxiliary: number;
    nfoPending: number;
    retyped: number;
    /** 影视库的"候选目录"数 (一个目录 = 一部剧/电影)。av 库恒为 0。 */
    shows: number;
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
  /** av / movie / tv。 */
  domain?: "av" | "movie" | "tv";
  /** 影视条目才有: 集数角标。 */
  episodeStats?: KuraEpisodeStats;
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
  action: "move" | "write-nfo" | "copy-image" | "skip";
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
  skipped?: boolean;
  reason?: string;
  /** 影视库整理的人话提醒: 认不出集号、抢同一目标、没有缓存海报… */
  warnings?: string[];
  /** 搬空之后删掉的源目录。 */
  removedDirs?: string[];
  /** 源目录里还有东西、所以没删的。 */
  leftoverDirs?: { dir: string; files: string[] }[];
  /** 删掉的 Kura 自己生成的残留 (旧目录里的 poster.jpg / fanart.jpg / 集 nfo)。 */
  removedFiles?: string[];
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
    /** 刮削顺手把图存进本地缓存 (默认开)。 */
    saveImages: boolean;
    /** 找建议时让模型补别名 (默认开; 没配 LLM 时自动不生效)。 */
    suggestAliases: boolean;
    proxy: string;
    tmdbApiKey: string;
  };
  dmmConfigured: boolean;
  dmmFromEnv: boolean;
  tmdbConfigured: boolean;
  tmdbFromEnv: boolean;
}

interface KuraTmdbTest {
  ok: boolean;
  status: string;
  probe?: number;
  title?: string | null;
  originalTitle?: string | null;
  error?: string;
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
  addLibrary(domain?: "av" | "video"): Promise<KuraLibrary | null>;
  bindableDirs(
    libraryId?: number,
    paging?: { limit?: number; offset?: number; kind?: "tv" | "movie" },
  ): Promise<{ dirs: KuraBindableDir[]; total: number; tv: number; movie: number }>;
  tmdbSearch(kind: "tv" | "movie", query: string): Promise<KuraTmdbHit[]>;
  tmdbTest(probeId?: number): Promise<KuraTmdbTest>;
  /** `ai` = 对 0 命中的候选再问一次模型要别名(ADR 0010), 结果仍要过 TMDB 校验。 */
  tmdbSuggest(libraryId?: number, kind?: "tv" | "movie", dirs?: string[], ai?: boolean): Promise<{
    suggestions: KuraBindingSuggestion[];
    taskId: number | null;
    error: string | null;
    cancelled?: boolean;
  }>;
  onSuggestProgress(callback: (update: { index: number; total: number; dir: string }) => void): () => void;
  /** 整理的进度 (搬文件 + 写 nfo + 复制图片, 一条任务行)。 */
  onOrganizeProgress(callback: (update: { index: number; total: number; key: string }) => void): () => void;
  /** 绑定并刮削的进度 (一条任务行, 任务页能看到历史)。 */
  onBindProgress(callback: (update: { index: number; total: number; dir: string }) => void): () => void;
  bindMany(
    libraryId: number,
    items: { dir: string; key: string; paths?: string[] }[],
  ): Promise<{ results: KuraBindManyResult[]; taskId: number; cancelled?: boolean }>;
  unrecognizedDirs(libraryId?: number, limit?: number): Promise<{ dirs: KuraUnrecognizedDir[] }>;
  /** 修「文件搬走了、索引没跟上」: 干跑后弹确认, 确认才改索引; 不动视频文件。 */
  repairPaths(libraryId?: number): Promise<{
    dryRun: boolean;
    applied: boolean;
    repaired: { from: string; to: string; key: string | null; orphanNfo: string | null }[];
    missing: { path: string }[];
    ambiguous: { from: string; to: string }[];
  }>;
  /**
   * 换盘 / 目录改名: 把库根搬到一个新位置。
   * 只改索引路径的前缀, 不动磁盘; 没给 root 时弹目录选择框。
   */
  relocateLibrary(
    libraryId: number,
    root?: string,
  ): Promise<{
    cancelled: boolean;
    applied?: boolean;
    library: string;
    from: string;
    to: string;
    moved: number;
    missing: number;
    missingSample: string[];
  }>;
  /** 待办页的便宜数字 (SQL 计数)。 */
  todoCounts(libraryId?: number): Promise<KuraTodoCounts>;
  /** 待办页的贵数字 (要读磁盘: 整理计划 / nfo 差异)。 */
  todoPlans(libraryId?: number): Promise<KuraTodoPlans>;
  /**
   * 从盘上的 nfo 恢复影视库: 建条目 + 绑文件 + 补空字段。
   * 不带 apply 只干跑(数一数), 带 apply 时主进程会先弹确认。
   */
  recoverNfo(
    libraryId: number,
    apply?: boolean,
  ): Promise<{
    libraryId: number;
    dryRun: boolean;
    shows: number;
    movies: number;
    files: number;
    confirmed: boolean;
    done: { kind: "tv" | "movie"; key: string; target: string; files: number; title: string | null; created: boolean; episodes: number }[];
    noTmdbId: string[];
  }>;
  bindLocalDir(
    libraryId: number,
    dir: string,
    paths?: string[],
    title?: string,
    type?: "movie" | "tv",
  ): Promise<{ key: string; dir: string; kind: "movie" | "tv"; title: string; bound: number; deduped: boolean }>;
  bindDir(
    libraryId: number,
    dir: string,
    key: string,
    paths?: string[],
    season?: number,
  ): Promise<{ key: string; dir: string; bound: number; episodes: number; stillUnparsed: string[] }>;
  itemEpisodes(key: string): Promise<{ key: string; episodes: KuraEpisode[]; stats: KuraEpisodeStats }>;
  itemDirs(key: string): Promise<{ key: string; dirs: { dir: string; files: number; episodeFrom: number | null; episodeTo: number | null; season: number | null }[] }>;
  setDirSeason(libraryId: number, dir: string, season: number, key?: string): Promise<{ files: number; season: number }>;
  spreadSeasons(key: string, dir?: string): Promise<{ key: string; files: number; declared: number; mapped: number; unmapped: number; from: string; to: string }>;
  rebindItem(key: string, newKey: string): Promise<{ from: string; to: string; moved: number; scraped: { declared: number; bound: number; missing: number } | null }>;
  unbindItem(key: string): Promise<{ unbound: number }>;
  scrapeShow(key: string): Promise<{ key: string; ok: boolean; fields: string[]; episodes: number; declared: number; bound: number; missing: number; error?: string }>;
  scan(libraryId: number, options?: { force?: boolean }): Promise<KuraScanReport>;
  removeLibrary(libraryId: number): Promise<{ library: KuraLibrary; removedFiles: number; orphanItems: number }>;
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
  /** 自绘标题栏的窗口控制 (frame:false 之后系统按钮不存在了)。 */
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  toggleDevTools(): Promise<boolean>;
  onWindowState(callback: (state: { maximized: boolean }) => void): () => void;
  /** 打开位置: 文件不在盘上时 ok=false (索引比磁盘旧), 界面要说话而不是静默。 */
  revealFile(path: string): Promise<{ ok: boolean; path: string; reason?: "missing" }>;
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
  /**
   * 查 GitHub 最新 release 看有没有新版。只查不下载 —— 产物未签名,
   * 自动更新在 Windows 上每次都要点「仍要运行」, 所以下载交给人点发布页。
   */
  checkUpdate(): Promise<{
    current: string;
    latest: string | null;
    newer: boolean;
    url: string | null;
    publishedAt: string | null;
    error: string | null;
  }>;
  tasks(limit?: number): Promise<KuraTask[]>;
  stopTask(id: number): Promise<{ stopped: boolean; reason: string | null }>;
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
  cleanupLibrary(libraryId: number, apply: boolean): Promise<{
    dryRun: boolean;
    removedDirs: string[];
    removedFiles: string[];
    kept: { dir: string; files: string[] }[];
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
    saveImages?: boolean;
    suggestAliases?: boolean;
    tmdbApiKey?: string;
  }): Promise<{ settings: KuraConfig["settings"]; dmmConfigured: boolean; tmdbConfigured: boolean }>;
  testDmm(probe?: string): Promise<KuraDmmTest>;
  testLlm(): Promise<{ ok: boolean; model: string; endpoint: string; sample: string }>;
  onScanEvent(callback: (event: KuraScanEvent) => void): () => void;
}

// 这个文件不是模块 (没有 import/export), 所以直接用顶层 interface 合并即可;
// 用 declare global 需要文件本身是模块, 否则整个声明会被静默忽略。
interface Window {
  kura: KuraBridge;
}
