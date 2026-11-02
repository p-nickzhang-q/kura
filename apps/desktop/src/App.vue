<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

const TYPE_LABEL: Record<string, string> = {
  censored: "有码",
  uncensored: "无码",
  fc2: "FC2",
  chinese: "国产",
  amateur: "素人",
  western: "欧美",
  anime: "动漫",
};

const FIELD_LABEL: Record<string, string> = {
  title: "标题",
  plot: "简介",
  release_date: "发行日期",
  duration_min: "时长(分钟)",
  studio: "片商",
  label: "厂牌",
  series: "系列",
  directors: "导演",
  actors: "演员",
  tags: "标签",
  poster_urls: "海报",
  cover_urls: "封面",
  thumb_urls: "缩略图",
};

const FIELDS = Object.keys(FIELD_LABEL);
/** 这三个字段存的是原始 URL, 详情里改显示"有没有缓存" */
const IMAGE_FIELDS = ["poster_urls", "cover_urls", "thumb_urls"];

const info = ref<KuraAppInfo | null>(null);
const libraries = ref<KuraLibrary[]>([]);
const selectedId = ref<number | null>(null);
const items = ref<KuraItem[]>([]);
const tab = ref<"items" | "unparsed" | "plan" | "tasks" | "settings">("items");
const busy = ref(false);
/** 启动/刷新过程中的错误, 直接显示在界面顶部 —— 白屏最不该让人去猜。 */
const errors = ref<string[]>([]);
const error = ref<string | null>(null);
const note = ref<string | null>(null);
const plan = ref<KuraPlan | null>(null);
const events = ref<KuraScanEvent[]>([]);
const confirmApply = ref(false);

const picked = ref<string[]>([]);
const page = ref(0);
/** 正在改名的库 id 与草稿 (Electron 的渲染进程没有 window.prompt, 只能自己做行内输入)。 */
const renamingId = ref<number | null>(null);
const renameDraft = ref("");
const renameInput = ref<HTMLInputElement | null>(null);
/** 页码输入框的草稿值: 输入过程中不立即跳页, 回车/失焦才跳。 */
const pageInput = ref("1");
const pageSize = 100;
const itemTotal = ref(0);
/** 当前生效的筛选条件。空对象 = 不过滤。键名与 core 的 listItems 选项一致。 */
type FilterKey = "q" | "actor" | "studio" | "label" | "series" | "director" | "tag" | "state";
const FILTERABLE_SINGLE: string[] = ["studio", "label", "series"];
const LIST_FIELDS: string[] = ["actors", "directors", "tags"];
const FILTER_LABEL: Record<FilterKey, string> = {
  q: "关键词",
  actor: "演员",
  studio: "片商",
  label: "厂牌",
  series: "系列",
  director: "导演",
  tag: "标签",
  state: "状态",
};
const filters = ref<Partial<Record<FilterKey, string>>>({});
/**
 * 列表排序。点表头切换: 第一次升序, 再点倒序, 第三次回到默认(按更新时间)。
 * 空值永远排最后 (core 里处理), 所以"未刮削"不会占满第一页。
 */
type SortField = "number" | "title" | "studio" | "release" | "duration" | "updated";
const sort = ref<{ field: SortField; desc: boolean } | null>(null);
const SORT_LABEL: Record<SortField, string> = {
  number: "番号",
  title: "标题",
  studio: "片商",
  release: "发行日期",
  duration: "时长",
  updated: "更新时间",
};
/** 表头点击: 升 → 降 → 取消。 */
function toggleSort(field: SortField): void {
  const current = sort.value;
  if (!current || current.field !== field) sort.value = { field, desc: false };
  else if (!current.desc) sort.value = { field, desc: true };
  else sort.value = null;
  page.value = 0;
  void refreshItems();
}

function sortState(field: SortField): "none" | "ascending" | "descending" {
  if (sort.value?.field !== field) return "none";
  return sort.value.desc ? "descending" : "ascending";
}
const hasFilters = computed(() => Object.keys(filters.value).length > 0);
/** 首次读库还没回来 —— 和"库里确实空"是两件事, 不能混成一个空状态。 */
const firstLoad = ref(true);
/** 长任务进度: 刮削与翻译共用一个进度条位置。 */
const taskProgress = computed(() => {
  const active = progress.value ?? translateProgress.value;
  if (!active || !active.total) return null;
  return { index: active.index, total: active.total };
});
const taskPercent = computed(() =>
  taskProgress.value ? Math.min(100, Math.round((taskProgress.value.index / taskProgress.value.total) * 100)) : 0,
);
const searchDraft = ref("");
/** 刷新请求的序号, 用来丢弃乱序返回的旧结果。 */
let refreshSeq = 0;
/** 遮罩里的大图地址; null = 没在放大。 */
const zoom = ref<string | null>(null);
const lightboxEl = ref<HTMLElement | null>(null);
watch(zoom, (value) => {
  if (value) void nextTick(() => lightboxEl.value?.focus());
});
const proxyTest = ref<{ configured: string; effective: string; reachable: string[] } | null>(null);
const llmTest = ref<{ ok: boolean; model: string; endpoint: string; sample: string } | null>(null);
const translateProgress = ref<{ index: number; total: number; key: string; error?: string } | null>(null);
const pendingTotal = ref(0);
const exhaustedTotal = ref(0);
const pageCount = computed(() => Math.max(1, Math.ceil(itemTotal.value / pageSize)));
const detail = ref<KuraItem | null>(null);
const dimension = ref("");
const unparsedFiles = ref<{ path: string; size: number; libraryId: number }[]>([]);
const unparsedCount = ref(0);
const unparsedPage = ref(0);
const unparsedPageSize = 100;
const progress = ref<{ index: number; total: number; key: string; ok: boolean } | null>(null);
const tasks = ref<KuraTask[]>([]);

const config = ref<KuraConfig | null>(null);
const apiIdInput = ref("");
const affiliateInput = ref("");
const proxyInput = ref("");
const llmBaseUrlInput = ref("");
const llmApiKeyInput = ref("");
const llmModelInput = ref("");
const translateOn = ref(false);
const dmmTest = ref<KuraDmmTest | null>(null);

let unsubscribe: (() => void) | null = null;
let unsubscribeProgress: (() => void) | null = null;
let unsubscribeTranslate: (() => void) | null = null;

const selected = computed(() => libraries.value.find((library) => library.id === selectedId.value) ?? null);

