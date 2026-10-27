/**
 * core 的公开面 = 唯一的稳定 API。
 * GUI、CLI、未来的 MCP server 都只从这里导入; 内部文件路径不属于契约, 可随时重排。
 */
export { AppError, EXIT, isRetryable } from "./exit";
export type { ExitCode } from "./exit";
export { openRuntime, withRuntime } from "./runtime";
export type { Runtime, RuntimeOptions } from "./runtime";
export { resolvePaths } from "./paths";
export type { Paths } from "./paths";
export { displayPath, scan } from "./tasks/scan";
export type { ScanEvent, ScanOptions, ScanReport } from "./tasks/scan";
export type { Db, DbInfo } from "./db/driver";
