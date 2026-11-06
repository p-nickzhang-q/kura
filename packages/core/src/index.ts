/**
 * core 的公开面 = 唯一的稳定 API。
 * GUI、CLI、未来的 MCP server 都只从这里导入; 内部文件路径不属于契约。
 */
export { AppError, EXIT, exitCodeName, isRetryable } from "./exit";
export type { ExitCode } from "./exit";

export { openRuntime, withRuntime } from "./runtime";
export type { Runtime, RuntimeOptions } from "./runtime";
export { resolvePaths } from "./paths";
export { resolveLlm, resolveTmdbEnv, translateEnabled } from "./config";
export { AUTO_PROXY, EMPTY_SETTINGS, isDmmConfigured, loadSettings, maskSecret, maskSettings, proxyCandidates, resetProxyCache, resolveDmmEnv, resolveProxy, resolveProxyUrl, saveSettings, settingsPath } from "./config";
export type { ProbeOptions } from "./config";
export type { Settings } from "./config";
export type { Paths } from "./paths";
export type { Db, DbInfo } from "./db/driver";

export {
  CONTENT_TYPES,
  CONTENT_TYPE_LABEL,
  DOMAINS,
  DOMAIN_LABEL,
  LIBRARY_DOMAINS,
  LIBRARY_DOMAIN_LABEL,
  isDomain,
  isLibraryDomain,
} from "./domain/types";
export type { Domain, LibraryDomain } from "./domain/types";
export { chineseNumber, locateEpisode, locateMovie, parseEpisode, seasonFromDir, showDirOf } from "./domain/episodes";
export type { EpisodeInfo, EpisodeLocation } from "./domain/episodes";
export type {
  ContentType,
  FieldKey,
  FileInfo,
  ItemKey,
  Metadata,
  RawFields,
  SourceRecord,
} from "./domain/types";

export { DIMENSIONS, TEMPLATE_PLACEHOLDERS, dimensionTemplate, findDimension, templatePlaceholders, unknownPlaceholders } from "./domain/dimensions";
export type { Dimension } from "./domain/dimensions";

export { detectContentType, extractNumber, identify, isSiteKey, normalizeText, parseFileInfo, siteKey } from "./domain/identify";
export { aggregate, mergeWithPinned } from "./domain/aggregate";
export { applyPlan, buildNfo, buildPlan, escapeXml, renderTemplate, targetState } from "./domain/materialize";
export type { ApplyResult, Library, Plan, PlanEntry, PlanInput, TargetState } from "./domain/materialize";

export { defaultSources, DEFAULT_ROUTES, createRegistry, fixtureSource, routeFor } from "./sources";
export { buildUrl, createDmmSource, matchDmmItem, normalizeCode, toRawFields } from "./sources/dmm";
export { assertNotBlocked, assertNotLoginPage, createJavdbSource, parseDetail as parseJavdbDetail, parseSearch as parseJavdbSearch } from "./sources/javdb";
export {
  createTmdbClient,
  parseTmdbKey,
  redactKey,
  redactUrl,
  TMDB_BASE,
  toMovieFields,
  toSearchHits,
  toSeason,
  toShowFields,
} from "./sources/tmdb";
export type { TmdbClient, TmdbEnv, TmdbEpisode, TmdbSearchHit, TmdbSeason, TmdbShow } from "./sources/tmdb";
export { createJavbusSource, numberMatch, numberVariants, parseDetail, parseSearch, selectCandidateIndex } from "./sources/javbus";
export type { SearchCandidate } from "./sources/javbus";
export type { DmmEnv, DmmItem, DmmResponse } from "./sources/dmm";
export type { DefaultSourcesOptions, Registry, Source, SourceConfig, SourceContext } from "./sources";
export { HttpClient } from "./net/http";
export type { FetchInit, FetchLike, HttpClientOptions, RequestOptions } from "./net/http";

export { createLibrary, defaultTemplateFor, deleteLibrary, findLibrary, listLibraries, pinnedFields, renameLibrary, rowToMetadata, updateLibraryOrganize, updateLibraryTemplate } from "./db/rows";
export { actorIndexDrift, setItemActors } from "./db/actors";
export type { DeleteLibraryResult, ItemRow, MediaFileRow } from "./db/rows";