onMounted(async () => {
  // 渲染进程里的未捕获异常也显示出来 (以前只在 DevTools 里能看到)
  window.addEventListener("error", (event) => errors.value.push(`界面错误: ${event.message}`));
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    errors.value.push(`请求失败: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  unsubscribe = window.kura.onScanEvent((event) => {
    events.value = [event, ...events.value].slice(0, 200);
  });
  unsubscribeTranslate = window.kura.onTranslateProgress((update) => {
    translateProgress.value = { index: update.index, total: update.total, key: update.key, error: update.error };
  });
  unsubscribeProgress = window.kura.onScrapeProgress((update) => {
    progress.value = update;
    // 每 5 条刷一次当前页: 刮到的结果立刻可见, 又不会每条都去查库。
    if (update.index > 0 && update.index % 5 === 0) void refreshItems();
  });
  await refreshAll();
});

onUnmounted(() => {
  unsubscribe?.();
  unsubscribeProgress?.();
  unsubscribeTranslate?.();
});

/**
 * 一次刷新全部面板。
 *
 * 每个接口单独 try: 以前任意一个失败 (比如多了个新字段让后端算错) 会中断整条链,
 * 表现成"升级后数据全没了" —— 实际只是界面没渲染出来。
 */
async function refreshAll(): Promise<void> {
  const step = async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (err) {
      errors.value.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  errors.value = [];
  info.value = (await step("读取状态", () => window.kura.info())) ?? info.value;
  config.value = (await step("读取配置", () => window.kura.configGet())) ?? config.value;
  translateOn.value = config.value?.settings.translate ?? false;
  libraries.value = (await step("读取媒体库", () => window.kura.libraries())) ?? libraries.value;
  if (selectedId.value === null && libraries.value[0]) selectedId.value = libraries.value[0].id;
  await step("读取条目", () => refreshItems());
  await step("读取未识别文件", () => refreshUnparsed());
  tasks.value = (await step("读取任务", () => window.kura.tasks(20))) ?? tasks.value;
  // 把当前模板反查成维度, 让下拉框显示"现在是什么"
  const current = libraries.value.find((library) => library.id === selectedId.value);
  const matched = info.value?.dimensions.find((item) => item.template === current?.template);
  dimension.value = matched?.id ?? "";
  // 选中项里可能有已经被删掉的条目
  picked.value = picked.value.filter((key) => items.value.some((item) => item.key === key));
  if (detail.value) detail.value = await window.kura.item(detail.value.key);
}

async function refreshUnparsed(): Promise<void> {
  const result = await window.kura.unparsedFiles({
    libraryId: selectedId.value ?? undefined,
    limit: unparsedPageSize,
    offset: unparsedPage.value * unparsedPageSize,
  });
  unparsedFiles.value = result.files;
  unparsedCount.value = result.total;
}

async function goUnparsedPage(next: number): Promise<void> {
  const pages = Math.max(1, Math.ceil(unparsedCount.value / unparsedPageSize));
  unparsedPage.value = Math.min(Math.max(next, 0), pages - 1);
  await refreshUnparsed();
}

async function copyPath(path: string): Promise<void> {
  await navigator.clipboard.writeText(path);
  note.value = "路径已复制";
}

async function reveal(path: string): Promise<void> {
  await window.kura.revealFile(path);
}

/** 详情里打开"这一部在磁盘上的位置"。库里没登记文件时给个明确的说法。 */
async function revealItem(): Promise<void> {
  const key = detail.value?.key;
  if (!key) return;
  const files = await window.kura.itemFiles(key);
  if (files.length === 0) {
    note.value = `${key} 还没有登记到任何文件`;
    return;
  }
  await reveal(files[0]!.path);
}

async function refreshItems(): Promise<void> {
  // 每次请求带一个序号: 刮削时进度会频繁触发刷新, 早发出的请求可能晚回来,
  // 用旧数据覆盖新数据 (页码突然只剩一页就是这么来的)。
  const seq = ++refreshSeq;
  const result = await window.kura.items({
    ...filters.value,
    // 侧栏选中哪个库, 列表就只看哪个库 —— 否则"共 3883 条"与"扫描只扫一个库"互相矛盾
    libraryId: selectedId.value ?? undefined,
    // filters 里的值是 string 宽类型, 这里收窄回 IPC 契约上的枚举
    state: filters.value.state as "unscraped" | "scraped" | "exhausted" | undefined,
    sort: sort.value ? { ...sort.value } : undefined,
    limit: pageSize,
    offset: page.value * pageSize,
  });
  if (seq !== refreshSeq) return;

  firstLoad.value = false;
  items.value = result.items;
  itemTotal.value = result.total;
  pendingTotal.value = result.pending;
  exhaustedTotal.value = result.exhausted;

  // 总数变少 (筛选、刮削后条目合并等) 时, 停在越界的页码上会看到空列表
  if (page.value > pageCount.value - 1) {
    page.value = pageCount.value - 1;
    pageInput.value = String(page.value + 1);
    if (items.value.length === 0) void refreshItems();
    return;
  }
  pageInput.value = String(page.value + 1);
}

async function jumpToPage(): Promise<void> {
  const target = Number(pageInput.value);
  if (!Number.isFinite(target)) {
    pageInput.value = String(page.value + 1);
    return;
  }
  await goPage(Math.round(target) - 1);
}

/**
 * 列表里的标题: 去掉开头的番号。
 *
 * 来源站给的标题常是「MIMK-182 住院期间…」, 但番号在左边那一列已经写了一遍,
 * 标题列又最缺宽度, 重复的这九个字符不如让给正文。
 */
function displayTitle(item: KuraItem): string {
  if (!item.title) return "未刮削";
  const escaped = item.number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = item.title.replace(new RegExp(`^${escaped}[\\s:：\\-–—|]*`, "i"), "");
  // 标题如果就是番号本身 (没刮到真标题), 别把它清成空
  return stripped || item.title;
}

/** 侧栏库名与路径重复时不显示路径 (库里叫"#整理完成", 路径尾巴也是它)。 */
function showRoot(library: KuraLibrary): boolean {
  const tail = library.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return tail.toLowerCase() !== library.name.toLowerCase();
}

/** 筛选条上的值展示: state 存的是英文枚举, 展示要给人看。 */
function filterText(key: FilterKey, value: string): string {
  if (key !== "state") return value;
  return { unscraped: "未刮削", scraped: "已刮削", exhausted: "已达上限" }[value] ?? value;
}

/** 点同一个值第二次就取消该条件。 */
async function applyFilter(key: FilterKey, value: string): Promise<void> {
  if (!value) return;
  if (filters.value[key] === value) delete filters.value[key];
  else filters.value[key] = value;
  page.value = 0;
  await refreshItems();
}

/** 输入即搜, 但压到 300ms 一次 —— 边打字边查库会让列表一直闪。 */
let searchTimer: ReturnType<typeof setTimeout> | null = null;
function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void applySearch();
  }, 300);
}

async function applySearch(): Promise<void> {
  const q = searchDraft.value.trim();
  if (q) filters.value.q = q;
  else delete filters.value.q;
  page.value = 0;
  await refreshItems();
}

async function clearFilters(): Promise<void> {
  filters.value = {};
  searchDraft.value = "";
  page.value = 0;
  await refreshItems();
}



async function goPage(next: number): Promise<void> {
  page.value = Math.min(Math.max(next, 0), pageCount.value - 1);
  pageInput.value = String(page.value + 1);
  await refreshItems();
}

async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  busy.value = true;
  error.value = null;
  note.value = null;
  try {
    return await fn();
  } catch (err) {
    error.value = `${label}失败: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  } finally {
    busy.value = false;
  }
}

function startRename(library: KuraLibrary): void {
  renamingId.value = library.id;
  renameDraft.value = library.name;
  void nextTick(() => renameInput.value?.select());
}

function cancelRename(): void {
  renamingId.value = null;
  renameDraft.value = "";
}

async function commitRename(library: KuraLibrary): Promise<void> {
  // 回车和失焦会连发, 第二次进来时 renamingId 已经清空, 直接忽略
  if (renamingId.value !== library.id) return;
  const name = renameDraft.value.trim();
  renamingId.value = null;
  if (!name || name === library.name) return;

  const updated = await run("改名", () => window.kura.renameLibrary(library.id, name));
  if (updated) {
    await refreshAll();
    note.value = `已改名为 ${updated.name}`;
  }
}

async function addLibrary(): Promise<void> {
  const library = await run("添加媒体库", () => window.kura.addLibrary());
  if (library) {
    await refreshAll();
    selectedId.value = library.id;
    note.value = `已添加 ${library.name}`;
  }
}

/** 切换范围: 列表、未识别、计数都跟着变。 */
function selectLibrary(id: number | null): void {
  selectedId.value = id;
  page.value = 0;
  picked.value = [];
  detail.value = null;
  void onScopeChange();
}

async function onScopeChange(): Promise<void> {
  page.value = 0;
  picked.value = [];
  detail.value = null;
  await refreshItems();
  await refreshUnparsed();
}

/** 扫描。`force` 用于"确实删了很多文件"的场景 —— 平时走安全阀保护。 */
async function scanLibrary(force: boolean): Promise<void> {
  // 选中"全部库"时挨个扫: 用户看到的是"全库", 扫一半就成了另一个 bug
  if (selectedId.value === null) {
    const targets = [...libraries.value];
    if (targets.length === 0) return;
    const reports: { name: string; counts: KuraScanReport["counts"] }[] = [];
    for (const library of targets) {
      const report = await run(`扫描 ${library.name}`, () => window.kura.scan(library.id, { force }));
      if (!report) break;
      reports.push({ name: library.name, counts: report.counts });
    }
    if (reports.length > 0) {
      const sum = (field: "added" | "removed" | "retyped") => reports.reduce((acc, r) => acc + r.counts[field], 0);
      note.value = `扫描 ${reports.length} 个库: 新增 ${sum("added")} · 移除 ${sum("removed")} 条索引${sum("retyped") ? ` · 修正类型 ${sum("retyped")} 条` : ""}`;
      await refreshAll();
    }
    return;
  }
  events.value = [];
  const report = await run("扫描", () => window.kura.scan(selectedId.value!, { force }));
  if (report) {
    const { counts } = report;
    note.value = `扫描完成: 新增 ${counts.added} · 更新 ${counts.updated} · 未变 ${counts.unchanged} · 未识别 ${counts.unparsed}${counts.nfoImported ? ` · 从 NFO 读回 ${counts.nfoImported} 条` : ""}${counts.retyped ? ` · 修正内容类型 ${counts.retyped} 条` : ""}`;
    page.value = 0;
    await refreshAll();
    return;
  }
  // 安全阀拦下来时把话说清楚: 这不是 bug, 是"库根可能没挂载完整"
  const message = errors.value.at(-1) ?? "";
  if (message.includes("已中止")) {
    note.value = `${message} —— 确认目录完整后重试; 若确实删了这么多, 到「更多操作」里点「强制扫描」`;
  }
}

async function doScan(): Promise<void> {
  await scanLibrary(false);
}

async function forceScan(): Promise<void> {
  await scanLibrary(true);
}

async function doScrape(): Promise<void> {
  progress.value = { index: 0, total: 0, key: "准备中", ok: true };
  // 不再固定 20 条: 待刮削多少就跑多少(进度与停止已有)
  const batch = await run("刮削", () => window.kura.scrapePending(pendingTotal.value || 1000));
  progress.value = null;
  if (batch) {
    const failed = batch.reports.filter((report) => !report.ok);
    note.value = batch.cancelled
      ? `已取消: 完成 ${batch.reports.length}/${batch.total} 条`
      : `刮削 ${batch.reports.length} 条, 失败 ${failed.length} 条${failed[0]?.error ? ` (${failed[0].error})` : ""}`;
    await refreshAll();
  }
}

async function translateAll(): Promise<void> {
  if (!info.value?.translate) {
    note.value = "先在「设置」里配置 LLM 并打开翻译开关";
    return;
  }
  translateProgress.value = { index: 0, total: 0, key: "准备中" };
  const result = await run("批量翻译", () => window.kura.translatePending(1000));
  translateProgress.value = null;
  if (result) {
    await refreshAll();
    note.value = describeTranslate(result);
  }
}

/** 别再拿"处理了多少条"当"翻译成功多少条" —— 全部失败时两者长得一样。 */
function describeTranslate(result: { count: number; cancelled: boolean; translated?: number; failed?: number; skipped?: number; repaired?: number; reports?: { error?: string }[] }): string {
  const translated = result.translated ?? 0;
  const failed = result.failed ?? 0;
  const skipped = result.skipped ?? 0;
  const parts = [`成功 ${translated} 条`];
  if (failed > 0) parts.push(`失败 ${failed} 条`);
  if (skipped > 0) parts.push(`无变化 ${skipped} 条`);
  if (result.repaired) parts.unshift(`缓存恢复 ${result.repaired} 条`);
  const head = result.cancelled ? `翻译已取消 (处理 ${result.count} 条)` : `翻译处理 ${result.count} 条`;
  const firstError = result.reports?.find((report) => report.error)?.error;
  if (failed > 0 && firstError) errors.value = [`翻译失败: ${firstError}`];
  const tail = translated === 0 && failed > 0 ? " —— 先点「测试 LLM」看模型为什么不通" : "";
  return `${head}: ${parts.join(" · ")}${tail}`;
}

async function translateSelected(): Promise<void> {
  if (picked.value.length === 0) return;
  translateProgress.value = { index: 0, total: picked.value.length, key: "准备中" };
  // 必须传普通数组: picked 是 Vue 的响应式代理, IPC 的结构化克隆克隆不了它
  // (报错是 "An object could not be cloned")。
  const keys = [...picked.value];
  const result = await run("翻译选中", () => window.kura.translateItems(keys));
  translateProgress.value = null;
  if (result) {
    note.value = describeTranslate(result);
    await refreshAll();
  }
}

async function cancelTranslate(): Promise<void> {
  await window.kura.cancelTranslate();
  note.value = "正在停止翻译…";
}

async function cancelScrape(): Promise<void> {
  await window.kura.cancelScrape();
  note.value = "正在停止…已发出的请求会立刻中断";
}

/* ---------- 条目选择与详情 ---------- */

function toggle(key: string): void {
  picked.value = picked.value.includes(key) ? picked.value.filter((item) => item !== key) : [...picked.value, key];
}

function toggleAll(): void {
  picked.value = picked.value.length === items.value.length ? [] : items.value.map((item) => item.key);
}

async function retryTask(task: KuraTask): Promise<void> {
  const created = await run("重试任务", () => window.kura.retryTask(task.id));
  if (created) {
    await refreshAll();
    note.value = `已重新入队 #${created.id} —— 用「刮削待处理」继续`;
  }
}

async function openDetail(item: KuraItem): Promise<void> {
  const fresh = await run("读取条目", () => window.kura.item(item.key));
  if (fresh) detail.value = fresh;
}

/** 详情里就地补一张图, 省得为了一个条目去勾选列表。 */
async function fetchOneImage(key: string): Promise<void> {
  const result = await run("下载图片", () => window.kura.fetchPoster(key));
  if (!result) return;
  detail.value = await window.kura.item(key);
  const saved = result.saved?.length ?? 0;
  note.value = result.poster
    ? `${key} 图片已缓存${saved ? `, 并复制 ${saved} 个文件到视频旁` : ""}`
    : `${key} 没取到海报`;
  await refreshItems();
}

async function scrapePicked(): Promise<void> {
  if (picked.value.length === 0) return;
  // 必须展开成普通数组: Vue 的 ref 背后是 Proxy, 结构化克隆(IPC)会直接抛
  // "An object could not be cloned"。
  const result = await run("刮削", () => window.kura.scrapeKeys([...picked.value]));
  if (result) {
    const failed = result.results.filter((entry) => !entry.ok);
    note.value = `刮削 ${result.count} 条, 失败 ${failed.length} 条${failed[0]?.error ? ` (${failed[0].error})` : ""}`;
    await refreshAll();
  }
}

async function postersPicked(): Promise<void> {
  if (picked.value.length === 0) return;
  const result = await run("下载图片", async () => {
    const outputs = [];
    for (const key of picked.value) outputs.push(await window.kura.fetchPoster(key));
    return outputs;
  });
  if (result) {
    const thumbs = result.filter((entry) => entry.thumb).length;
    note.value = `已缓存 ${result.length} 条: 海报 ${result.filter((entry) => entry.poster).length} 张, 缩略图 ${thumbs} 张 —— 整理时会复制进库`;
  }
}

/** 单条改类型: 只影响这条的刮削路由, 不动已有字段。 */
async function retypeOne(key: string, contentType: string): Promise<void> {
  const result = await run("改类型", () => window.kura.retypeItem(key, contentType));
  if (!result) return;
  if (result.item) detail.value = result.item;
  note.value = result.from === result.to ? `${key} 类型本来就是 ${TYPE_LABEL[result.to] ?? result.to}` : `${key} 类型改为 ${TYPE_LABEL[result.to] ?? result.to}`;
  await refreshItems();
}

/** 批量修正: 先只查(不动数据), 报出条数, 人确认后才写。 */
async function retypeDetect(): Promise<void> {
  const preview = await run("检查内容类型", () => window.kura.retypeDetect(false));
  if (!preview) return;
  if (preview.changes.length === 0) {
    note.value = "没有内容类型判错的条目。";
    return;
  }
  const samples = preview.changes.slice(0, 5).map((c) => `${c.number} ${c.from}→${c.to}`).join(", ");
  const ok = window.confirm(
    `发现 ${preview.changes.length} 条类型判错 (例如 ${samples}${preview.changes.length > 5 ? " …" : ""})。\n\n` +
      "修正只改刮削路由; 已有字段不动, 但若库开着整理且用 {content_type} 目录, 下次整理会按新类型归档。\n\n确定修正吗?",
  );
  if (!ok) {
    note.value = `已取消, 未改动 (${preview.changes.length} 条待修)`;
    return;
  }
  const applied = await run("修正内容类型", () => window.kura.retypeDetect(true));
  if (applied) {
    note.value = `已修正 ${applied.changes.length} 条内容类型`;
    await refreshAll();
  }
}

async function togglePin(field: string): Promise<void> {
  if (!detail.value) return;
  const pinned = detail.value.pinned.includes(field);
  const updated = await run("更新锁定", () =>
    window.kura.updateItem(pinned ? { key: detail.value!.key, unpin: [field] } : { key: detail.value!.key, pin: [field] }),
  );
  if (updated) {
    detail.value = updated;
    // 列表里的锁标记也要跟着变, 不然要等下次刷新才更新。
    items.value = items.value.map((item) => (item.key === updated.key ? { ...item, pinned: updated.pinned } : item));
  }
}

function fieldValue(item: KuraItem, field: string): string {
  const value = (item as unknown as Record<string, unknown>)[field];
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) return value.join("、");
  return String(value);
}

