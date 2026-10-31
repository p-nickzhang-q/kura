<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";

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
type FilterKey = "q" | "actor" | "studio" | "label" | "series" | "director" | "tag";
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
};
const filters = ref<Partial<Record<FilterKey, string>>>({});
const searchDraft = ref("");
/** 刷新请求的序号, 用来丢弃乱序返回的旧结果。 */
let refreshSeq = 0;
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

async function refreshItems(): Promise<void> {
  // 每次请求带一个序号: 刮削时进度会频繁触发刷新, 早发出的请求可能晚回来,
  // 用旧数据覆盖新数据 (页码突然只剩一页就是这么来的)。
  const seq = ++refreshSeq;
  const result = await window.kura.items({
    ...filters.value,
    limit: pageSize,
    offset: page.value * pageSize,
  });
  if (seq !== refreshSeq) return;

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

async function goFirst(): Promise<void> {
  await goPage(0);
}

async function goLast(): Promise<void> {
  await goPage(pageCount.value - 1);
}

/** 点同一个值第二次就取消该条件。 */
async function applyFilter(key: FilterKey, value: string): Promise<void> {
  if (!value) return;
  if (filters.value[key] === value) delete filters.value[key];
  else filters.value[key] = value;
  page.value = 0;
  await refreshItems();
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

async function doScan(): Promise<void> {
  if (selectedId.value === null) return;
  events.value = [];
  const report = await run("扫描", () => window.kura.scan(selectedId.value!));
  if (report) {
    const { counts } = report;
    note.value = `扫描完成: 新增 ${counts.added} · 更新 ${counts.updated} · 未变 ${counts.unchanged} · 未识别 ${counts.unparsed}`;
    page.value = 0;
    await refreshAll();
  }
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
function describeTranslate(result: { count: number; cancelled: boolean; translated?: number; failed?: number; skipped?: number }): string {
  const translated = result.translated ?? 0;
  const failed = result.failed ?? 0;
  const skipped = result.skipped ?? 0;
  const parts = [`成功 ${translated} 条`];
  if (failed > 0) parts.push(`失败 ${failed} 条`);
  if (skipped > 0) parts.push(`无变化 ${skipped} 条`);
  const head = result.cancelled ? `翻译已取消 (处理 ${result.count} 条)` : `翻译处理 ${result.count} 条`;
  const tail = translated === 0 && failed > 0 ? " —— 全都是失败, 先点「测试 LLM」看模型为什么不通" : "";
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

async function testDmm(): Promise<void> {
  dmmTest.value = await run("测试 DMM", () => window.kura.testDmm("SSIS-001"));
}
</script>

<template>
  <main class="shell">
    <header class="top">
      <h1>Kura</h1>
      <span v-if="info" class="meta">
        v{{ info.version }} · {{ info.dbRuntime }} · schema v{{ info.schemaVersion }} · 条目 {{ info.items }} · 文件
        {{ info.mediaFiles }}
      </span>
    </header>

    <div v-if="info?.fixturesDir" class="banner">
      离线样本模式：刮削只走 fixture 源（{{ info.fixturesDir }}），不会访问真实站点。去掉 <code>KURA_FIXTURE_DIR</code> 重启即为真实刮削。
    </div>

    <div class="body">
      <aside class="side">
        <div class="side-head">
          <span>媒体库</span>
          <button class="ghost" type="button" :disabled="busy" @click="addLibrary">+</button>
        </div>
        <ul class="libs">
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
            <button v-else type="button" class="lib" @click="selectedId = library.id">
              <strong>
                {{ library.name }}
                <span v-if="library.organizeEnabled === false" class="badge">只索引</span>
              </strong>
              <small :title="library.root">{{ library.root }}</small>
              <span class="pencil" title="改名" @click.stop="startRename(library)">✎</span>
            </button>
          </li>
          <li v-if="libraries.length === 0" class="muted">还没有媒体库</li>
        </ul>

        <div class="actions">
          <button type="button" :disabled="busy || !selected" @click="doScan">扫描</button>
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
          <div class="toolbar">
            <label class="check">
              <input
                type="checkbox"
                :checked="picked.length > 0 && picked.length === items.length"
                @change="toggleAll"
              />
              全选
            </label>
            <span class="muted">已选 {{ picked.length }}</span>
            <span class="spacer" />
            <input
              v-model="searchDraft"
              class="search"
              type="search"
              placeholder="搜番号 / 标题 / 演员 / 标签…"
              @keyup.enter="applySearch"
              @search="applySearch"
            />
            <button v-if="Object.keys(filters).length" type="button" class="chip" @click="clearFilters">
              清空筛选 ✕
            </button>
            <span class="spacer" />
            <span class="muted">
              共 {{ itemTotal }} 条 · 待刮削 {{ pendingTotal }}
              <template v-if="exhaustedTotal > 0"> · 已达上限 {{ exhaustedTotal }}（用 --retry-failed 重试）</template>
            </span>
            <!-- 翻页是只读操作, 不该被长任务锁住: 刮削 200 条要十几分钟, 期间连看下一页都不行毫无道理 -->
            <button type="button" title="第一页" :disabled="page === 0" @click="goFirst">«</button>
            <button type="button" title="上一页" :disabled="page === 0" @click="goPage(page - 1)">‹</button>
            <input
              v-model="pageInput"
              class="page-input"
              type="text"
              inputmode="numeric"
              :title="`跳到第 1–${pageCount} 页`"
              @keyup.enter="jumpToPage"
              @blur="jumpToPage"
            />
            <span class="muted">/ {{ pageCount }}</span>
            <button type="button" title="下一页" :disabled="page >= pageCount - 1" @click="goPage(page + 1)">›</button>
            <button type="button" title="最后一页" :disabled="page >= pageCount - 1" @click="goLast">»</button>
            <button type="button" :disabled="busy || picked.length === 0" @click="scrapePicked">
              刮削选中 ({{ picked.length }})
            </button>
            <button type="button" :disabled="busy || picked.length === 0" @click="postersPicked">
              下载图片 ({{ picked.length }})
            </button>
            <button type="button" :disabled="busy || picked.length === 0" @click="translateSelected">
              翻译选中 ({{ picked.length }})
            </button>
            <button v-if="translateProgress" type="button" class="danger" @click="cancelTranslate">
              停止翻译
            </button>
          </div>

          <div v-if="Object.keys(filters).length" class="filter-bar">
            <span
              v-for="(value, key) in filters"
              :key="key"
              class="chip"
              :title="`点一下取消这个条件`"
              @click="applyFilter(key as FilterKey, value as string)"
            >
              {{ FILTER_LABEL[key as FilterKey] }}: {{ value }} ✕
            </span>
          </div>

          <div class="split">
            <div class="list">
              <table>
                <thead>
                  <tr>
                    <th class="pick" />
                    <th>番号</th>
                    <th>类型</th>
                    <th>标题</th>
                    <th>片商</th>
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
                    <td class="mono">
                      {{ item.number }}
                      <span v-if="item.pinned.length" title="有锁定字段">🔒</span>
                    </td>
                    <td>{{ TYPE_LABEL[item.contentType] ?? item.contentType }}</td>
                    <td class="wrap-2" :title="item.title ?? ''">{{ item.title ?? "未刮削" }}</td>
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
                  <tr v-if="items.length === 0">
                    <td colspan="6" class="muted">
                      {{ Object.keys(filters).length ? "没有符合筛选条件的条目。" : "没有条目。先扫描一个媒体库。" }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <aside v-if="detail" class="detail">
              <header>
                <strong class="mono">{{ detail.number }}</strong>
                <button class="ghost" type="button" @click="detail = null">×</button>
              </header>
              <ul>
                <li
                  v-for="field in FIELDS"
                  :key="field"
                  v-show="fieldValue(detail, field) && !LIST_FIELDS.includes(field)"
                >
                  <span class="label">{{ FIELD_LABEL[field] }}</span>
                  <span
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
                    @click="togglePin(field)"
                  >
                    {{ detail.pinned.includes(field) ? "🔒" : "🔓" }}
                  </button>
                  <span class="from" :title="'字段来源'">{{ detail.fieldSources?.[field] ?? "" }}</span>
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
                <img :src="detail.coverUrl" :alt="detail.number" />
              </div>
            </aside>
          </div>
        </div>

        <!-- 未识别 -->
        <div v-else-if="tab === 'unparsed'" class="pane">
          <div class="toolbar">
            <span class="muted">扫到了但认不出番号的文件: {{ unparsedCount }} 个（不会进入刮削）</span>
            <span class="spacer" />
            <button type="button" :disabled="unparsedPage === 0" @click="goUnparsedPage(unparsedPage - 1)">‹</button>
            <span class="muted">{{ unparsedPage + 1 }}/{{ Math.max(1, Math.ceil(unparsedCount / unparsedPageSize)) }}</span>
            <button
              type="button"
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
              当前 {{ info?.libraries ?? 0 }} 个媒体库 · {{ info?.items ?? 0 }} 个条目 · schema v{{ info?.schemaVersion }}
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
            <input v-model="proxyInput" spellcheck="false" :placeholder="config?.settings.proxy || '留空 = 跟随系统代理'" />
          </label>
          <p class="muted">
            留空即跟随系统代理(Clash 开系统代理或 TUN 即可)。填 <code>auto</code> 由命令行在运行时探测常见端口;
            也可直接填 <code>http://127.0.0.1:7890</code>。
          </p>

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
  </main>
</template>

<style>
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --panel: #171a21;
  --line: #262b35;
  --text: #e6e8ee;
  --muted: #8b93a7;
  --accent: #5b8cff;
  --ok: #4ec9a5;
  --warn: #e5b567;
  --danger: #ff7b72;
  --danger-line: #b3403a;
  /* ---- 设计令牌: 圆角/间距/字号成体系, 不再散落 magic number ---- */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-pill: 999px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --ease: cubic-bezier(0.2, 0, 0, 1);

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
  font-size: 18px;
  letter-spacing: 0.08em;
}

.meta,
.muted {
  color: var(--muted);
  font-size: 12px;
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
  font-size: 12px;
}

.lib:hover .pencil {
  opacity: 1;
}

.rename input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
}

/* 条目列表里的封面缩略图 */
.cover {
  width: 46px;
  height: 64px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  display: block;
  background: var(--panel-2);
}

.cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 12px;
}

.search {
  width: 220px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 12px;
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
  font-size: 12px;
  text-align: center;
}

/* 演员名是可点的: 点了就把列表过滤到这个人 */
.actor {
  background: none;
  border: none;
  padding: 0 4px;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
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
  font-size: 12px;
  cursor: pointer;
}

.banner {
  margin: 0 20px;
  padding: 8px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel);
  color: var(--warn);
  font-size: 12px;
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
  font-size: 12px;
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
  border-radius: 8px;
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
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sources {
  font-size: 12px;
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
  border-radius: 8px;
  border: 1px solid var(--line);
  background: #1e232d;
  color: var(--text);
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
}

button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--panel-2);
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
  font-size: 12px;
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
  gap: 12px;
  font-size: 13px;
}

