/**
 * core 的公开面 = 唯一的稳定 API。
 * GUI、CLI、未来的 MCP server 都只从这里导入; 内部文件路径不属于契约。
 */
export { AppError, EXIT, exitCodeName, isRetryable } from "./exit";
export type { ExitCode } from "./exit";

export { openRuntime, withRuntime } from "./runtime";
export type { Runtime, RuntimeOptions } from "./runtime";
export { resolvePaths } from "./paths";
export { resolveLlm, translateEnabled } from "./config";
export { AUTO_PROXY, EMPTY_SETTINGS, isDmmConfigured, loadSettings, maskSecret, maskSettings, proxyCandidates, resetProxyCache, resolveDmmEnv, resolveProxy, resolveProxyUrl, saveSettings, settingsPath } from "./config";
export type { ProbeOptions } from "./config";
export type { Settings } from "./config";
export type { Paths } from "./paths";
export type { Db, DbInfo } from "./db/driver";

export { CONTENT_TYPES, CONTENT_TYPE_LABEL } from "./domain/types";
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
export { createJavbusSource, numberMatch, numberVariants, parseDetail, parseSearch, selectCandidateIndex } from "./sources/javbus";
export type { SearchCandidate } from "./sources/javbus";
export type { DmmEnv, DmmItem, DmmResponse } from "./sources/dmm";
export type { DefaultSourcesOptions, Registry, Source, SourceConfig, SourceContext } from "./sources";
export { HttpClient } from "./net/http";
export type { FetchInit, FetchLike, HttpClientOptions, RequestOptions } from "./net/http";

export { createLibrary, findLibrary, listLibraries, pinnedFields, renameLibrary, rowToMetadata, updateLibraryOrganize, updateLibraryTemplate } from "./db/rows";
export type { ItemRow, MediaFileRow } from "./db/rows";

export { countFiles, filePhase, listFiles, scan } from "./tasks/scan";
export type { MediaFileView } from "./tasks/scan";
export type { ScanEvent, ScanOptions, ScanReport } from "./tasks/scan";

export { countExhausted, countItems, countPending, getItem, listItems, MAX_SCRAPE_ATTEMPTS, pendingKeys, scrape, scrapePending, scrapePendingTask } from "./tasks/scrape";
export { countPendingTranslation, pendingTranslationKeys, translationStats, translateItem, translatePending, type TranslateBatchResult, type TranslateProgress } from "./tasks/translate";
export type { TranslateReport } from "./tasks/translate";
export { buildSystemPrompt, chatEndpoint, createTranslator, hasKana, needsTranslation, openTranslator, probeTranslator, TranslationCache } from "./llm/translate";
export type { LlmConfig, Translator } from "./llm/translate";
export type { ItemView, ScrapeOptions, ScrapePendingOptions, ScrapePendingResult, ScrapeProgress, ScrapeReport, TaskScrapeOptions, TaskScrapeResult } from "./tasks/scrape";

export { parseFieldList, parseListValue, updateItem } from "./tasks/item";
export type { UpdateItemOptions } from "./tasks/item";

export { cachedPoster, cachedThumb, downloadPoster, downloadResource, findResource, findSidecarImages, refererFor, resourceDir } from "./tasks/resources";
export type { LocalResource, PosterDownloadResult } from "./tasks/resources";

export { cancelTask, createTask, finishTask, getTask, listTasks, markRunning, recoverInterrupted, retryTask, runTask, updateProgress } from "./tasks/queue";
export type { TaskRow, TaskRun, TaskStatus } from "./tasks/queue";
export { redact, TaskLog, taskLogFiles } from "./observability/task-log";

export { organize } from "./tasks/organize";
export type { OrganizeOptions, OrganizeReport } from "./tasks/organize";