/* ---------- 整理 ---------- */

async function toggleOrganize(event: Event): Promise<void> {
  if (selectedId.value === null) return;
  const enabled = (event.target as HTMLInputElement).checked;
  const updated = await run("切换整理开关", () => window.kura.setLibraryOrganize(selectedId.value!, enabled));
  if (updated) {
    plan.value = null;
    await refreshAll();
    note.value = enabled ? "已允许整理" : "已设为只索引: 不会移动/改名/写 NFO";
  }
}

async function applyDimension(): Promise<void> {
  if (selectedId.value === null || !dimension.value) return;
  const updated = await run("切换整理维度", () => window.kura.setLibraryTemplate(selectedId.value!, dimension.value));
  if (updated) {
    // 计划已失效, 清掉, 让用户重新预览
    plan.value = null;
    await refreshAll();
    note.value = `整理维度已切换为 ${info.value?.dimensions.find((item) => item.id === dimension.value)?.label ?? dimension.value}`;
  }
}


async function preview(): Promise<void> {
  if (selectedId.value === null) return;
  if (selected.value?.organizeEnabled === false) {
    note.value = "该库已设为只索引, 不会整理。要整理请先勾选「允许整理」。";
    return;
  }
  const report = await run("生成计划", () => window.kura.organizePreview(selectedId.value!));
  if (report) {
    plan.value = report.plan;
    tab.value = "plan";
    confirmApply.value = false;
  }
}

async function apply(): Promise<void> {
  if (selectedId.value === null) return;
  const report = await run("整理", () => window.kura.organizeApply(selectedId.value!));
  if (report) {
    plan.value = report.plan;
    const failed = (report.applied ?? []).filter((result) => !result.ok);
    note.value = `已整理, 失败 ${failed.length} 项`;
    confirmApply.value = false;
    await refreshAll();
  }
}

/* ---------- 设置 ---------- */

