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

/** 任务类型/状态的中文名。库里的值是英文枚举, 不该直接印给人看。 */
const TASK_TYPE_LABEL: Record<string, string> = {
  "scrape.pending": "刮削 (待处理)",
  "scrape.keys": "刮削 (选中)",
  "translate.pending": "翻译 (待处理)",
  "translate.items": "翻译 (选中)",
  "nfo.sync": "同步 NFO",
};

const TASK_STATUS_LABEL: Record<string, string> = {
  queued: "排队",
  running: "进行中",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "中断",
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
/**
 * 改名输入框的引用。
 *
 * 用回调 ref 而不是 `ref="renameInput"`: 这个 input 在 `v-for` 里, 同名 ref 会被收集成
 * **数组**, 于是 `renameInput.value?.select()` 直接抛 "is not a function"。
 * 一次只可能有一行在改名, 所以回调只会在那一行拿到元素。
 */
const renameInput = ref<HTMLInputElement | null>(null);
function bindRenameInput(el: unknown): void {
  renameInput.value = (el as HTMLInputElement | null) ?? null;
}
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
/** 当前选中的库是不是影视域; 全部库时为 null (按 av 的界面走)。 */
const currentDomain = computed<"av" | "video" | null>(() => {
  if (selectedId.value === null) return null;
  return libraries.value.find((library) => library.id === selectedId.value)?.domain ?? "av";
});
/** 影视模式的界面分支 (电影与剧集在同一个域里, 由条目类型再分)。 */
const isVideoMode = computed(() => currentDomain.value === "video");
/** 盘上有、但不在声明集列表里的集数 —— 集号对不上的信号。 */
const undeclaredCount = computed(() => (episodeView.value?.episodes ?? []).filter((ep) => ep.undeclared).length);

/** 详情页按季分组。 */
const seasonGroups = computed(() => {
  const groups = new Map<number, KuraEpisode[]>();
  for (const episode of episodeView.value?.episodes ?? []) {
    const list = groups.get(episode.season) ?? [];
    list.push(episode);
    groups.set(episode.season, list);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([season, episodes]) => ({ season, episodes }));
});
/** 首次读库还没回来 —— 和"库里确实空"是两件事, 不能混成一个空状态。 */
const firstLoad = ref(true);
/**
 * 正在跑的那一行任务(库里 status = running)。
 *
 * 有些任务没有逐条事件可发(影视刮削是"一部剧一次请求", 进度由任务行自己推进),
 * 所以进度条必须能从任务行读, 不能只依赖 IPC 事件。
 */
const liveTask = computed(() => tasks.value.find((task) => task.status === "running") ?? null);
/** 长任务进度: 优先用实时事件, 没有就退回任务行的已处理/总数。 */
const taskProgress = computed(() => {
  const active = progress.value ?? translateProgress.value ?? nfoProgress.value;
  if (active?.total) return { index: active.index, total: active.total };
  const task = liveTask.value;
  if (task && task.total > 0) return { index: task.processed, total: task.total };
  return null;
});
const taskPercent = computed(() =>
  taskProgress.value ? Math.min(100, Math.round((taskProgress.value.index / taskProgress.value.total) * 100)) : 0,
);
const searchDraft = ref("");
/**
 * 传给 IPC 的数组一律过这里。
 *
 * Vue 的响应式数组是 Proxy, `ipcRenderer.invoke` 的结构化克隆克隆不了它 ——
 * 报错是难懂的 "An object could not be cloned"。这个坑踩过三次(nfo 番号、翻译选中、绑定),
 * 所以留一个显式函数, 让"要转普通值"这件事在调用处看得见。
 */
function plainArray<T>(values: readonly T[] | undefined): T[] {
  return values ? [...values] : [];
}

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
/** 影视库的未识别页: 一个候选 = 一部剧(目录) 或 一部电影(文件)。 */
const bindableDirs = ref<KuraBindableDir[]>([]);
/** 候选总数(分页用): 真库里可能有上百个电影候选。 */
const bindTotal = ref(0);
const bindLimit = ref(100);
/** 候选分类计数(剧 / 电影), 给工具栏说人话用。 */
const bindKinds = ref({ tv: 0, movie: 0 });
/** 候选筛选: 真库里电影候选可能几百个, 和剧混在一起看不过来。 */
const bindKind = ref<"" | "tv" | "movie">("tv");
/** 正在等确认删除的库 id (就地两段式确认, 不弹 window.confirm)。 */
const removingId = ref<number | null>(null);
/** 建库菜单: 先选域, 再选目录 (域决定识别方式, 事后改不了)。 */
const libMenu = ref(false);
/** 绑定对话框: 搜 TMDB → 选一部 → 绑整个目录。 */
const bindDialog = ref<{
  /** rebind 模式下没有候选(条目已经绑好了), 只用来显示标题。 */
  dir: KuraBindableDir | null;
  kind: "tv" | "movie";
  query: string;
  hits: KuraTmdbHit[];
  busy: boolean;
  /** rebind = 给已绑定条目换一个身份; bind = 把未绑定的候选绑上。 */
  mode?: "bind" | "rebind";
  /** rebind 模式: 要改的条目身份。 */
  rebindKey?: string;
  /** rebind 模式下的标题(条目当前名)。 */
  label?: string;
  /** 强制季号(同一部剧拆成多个目录时用): 空 = 按文件名/目录自动。 */
  season: string | number;
} | null>(null);

/** 已绑定条目的来源文件夹 (同一部剧可能来自多个目录)。 */
const itemDirs = ref<{ dir: string; files: number; episodeFrom: number | null; episodeTo: number | null; season: number | null }[]>([]);
/** 每行"改成第 N 季"的输入值。 */
// 注意: `<input type="number">` 上的 v-model 会被 Vue 转成 number(looseToNumber),
// 所以这里可能是 string, 也可能是 number —— 一律用 numberDraft() 读, 别直接 .trim()
const seasonDraft = ref<Record<string, string | number>>({});
/** 待绑定目录的搜索建议 (dir → 建议)。批量找建议的结果, 不是决定。 */
const suggestions = ref<Record<string, KuraBindingSuggestion>>({});
/** 勾选要绑的建议 (dir 列表)。 */
const suggestPicked = ref<string[]>([]);
const suggestBusy = ref(false);
/** 批量找建议的进度: 一个目录一次 TMDB 往返, 没有进度就像卡死。 */
const suggestProgress = ref<{ index: number; total: number; dir: string } | null>(null);
/** 打开中的剧的集列表 (影视条目才有)。 */
const episodeView = ref<{ key: string; episodes: KuraEpisode[]; stats: KuraEpisodeStats } | null>(null);
const unparsedCount = ref(0);
const unparsedPage = ref(0);
const unparsedPageSize = 100;
const progress = ref<{ index: number; total: number; key: string; ok: boolean } | null>(null);
const tasks = ref<KuraTask[]>([]);
/** 展开的那条任务的失败清单: 只有点开时才去读 jsonl */
const openTaskId = ref<number | null>(null);
const taskFailureList = ref<KuraTaskFailure[]>([]);
/** 正在跑的任务叫什么 —— 任务页顶部那张"当前任务"卡片用它 */
const runningLabel = ref<string>("");
const nfoProgress = ref<{ index: number; total: number; key: string } | null>(null);
const nfoDialog = ref<{
  open: boolean;
  phase: "preview" | "running" | "done";
  report: KuraNfoSyncReport | null;
  errorsOnly: boolean;
}>({ open: false, phase: "preview", report: null, errorsOnly: false });
/** 有多少个条目的 .nfo 还没和库对齐 (扫描/刮削后算出来, 点一下就去同步) */
const nfoHint = ref(0);

const config = ref<KuraConfig | null>(null);
const apiIdInput = ref("");
const affiliateInput = ref("");
const proxyInput = ref("");
const llmBaseUrlInput = ref("");
const llmApiKeyInput = ref("");
/** 影视来源 (TMDB) 的 key 输入框; 留空表示不改。 */
const tmdbKeyInput = ref("");
const tmdbTest = ref<KuraTmdbTest | null>(null);
const llmModelInput = ref("");
const translateOn = ref(false);
const dmmTest = ref<KuraDmmTest | null>(null);

let unsubscribe: (() => void) | null = null;
let unsubscribeProgress: (() => void) | null = null;
let unsubscribeSuggest: (() => void) | null = null;
let unsubscribeTranslate: (() => void) | null = null;
let unsubscribeNfo: (() => void) | null = null;

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
  unsubscribeNfo = window.kura.onNfoProgress((update) => {
    nfoProgress.value = { index: update.index, total: update.total, key: update.key };
  });
  unsubscribeSuggest = window.kura.onSuggestProgress((update) => {
    suggestProgress.value = update;
  });
  unsubscribeProgress = window.kura.onScrapeProgress((update) => {
    progress.value = update;
    // 每 5 条刷一次当前页: 刮到的结果立刻可见, 又不会每条都去查库。
    if (update.index > 0 && update.index % 5 === 0) void refreshItems();
  });
  await refreshAll();
});