.row-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.row-actions button {
  padding: 4px 8px;
  font-size: 12px;
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

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

th {
  text-align: left;
  color: var(--muted);
  font-weight: 500;
  font-size: 12px;
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
select:focus-visible {
  outline: 2px solid var(--accent);
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
td.wrap-2 {
  max-width: 380px;
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.35;
}

/*
 * 详情底部的图: 做成有边界的"画框", 而不是让图片裸在空白里。
 * - 画框吃掉字段下方剩余高度 (flex:1), 但最小 160px, 窗口再矮也不会压没
 * - 图片不设宽高, 只用 max-*: 小图 (比如 147x200 的缩略图) 保持自然尺寸不被放大糊掉
 * - object-fit: contain 保证任何比例都不裁切
 */
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
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.detail {
  width: 380px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 12px;
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

.detail li {
  display: grid;
  grid-template-columns: 74px 1fr 24px 48px;
  gap: 8px;
  align-items: baseline;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  font-size: 12px;
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

.detail .pin {
  padding: 0;
  border: none;
  background: transparent;
  font-size: 12px;
  opacity: 0.45;
}

.detail .pin.on {
  opacity: 1;
}

.detail .from {
  color: var(--line-strong);
  font-family: ui-monospace, monospace;
  font-size: 12px;
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
  font-size: 13px;
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}

.note {
  margin: 0;
  color: var(--ok);
  font-size: 13px;
}

.lib-config {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  margin-bottom: 8px;
  font-size: 13px;
}

.lib-config select {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px;
  font-size: 13px;
  max-width: 320px;
}

.badge {
  font-size: 12px;
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
  font-size: 12px;
}

.note-line {
  margin: 0 0 12px;
}

.summary {
  font-size: 13px;
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
  font-size: 12px;
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
  font-size: 13px;
}

.settings h2 {
  font-size: 14px;
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
  font-size: 13px;
}

.settings .field input {
  flex: 1;
  max-width: 420px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--text);
  font-family: ui-monospace, monospace;
  font-size: 13px;
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
  font-size: 13px;
}

.tag[data-ready="true"] {
  color: var(--ok);
}

.path {
  color: var(--muted);
  font-size: 12px;
  font-family: ui-monospace, monospace;
}

.events {
  display: flex;
  gap: 12px;
  overflow: hidden;
  white-space: nowrap;
  color: var(--muted);
  font-size: 12px;
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