async function saveConfig(): Promise<void> {
  const patch: {
    apiId?: string;
    affiliateId?: string;
    proxy?: string;
    llmBaseUrl?: string;
    llmApiKey?: string;
    llmModel?: string;
    translate?: boolean;
  } = {};
  if (apiIdInput.value.trim()) patch.apiId = apiIdInput.value.trim();
  if (affiliateInput.value.trim()) patch.affiliateId = affiliateInput.value.trim();
  patch.proxy = proxyInput.value.trim();
  if (llmBaseUrlInput.value.trim()) patch.llmBaseUrl = llmBaseUrlInput.value.trim();
  if (llmApiKeyInput.value.trim()) patch.llmApiKey = llmApiKeyInput.value.trim();
  if (llmModelInput.value.trim()) patch.llmModel = llmModelInput.value.trim();
  patch.translate = translateOn.value;

  const changed =
    patch.apiId || patch.affiliateId || patch.proxy || patch.llmBaseUrl || patch.llmApiKey || patch.llmModel ||
    patch.translate !== Boolean(config.value?.settings.translate);
  if (!changed) {
    note.value = "没有改动";
    return;
  }
  const saved = await run("保存配置", () => window.kura.configSet(patch));
  if (saved) {
    apiIdInput.value = "";
    affiliateInput.value = "";
    proxyInput.value = "";
    llmBaseUrlInput.value = "";
    llmApiKeyInput.value = "";
    llmModelInput.value = "";
    await refreshAll();
    note.value = `已保存到 ${config.value?.path ?? "配置文件"}`;
  }
}

function openDataDir(): void {
  void window.kura.openDataDir();
}

async function testLlm(): Promise<void> {
  llmTest.value = await run("测试 LLM", () => window.kura.testLlm());
}

/**
 * 侧栏只该有一个主按钮。
 *
 * 顺序即优先级: 有待刮削就推刮削(它是把条目从"没元数据"变"有元数据"的动作),
 * 其次是翻译(元数据齐了才轮到它), 都没有才退回扫描。
 */
const primary = computed(() => {
  const scope = selected.value?.name ?? "全部库";
  if (selected.value && pendingTotal.value > 0) {
    return { id: "scrape" as const, label: `刮削 ${scope} (${pendingTotal.value})` };
  }
  const pending = info.value?.pendingTranslation ?? 0;
  if (info.value?.translate && pending > 0) {
    return { id: "translate" as const, label: `翻译待处理 (${pending})` };
  }
  return { id: "scan" as const, label: selected.value ? `扫描 «${scope}»` : `扫描全部 ${libraries.value.length} 个库` };
});

function runPrimary(): void {
  if (primary.value.id === "scrape") void doScrape();
  else if (primary.value.id === "translate") void translateAll();
  else void doScan();
}

async function testProxy(): Promise<void> {
  proxyTest.value = await run("测试代理", () => window.kura.proxyTest());
}

async function testDmm(): Promise<void> {
  dmmTest.value = await run("测试 DMM", () => window.kura.testDmm("SSIS-001"));
}
</script>