onUnmounted(() => {
  stopTasksPolling();
  unsubscribeSuggest?.();
  unsubscribe?.();
  unsubscribeProgress?.();
  unsubscribeTranslate?.();
  unsubscribeNfo?.();
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

/** 任务页随时反映库里的状态: 切过去就读一次, 别等刷新整页。 */
async function refreshTasks(): Promise<void> {
  tasks.value = (await window.kura.tasks(20)) ?? tasks.value;
}

/**
 * 任务页轮询。
 *
 * 任务在**主进程里同步跑**, 库里的 processed 由 runTask 每 500ms 对齐一次;
 * 渲染进程除了收到几条专门的进度事件(刮削/翻译/NFO)之外, 对其它任务一无所知。
 * 没有守护进程, 也就没有"任务完成时推一条事件"的通路 —— 所以界面上停在任务页时
 * 自己读库, 有任务在跑就勤一点(0.7s), 只是看看历史就慢一点(3s)。
 */
let tasksPollTimer: number | null = null;

function stopTasksPolling(): void {
  if (tasksPollTimer !== null) {
    window.clearTimeout(tasksPollTimer);
    tasksPollTimer = null;
  }
}

/** 排下一次轮询: 有任务在跑就勤, 只是看历史就懒。离开任务页立刻停。 */
function scheduleTasksPoll(delay: number): void {
  stopTasksPolling();
  if (tab.value !== "tasks") return;
  tasksPollTimer = window.setTimeout(() => {
    if (tab.value !== "tasks") return;
    void refreshTasks().finally(() => {
      const busy = tasks.value.some((task) => task.status === "running" || task.status === "queued");
      scheduleTasksPoll(busy ? 700 : 3000);
    });
  }, delay);
}

watch(tab, (value) => {
  if (value === "tasks") {
    void refreshTasks();
    scheduleTasksPoll(700);
  } else {
    stopTasksPolling();
  }
});

async function refreshUnparsed(): Promise<void> {
  const result = await window.kura.unparsedFiles({
    libraryId: selectedId.value ?? undefined,
    limit: unparsedPageSize,
    offset: unparsedPage.value * unparsedPageSize,
  });
  unparsedFiles.value = result.files;
  unparsedCount.value = result.total;

  // 影视库的"未识别"是候选级的: 剧 = 一个目录, 电影 = 一个文件
  if (isVideoMode.value) {
    const result = await window.kura
      .bindableDirs(selectedId.value ?? undefined, {
        limit: bindLimit.value,
        ...(bindKind.value ? { kind: bindKind.value } : {}),
      })
      .catch(() => ({ dirs: [] as KuraBindableDir[], total: 0, tv: 0, movie: 0 }));
    bindableDirs.value = result.dirs;
    bindTotal.value = result.total;
    bindKinds.value = { tv: result.tv, movie: result.movie };
  } else {
    bindableDirs.value = [];
    bindTotal.value = 0;
    bindKinds.value = { tv: 0, movie: 0 };
  }
}

/** 打开详情时顺带读集列表 (只有影视条目有)。 */
async function loadEpisodes(key: string, domain: string | undefined): Promise<void> {
  episodeView.value = null;
  itemDirs.value = [];
  if (!domain || domain === "av") return;
  try {
    episodeView.value = await window.kura.itemEpisodes(key);
    // 同一部剧可能来自多个目录(仁医 / 仁医2), 各自可能是不同季
    const dirs = await window.kura.itemDirs(key).catch(() => ({ dirs: [] }));
    itemDirs.value = dirs.dirs.filter((dir) => dir.files > 1 || dir.season !== null);
  } catch {
    episodeView.value = null;
  }
}

/**
 * 按"整部剧的绝对集号"把文件摊到各季。
 *
 * 国内合集包常是 `001集 … 165集` 跨季连续编号, 文件名里没有季号 ——
 * 全落在第 1 季, 于是集号与声明的第 1 季对不上。
 */
async function spreadSeasons(): Promise<void> {
  if (!detail.value) return;
  try {
    const result = await window.kura.spreadSeasons(detail.value.key);
    note.value = `已按播出顺序摊到各季: ${result.mapped} 个文件 (${result.from} → ${result.to})${
      result.unmapped > 0 ? ` · ${result.unmapped} 个文件超出声明的 ${result.declared} 集` : ""
    }`;
    await loadEpisodes(detail.value.key, detail.value.domain);
  } catch (err) {
    errors.value.push(`摊到各季: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 把某个来源目录整体改成第 N 季。 */
async function applyDirSeason(dir: string): Promise<void> {
  if (selectedId.value === null || !detail.value) return;
  const season = Number(numberDraft(seasonDraft.value[dir]));
  if (!Number.isInteger(season) || season < 0) {
    errors.value.push("季号要填非负整数");
    return;
  }
  try {
    const result = await window.kura.setDirSeason(selectedId.value, dir, season, detail.value.key);
    note.value = `「${dir.split(/[\\/]/).pop()}」已改为第 ${result.season} 季: ${result.files} 个文件`;
    seasonDraft.value[dir] = "";
    await loadEpisodes(detail.value.key, detail.value.domain);
    await refreshTasks().catch(() => undefined);
  } catch (err) {
    errors.value.push(`改季: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 批量找建议: 把"待绑定目录"逐个拿去搜 TMDB, 给出建议并默认勾上高把握的。
 * 只是把搜索这一步自动化 —— 绑哪个仍然要人看一眼。
 */
async function findSuggestions(): Promise<void> {
  if (selectedId.value === null) return;
  suggestBusy.value = true;
  suggestProgress.value = { index: 0, total: 0, dir: "准备中" };
  runningLabel.value = `找绑定建议 · ${selected.value?.name ?? ""}`;
  try {
    // 只搜当前筛选的那一类: 电影候选几百个, 一起搜会卡很久且大多没结果
    const result = await window.kura.tmdbSuggest(selectedId.value, bindKind.value || undefined);
    if (result.error) {
      errors.value.push(result.error);
      return;
    }
    suggestions.value = Object.fromEntries(result.suggestions.map((item) => [item.dir, item]));
    // 默认只勾"片名与年份都对上"的: 中等把握也要人点, 免得一次误绑一整批
    suggestPicked.value = result.suggestions
      .filter((item) => item.confidence === "high" && item.hit)
      .map((item) => item.dir);
    const total = result.suggestions.length;
    const hit = result.suggestions.filter((item) => item.hit).length;
    note.value = result.cancelled
      ? `已停止 · 完成 ${total} 个目录 (${hit} 个有建议)`
      : `找到 ${hit}/${total} 个建议 · 已勾选 ${suggestPicked.value.length} 个高把握的, 确认后一次绑完`;
    // 任务记录了这次搜索, 任务页能看到进度与结果
    void refreshTasks();
  } catch (err) {
    errors.value.push(`批量找建议: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    suggestBusy.value = false;
    suggestProgress.value = null;
    runningLabel.value = "";
  }
}

function toggleSuggest(dir: string): void {
  suggestPicked.value = suggestPicked.value.includes(dir)
    ? suggestPicked.value.filter((item) => item !== dir)
    : [...suggestPicked.value, dir];
}

/** 把勾选的建议一次绑完(逐个绑 + 顺手刮)。 */
async function bindPicked(): Promise<void> {
  if (selectedId.value === null || suggestPicked.value.length === 0) return;
  const items = suggestPicked.value
    .map((dir) => suggestions.value[dir])
    .filter((item): item is KuraBindingSuggestion => Boolean(item?.hit))
    .map((item) => ({ dir: item.dir, key: item.hit!.key, paths: plainArray(item.paths) }));
  if (items.length === 0) return;

  suggestBusy.value = true;
  try {
    const { results } = await window.kura.bindMany(selectedId.value, items);
    const ok = results.filter((item) => item.ok);
    const failed = results.filter((item) => !item.ok);
    const episodes = ok.reduce((sum, item) => sum + (item.declared ?? 0), 0);
    const missing = ok.reduce((sum, item) => sum + (item.missing ?? 0), 0);
    note.value = `已绑定 ${ok.length} 个${failed.length > 0 ? `, 失败 ${failed.length} 个` : ""} · 声明 ${episodes} 集 · 缺 ${missing} 集`;
    if (failed.length > 0) {
      errors.value.push(...failed.map((item) => `${item.dir.split(/[\\/]/).pop()}: ${item.error ?? "未知原因"}`));
    }
    suggestions.value = {};
    suggestPicked.value = [];
    await refreshAll();
  } catch (err) {
    errors.value.push(`绑定: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    suggestBusy.value = false;
  }
}

/** 已绑定的影视条目: 换一个 TMDB 身份。 */
function openRebindDialog(): void {
  if (!detail.value || detail.value.domain === "av") return;
  bindDialog.value = {
    dir: null,
    kind: detail.value.domain === "tv" ? "tv" : "movie",
    // 预填当前标题, 名字不对就自己改 —— 大多数改绑都是"搜错了一部同名的"
    query: detail.value.title ?? "",
    hits: [],
    busy: false,
    mode: "rebind",
    rebindKey: detail.value.key,
    label: `${detail.value.title ?? detail.value.key}`,
    season: "",
  };
}

/** 解绑: 退回未识别, 之后可以在未识别页重新选。 */
async function unbindCurrent(): Promise<void> {
  if (!detail.value || detail.value.domain === "av") return;
  const key = detail.value.key;
  try {
    const result = await window.kura.unbindItem(key);
    detail.value = null;
    episodeView.value = null;
    await refreshAll();
    note.value = `已解绑 ${key}: ${result.unbound} 个文件退回未识别，可以在「未识别」页重新绑`;
  } catch (err) {
    errors.value.push(`解绑: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 读数字输入框: v-model 可能给 string 也可能给 number(number 输入框)。 */
function numberDraft(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** 打开绑定面板: 预填建议里的搜索词(已剥掉年份/发布标记), 没有就用候选名。 */
function openBindDialog(dir: KuraBindableDir): void {
  bindDialog.value = {
    dir,
    kind: dir.kind === "tv" ? "tv" : "movie",
    query: suggestions.value[dir.dir]?.query || dir.name,
    hits: [],
    busy: false,
    season: "",
  };
}

/** 绑定对话框: 先搜 TMDB, 再绑整个目录并顺手刮一次。 */
async function searchTmdb(): Promise<void> {
  const dialog = bindDialog.value;
  if (!dialog || dialog.query.trim().length === 0) return;
  dialog.busy = true;
  try {
    dialog.hits = await window.kura.tmdbSearch(dialog.kind, dialog.query.trim());
  } catch (err) {
    errors.value.push(`搜索 TMDB: ${err instanceof Error ? err.message : String(err)}`);
    dialog.hits = [];
  } finally {
    dialog.busy = false;
  }
}

async function bindDir(hit: KuraTmdbHit): Promise<void> {
  const dialog = bindDialog.value;
  if (!dialog) return;

  // 改绑: 不新建条目, 把旧条目的文件转到新身份
  if (dialog.mode === "rebind" && dialog.rebindKey) {
    dialog.busy = true;
    try {
      const result = await window.kura.rebindItem(dialog.rebindKey, hit.key);
      bindDialog.value = null;
      // 先把详情指到新身份再刷新: refreshAll 会用旧 key 去查, 查不到就把面板关了
      detail.value = await window.kura.item(hit.key).catch(() => null);
      await refreshAll();
      await loadEpisodes(hit.key, detail.value?.domain ?? dialog.kind);
      note.value = `已改绑到「${hit.title}」: ${result.moved} 个文件${
        result.scraped ? ` · 声明 ${result.scraped.declared} 集 · 缺 ${result.scraped.missing} 集` : ""
      }`;
    } catch (err) {
      errors.value.push(`改绑: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      dialog.busy = false;
    }
    return;
  }

  if (selectedId.value === null || !dialog.dir) return;
  const candidate = dialog.dir;
  dialog.busy = true;
  try {
    // paths 来自 Vue 的响应式对象, 直接传会抛 "An object could not be cloned"
    const seasonText = numberDraft(dialog.season);
    const season = seasonText === "" ? undefined : Number(seasonText);
    const result = await window.kura.bindDir(
      selectedId.value,
      candidate.dir,
      hit.key,
      plainArray(candidate.paths),
      season,
    );
    const scraped = (result as { scraped?: { declared: number; bound: number; missing: number } | null }).scraped;
    note.value = scraped
      ? `已绑定「${hit.title}」: ${result.bound} 个文件 · ${result.episodes} 集 · 缺 ${scraped.missing} 集${
          result.stillUnparsed.length > 0 ? ` · ${result.stillUnparsed.length} 个文件还缺集号` : ""
        }`
      : `已绑定「${hit.title}」: ${result.bound} 个文件 · ${result.episodes} 集`;
    bindDialog.value = null;
    await refreshAll();
  } catch (err) {
    errors.value.push(`绑定: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    dialog.busy = false;
  }
}

async function rescrapeShow(): Promise<void> {
  if (!detail.value || detail.value.domain === "av") return;
  try {
    const report = await window.kura.scrapeShow(detail.value.key);
    note.value = report.ok
      ? `已刮削: ${report.fields.length} 个字段 · ${report.declared} 集（盘上 ${report.bound} 集，缺 ${report.missing}）`
      : `刮削失败: ${report.error ?? "未知原因"}`;
    await refreshAll();
    await loadEpisodes(detail.value.key, detail.value.domain);
  } catch (err) {
    errors.value.push(`刮削: ${err instanceof Error ? err.message : String(err)}`);
  }
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

/** 详情页"打开位置"的候选文件夹(一个条目可能横跨多个目录)。 */
const revealDirs = ref<{ dir: string; files: number }[] | null>(null);

/**
 * 详情里打开"这一部在磁盘上的位置"。
 *
 * 一个条目可能横跨多个目录(仁医 / 仁医2 是两个季), 这时**不能默默打开第一个** ——
 * 用户点的可能是第二季的文件。多个目录时先弹出清单让人选。
 */
async function revealItem(): Promise<void> {
  const key = detail.value?.key;
  if (!key) return;
  const files = await window.kura.itemFiles(key);
  if (files.length === 0) {
    note.value = `${key} 还没有登记到任何文件`;
    return;
  }
  const dirs = new Map<string, number>();
  for (const file of files) {
    const dir = file.path.slice(0, Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\")));
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  if (dirs.size === 1) {
    revealDirs.value = null;
    await reveal(files[0]!.path);
    return;
  }
  revealDirs.value = [...dirs.entries()].map(([dir, count]) => ({ dir, files: count }));
}

async function revealDir(dir: string): Promise<void> {
  revealDirs.value = null;
  await reveal(dir);
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

/** 侧栏库名与路径重复时不显示路径 (库里叫"电影库", 路径尾巴也是它)。 */
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
  // 只把光标放到末尾, 不做全选: 深色主题下"全选高亮"的默认样式是一团灰,
  // 看着像输入框坏了。想整段替换的人按 Ctrl+A 就行。
  void nextTick(() => {
    const input = renameInput.value;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
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

async function addLibrary(domain: "av" | "video" = "av"): Promise<void> {
  libMenu.value = false;
  const library = await run("添加媒体库", () => window.kura.addLibrary(domain));
  if (library) {
    await refreshAll();
    selectedId.value = library.id;
    note.value = `已添加 ${library.name}`;
  }
}

/** 删库: 只删库与文件索引, 磁盘上什么都不动。 */
async function removeLibrary(library: KuraLibrary): Promise<void> {
  try {
    const result = await window.kura.removeLibrary(library.id);
    removingId.value = null;
    if (selectedId.value === library.id) selectedId.value = null;
    await refreshAll();
    note.value = `已删除库「${result.library.name}」: 索引里的 ${result.removedFiles} 个文件已移除, 磁盘上的文件一个都没动。${
      result.orphanItems > 0 ? ` 库里还有 ${result.orphanItems} 个条目没有被任何文件指向。` : ""
    }`;
  } catch (err) {
    errors.value.push(`删除媒体库: ${err instanceof Error ? err.message : String(err)}`);
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
    // 影视库的"未识别"是**目录级**的(一个目录 = 一部剧/电影), av 库是文件级的。
    // 两者混着说会出现"未识别 2"但页签写着 10 的自相矛盾。
    note.value = isVideoMode.value
      ? `扫描完成: 新增 ${counts.added} 个文件 · 待绑定目录 ${counts.shows} 个${
          counts.unparsed ? ` (其中 ${counts.unparsed} 个文件认不出集号)` : ""
        }${counts.auxiliary ? ` · 跳过辅助媒体 ${counts.auxiliary}` : ""}`
      : `扫描完成: 新增 ${counts.added} · 更新 ${counts.updated} · 未变 ${counts.unchanged} · 未识别 ${counts.unparsed}${counts.auxiliary ? ` · 跳过辅助媒体 ${counts.auxiliary}` : ""}${counts.retyped ? ` · 修正内容类型 ${counts.retyped} 条` : ""}`;
    // 扫描不再读 nfo: 有 nfo 没读进来时明确告诉人下一步做什么, 别静默丢功能。
    nfoHint.value = counts.nfoPending ?? 0;
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
  // 有任务行就会出现在「任务」页, 所以直接把视图切过去 —— 否则人不知道进度去哪看。
  tab.value = "tasks";
  runningLabel.value = `刮削 · ${selected.value?.name ?? "全部库"}`;
  progress.value = { index: 0, total: 0, key: "准备中", ok: true };
  // 不再固定 20 条: 待刮削多少就跑多少(进度与停止已有)
  const batch = await run("刮削", () => window.kura.scrapePending(pendingTotal.value || 1000));
  progress.value = null;
  runningLabel.value = "";
  if (batch) {
    const failed = batch.reports.filter((report) => !report.ok);
    note.value = batch.cancelled
      ? `已取消: 完成 ${batch.reports.length}/${batch.total} 条`
      : `刮削 ${batch.reports.length} 条, 失败 ${failed.length} 条${failed[0]?.error ? ` (${failed[0].error})` : ""}`;
    // 刮完不代表 Emby 看得到: nfo 还是旧的。数一下有多少条能写回, 给一条可点的提示。
    nfoHint.value = batch.reports.filter((report) => report.ok).length;
    await refreshAll();
  }
}

async function translateAll(): Promise<void> {
  if (!info.value?.translate) {
    note.value = "先在「设置」里配置 LLM 并打开翻译开关";
    return;
  }
  tab.value = "tasks";
  runningLabel.value = "翻译 · 待处理";
  translateProgress.value = { index: 0, total: 0, key: "准备中" };
  const result = await run("批量翻译", () => window.kura.translatePending(1000));
  translateProgress.value = null;
  runningLabel.value = "";
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
  tab.value = "tasks";
  runningLabel.value = `翻译选中 · ${picked.value.length} 条`;
  translateProgress.value = { index: 0, total: picked.value.length, key: "准备中" };
  // 必须传普通数组: picked 是 Vue 的响应式代理, IPC 的结构化克隆克隆不了它
  // (报错是 "An object could not be cloned")。
  const keys = [...picked.value];
  const result = await run("翻译选中", () => window.kura.translateItems(keys));
  translateProgress.value = null;
  runningLabel.value = "";
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

/** 展开一条任务的失败清单(从 jsonl 读, 不查库)。 */
async function toggleTaskFailures(task: KuraTask): Promise<void> {
  if (openTaskId.value === task.id) {
    openTaskId.value = null;
    taskFailureList.value = [];
    return;
  }
  openTaskId.value = task.id;
  taskFailureList.value = (await window.kura.taskFailures(task.id)) ?? [];
}

function formatTime(seconds: number | null): string {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 「停止」按钮按当前在跑的东西分派 —— 三者共用一个 AbortController。 */
async function cancelRunning(): Promise<void> {
  await window.kura.cancelScrape();
}

/** 任务类型与状态在库里是英文枚举, 界面上必须说人话。 */
function taskTypeLabel(type: string): string {
  const label = TASK_TYPE_LABEL[type];
  return label ?? type;
}

function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABEL[status] ?? status;
}

/** 重跑 = 立刻再跑一遍。onlyFailed 时只跑那条任务里失败的番号。 */
async function retryTask(task: KuraTask, onlyFailed: boolean): Promise<void> {
  runningLabel.value = `${taskTypeLabel(task.type)} · ${onlyFailed ? "重跑失败项" : "整批重跑"}`;
  tab.value = "tasks";
  const rerun = await run("重跑任务", () => window.kura.retryTask(task.id, onlyFailed));
  runningLabel.value = "";
  openTaskId.value = null;
  taskFailureList.value = [];
  await refreshAll();
  if (rerun) note.value = `已重跑 #${task.id} → 新任务 #${rerun.taskId} (${rerun.count} 条)`;
}

async function openDetail(item: KuraItem): Promise<void> {
  const fresh = await run("读取条目", () => window.kura.item(item.key));
  if (fresh) detail.value = fresh;
  await loadEpisodes(item.key, item.domain);
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
  tab.value = "tasks";
  runningLabel.value = `刮削选中 · ${picked.value.length} 条`;
  const result = await run("刮削", () => window.kura.scrapeKeys([...picked.value]));
  runningLabel.value = "";
  if (result) {
    const failed = result.reports.filter((entry) => !entry.ok);
    note.value = `刮削 ${result.reports.length} 条, 失败 ${failed.length} 条${failed[0]?.error ? ` (${failed[0].error})` : ""}`;
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

/**
 * 回写 NFO: 先干跑拿到清单, 人确认了才写。
 *
 * 这个动作改的是用户磁盘上的文件, 所以绝不允许"点了就跑" —— 而且默认跳过
 * 没联网刮过的条目(回写只是把旧值抄一遍)。
 */
/**
 * 同步 NFO: 先干跑, 把清单放进模态面板给人看, 确认后才写。
 *
 * 不能用 window.confirm —— 它只能塞纯文本: 2641 个文件的清单放不下、失败项标不红、
 * 也没法复制。面板里能滚动、能按原因看失败、失败项还能单独重跑。
 */
async function writeNfoFiles(numbers?: string[]): Promise<void> {
  if (!selected.value) return;
  nfoDialog.value = { open: true, phase: "preview", report: null, errorsOnly: false };
  nfoProgress.value = { index: 0, total: 0, key: "准备中" };
  const report = await run(
    "检查 NFO",
    () =>
      window.kura.syncNfo({
        libraryId: selected.value!.id,
        ...(numbers ? { numbers } : {}),
      }),
  );
  nfoProgress.value = null;
  if (!report) {
    nfoDialog.value = { open: false, phase: "preview", report: null, errorsOnly: false };
    return;
  }
  nfoDialog.value = { open: true, phase: "preview", report: slimNfoReport(report), errorsOnly: false };
  if (report.created + report.written + report.imported === 0) {
    // 没有任何要改的: 不需要人再点一次"写入"
    nfoDialog.value.phase = "done";
  }
}

/** 面板里点「写入」/「重试失败项」。 */
async function applyNfoSync(): Promise<void> {
  const report = nfoDialog.value.report;
  if (!selected.value || !report) return;
  const failed = report.entries.filter((entry) => entry.error).map((entry) => entry.number);
  const numbers = nfoDialog.value.errorsOnly ? failed : undefined;
  nfoDialog.value.phase = "running";
  nfoProgress.value = { index: 0, total: 0, key: "准备中" };
  runningLabel.value = `同步 NFO · ${selected.value.name}${numbers ? " (重试失败项)" : ""}`;
  const applied = await run(
    "同步 NFO",
    () =>
      window.kura.syncNfo({
        libraryId: selected.value!.id,
        apply: true,
        ...(numbers ? { numbers } : {}),
      }),
  );
  nfoProgress.value = null;
  runningLabel.value = "";
  if (applied) {
    nfoDialog.value = { open: true, phase: "done", report: slimNfoReport(applied), errorsOnly: false };
    nfoHint.value = 0;
    if (applied.imported > 0) await refreshAll();
    note.value = `NFO 同步完成: 写回 ${applied.written} · 新建 ${applied.created} · 读入 ${applied.imported}${applied.errors ? ` · 失败 ${applied.errors}` : ""}`;
  } else {
    nfoDialog.value.phase = "preview";
  }
}

/**
 * 面板只需要"有变化 + 失败"的条目 —— 把 4000 条 skip 塞进响应式状态会被 Vue 全量代理,
 * 渲染直接卡几秒(实测主进程探活往返 2.4s)。这里先瘦身: 丢掉 skip, 截断、砍掉长字段。
 */
function slimNfoReport(report: KuraNfoSyncReport): KuraNfoSyncReport {
  const keep = report.entries.filter((entry) => entry.action !== "skip" || entry.error);
  const limited = keep.slice(0, 500).map((entry) => ({
    ...entry,
    changed: entry.changed.slice(0, 3).map((text) => (text.length > 120 ? `${text.slice(0, 120)}…` : text)),
  }));
  return { ...report, entries: limited };
}

/** 面板里"只看失败"。 */
function nfoEntries(report: KuraNfoSyncReport): KuraNfoSyncEntry[] {
  const list = report.entries.filter((entry) => entry.action !== "skip");
  if (!nfoDialog.value.errorsOnly) return list;
  return report.entries.filter((entry) => entry.error);
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
    tmdbApiKey?: string;
  } = {};
  if (apiIdInput.value.trim()) patch.apiId = apiIdInput.value.trim();
  if (affiliateInput.value.trim()) patch.affiliateId = affiliateInput.value.trim();
  patch.proxy = proxyInput.value.trim();
  if (llmBaseUrlInput.value.trim()) patch.llmBaseUrl = llmBaseUrlInput.value.trim();
  if (llmApiKeyInput.value.trim()) patch.llmApiKey = llmApiKeyInput.value.trim();
  if (llmModelInput.value.trim()) patch.llmModel = llmModelInput.value.trim();
  if (tmdbKeyInput.value.trim()) patch.tmdbApiKey = tmdbKeyInput.value.trim();
  patch.translate = translateOn.value;

  const changed =
    patch.apiId || patch.affiliateId || patch.proxy || patch.llmBaseUrl || patch.llmApiKey || patch.llmModel ||
    patch.tmdbApiKey || patch.translate !== Boolean(config.value?.settings.translate);
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
    tmdbKeyInput.value = "";
    tmdbTest.value = null;
    await refreshAll();
    note.value = `已保存到 ${config.value?.path ?? "配置文件"}`;
  }
}

function openDataDir(): void {
  void window.kura.openDataDir();
}

/** 测试 TMDB: 真发一次请求, 验 key + 语言 + 网络。 */
async function testTmdb(): Promise<void> {
  tmdbTest.value = null;
  try {
    tmdbTest.value = await window.kura.tmdbTest();
  } catch (err) {
    tmdbTest.value = { ok: false, status: "ERROR", error: err instanceof Error ? err.message : String(err) };
  }
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
          <button
            class="ghost"
            type="button"
            aria-label="添加媒体库"
            title="添加媒体库"
            :disabled="busy"
            @click="libMenu = !libMenu"
          >
            +
          </button>
          <!-- 域决定识别方式、来源与模板, 建库时落定就改不了, 所以必须先选 -->
          <div v-if="libMenu" class="lib-menu" role="menu">
            <button type="button" role="menuitem" @click="addLibrary('av')">
              <strong>番号制</strong>
              <small>番号识别 · DMM/JavBus/JavDB</small>
            </button>
            <button type="button" role="menuitem" @click="addLibrary('video')">
              <strong>影视</strong>
              <small>TMDB · 剧集按季分集, 电影一个文件一部 (可以混着放)</small>
            </button>
          </div>
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
            <!-- 改名: 就地一条输入 + 显式的保存/取消。不用 blur 提交 ——
                 点保存时 blur 会先触发一次, 结果是"保存成功但界面报错" -->
            <form v-if="renamingId === library.id" class="lib-edit" @submit.prevent="commitRename(library)">
              <input
                :ref="bindRenameInput"
                v-model="renameDraft"
                type="text"
                aria-label="媒体库名称"
                @keyup.esc="cancelRename"
              />
              <button type="submit" class="lib-edit-ok" title="保存" aria-label="保存名称">✓</button>
              <button type="button" title="取消" aria-label="取消改名" @click="cancelRename">✕</button>
            </form>
            <!-- 删库只删索引, 这句话必须让人看见 —— 否则没人敢点 -->
            <div v-else-if="removingId === library.id" class="lib-confirm">
              <p>
                删除「{{ library.name }}」的索引？
                <span class="muted">磁盘上的文件不会被删除。</span>
              </p>
              <div class="lib-confirm-actions">
                <button type="button" class="danger" @click="removeLibrary(library)">删除索引</button>
                <button type="button" @click="removingId = null">取消</button>
              </div>
            </div>
            <div v-else class="lib-row">
              <button type="button" class="lib" @click="selectLibrary(library.id)">
                <strong>
                  {{ library.name }}
                  <span v-if="library.domain === 'video'" class="badge accent">影视</span>
                </strong>
                <!-- 「只索引」放第二行: 第一行留给名字, 悬停时的动作按钮会盖住行尾,
                     角标放第一行会被切成半个空胶囊 -->
                <small v-if="showRoot(library)" :title="library.root">
                  <span v-if="library.organizeEnabled === false" class="badge">只索引</span>
                  {{ library.root }}
                </small>
              </button>
              <!-- 悬停/键盘聚焦才出现: 常驻两个图标会让整列看起来像工具栏 -->
              <div class="lib-actions">
                <button type="button" title="改名" aria-label="重命名媒体库" @click.stop="startRename(library)">✎</button>
                <button
                  type="button"
                  class="danger-action"
                  title="删除这个库（只删索引）"
                  aria-label="删除媒体库"
                  @click.stop="removingId = library.id"
                >
                  ✕
                </button>
              </div>
            </div>
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
              <button
                type="button"
                :disabled="busy || !selected"
                title="双向同步: 库里没数据的读 nfo 补进来, 有网络数据的把库写回 .nfo (Emby/Jellyfin 读的是它)。先列清单, 确认后才动"
                @click="writeNfoFiles()"
              >
                同步 NFO
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
            <!-- 影视库的"未识别"是目录级的, 标签上的数字也跟着换成目录数 -->
            未识别 ({{ isVideoMode ? bindableDirs.length : unparsedCount }})
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

        <!-- 刮削/扫描之后的一致性提醒: 不自动写盘, 但必须把人顶到那一步 -->
        <div v-if="nfoHint > 0 && !busy" class="nfo-hint">
          <span>有 {{ nfoHint }} 个条目的 NFO 还没和库对齐 —— Emby / Jellyfin 读的是文件, 不是这里。</span>
          <button type="button" class="chip" @click="writeNfoFiles()">同步 NFO</button>
          <button type="button" class="ghost" aria-label="忽略提示" title="忽略" @click="nfoHint = 0">×</button>
        </div>

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
                :title="`还没联网刮到过、且还能自动重试的条目 (共 ${pendingTotal} 条)`"
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
                共 {{ itemTotal }} 条 ·
                <button type="button" class="link" :class="{ on: filters.state === 'unscraped' }" @click="applyFilter('state', 'unscraped')">
                  可自动刮削 {{ pendingTotal }}
                </button>
                <template v-if="exhaustedTotal > 0">
                  · <button type="button" class="link warn" :class="{ on: filters.state === 'exhausted' }" @click="applyFilter('state', 'exhausted')">
                    需手动重试 {{ exhaustedTotal }}
                  </button>
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

          <p v-if="filters.state === 'exhausted'" class="muted exhausted-hint">
            这 {{ exhaustedTotal }} 条有元数据（多半是从 nfo 读来的），但从没联网刮成功过，已试满 {{ 3 }} 次。
            勾选后点「刮削选中」可以再试一次；网络拿到值会覆盖 nfo 带来的旧值。
          </p>

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
                      <span v-if="item.contentType" class="type-badge">
                        {{ TYPE_LABEL[item.contentType] ?? item.contentType }}
                      </span>
                      <span v-if="item.pinned.length" title="有锁定字段" aria-label="有锁定字段">🔒</span>
                    </td>
                    <td class="title-cell" :title="item.title ?? ''">
                      <div class="title-line">
                        <span class="title-text">{{ displayTitle(item) }}</span>
                        <!-- 影视条目: 盘上/声明集数。缺集不是错误, 只是信息 -->
                        <span
                          v-if="item.episodeStats"
                          class="badge ep-badge"
                          :class="{ warn: item.episodeStats.bound < item.episodeStats.declared }"
                          :title="`盘上 ${item.episodeStats.bound} 集 / 声明 ${item.episodeStats.declared} 集`"
                        >
                          {{ item.episodeStats.bound }}/{{ item.episodeStats.declared }}
                        </span>
                      </div>
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
              <div v-else-if="items.length === 0" class="empty">
                <template v-if="hasFilters">
                  <p>没有符合当前筛选条件的条目。</p>
                  <button type="button" class="chip" @click="clearFilters">清空筛选</button>
                </template>
                <template v-else-if="libraries.length === 0">
                  <p>还没有媒体库。</p>
                  <button type="button" class="primary" :disabled="busy" @click="addLibrary('av')">添加媒体库</button>
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
                <!-- 多个目录时列出来让人自己选: 第一季和第二季在不同的文件夹里 -->
                <div v-if="revealDirs" class="reveal-menu" role="menu">
                  <p class="muted">这一部在 {{ revealDirs.length }} 个文件夹里:</p>
                  <button v-for="entry in revealDirs" :key="entry.dir" type="button" role="menuitem" @click="revealDir(entry.dir)">
                    <strong class="mono">{{ entry.dir }}</strong>
                    <small class="muted">{{ entry.files }} 个文件</small>
                  </button>
                  <button type="button" class="ghost" @click="revealDirs = null">取消</button>
                </div>
                <button class="ghost" type="button" aria-label="关闭详情" title="关闭详情" @click="detail = null">×</button>
              </header>
              <!-- 类型决定刮削路由与整理目录, 所以做成显式可改: 判错时人得能修。
                   影视条目没有内容类型(域决定一切), 所以这一行对它们不显示 -->
              <div v-if="!detail.domain || detail.domain === 'av'" class="detail-type">
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

              <!-- 影视条目: 季/集展开 + 缺集。集是"内容单位", 与 av 的分集不是一回事 -->
              <section v-if="detail.domain && detail.domain !== 'av'" class="detail-episodes">
                <header class="episodes-head">
                  <strong>集</strong>
                  <span v-if="episodeView" class="muted">
                    盘上 {{ episodeView.stats.bound }} / 声明 {{ episodeView.stats.declared }}
                    <span v-if="episodeView.stats.declared > episodeView.stats.bound" class="warn">
                      · 缺 {{ episodeView.stats.declared - episodeView.stats.bound }}
                    </span>
                  </span>
                  <span class="spacer" />
                  <button
                    type="button"
                    :disabled="busy || !episodeView || episodeView.stats.declared === 0"
                    :title="`按播出顺序把文件摊到各季（合集包常见 001…165 这种跨季连续编号）`"
                    @click="spreadSeasons"
                  >
                    摊到各季
                  </button>
                  <button type="button" :disabled="busy" @click="openRebindDialog">改绑</button>
                  <button type="button" :disabled="busy" class="danger-ghost" @click="unbindCurrent">解绑</button>
                  <button type="button" :disabled="busy" @click="rescrapeShow">重新刮削</button>
                </header>
                <!-- 同一部剧拆成多个目录时, 各目录可能是不同季 (仁医 / 仁医2) -->
                <div v-if="itemDirs.length > 1" class="item-dirs">
                  <p class="season-title">来源文件夹</p>
                  <div v-for="dir in itemDirs" :key="dir.dir" class="item-dir">
                    <span class="mono" :title="dir.dir">{{ dir.dir.split(/[\\/]/).pop() }}</span>
                    <span class="muted">
                      {{ dir.files }} 个文件
                      <template v-if="dir.episodeFrom !== null"> · 第 {{ dir.episodeFrom }}–{{ dir.episodeTo }} 集</template>
                      · 第 {{ dir.season ?? "?" }} 季
                    </span>
                    <input
                      v-model="seasonDraft[dir.dir]"
                      type="number"
                      min="0"
                      :placeholder="String(dir.season ?? 1)"
                      :aria-label="`把 ${dir.dir} 改成第几季`"
                    />
                    <button type="button" :disabled="!seasonDraft[dir.dir]" @click="applyDirSeason(dir.dir)">改季</button>
                    <button type="button" @click="reveal(dir.dir)">打开</button>
                  </div>
                  <p class="muted hint">
                    两个文件夹都指向同一部剧时（例如第一季和第二季），把其中一个改成第 2 季，否则两季的集号会撞在第一季上。
                  </p>
                </div>

                <p v-if="undeclaredCount > 0" class="warn">
                  盘上有 {{ undeclaredCount }} 集不在来源的集列表里（集号可能对不上，点「摊到各季」按播出顺序重排）
                </p>
                <p v-if="!episodeView || episodeView.episodes.length === 0" class="muted">
                  还没有集信息。点「重新刮削」从 TMDB 拉一次。
                </p>
                <div v-for="group in seasonGroups" :key="group.season" class="season-group">
                  <p class="season-title">第 {{ group.season }} 季 · {{ group.episodes.length }} 集</p>
                  <ul>
                    <li v-for="episode in group.episodes" :key="`${episode.season}-${episode.episode}`" :class="{ missing: !episode.hasFile }">
                      <span class="ep mono">E{{ String(episode.episode).padStart(2, "0") }}</span>
                      <span class="ep-title">{{ episode.title || "（无集名）" }}</span>
                      <span v-if="episode.undeclared" class="warn" title="来源的集列表里没有这一集">集号对不上</span>
                      <span v-else-if="!episode.hasFile" class="warn">盘上没有</span>
                    </li>
                  </ul>
                </div>
              </section>
              <!-- 图放最后: 字段通常占不满整栏, 让图吃掉剩下的空白, 也就能显示得更大 -->
              <div v-if="detail.coverUrl" class="detail-cover">
                <button type="button" class="cover-zoom" :aria-label="`放大 ${detail.number} 的封面`" @click="zoom = detail.coverUrl!">
                  <img :src="detail.coverUrl" :alt="detail.number" />
                </button>
              </div>
            </aside>
          </div>
        </div>

        <!-- 未识别: 影视库是"目录"级 (一个目录 = 一部剧的候选) -->
        <div v-else-if="tab === 'unparsed' && isVideoMode" class="pane">
          <div class="toolbar">
            <span class="muted">
              待绑定 {{ bindKinds.tv }} 部剧 · {{ bindKinds.movie }} 部电影
              <span class="hint">（影视没有番号，要先绑到 TMDB 才知道是哪一部）</span>
            </span>
            <span class="spacer" />
            <div class="kind-filter">
              <button type="button" class="chip" :class="{ on: bindKind === 'tv' }" @click="bindKind = 'tv'; bindLimit = 100; refreshUnparsed()">
                剧集 {{ bindKinds.tv }}
              </button>
              <button type="button" class="chip" :class="{ on: bindKind === 'movie' }" @click="bindKind = 'movie'; bindLimit = 100; refreshUnparsed()">
                电影 {{ bindKinds.movie }}
              </button>
              <button type="button" class="chip" :class="{ on: bindKind === '' }" @click="bindKind = ''; bindLimit = 100; refreshUnparsed()">
                全部
              </button>
            </div>
            <span v-if="suggestProgress" class="muted nowrap">
              搜索中 {{ suggestProgress.index }}/{{ suggestProgress.total || "?" }} · {{ suggestProgress.dir }}
            </span>
            <button type="button" :disabled="busy || suggestBusy || bindableDirs.length === 0" @click="findSuggestions">
              {{ suggestBusy ? "搜索中…" : "批量找建议" }}
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th v-if="Object.keys(suggestions).length > 0" class="pick" />
                <th>候选</th><th>建议</th><th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="dir in bindableDirs" :key="dir.dir">
                <td v-if="Object.keys(suggestions).length > 0" class="pick" @click.stop>
                  <input
                    v-if="suggestions[dir.dir]?.hit"
                    type="checkbox"
                    :checked="suggestPicked.includes(dir.dir)"
                    :aria-label="`绑定 ${dir.name}`"
                    @change="toggleSuggest(dir.dir)"
                  />
                </td>
                <!-- 名字 + 类型 + 元信息堆在一个单元格里: 单独开"情况"列会把动作按钮挤出屏幕 -->
                <td class="path-cell" :title="dir.dir">
                  <div class="cand-name mono">
                    {{ dir.name }}
                    <span class="badge accent" v-if="dir.kind === 'tv'">剧集</span>
                    <span class="badge" v-else>电影</span>
                    <!-- 名字像同一部剧的散集, 但集号没认出来: 绑成电影是错的, 提示补集号 -->
                    <span
                      v-if="dir.suspectSeries"
                      class="badge warn"
                      title="目录里多个文件名字相近, 像同一部剧的分集, 但文件名里认不出集号。补集号后重扫更合适。"
                    >
                      可能是一部剧
                    </span>
                  </div>
                  <div class="cand-meta muted">
                    <template v-if="dir.kind === 'tv'">
                      {{ dir.parsed }}/{{ dir.files }} 集识出
                      <template v-if="dir.seasons.length > 0"> · S{{ dir.seasons.join(",") }}</template>
                      <span v-if="dir.parsed < dir.files" class="warn"> · {{ dir.files - dir.parsed }} 待补集号</span>
                    </template>
                    <template v-else>单个视频文件</template>
                  </div>
                </td>
                <td class="suggest-cell">
                  <div class="suggest-line">
                  <template v-if="suggestions[dir.dir]">
                    <template v-if="suggestions[dir.dir]!.hit">
                      <strong>{{ suggestions[dir.dir]!.hit!.title }}</strong>
                      <span class="muted">{{ suggestions[dir.dir]!.hit!.year ?? "年份未知" }}</span>
                      <span class="badge" :class="{ accent: suggestions[dir.dir]!.confidence === 'high', warn: suggestions[dir.dir]!.confidence !== 'high' }">
                        {{ suggestions[dir.dir]!.confidence === "high" ? "很可能是" : "可能是" }}
                      </span>
                    </template>
                    <span v-else-if="suggestions[dir.dir]!.error" class="warn">搜索失败: {{ suggestions[dir.dir]!.error }}</span>
                    <span v-else class="muted">没搜到，手动搜一次</span>
                  </template>
                  <span v-else class="muted">—</span>
                  </div>
                </td>
                <td class="row-actions">
                  <button
                    type="button"
                    :disabled="busy || selectedId === null"
                    @click="openBindDialog(dir)"
                  >
                    {{ suggestions[dir.dir]?.hit ? "换一个" : "绑定到 TMDB" }}
                  </button>
                  <button type="button" @click="reveal(dir.dir)">定位</button>
                </td>
              </tr>
              <tr v-if="bindableDirs.length === 0">
                <td colspan="4" class="muted">没有待绑定的候选。扫一遍库，或者它们都已经绑过了。</td>
              </tr>
            </tbody>
          </table>
          <!-- 真库里电影候选可能上百个: 分批显示, 别一次塞 400 行 -->
          <div v-if="bindTotal > bindableDirs.length" class="bind-more">
            <span class="muted">已显示 {{ bindableDirs.length }} / {{ bindTotal }} 个候选</span>
            <button type="button" :disabled="busy" @click="bindLimit += 100; refreshUnparsed()">再显示 100 个</button>
          </div>
          <!-- 勾选后才出现的动作条: 没勾选时不占位置, 也不制造"这里有东西等着点"的错觉 -->
          <div v-if="suggestPicked.length > 0" class="bind-bar">
            <span>已勾选 {{ suggestPicked.length }} 个</span>
            <span class="spacer" />
            <button type="button" :disabled="suggestBusy" @click="suggestPicked = []">取消勾选</button>
            <button type="button" class="primary" :disabled="suggestBusy" @click="bindPicked">
              {{ suggestBusy ? "绑定中…" : `绑定这 ${suggestPicked.length} 个并刮削` }}
            </button>
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

        <!-- 任务: 现在在干什么 + 干过什么 + 失败详情 -->
        <div v-else-if="tab === 'tasks'" class="pane tasks-pane">
          <div v-if="busy" class="running-card">
            <div class="running-head">
              <strong>{{ runningLabel || "进行中" }}</strong>
              <span class="spacer" />
              <span v-if="taskProgress" class="progress">{{ taskProgress.index }}/{{ taskProgress.total }}</span>
              <button type="button" class="danger" @click="cancelRunning">停止</button>
            </div>
            <div v-if="taskProgress" class="task-bar" role="progressbar" :aria-valuenow="taskPercent" aria-valuemin="0" aria-valuemax="100">
              <span class="task-bar-fill" :style="{ width: `${taskPercent}%` }" />
            </div>
            <p v-else class="muted">正在准备…</p>
          </div>

          <p class="muted">
            刮削、翻译、同步 NFO 都会留下记录 —— 关掉软件后仍能看到跑到哪、哪几条失败、并只重跑失败的那些。
            扫描与修正内容类型是秒级动作，不记任务。
          </p>

          <table>
            <thead>
              <tr><th>#</th><th>类型</th><th>状态</th><th>进度</th><th>失败</th><th>结束时间</th><th /></tr>
            </thead>
            <tbody>
              <template v-for="task in tasks" :key="task.id">
                <tr :class="{ 'task-open': openTaskId === task.id }">
                  <td class="mono">{{ task.id }}</td>
                  <td>{{ taskTypeLabel(task.type) }}</td>
                  <td :class="`st-${task.status}`">{{ taskStatusLabel(task.status) }}</td>
                  <td class="mono">{{ task.processed }}/{{ task.total }}</td>
                  <td class="mono" :class="{ warn: task.failed > 0 }">{{ task.failed }}</td>
                  <td class="mono muted">{{ formatTime(task.finishedAt ?? task.startedAt) }}</td>
                  <td class="row-actions">
                    <button
                      v-if="task.failed > 0"
                      type="button"
                      :disabled="busy"
                      title="只重跑这条任务里失败的番号"
                      @click="toggleTaskFailures(task)"
                    >
                      {{ openTaskId === task.id ? "收起" : `失败 ${task.failed}` }}
                    </button>
                    <button
                      v-if="['interrupted', 'failed', 'cancelled', 'done'].includes(task.status)"
                      type="button"
                      :disabled="busy"
                      title="按同样的参数再跑一遍整批"
                      @click="retryTask(task, false)"
                    >
                      整批重跑
                    </button>
                    <button
                      v-if="task.failed > 0 && ['interrupted', 'failed', 'cancelled', 'done'].includes(task.status)"
                      type="button"
                      class="primary"
                      :disabled="busy"
                      @click="retryTask(task, true)"
                    >
                      重跑失败
                    </button>
                  </td>
                </tr>
                <tr v-if="openTaskId === task.id" class="task-detail">
                  <td colspan="7">
                    <p v-if="taskFailureList.length === 0" class="muted">这条任务的日志里没有失败记录。</p>
                    <ul v-else class="failure-list">
                      <li v-for="failure in taskFailureList" :key="`${failure.key}-${failure.index}`">
                        <span class="mono">{{ failure.key }}</span>
                        <span class="fail-reason">{{ failure.error }}</span>
                      </li>
                    </ul>
                  </td>
                </tr>
              </template>
              <tr v-if="tasks.length === 0">
                <td colspan="7" class="muted">还没有任务记录。跑一次刮削、翻译或同步 NFO 就会出现。</td>
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
            <button type="button" :disabled="busy" @click="testDmm">测试 DMM</button>
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

          <h2>影视来源 (TMDB)</h2>
          <p class="muted">
            影视库（剧集 / 动画 / 综艺 / 电影）唯一的数据来源。免费申请，选 personal use 即可；
            key 只存在本地 config.json，不发往任何第三方（除了 TMDB 自己的请求）。
          </p>
          <label class="field">
            <span>API Key</span>
            <input
              v-model="tmdbKeyInput"
              type="password"
              spellcheck="false"
              :placeholder="config?.settings.tmdbApiKey || '未设置'"
            />
          </label>
          <div class="row">
            <button type="button" :disabled="busy" @click="saveConfig">保存</button>
            <button type="button" :disabled="busy" @click="testTmdb">测试 TMDB</button>
            <a class="muted" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">
              去申请 / 查看 key
            </a>
            <span class="muted">
              {{ config?.tmdbConfigured ? "TMDB 已配置" : "TMDB 未配置" }}
              <template v-if="config?.tmdbFromEnv">(环境变量生效中)</template>
            </span>
          </div>
          <p v-if="tmdbTest" class="note">
            {{ tmdbTest.ok ? "连接成功" : "未通过" }} ({{ tmdbTest.status }})
            <template v-if="tmdbTest.title">· 查到《{{ tmdbTest.title }}》</template>
            <template v-if="tmdbTest.originalTitle">· 原名 {{ tmdbTest.originalTitle }}</template>
            <template v-if="tmdbTest.error">· {{ tmdbTest.error }}</template>
          </p>

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
  <!-- 绑定: 搜 TMDB → 选一部 → 绑整个目录。选错会让整季集名全错, 所以不自动挑 -->
  <div v-if="bindDialog" class="lightbox" role="dialog" aria-modal="true" aria-label="绑定到 TMDB" @keydown.esc="bindDialog = null">
    <div class="bind-modal">
      <header>
        <strong>{{ bindDialog.mode === "rebind" ? "改绑到别的 TMDB 条目" : "绑定到 TMDB" }}</strong>
        <span class="spacer" />
        <button class="ghost" type="button" aria-label="关闭" title="关闭" @click="bindDialog = null">×</button>
      </header>
      <p class="muted">
        <template v-if="bindDialog.mode === 'rebind'">
          把「{{ bindDialog.label }}」改绑到别的 TMDB 条目 —— 文件不会动, 只换身份
        </template>
        <template v-else-if="bindDialog.dir">
          {{ bindDialog.dir.name }} · {{ bindDialog.dir.files }} 个文件
          <template v-if="bindDialog.dir.seasons.length > 0"> · 季 {{ bindDialog.dir.seasons.join(", ") }}</template>
        </template>
      </p>
      <div class="bind-kind">
        <span class="muted">搜</span>
        <button type="button" :class="{ on: bindDialog.kind === 'tv' }" @click="bindDialog.kind = 'tv'; bindDialog.hits = []">剧集</button>
        <button type="button" :class="{ on: bindDialog.kind === 'movie' }" @click="bindDialog.kind = 'movie'; bindDialog.hits = []">电影</button>
        <span class="muted">· 从文件名推断的，可以改</span>
      </div>
      <label v-if="bindDialog.kind === 'tv' && bindDialog.mode !== 'rebind'" class="bind-season">
        <span class="muted">季</span>
        <input v-model="bindDialog.season" type="number" min="0" placeholder="自动" aria-label="强制季号" />
        <span class="muted">留空 = 按文件名/目录自动判断；同一部剧的第二个目录填 2</span>
      </label>
      <div class="bind-search">
        <input
          v-model="bindDialog.query"
          type="search"
          :placeholder="bindDialog.kind === 'tv' ? '剧名（中文或原名）' : '片名'"
          @keyup.enter="searchTmdb"
        />
        <button type="button" :disabled="bindDialog.busy || bindDialog.query.trim().length === 0" @click="searchTmdb">
          {{ bindDialog.busy ? "处理中…" : "搜索" }}
        </button>
      </div>
      <ul class="bind-hits">
        <li v-for="hit in bindDialog.hits" :key="hit.key">
          <button type="button" :disabled="bindDialog.busy" @click="bindDir(hit)">
            <strong>{{ hit.title }}</strong>
            <small class="muted">{{ hit.year ?? "年份未知" }} · TMDB {{ hit.id }}</small>
          </button>
        </li>
        <li v-if="!bindDialog.busy && bindDialog.hits.length === 0" class="muted">还没搜。</li>
      </ul>
    </div>
  </div>

  <!-- 同步 NFO 的结果/预览面板: 原生 confirm 塞不下 2641 条清单, 失败也标不红 -->
    <div
      v-if="nfoDialog.open && nfoDialog.report"
      class="nfo-modal"
      role="dialog"
      aria-modal="true"
      aria-label="同步 NFO"
      @keydown.esc="nfoDialog.open = false"
    >
      <div class="nfo-modal-body">
        <header>
          <strong>同步 NFO · «{{ selected?.name }}»</strong>
          <button type="button" class="ghost" aria-label="关闭" @click="nfoDialog.open = false">×</button>
        </header>

        <p class="summary">
          写回 {{ nfoDialog.report.written }} · 新建 {{ nfoDialog.report.created }} · 读入 {{ nfoDialog.report.imported }} ·
          跳过 {{ nfoDialog.report.skipped }}
          <span v-if="nfoDialog.report.errors" class="fail"> · 失败 {{ nfoDialog.report.errors }}</span>
        </p>

        <div class="nfo-filters">
          <button type="button" class="chip" :class="{ on: !nfoDialog.errorsOnly }" @click="nfoDialog.errorsOnly = false">
            有变化 ({{ nfoDialog.report.entries.filter((entry) => entry.action !== "skip").length }})
          </button>
          <button
            type="button"
            class="chip"
            :class="{ on: nfoDialog.errorsOnly }"
            :disabled="nfoDialog.report.errors === 0"
            @click="nfoDialog.errorsOnly = true"
          >
            只看失败 ({{ nfoDialog.report.errors }})
          </button>
        </div>

        <ul class="nfo-list">
          <li v-for="entry in nfoEntries(nfoDialog.report).slice(0, 300)" :key="entry.nfoPath">
            <div class="nfo-line">
              <span class="mono">{{ entry.number }}</span>
              <span class="nfo-action">{{
                entry.error ? "失败" : entry.action === "create" ? "新建" : entry.action === "import" ? "读入" : "写回"
              }}</span>
              <span v-if="entry.error" class="fail-reason">{{ entry.error }}</span>
              <span v-else class="muted nfo-changes">{{ entry.changed.slice(0, 3).join(" · ") }}</span>
            </div>
            <div class="mono nfo-path" :title="entry.nfoPath">{{ entry.nfoPath }}</div>
          </li>
        </ul>
        <p v-if="nfoEntries(nfoDialog.report).length > 300" class="muted">
          只列前 300 条，共 {{ nfoEntries(nfoDialog.report).length }} 条。
        </p>

        <footer>
          <template v-if="nfoDialog.phase === 'preview'">
            <button type="button" @click="nfoDialog.open = false">取消</button>
            <button
              type="button"
              class="primary"
              :disabled="busy || nfoDialog.report.written + nfoDialog.report.created + nfoDialog.report.imported === 0"
              @click="applyNfoSync"
            >
              写入
            </button>
          </template>
          <template v-else-if="nfoDialog.phase === 'running'">
            <span class="muted">正在写… {{ nfoProgress?.index ?? 0 }}/{{ nfoProgress?.total ?? "?" }}</span>
          </template>
          <template v-else>
            <button type="button" class="chip" @click="nfoDialog.open = false; tab = 'tasks'">在任务里查看</button>
            <button type="button" @click="nfoDialog.open = false">完成</button>
            <button
              v-if="nfoDialog.report.errors > 0"
              type="button"
              class="primary"
              :disabled="busy"
              @click="nfoDialog.errorsOnly = true; applyNfoSync()"
            >
              只重试失败的 {{ nfoDialog.report.errors }} 个
            </button>
          </template>
        </footer>
      </div>
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
/* ---- 库行: 三态 (正常 / 改名 / 删除确认) ----
   动作按钮浮在行右侧、悬停或键盘聚焦才出现; 常驻两个图标会让整列像工具栏。
   `.libs button` 上有 width:100% + flex-direction:column, 这里的按钮都要显式覆盖。 */
.lib-row {
  position: relative;
  display: flex;
  align-items: stretch;
}

.lib-row .lib {
  flex: 1;
  min-width: 0;
}

.libs .lib strong {
  display: flex;
  gap: 4px;
  align-items: center;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 动作按钮**浮在行右端**而不是占位: 常驻占位会把 240px 的侧栏挤掉 88px,
   库名和路径全被压成一截。背景取行底色, 让字从按钮下面干净地消失。 */
.libs .lib-actions {
  position: absolute;
  top: 50%;
  right: 0;
  display: flex;
  gap: 4px;
  align-items: center;
  padding-left: 20px;
  transform: translateY(-50%);
  /* 用渐变而不是一块实心背景: 实心块会把行尾的「只索引」角标切成半个空胶囊 */
  background: linear-gradient(to right, transparent, var(--bg) 20px);
  opacity: 0;
  transition: opacity 120ms var(--ease);
}

.libs li.active .lib-actions {
  background: linear-gradient(to right, transparent, var(--panel-2) 20px);
}

.libs li:hover .lib-actions,
.libs li.active .lib-actions,
.lib-actions:focus-within {
  opacity: 1;
}

.libs .lib-actions button {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--text-faint);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: background 120ms var(--ease), color 120ms var(--ease);
}

.libs .lib-actions button:hover {
  background: var(--panel-3);
  color: var(--text);
}

/* 删除是唯一会造成损失的动作: 只在它自己身上用危险色, 别把整行染红 */
.libs .lib-actions button.danger-action:hover {
  border-color: var(--danger-line);
  color: var(--danger);
}

/* 改名: 卡片内联一条输入, 高度与库行一致 (44px 触控), 保存/取消各一个方形按钮 */
.lib-edit {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 4px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.lib-edit input {
  flex: 1;
  min-width: 0;
  height: 44px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-body);
}

.lib-edit input:focus {
  outline: none;
}

.libs .lib-edit button {
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  background: var(--panel);
  color: var(--text-faint);
  font-size: var(--fs-label);
  line-height: 1;
  cursor: pointer;
}

.libs .lib-edit button:hover {
  color: var(--text);
}

.libs .lib-edit .lib-edit-ok {
  border-color: var(--accent);
  color: var(--accent);
}

.libs .lib-edit .lib-edit-ok:hover {
  background: var(--accent);
  color: var(--on-accent);
}

/* 删除确认: 就地一张危险色卡片, 把"磁盘文件不动"写在正文里 */
.lib-confirm {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--danger-line);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.lib-confirm p {
  margin: 0;
  font-size: var(--fs-label);
  line-height: 1.6;
  color: var(--text);
}

.lib-confirm-actions {
  display: flex;
  gap: 8px;
}

.libs .lib-confirm-actions button {
  width: auto;
  min-height: 44px;
  padding: 8px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  background: var(--panel);
  color: var(--text);
  font-size: var(--fs-label);
  cursor: pointer;
}

.libs .lib-confirm-actions button:hover {
  border-color: var(--line-strong);
}

.libs .lib-confirm-actions button.danger {
  border-color: var(--danger-line);
  color: var(--danger);
}

.libs .lib-confirm-actions button.danger:hover {
  background: var(--danger);
  border-color: var(--danger);
  color: var(--on-accent);
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

/* 只给"库行"上底色。写成 .libs li.active button 会把行内的动作按钮也染上,
   改名输入旁边的 ✓ / ✕ 就会跟着变成一整块灰底 */
.libs li.active .lib {
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

/* 任务页: 当前任务卡片 + 失败清单 */
.running-card {
  margin-bottom: 12px;
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.running-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.running-card .task-bar {
  margin: 0;
}

.task-open {
  background: var(--panel-2);
}

.task-detail td {
  padding: 0 12px 12px;
  background: var(--panel-2);
}

.failure-list {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-label);
}

.failure-list li {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.fail-reason {
  color: var(--danger);
}

/* 同步 NFO 面板: 清单要能滚, 失败要能标红 */
.nfo-modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: rgba(8, 10, 14, 0.86);
}

.nfo-modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(760px, 100%);
  max-height: min(80vh, 720px);
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.4),
    0 16px 48px rgba(0, 0, 0, 0.42);
}

.nfo-modal-body header,
.nfo-modal-body footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nfo-modal-body footer {
  justify-content: flex-end;
  padding-top: 4px;
}

.nfo-modal-body .summary {
  margin: 0;
  font-size: var(--fs-body);
}

.nfo-filters {
  display: flex;
  gap: 8px;
}

.nfo-list {
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--line);
}

.nfo-list li {
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}

.nfo-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: var(--fs-label);
}

.nfo-action {
  color: var(--text-faint);
}

.nfo-changes {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
}

.nfo-path {
  color: var(--text-faint);
  font-size: var(--fs-label);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 建库前的域选择: 三个选项各带一句"它会怎么处理文件" */
.lib-menu {
  position: absolute;
  top: 44px;
  right: 12px;
  z-index: 20;
  display: grid;
  gap: 2px;
  padding: 8px;
  min-width: 232px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 12px 28px rgb(0 0 0 / 40%);
}

.lib-menu button {
  display: grid;
  gap: 2px;
  padding: 8px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.lib-menu button:hover {
  background: var(--panel-2);
}

.lib-menu small {
  color: var(--text-faint);
}

.badge.accent {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}

.ep-badge {
  margin-left: 8px;
  font-variant-numeric: tabular-nums;
}

/* 详情里的集列表: 季分组, 缺集的那一行轻一点 */
.detail-episodes {
  margin-top: 12px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}

.episodes-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-label);
}

.season-title {
  margin: 12px 0 4px;
  color: var(--text-faint);
  font-size: var(--fs-label);
}

.detail-episodes ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.detail-episodes li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 4px 0;
  font-size: var(--fs-label);
}

.detail-episodes li.missing .ep-title {
  color: var(--text-faint);
}

.ep {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.ep-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 缺集标记不能被挤成竖排 (flex 容器里没有 nowrap 就会一个字一行) */
.detail-episodes li > .warn {
  flex: none;
  white-space: nowrap;
  font-size: var(--fs-label);
}

/* 建议列: 片名 + 年份 + 把握标签, 一行放得下就一行 */
.nowrap {
  white-space: nowrap;
}

/* 候选单元格: 名字一行 + 元信息一行; 限宽让动作按钮始终在屏幕内 */
.pane td.path-cell {
  max-width: 460px;
}

.cand-name {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.cand-name .badge {
  flex: none;
  margin-left: 0;
  padding: 2px 8px;
}

.cand-meta {
  font-size: var(--fs-label);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 影视目录名可能很长 (发布组前缀 + 季 + 画质), 限宽 + 省略号, 完整路径走 title */
.pane td.path-cell {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* td 不能当 flex 容器: 会让整行变成两行高。内层用 inline-flex 就够 */
td.suggest-cell {
  white-space: nowrap;
  font-size: var(--fs-label);
}

.suggest-line {
  display: inline-flex;
  gap: 8px;
  align-items: baseline;
}

.suggest-cell .badge {
  margin-left: 0;
  padding: 2px 8px;
}

.kind-filter {
  display: flex;
  gap: 4px;
  align-items: center;
}

.kind-filter .chip {
  cursor: pointer;
}

.bind-more {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}

.bind-more button {
  min-height: 44px;
  padding: 8px 16px;
}

.badge.warn {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 40%, transparent);
}

/* 勾选后的动作条: 贴在表格下方, 不浮在内容上遮挡 */
.bind-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
  padding: 12px 16px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  font-size: var(--fs-label);
  box-shadow: 0 -8px 24px rgb(0 0 0 / 32%), 0 2px 8px rgb(0 0 0 / 24%);
}

.bind-bar .primary {
  min-height: 44px;
  padding: 8px 16px;
}

.bind-bar button:not(.primary) {
  min-height: 44px;
  padding: 8px 12px;
}

.reveal-menu {
  position: absolute;
  top: 44px;
  right: 8px;
  z-index: 30;
  display: grid;
  gap: 4px;
  max-width: 420px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-2);
  box-shadow: 0 12px 28px rgb(0 0 0 / 40%);
}

.reveal-menu p {
  margin: 0 0 4px;
  font-size: var(--fs-label);
}

.reveal-menu button {
  display: grid;
  gap: 2px;
  min-height: 44px;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.reveal-menu button:hover {
  border-color: var(--line-strong);
  background: var(--panel-3);
}

.reveal-menu strong {
  font-size: var(--fs-label);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.item-dirs {
  margin-bottom: 8px;
}

.item-dir {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: var(--fs-label);
  padding: 4px 0;
}

.item-dir .mono {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-dir input {
  width: 56px;
  height: 44px;
  padding: 0 8px;
}

.item-dir button {
  min-height: 44px;
  padding: 4px 12px;
  font-size: var(--fs-label);
}

.bind-season {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: var(--fs-label);
}

.bind-season input {
  width: 64px;
  height: 44px;
  padding: 0 8px;
}

/* 绑定面板: 借 lightbox 的遮罩, 自己是一张宽卡片 */
.bind-modal {
  display: grid;
  gap: 8px;
  width: min(560px, 92vw);
  max-height: 82vh;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 24px 64px rgb(0 0 0 / 45%), 0 2px 8px rgb(0 0 0 / 30%);
  overflow: auto;
}

.bind-modal header {
  display: flex;
  align-items: center;
}

.bind-kind {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: var(--fs-label);
}

.bind-kind button {
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text-faint);
  font-size: var(--fs-label);
  cursor: pointer;
}

.bind-kind button.on {
  border-color: var(--accent);
  color: var(--accent);
}

.bind-search {
  display: flex;
  gap: 8px;
}

.bind-search input {
  flex: 1;
}

.bind-hits {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 4px;
}

.bind-hits button {
  display: grid;
  gap: 2px;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.bind-hits button:hover {
  border-color: var(--accent);
}

/* 行内可点的统计数字: 比 chip 轻, 不跟主按钮抢注意力 */
.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-faint);
  font-size: inherit;
  text-decoration: underline;
  text-decoration-color: var(--line);
  text-underline-offset: 3px;
  cursor: pointer;
}

.link:hover {
  color: var(--text);
}

.link.on {
  color: var(--accent);
  text-decoration-color: currentColor;
}

.exhausted-hint {
  margin: 0 16px 8px;
  font-size: var(--fs-label);
  line-height: 1.6;
}

/* 一致性提醒: 一条色条就够, 别跟错误提示抢注意力 */
.nfo-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 16px 0;
  padding: 8px 12px;
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-xs);
  background: var(--panel-2);
  color: var(--text-faint);
  font-size: var(--fs-label);
}

.nfo-hint .chip {
  margin-left: auto;
}

.st-running,
.st-queued {
  color: var(--warn);
}
.st-cancelled {
  color: var(--text-faint);
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
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: var(--fs-body);
}

/* 条目页的工具栏是"两行", 其它页仍是一行 —— 写在 .toolbar 上会把未识别页
   的上一页/下一页拉成两条横贯整屏的大按钮。 */
.pane.items > .toolbar {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
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

/* 未识别页: 路径列吃掉剩余宽度, 但给大小和按钮留位置 */
.pane:not(.items) table td.mono:first-child {
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
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
.title-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.title-line .title-text {
  min-width: 0;
}

td.title-cell .title-text {
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

/* 影视条目要装"季 → 集"两列信息, 320px 挤成面条 */
.detail:has(.detail-episodes) {
  width: 400px;
}

.detail header {
  position: relative;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
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
  /* 库名后面的角标不许换行: 侧栏窄, "影视" 竖排成两行像坏了 */
  white-space: nowrap;
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