export { countFiles, filePhase, listFiles, scan } from "./tasks/scan";
export { countPendingShows, episodeStats, listEpisodes, pendingShowKeys, scrapeShow, scrapeShows, scrapeShowsTask } from "./tasks/scrape-show";
export type { EpisodeStats } from "./tasks/scrape-show";
export type { ScrapeShowOptions, ScrapeShowReport, ScrapeShowsOptions, ScrapeShowsResult } from "./tasks/scrape-show";
export { bindDirectory, rebindItem, countBindableDirs, countBindableKinds, listBindableDirs, setFileEpisode, unbindDirectory } from "./tasks/bind";
export type { BindableDir, BindResult, BindingSuggestion, RebindResult } from "./tasks/bind";
export { suggestBindings, suggestBindingsTask } from "./tasks/suggest";
export type { SuggestOptions } from "./tasks/suggest";
export { guessTitleFromDir, matchConfidence, normalizeTitle, searchableGuess } from "./domain/title-guess";
export type { MatchConfidence, TitleGuess } from "./domain/title-guess";
export { hasNetworkSource, mergeNfoFields, syncNfo, syncNfoTask } from "./tasks/nfo-sync";
export type { NfoSyncEntry, NfoSyncOptions, NfoSyncProgress, NfoSyncReport } from "./tasks/nfo-sync";
export { exportTvNfo, exportTvNfoTask, listTvShows } from "./tasks/nfo-tv";
export type { TvNfoEntry, TvNfoOptions, TvNfoReport } from "./tasks/nfo-tv";
export { mergeTvNfo, renderEpisodeNfo, renderTvShowNfo } from "./domain/nfo-tv";
export type { EpisodeNfoFields, TvShowNfoFields, TvNfoRoot } from "./domain/nfo-tv";
export { nfoPathFor, nfoToMetadata, parseNfo, readNfo, updateNfoContent } from "./domain/nfo";
export type { NfoFields, NfoUpdate } from "./domain/nfo";
export type { MediaFileView } from "./tasks/scan";
export type { ScanEvent, ScanOptions, ScanReport } from "./tasks/scan";

export { countExhausted, countItems, countPending, getItem, isItemSortField, listItems, MAX_SCRAPE_ATTEMPTS, pendingKeys, scrape, scrapeKeysTask, scrapePending, scrapePendingTask } from "./tasks/scrape";
export { countPendingTranslation, pendingTranslationKeys, translationStats, translateItem, repairTranslations, translateItemsTask, translatePending, translatePendingTask, type RepairReport, type TranslateBatchResult, type TranslateProgress } from "./tasks/translate";
export type { TranslateReport } from "./tasks/translate";
export { buildSystemPrompt, chatEndpoint, createTranslator, hasKana, needsTranslation, openTranslator, probeTranslator, TranslationCache } from "./llm/translate";
export type { LlmConfig, Translator } from "./llm/translate";
export type { ItemSort, ItemSortField, ItemView, ScrapeOptions, ScrapePendingOptions, ScrapePendingResult, ScrapeProgress, ScrapeReport, TaskScrapeOptions, TaskScrapeResult } from "./tasks/scrape";

export { detectRetypes, parseFieldList, parseListValue, retypeItem, updateItem } from "./tasks/item";
export type { RetypeCandidate, UpdateItemOptions } from "./tasks/item";

export {
  cachedPoster,
  cachedThumb,
  downloadPoster,
  downloadResource,
  findResource,
  findSidecarImages,
  placeImagesBesideVideo,
  refererFor,
  resourceDir,
} from "./tasks/resources";
export type { LocalResource, PosterDownloadResult } from "./tasks/resources";

export { cancelTask, createTask, deleteTask, finishTask, getTask, listTasks, markRunning, pruneTasks, recoverInterrupted, retryTask, runTask, taskFailures, updateProgress, TASK_KEEP } from "./tasks/queue";
export type { TaskFailure, TaskRow, TaskRun, TaskStatus } from "./tasks/queue";
export { redact, TaskLog, taskLogFiles } from "./observability/task-log";

export { organize } from "./tasks/organize";
export type { OrganizeOptions, OrganizeReport } from "./tasks/organize";