<template>
  <main class="shell">
    <header class="top">
      <h1>Kura</h1>
      <!-- 版本/引擎/schema 是排障信息, 不是用户每天要看的东西 —— 它们挪到设置页 -->
      <span v-if="info" class="meta">条目 {{ info.items.toLocaleString() }} · 文件 {{ info.mediaFiles.toLocaleString() }}</span>
    </header>

    <div v-if="info?.fixturesDir" class="banner">
      离线样本模式：刮削只走 fixture 源（{{ info.fixturesDir }}），不会访问真实站点。去掉 <code>KURA_FIXTURE_DIR</code> 重启即为真实刮削。
    </div>

    <div class="body">
      <aside class="side">
        <div class="side-head">
          <span>媒体库</span>
          <button class="ghost" type="button" aria-label="添加媒体库" title="添加媒体库" :disabled="busy" @click="addLibrary">
            +
          </button>
        </div>
        <ul class="libs">
          <!-- 「全部库」不是真库, 只是把范围放宽: 扫描会挨个跑 -->
          <li :class="{ active: selectedId === null }">
            <button type="button" class="lib" @click="selectedId = null; onScopeChange()">
              <strong>全部库</strong>
              <small>{{ libraries.length }} 个媒体库 · {{ info?.items ?? 0 }} 条</small>
            </button>
          </li>
          <li v-for="library in libraries" :key="library.id" :class="{ active: library.id === selectedId }">
            <div v-if="renamingId === library.id" class="rename">
              <input
                ref="renameInput"
                v-model="renameDraft"
                type="text"
                @keyup.enter="commitRename(library)"
                @keyup.esc="cancelRename"
                @blur="commitRename(library)"
              />
            </div>
            <button v-else type="button" class="lib" @click="selectLibrary(library.id)">
              <strong>
                {{ library.name }}
                <span v-if="library.organizeEnabled === false" class="badge">只索引</span>
              </strong>
              <small v-if="showRoot(library)" :title="library.root">{{ library.root }}</small>
              <span class="pencil" role="button" tabindex="0" title="改名" aria-label="重命名媒体库" @click.stop="startRename(library)" @keyup.enter.stop="startRename(library)">✎</span>
            </button>
          </li>
          <li v-if="libraries.length === 0" class="muted">还没有媒体库</li>
        </ul>

        <div class="actions">
          <!-- 主按钮按当前状态推导: 每屏一个视觉中心, 其余收进"更多" -->
          <button
            type="button"
            class="primary"
            :disabled="busy || libraries.length === 0"
            :title="selected ? `只作用于「${selected.name}」` : '按顺序扫描全部媒体库'"
            @click="runPrimary"
          >
            {{ primary.label }}
          </button>
          <details class="more">
            <summary>更多操作</summary>
            <div class="more-list">
              <button type="button" :disabled="busy || !selected" @click="doScan">扫描</button>
              <button
                type="button"
                :disabled="busy || !selected"
                title="跳过「一次移除过多文件」的安全阀。盘没挂全时别用"
                @click="forceScan"
              >
                强制扫描
              </button>
              <button
                type="button"
                :disabled="busy"
                title="按当前解析器重新判定内容类型 (会先列出清单让你确认)"
                @click="retypeDetect"
              >
                修正内容类型
              </button>
              <button type="button" :disabled="busy" @click="doScrape">刮削待处理</button>
              <button
                type="button"
                :disabled="busy || !info?.translate"
                :title="info?.translate ? '把已有条目里的日文标题/简介翻译成中文' : '先在设置里配置 LLM 并打开翻译开关'"
                @click="translateAll"
              >
                翻译待处理{{ info?.translate && info.pendingTranslation ? ` (${info.pendingTranslation})` : "" }}
              </button>
              <button
                type="button"
                :disabled="busy || !selected || selected.organizeEnabled === false"
                :title="selected?.organizeEnabled === false ? '该库已设为只索引, 不会整理' : ''"
                @click="preview"
              >
                整理预览
              </button>
            </div>
          </details>
        </div>

        <p v-if="info" class="sources">
          来源:
          <span v-for="source in info.sources" :key="source.id" :class="source.status">
            {{ source.id }}({{ source.status === "ready" ? "可用" : "待实现" }})
          </span>
        </p>
      </aside>

      <section class="main">
        <nav class="tabs">
          <button type="button" :class="{ on: tab === 'items' }" @click="tab = 'items'">条目</button>
          <button type="button" :class="{ on: tab === 'unparsed' }" @click="tab = 'unparsed'; goUnparsedPage(unparsedPage)">
            未识别 ({{ unparsedCount }})
          </button>
          <button type="button" :class="{ on: tab === 'plan' }" @click="tab = 'plan'">整理预览</button>
          <button type="button" :class="{ on: tab === 'tasks' }" @click="tab = 'tasks'">任务</button>
          <button type="button" :class="{ on: tab === 'settings' }" @click="tab = 'settings'">设置</button>
          <span class="spacer" />
          <span v-if="progress" class="progress">
            {{ progress.index }}/{{ progress.total || "?" }} · {{ progress.key }}
          </span>
          <button v-if="progress" type="button" class="danger" @click="cancelScrape">停止</button>
          <span v-else-if="translateProgress" class="muted" :class="{ fail: translateProgress.error }">
            翻译 {{ translateProgress.index }}/{{ translateProgress.total }} · {{ translateProgress.key }}
            <template v-if="translateProgress.error"> ✗ {{ translateProgress.error }}</template>
          </span>
          <span v-else-if="busy" class="muted">进行中…</span>
        </nav>

        <p v-if="error" class="error">{{ error }}</p>
        <div v-if="errors.length" class="banner error">
          <strong>出错了</strong>
          <ul>
            <li v-for="(message, index) in errors" :key="index">{{ message }}</li>
          </ul>
        </div>
        <p v-else-if="note" class="note">{{ note }}</p>

        <!-- 条目 -->
        <div v-if="tab === 'items'" class="pane items">
          <!-- 一条挤不下: 筛选一行, 翻页与批量动作一行, 免得文字被压成竖排 -->
          <div class="toolbar">
            <div class="toolbar-row">
              <label class="check">
                <input
                  type="checkbox"
                  :checked="picked.length > 0 && picked.length === items.length"
                  @change="toggleAll"
                />
                全选
              </label>
              <span class="muted nowrap">已选 {{ picked.length }}</span>
              <span class="spacer" />
              <button
                type="button"
                class="chip"
                :class="{ on: filters.state === 'unscraped' }"
                :title="`只看还没有元数据的条目 (共 ${pendingTotal} 条)`"
                @click="applyFilter('state', 'unscraped')"
              >
                未刮削 {{ pendingTotal }}
              </button>
              <input
                v-model="searchDraft"
                class="search"
                type="search"
                placeholder="搜番号 / 标题 / 演员 / 标签…"
                @keyup.enter="applySearch"
                @search="applySearch"
              />
              <button v-if="hasFilters" type="button" class="chip" @click="clearFilters">清空筛选 ✕</button>
            </div>

            <div class="toolbar-row">
              <!-- 翻页是只读操作, 不该被长任务锁住: 刮削 200 条要十几分钟, 期间连看下一页都不行毫无道理 -->
              <button type="button" title="上一页" aria-label="上一页" :disabled="page === 0" @click="goPage(page - 1)">‹</button>
              <input
                v-model="pageInput"
                class="page-input"
                type="text"
                inputmode="numeric"
                :title="`跳到第 1–${pageCount} 页`"
                @keyup.enter="jumpToPage"
                @blur="jumpToPage"
              />
              <span class="muted nowrap">/ {{ pageCount }}</span>
              <button type="button" title="下一页" aria-label="下一页" :disabled="page >= pageCount - 1" @click="goPage(page + 1)">›</button>
              <span class="muted nowrap">
                共 {{ itemTotal }} 条 · 待刮削 {{ pendingTotal }}
                <template v-if="exhaustedTotal > 0">
                  · <span class="warn" title="失败的条目不再自动重试, 用 kura scrape --retry-failed 显式重试">已达上限 {{ exhaustedTotal }}</span>
                </template>
              </span>
              <span class="spacer" />
              <button type="button" :disabled="busy || picked.length === 0" @click="scrapePicked">
                刮削选中 ({{ picked.length }})
              </button>
              <button type="button" :disabled="busy || picked.length === 0" @click="postersPicked">
                下载图片 ({{ picked.length }})
              </button>
              <button type="button" :disabled="busy || picked.length === 0" @click="translateSelected">
                翻译选中 ({{ picked.length }})
              </button>
              <button v-if="translateProgress" type="button" class="danger" @click="cancelTranslate">停止翻译</button>
            </div>
          </div>

          <!-- 长任务的可视进度: 只有数字没有条, 用户无法判断"还剩多久" -->
          <div v-if="taskProgress" class="task-bar" role="progressbar" :aria-valuenow="taskPercent" aria-valuemin="0" aria-valuemax="100">
            <span class="task-bar-fill" :style="{ width: `${taskPercent}%` }" />
          </div>

          <div v-if="hasFilters" class="filter-bar">
            <span
              v-for="(value, key) in filters"
              :key="key"
              class="chip"
              :title="`点一下取消这个条件`"
              @click="applyFilter(key as FilterKey, value as string)"
            >
              {{ FILTER_LABEL[key as FilterKey] }}: {{ filterText(key as FilterKey, value as string) }} ✕
            </span>
          </div>

          <div class="split">
            <div class="list">
              <table v-if="items.length > 0">
                <thead>
                  <tr>
                    <th class="pick" />
                    <th
                      v-for="column in [
                        { field: 'number', label: '番号' },
                        { field: 'title', label: '标题' },
                        { field: 'studio', label: '片商' },
                      ] as const"
                      :key="column.field"
                      :aria-sort="sortState(column.field)"
                    >
                      <button type="button" class="sort" @click="toggleSort(column.field)">
                        {{ column.label }}
                        <span class="sort-arrow" aria-hidden="true">{{
                          sortState(column.field) === "ascending" ? "↑" : sortState(column.field) === "descending" ? "↓" : ""
                        }}</span>
                      </button>
                    </th>
                    <th>演员</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="item in items"
                    :key="item.key"
                    :class="{ active: detail?.key === item.key }"
                    @click="openDetail(item)"
                  >
                    <td class="pick" @click.stop>
                      <input
                        type="checkbox"
                        :checked="picked.includes(item.key)"
                        @change="toggle(item.key)"
                      />
                    </td>
                    <td class="num-cell">
                      <span class="mono">{{ item.number }}</span>
                      <span class="type-badge">{{ TYPE_LABEL[item.contentType] ?? item.contentType }}</span>
                      <span v-if="item.pinned.length" title="有锁定字段" aria-label="有锁定字段">🔒</span>
                    </td>
                    <td class="title-cell" :title="item.title ?? ''">
                      <span>{{ displayTitle(item) }}</span>
                    </td>
                    <td>
                      <button v-if="item.studio" type="button" class="actor" :title="`只看 ${item.studio}`" @click="applyFilter('studio', item.studio!)">
                        {{ item.studio }}
                      </button>
                      <span v-else>—</span>
                    </td>
                    <td>
                      <template v-if="item.actors?.length">
                        <button
                          v-for="name in item.actors.slice(0, 3)"
                          :key="name"
                          type="button"
                          class="actor"
                          :title="`只看 ${name}`"
                          @click="applyFilter('actor', name)"
                        >
                          {{ name }}
                        </button>
                        <span v-if="item.actors.length > 3" class="muted">…</span>
                      </template>
                      <span v-else>—</span>
                    </td>
                  </tr>
                </tbody>
              </table>

              <!-- 空状态要给出"下一步该做什么", 只说"没有条目"等于把问题丢回给用户 -->
              <div v-if="items.length === 0 && (firstLoad || busy)" class="skeleton" aria-hidden="true">
                <span v-for="n in 8" :key="n" class="skeleton-row" :style="{ opacity: 1 - n * 0.06 }" />
                <p class="skeleton-hint">{{ busy ? "正在扫描…" : "正在读取条目…" }}</p>
              </div>
              <div v-else class="empty">
                <template v-if="hasFilters">
                  <p>没有符合当前筛选条件的条目。</p>
                  <button type="button" class="chip" @click="clearFilters">清空筛选</button>
                </template>
                <template v-else-if="libraries.length === 0">
                  <p>还没有媒体库。</p>
                  <button type="button" class="primary" :disabled="busy" @click="addLibrary">添加媒体库</button>
                  <p class="hint">选一个存放影片的文件夹, Kura 会扫一遍并登记所有文件。</p>
                </template>
                <template v-else>
                  <p>这个库里还没有条目。</p>
                  <button type="button" class="primary" :disabled="busy || !selected" @click="doScan">扫描 «{{ selected?.name }}»</button>
                  <p class="hint">第一次扫描要遍历整棵目录树, 大库可能需要几分钟。</p>
                </template>
              </div>
            </div>

            <aside v-if="detail" class="detail">
              <header>
                <strong class="mono">{{ detail.number }}</strong>
                <button type="button" class="chip" title="在资源管理器里打开这个文件" @click="revealItem">
                  打开位置
                </button>
                <button class="ghost" type="button" aria-label="关闭详情" title="关闭详情" @click="detail = null">×</button>
              </header>
              <!-- 类型决定刮削路由与整理目录, 所以做成显式可改: 判错时人得能修 -->
              <div class="detail-type">
                <span class="muted">类型</span>
                <select
                  :value="detail.contentType"
                  aria-label="内容类型"
                  @change="retypeOne(detail!.key, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="(label, value) in TYPE_LABEL" :key="value" :value="value">{{ label }}</option>
                </select>
                <span class="muted hint">改了会换刮削来源</span>
              </div>

              <ul>
                <li
                  v-for="field in FIELDS"
                  :key="field"
                  v-show="(IMAGE_FIELDS.includes(field) || fieldValue(detail, field)) && !LIST_FIELDS.includes(field)"
                >
                  <span class="label">{{ FIELD_LABEL[field] }}</span>
                  <span
                    v-if="IMAGE_FIELDS.includes(field)"
                    class="value"
                    :title="fieldValue(detail, field)"
                  >
                    <template v-if="detail.coverUrl">已缓存 ✓</template>
                    <button
                      v-else
                      type="button"
                      class="chip"
                      :disabled="busy"
                      title="从来源下载这一张图, 并复制到视频旁边"
                      @click="fetchOneImage(detail!.key)"
                    >
                      未缓存 · 下载
                    </button>
                  </span>
                  <span
                    v-else
                    class="value"
                    :class="{ link: FILTERABLE_SINGLE.includes(field) }"
                    :title="FILTERABLE_SINGLE.includes(field) ? '点一下只看这个' : ''"
                    @click="FILTERABLE_SINGLE.includes(field) && applyFilter(field as FilterKey, fieldValue(detail, field))"
                  >
                    {{ fieldValue(detail, field) }}
                  </span>
                  <button
                    class="pin"
                    type="button"
                    :class="{ on: detail.pinned.includes(field) }"
                    :title="detail.pinned.includes(field) ? '已锁定: 重新刮削不覆盖' : '点击锁定'"
                    :aria-label="detail.pinned.includes(field) ? `解锁${FIELD_LABEL[field]}` : `锁定${FIELD_LABEL[field]}`"
                    :aria-pressed="detail.pinned.includes(field)"
                    @click="togglePin(field)"
                  >
                    {{ detail.pinned.includes(field) ? "🔒" : "🔓" }}
                  </button>
                  <span class="from" :title="`字段来源: ${detail.fieldSources?.[field] ?? '未知'}`">
                    {{ detail.fieldSources?.[field] ?? "" }}
                  </span>
                </li>
              </ul>
              <div v-for="field in ['actors', 'directors', 'tags'] as const" :key="field" class="detail-chips">
                <span class="muted">{{ FIELD_LABEL[field] }}</span>
                <template v-if="detail[field]?.length">
                  <button
                    v-for="value in detail[field]"
                    :key="value"
                    type="button"
                    class="chip"
                    :title="`只看这个${FIELD_LABEL[field]}`"
                    @click="applyFilter(field === 'actors' ? 'actor' : field === 'directors' ? 'director' : 'tag', value)"
                  >
                    {{ value }}
                  </button>
                </template>
                <span v-else class="muted">—</span>
              </div>
              <p class="muted hint">锁定后重新刮削不会覆盖该字段。点片商/厂牌/系列/演员/导演/标签可以筛出同类条目。</p>
              <!-- 图放最后: 字段通常占不满整栏, 让图吃掉剩下的空白, 也就能显示得更大 -->
              <div v-if="detail.coverUrl" class="detail-cover">
                <button type="button" class="cover-zoom" :aria-label="`放大 ${detail.number} 的封面`" @click="zoom = detail.coverUrl!">
                  <img :src="detail.coverUrl" :alt="detail.number" />
                </button>
              </div>
            </aside>
          </div>
        </div>

        <!-- 未识别 -->
        <div v-else-if="tab === 'unparsed'" class="pane">
          <div class="toolbar">
            <span class="muted">扫到了但认不出番号的文件: {{ unparsedCount }} 个（不会进入刮削）</span>
            <span class="spacer" />
            <button type="button" aria-label="上一页" title="上一页" :disabled="unparsedPage === 0" @click="goUnparsedPage(unparsedPage - 1)">‹</button>
            <span class="muted">{{ unparsedPage + 1 }}/{{ Math.max(1, Math.ceil(unparsedCount / unparsedPageSize)) }}</span>
            <button
              type="button"
              aria-label="下一页"
              title="下一页"
              :disabled="unparsedPage >= Math.max(1, Math.ceil(unparsedCount / unparsedPageSize)) - 1"
              @click="goUnparsedPage(unparsedPage + 1)"
            >
              ›
            </button>
          </div>
          <table>
            <thead>
              <tr><th>路径</th><th>大小</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="file in unparsedFiles" :key="file.path">
                <td class="mono" :title="file.path">{{ file.path }}</td>
                <td class="mono">{{ Math.max(1, Math.round(file.size / 1024)) }} KB</td>
                <td class="row-actions">
                  <button type="button" @click="copyPath(file.path)">复制路径</button>
                  <button type="button" @click="reveal(file.path)">定位</button>
                </td>
              </tr>
              <tr v-if="unparsedFiles.length === 0">
                <td colspan="3" class="muted">没有未识别的文件。</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 整理预览 -->
        <div v-else-if="tab === 'plan'" class="pane">
          <div class="lib-config">
            <span class="muted">整理维度</span>
            <select v-model="dimension" :disabled="!selected || busy">
              <option v-for="item in info?.dimensions ?? []" :key="item.id" :value="item.id">
                {{ item.label }} — {{ item.template }}
              </option>
            </select>
            <button type="button" :disabled="!selected || busy || !dimension" @click="applyDimension">切换</button>
            <label class="check">
              <input
                type="checkbox"
                :checked="selected?.organizeEnabled !== false"
                :disabled="!selected || busy"
                @change="toggleOrganize"
              />
              允许整理
            </label>
            <span class="muted">当前模板: <code>{{ selected?.template }}</code></span>
          </div>
          <p class="muted note-line">
            一个库只选一个维度。多演员时"按演员"取第一演员; 想全部列进目录名, 把模板改成 <code>{actors}/{number}</code>。
          </p>

          <div v-if="!plan" class="muted">点左侧「整理预览」生成计划。</div>
          <template v-else>
            <p class="summary">
              移动 {{ plan.summary.move }} · 写 NFO {{ plan.summary.writeNfo }} · 海报 {{ plan.summary.copyImage }} · 跳过
              {{ plan.summary.skip }}
              <span class="muted">(库根 {{ plan.libraryRoot }})</span>
            </p>
            <ul class="plan">
              <li v-for="(entry, index) in plan.entries.slice(0, 200)" :key="index" :data-action="entry.action">
                <span class="tag">{{ entry.action }}</span>
                <span v-if="entry.action === 'move'" class="mono">{{ entry.from }} → {{ entry.to }}</span>
                <span v-else class="mono">{{ entry.to ?? entry.from }} {{ entry.reason ?? "" }}</span>
              </li>
            </ul>

            <div class="apply">
              <template v-if="!confirmApply">
                <button
                  type="button"
                  class="primary"
                  :disabled="busy || (plan.summary.move === 0 && plan.summary.copyImage === 0)"
                  @click="confirmApply = true"
                >
                  执行整理…
                </button>
              </template>
              <template v-else>
                <span class="warn">会移动 {{ plan.summary.move }} 个文件, 不可撤销。确认?</span>
                <button type="button" class="danger" :disabled="busy" @click="apply">确认执行</button>
                <button type="button" :disabled="busy" @click="confirmApply = false">取消</button>
              </template>
            </div>
          </template>
        </div>

        <!-- 任务 -->
        <div v-else-if="tab === 'tasks'" class="pane">
          <p class="muted">批量操作会留下记录；关掉软件后仍能看到跑到哪、并重试。</p>
          <table>
            <thead>
              <tr><th>#</th><th>类型</th><th>状态</th><th>进度</th><th>失败</th><th>备注</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="task in tasks" :key="task.id">
                <td class="mono">{{ task.id }}</td>
                <td>{{ task.type }}</td>
                <td :class="`st-${task.status}`">{{ task.status }}</td>
                <td class="mono">{{ task.processed }}/{{ task.total }}</td>
                <td class="mono">{{ task.failed }}</td>
                <td class="muted">{{ task.error ?? "—" }}</td>
                <td>
                  <button
                    v-if="['interrupted', 'failed', 'cancelled', 'done'].includes(task.status)"
                    type="button"
                    :disabled="busy"
                    @click="retryTask(task)"
                  >
                    重试
                  </button>
                </td>
              </tr>
              <tr v-if="tasks.length === 0">
                <td colspan="7" class="muted">还没有任务记录。</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 设置 -->
        <div v-else class="pane settings">
          <h2>数据目录</h2>
          <p class="muted">
            条目、媒体库、配置都在这里。换机器/换用户后看到"没有数据", 通常是这份文件不在预期位置。
          </p>
          <label class="field">
            <span>路径</span>
            <input :value="info?.dataDir ?? ''" readonly class="mono" />
          </label>
          <div class="row">
            <button type="button" @click="openDataDir">打开数据目录</button>
            <span class="muted">
              当前 {{ info?.libraries ?? 0 }} 个媒体库 · {{ info?.items ?? 0 }} 个条目 · schema v{{ info?.schemaVersion }} ·
              v{{ info?.version }} ({{ info?.dbRuntime }})
              <template v-if="info?.translation">
                · 已翻译 {{ info.translation.translated }} 条 · 待翻译 {{ info.translation.pending }} 条
              </template>
            </span>
          </div>

          <h2>数据源</h2>
          <p class="muted">DMM 走官方 API, 需要 affiliate 凭据。配置保存在本地文件, 环境变量优先。</p>

          <label class="field">
            <span>API ID</span>
            <input v-model="apiIdInput" type="password" spellcheck="false" :placeholder="config?.settings.dmm.apiId || '未设置'" />
          </label>
          <label class="field">
            <span>Affiliate ID</span>
            <input
              v-model="affiliateInput"
              type="password"
              spellcheck="false"
              :placeholder="config?.settings.dmm.affiliateId || '未设置'"
            />
          </label>

          <div class="row">
            <button type="button" class="primary" :disabled="busy" @click="saveConfig">保存</button>
            <button type="button" :disabled="busy" @click="testDmm">测试连接</button>
            <button type="button" :disabled="busy" @click="testLlm">测试 LLM</button>
            <span v-if="llmTest" class="muted">模型 {{ llmTest.model }} 回: {{ llmTest.sample }}</span>
            <span class="muted">
              {{ config?.dmmConfigured ? "DMM 已配置" : "DMM 未配置" }}
              <template v-if="config?.dmmFromEnv">(环境变量生效中)</template>
            </span>
          </div>

          <p v-if="dmmTest" class="note">
            {{ dmmTest.ok ? "连接成功" : "未通过" }} ({{ dmmTest.status }})
            <template v-if="dmmTest.fields?.length">· 取到 {{ dmmTest.fields.length }} 个字段</template>
            <template v-if="dmmTest.missing?.length">· 缺 {{ dmmTest.missing.join(", ") }}</template>
            <template v-if="dmmTest.error">· {{ dmmTest.error }}</template>
          </p>

          <p v-if="config" class="path">{{ config.path }}</p>

          <h2>翻译 (日 → 中)</h2>
          <p class="muted">
            只翻含假名的日文; 演员名不翻。译文覆盖标题/简介, 原文另存, NFO 的 originaltitle 与目录名仍用日文。
          </p>
          <label class="field">
            <span>接口地址</span>
            <input v-model="llmBaseUrlInput" spellcheck="false" :placeholder="config?.settings.llm.baseUrl || 'https://api.deepseek.com/v1'" />
          </label>
          <label class="field">
            <span>API Key</span>
            <input v-model="llmApiKeyInput" type="password" spellcheck="false" :placeholder="config?.settings.llm.apiKey || '未设置'" />
          </label>
          <label class="field">
            <span>模型</span>
            <input v-model="llmModelInput" spellcheck="false" :placeholder="config?.settings.llm.model || 'deepseek-chat'" />
          </label>
          <div class="row">
            <label class="check">
              <input v-model="translateOn" type="checkbox" />
              刮削后自动翻译
            </label>
            <span class="muted">{{ info?.llmConfigured ? "LLM 已配置" : "LLM 未配置" }}</span>
          </div>

          <h2>代理</h2>
          <label class="field">
            <span>代理地址</span>
            <input
              v-model="proxyInput"
              spellcheck="false"
              aria-label="代理地址"
              :placeholder="config?.settings.proxy || '留空 = 跟随系统代理, 或填 127.0.0.1:7890'"
            />
          </label>
          <p class="muted">
            留空即跟随 Windows 系统代理(Clash 开系统代理或 TUN 即可)。填 <code>auto</code> 会在启动时探测常见端口;
            也可直接填 <code>127.0.0.1:7890</code>(没写 http:// 会自动补上)。
          </p>
          <div class="row">
            <button type="button" :disabled="busy" @click="testProxy">测试代理</button>
            <span v-if="proxyTest" class="muted">
              配置: {{ proxyTest.configured || "(跟随系统)" }} · 实际在用:
              {{ proxyTest.effective }} ·
              <template v-if="proxyTest.reachable.length">监听中: {{ proxyTest.reachable.join(", ") }}</template>
              <span v-else class="warn">没有任何常见代理端口在监听 —— 代理软件没开, 或端口不是 7890/7891/7897/1080/10808</span>
            </span>
          </div>

          <h2>来源状态</h2>
          <ul class="src-list">
            <li v-for="source in info?.sources ?? []" :key="source.id">
              <span class="tag" :data-ready="source.status === 'ready'">{{ source.status }}</span>
              <strong>{{ source.id }}</strong>
              <span class="muted">{{ source.label }}</span>
              <span v-if="source.missing.length" class="warn">缺 {{ source.missing.join(", ") }}</span>
            </li>
          </ul>
        </div>

        <div v-if="events.length" class="events">
          <span v-for="(event, index) in events.slice(0, 12)" :key="index" :data-type="event.type" class="mono">
            {{ event.type.replace("file.", "") }} {{ event.path.split(/[\\/]/).pop() }}
          </span>
        </div>
      </section>
    </div>

    <!-- 看大图: 点封面放大, 点任意处或按 Esc 关闭 -->
    <div
      v-if="zoom"
      class="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="封面大图"
      tabindex="-1"
      ref="lightboxEl"
      @click="zoom = null"
      @keydown.esc="zoom = null"
    >
      <img :src="zoom" alt="" />
      <button type="button" class="ghost lightbox-close" aria-label="关闭大图" @click.stop="zoom = null">×</button>
    </div>
  </main>
</template>

<style>
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --panel: #171a21;
  /* 这两档"表面"以前只有引用没有定义: var() 解析失败会静默退回继承,
     结果选中行没有底色、主按钮文字继承成浅色 (浅字压蓝底 = 2.58:1)。 */
  --panel-2: #1e232d;
  --panel-3: #232935;
  --line: #262b35;
  --text: #e6e8ee;
  --muted: #8b93a7;
  /* 元信息(字段来源/次要标注): 在 panel 上 4.53:1, 刚过 AA 正文线 —— 再暗就是不可见 */
  --text-faint: #78829b;
  --accent: #5b8cff;
  --ok: #4ec9a5;
  --warn: #e5b567;
  --danger: #ff7b72;
  --danger-line: #b3403a;
  --line-strong: #3a455c;
  /* 主色上的文字: 用最暗的背景色, 5.97:1。别再让 color 失继承。 */
  --on-accent: #0f1115;
  /* ---- 设计令牌: 圆角/间距/字号成体系, 不再散落 magic number ---- */
  /* 圆角按"元件级别"分档: 小控件 < 卡片 < 面板, 不再按数字大小命名 */
  --radius-xs: 8px; /* 仅限缩略图这类小方块, 12px 会把小图吃掉 */
  --radius-sm: 12px; /* 按钮 / 输入 / 选择器 */
  --radius-md: 16px; /* 卡片 / 图片画框 */
  --radius-lg: 20px; /* 详情、浮层面板 */
  --radius-pill: 999px;
  --ease: cubic-bezier(0.2, 0, 0, 1);
  /* ---- 字阶: 视觉上只有三层 —— 标题(18/16) / 正文(14) / 标签(12) ---- */
  --fs-display: 18px;
  --fs-section: 16px;
  --fs-body: 14px;
  --fs-label: 12px;

  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
}

.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  box-sizing: border-box;
}

.top {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
}

h1 {
  margin: 0;
  font-size: var(--fs-display);
  font-weight: 600;
  /* 大字号要收紧字距, 否则标题看着比正文松散 */
  letter-spacing: -0.02em;
}

.meta,
.muted {
  color: var(--muted);
  font-size: var(--fs-label);
}

/* 侧边栏库列表: 名字旁边一个铅笔, 点了就地改名 */
.lib {
  position: relative;
}

.pencil {
  position: absolute;
  top: 8px;
  right: 8px;
  opacity: 0;
  color: var(--muted);
  font-size: var(--fs-label);
}

.lib:hover .pencil {
  opacity: 1;
}

.rename input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--text);
  font: inherit;
}

/* 条目列表里的封面缩略图 */
.cover {
  width: 46px;
  height: 64px;
  object-fit: cover;
  border-radius: var(--radius-xs);
  display: block;
  background: var(--panel-2);
}

.cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: var(--fs-label);
}

.search {
  width: 220px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-label);
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}

.filter-bar .chip {
  cursor: pointer;
}

.value.link {
  color: var(--accent);
  cursor: pointer;
}

.value.link:hover {
  text-decoration: underline;
}

.detail-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
}

.detail-chips .chip {
  cursor: pointer;
  border-color: var(--line);
  color: var(--text);
}

/* 页码输入框: 和翻页按钮同高, 窄到只放几位数字 */
.page-input {
  width: 46px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-label);
  text-align: center;
}

/* 演员名是可点的: 点了就把列表过滤到这个人 */
.actor {
  background: none;
  border: none;
  padding: 0 4px;
  color: var(--accent);
  font: inherit;
  font-size: var(--fs-label);
  cursor: pointer;
}

.actor:hover {
  text-decoration: underline;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: none;
  color: var(--accent);
  font-size: var(--fs-label);
  cursor: pointer;
}

.chip:hover {
  background: var(--panel-3);
}

/* 进行中的筛选: 反色, 一眼看出列表被条件限住了 */
.chip.on {
  background: var(--accent);
  color: var(--on-accent);
}

.banner {
  margin: 0 20px;
  padding: 8px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--warn);
  font-size: var(--fs-label);
}

.banner code {
  font-family: ui-monospace, monospace;
  color: var(--warn);
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.side {
  width: 240px;
  flex: none;
  border-right: 1px solid var(--line);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
}

.side-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--fs-label);
  color: var(--muted);
}

.libs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.libs button {
  width: 100%;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}

.libs li.active button {
  background: var(--panel-2);
  border-color: var(--line-strong);
}

.libs small {
  color: var(--muted);
  font-family: ui-monospace, monospace;
  font-size: var(--fs-label);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 主按钮撑满侧栏宽度, 是这一屏唯一的行动号召 */
.actions .primary {
  width: 100%;
  padding: 8px 12px;
  font-weight: 600;
}

.more summary {
  font-size: var(--fs-label);
  color: var(--muted);
  cursor: pointer;
  padding: 4px 2px;
  border-radius: var(--radius-sm);
  list-style: none;
}

.more summary::-webkit-details-marker {
  display: none;
}

.more summary::before {
  content: "▸ ";
}

.more[open] summary::before {
  content: "▾ ";
}

.more summary:hover,
.more summary:focus-visible {
  color: var(--text);
}

.more-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.sources {
  font-size: var(--fs-label);
  color: var(--muted);
  line-height: 1.8;
}

.sources .ready {
  color: var(--ok);
  margin-right: 8px;
}

.sources .todo {
  color: var(--muted);
  margin-right: 8px;
  text-decoration: line-through;
}

button {
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: #1e232d;
  color: var(--text);
  padding: 8px 12px;
  font-size: var(--fs-body);
  cursor: pointer;
}

button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}

button.danger {
  background: var(--danger-line);
  border-color: var(--danger-line);
  color: var(--text);
}

button.ghost {
  padding: 4px 12px;
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 20px;
  gap: 12px;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 8px;
}

.tabs button {
  background: transparent;
  border: 1px solid transparent;
  color: var(--muted);
}

.tabs button.on {
  color: var(--text);
  border-color: var(--line);
  background: var(--panel);
}

.spacer {
  flex: 1;
}

.st-running {
  color: var(--warn);
}
.st-done {
  color: var(--ok);
}
.st-interrupted,
.st-failed {
  color: var(--danger);
}

.progress {
  font-family: ui-monospace, monospace;
  font-size: var(--fs-label);
  color: var(--warn);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.pane.items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: var(--fs-body);
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 工具栏里的文字一律不折行: 挤不下就换行到下一行, 而不是压成竖排 */
.toolbar-row button,
.toolbar-row .nowrap {
  white-space: nowrap;
  flex: none;
}

.toolbar-row .spacer {
  flex: 1 1 0;
  min-width: 8px;
}

.row-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.row-actions button {
  padding: 4px 8px;
  font-size: var(--fs-label);
}

.split {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}

.list {
  flex: 1;
  min-width: 0;
  overflow: auto;
}

/* 进度条: 2px, 只在前景任务进行时出现, 不抢注意力 */
.task-bar {
  height: 2px;
  margin: 0 20px;
  border-radius: var(--radius-pill);
  background: var(--line);
  overflow: hidden;
}

.task-bar-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 200ms var(--ease);
}

/* 骨架屏: 首屏与扫描中代替空列表, 避免"正在扫却显示没有条目" */
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
}

.skeleton-row {
  display: block;
  height: 44px;
  border-radius: var(--radius-sm);
  background: linear-gradient(90deg, var(--panel) 0%, var(--panel-2) 50%, var(--panel) 100%);
  background-size: 200% 100%;
  animation: shimmer 1.4s var(--ease) infinite;
}

@keyframes shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

/* 减弱动效偏好: 骨架不闪, 进度条不补间 */
@media (prefers-reduced-motion: reduce) {
  .skeleton-row {
    animation: none;
  }
  .task-bar-fill,
  tbody tr {
    transition: none;
  }
}

.skeleton-hint {
  margin: 8px 0 0;
  text-align: center;
  font-size: var(--fs-label);
  color: var(--muted);
}

.empty {
  height: 100%;
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
}

.empty p {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--muted);
}

.empty .hint {
  font-size: var(--fs-label);
  max-width: 36ch;
}

table {
  width: 100%;
  /* 打开详情面板后表格区只剩一半宽度: 给它一条底线, 让它横向滚动, 而不是把列压到两三个字宽 */
  min-width: 620px;
  border-collapse: collapse;
  font-size: var(--fs-body);
}

th {
  text-align: left;
  color: var(--muted);
  font-weight: 500;
  font-size: var(--fs-label);
  padding: 8px;
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  background: var(--bg);
}


/* ---- 交互状态: 之前 hover/disabled/focus 一个都没有 ---- */
button:hover:not(:disabled) {
  border-color: #3a455c;
  background: #232935;
}

button:active:not(:disabled) {
  transform: translateY(1px);
}

button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

button:focus-visible,
input:focus-visible,
select:focus-visible,
summary:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

tbody tr {
  cursor: pointer;
  transition: background 120ms var(--ease);
}

tbody tr:hover {
  background: var(--panel);
}

tbody tr.active {
  background: var(--panel-2);
  box-shadow: inset 2px 0 0 var(--accent);
}

td {
  padding: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 标题这类长文本: 允许折两行, 鼠标悬停看完整内容 */
/* 番号格: 番号 + 类型小徽标, 省掉一整个「类型」列 */
/* 表头即排序开关: 保持表头的克制, 只在 hover 时提示可点 */
th .sort {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}

th .sort:hover {
  color: var(--text);
}

.sort-arrow {
  font-size: var(--fs-label);
  color: var(--accent);
}

td.num-cell {
  white-space: nowrap;
}

.num-cell .type-badge {
  margin-left: 8px;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  color: var(--muted);
  font-size: var(--fs-label);
  font-family: ui-sans-serif, system-ui, sans-serif;
}

td.title-cell {
  min-width: 240px;
  max-width: 380px;
  white-space: normal;
}

/* 两行截断必须作用在单元格内部: 直接把 td 变成 -webkit-box 会让表格行高错乱 */
td.title-cell > span {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  line-height: 1.4;
}

/*
 * 详情底部的图: 做成有边界的"画框", 而不是让图片裸在空白里。
 * - 画框吃掉字段下方剩余高度 (flex:1), 但最小 160px, 窗口再矮也不会压没
 * - 图片不设宽高, 只用 max-*: 小图 (比如 147x200 的缩略图) 保持自然尺寸不被放大糊掉
 * - object-fit: contain 保证任何比例都不裁切
 */
/* 封面按钮只为了让键盘也能打开大图, 视觉上就是那张图 */
.cover-zoom {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  background: none;
  cursor: zoom-in;
}

.lightbox {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: rgba(8, 10, 14, 0.86);
  animation: lightbox-in 160ms var(--ease);
}

.lightbox img {
  max-width: 100%;
  max-height: 100%;
  border-radius: var(--radius-md);
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.45),
    0 24px 64px rgba(0, 0, 0, 0.45);
}

.lightbox-close {
  position: absolute;
  top: 16px;
  right: 16px;
  font-size: var(--fs-section);
}

@keyframes lightbox-in {
  from {
    opacity: 0;
    transform: scale(0.985);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .lightbox {
    animation: none;
  }
}

.detail-cover {
  margin-top: 12px;
  flex: 1 1 auto;
  min-height: 160px;
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg);
}

.detail-cover img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-sm);
  /* 两层克制阴影: 让图从画框里"浮"起来一点, 不是贴纸 */
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.4),
    0 8px 24px rgba(0, 0, 0, 0.35);
}

tbody tr {
  cursor: pointer;
}

tbody tr.active {
  background: var(--panel-2);
}

th.pick,
td.pick {
  width: 32px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--fs-label);
  font-variant-numeric: tabular-nums;
}

.detail {
  width: 320px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--panel);
  padding: 12px;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.detail header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.detail ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.detail-type {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
  font-size: var(--fs-label);
}

.detail-type select {
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
}

.detail-type .hint {
  font-size: var(--fs-label);
}

.detail li {
  display: grid;
  grid-template-columns: 76px 1fr 20px 42px;
  gap: 8px;
  align-items: baseline;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  font-size: var(--fs-label);
}

.detail .label {
  color: var(--muted);
}

.detail .value {
  /* 详情是"看全"的地方, 长标题/长简介允许折行, 不要再截断 */
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.45;
}

/* 未锁的字段常态不显示锁图标: 每行一个 🔓 是纯噪音 */
.detail .pin {
  padding: 0;
  border: none;
  background: transparent;
  font-size: var(--fs-label);
  opacity: 0;
  transition: opacity 150ms var(--ease);
}

.detail li:hover .pin,
.detail li:focus-within .pin {
  opacity: 0.6;
}

/* 锁住的必须一直看得见 —— 它解释"为什么这个字段重刮也不变" */
.detail .pin.on {
  opacity: 1;
}

/* 来源在每行都重复同一个值, 常态显示只是噪音: 悬停该行才亮出来 */
.detail li .from {
  opacity: 0;
  transition: opacity 150ms var(--ease);
}

.detail li:hover .from,
.detail li:focus-within .from {
  opacity: 1;
}

.detail .from {
  color: var(--text-faint);
  font-family: ui-monospace, monospace;
  font-size: var(--fs-label);
  text-align: right;
}

.detail .hint {
  margin: 12px 0 0;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: var(--fs-body);
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-body);
}

.note {
  margin: 0;
  color: var(--ok);
  font-size: var(--fs-body);
}

.lib-config {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
  margin-bottom: 8px;
  font-size: var(--fs-body);
}

.lib-config select {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 8px;
  font-size: var(--fs-body);
  max-width: 320px;
}

.badge {
  font-size: var(--fs-label);
  color: var(--warn);
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  padding: 4px 12px;
  margin-left: 8px;
  vertical-align: middle;
}

.lib-config code,
.note-line code {
  color: var(--text);
  font-family: ui-monospace, monospace;
  font-size: var(--fs-label);
}

.note-line {
  margin: 0 0 12px;
}

.summary {
  font-size: var(--fs-body);
  color: var(--text);
}

.plan {
  list-style: none;
  margin: 0;
  padding: 0;
}

.plan li {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.plan .tag {
  flex: none;
  width: 84px;
  text-align: center;
  border-radius: 999px;
  background: var(--panel-3);
  color: var(--muted);
  font-size: var(--fs-label);
  padding: 4px 0;
}

.plan li[data-action="move"] .tag {
  color: var(--warn);
}

.plan li[data-action="copy-image"] .tag {
  color: var(--ok);
}

.apply {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.warn {
  color: var(--warn);
  font-size: var(--fs-body);
}

.settings h2 {
  font-size: var(--fs-section);
  margin: 16px 0 8px;
  color: var(--text);
}

.settings h2:first-child {
  margin-top: 0;
}

.settings .field {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.settings .field span {
  width: 110px;
  color: var(--muted);
  font-size: var(--fs-body);
}

.settings .field input {
  flex: 1;
  max-width: 420px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  color: var(--text);
  font-family: ui-monospace, monospace;
  font-size: var(--fs-body);
}

.settings .row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 4px 0 12px;
}

.src-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.src-list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  font-size: var(--fs-body);
}

.tag[data-ready="true"] {
  color: var(--ok);
}

.path {
  color: var(--muted);
  font-size: var(--fs-label);
  font-family: ui-monospace, monospace;
}

.events {
  display: flex;
  gap: 12px;
  overflow: hidden;
  white-space: nowrap;
  color: var(--muted);
  font-size: var(--fs-label);
  border-top: 1px solid var(--line);
  padding-top: 8px;
}

.events [data-type="file.added"] {
  color: var(--ok);
}
.events [data-type="file.removed"] {
  color: var(--danger);
}
</style>
