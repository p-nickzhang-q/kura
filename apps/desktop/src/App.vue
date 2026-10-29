<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

const TYPE_LABEL: Record<string, string> = {
  censored: "有码",
  uncensored: "无码",
  fc2: "FC2",
  chinese: "国产",
  amateur: "素人",
  western: "欧美",
  anime: "动漫",
};

const info = ref<KuraAppInfo | null>(null);
const libraries = ref<KuraLibrary[]>([]);
const selectedId = ref<number | null>(null);
const items = ref<KuraItem[]>([]);
const tab = ref<"items" | "plan" | "settings">("items");
const busy = ref(false);
const error = ref<string | null>(null);
const note = ref<string | null>(null);
const plan = ref<KuraPlan | null>(null);
const events = ref<KuraScanEvent[]>([]);
const confirmApply = ref(false);
const config = ref<KuraConfig | null>(null);
const apiIdInput = ref("");
const affiliateInput = ref("");
const proxyInput = ref("");
const dmmTest = ref<KuraDmmTest | null>(null);

let unsubscribe: (() => void) | null = null;

const selected = computed(() => libraries.value.find((library) => library.id === selectedId.value) ?? null);

onMounted(async () => {
  unsubscribe = window.kura.onScanEvent((event) => {
    events.value = [event, ...events.value].slice(0, 200);
  });
  await refreshAll();
});

onUnmounted(() => unsubscribe?.());

async function refreshAll(): Promise<void> {
  info.value = await window.kura.info();
  config.value = await window.kura.configGet();
  libraries.value = await window.kura.libraries();
  if (selectedId.value === null && libraries.value[0]) selectedId.value = libraries.value[0].id;
  items.value = await window.kura.items(100);
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
    await refreshAll();
  }
}

async function doScrape(): Promise<void> {
  const batch = await run("刮削", () => window.kura.scrapePending(20));
  if (batch) {
    const failed = batch.reports.filter((report) => !report.ok);
    note.value = `刮削 ${batch.count} 条, 失败 ${failed.length} 条${failed[0]?.error ? ` (${failed[0].error})` : ""}`;
    await refreshAll();
  }
}

async function preview(): Promise<void> {
  if (selectedId.value === null) return;
  const report = await run("生成计划", () => window.kura.organizePreview(selectedId.value!));
  if (report) {
    plan.value = report.plan;
    tab.value = "plan";
    confirmApply.value = false;
  }
}

async function saveConfig(): Promise<void> {
  const patch: { apiId?: string; affiliateId?: string; proxy?: string } = {};
  // 凭据留空 = 保持原值; 代理留空 = 显式清空(回落系统代理)。
  if (apiIdInput.value.trim()) patch.apiId = apiIdInput.value.trim();
  if (affiliateInput.value.trim()) patch.affiliateId = affiliateInput.value.trim();
  patch.proxy = proxyInput.value.trim();
  if (!patch.apiId && !patch.affiliateId && !patch.proxy) {
    note.value = "没有改动";
    return;
  }
  const saved = await run("保存配置", () => window.kura.configSet(patch));
  if (saved) {
    apiIdInput.value = "";
    affiliateInput.value = "";
    proxyInput.value = "";
    await refreshAll();
    note.value = `已保存到 ${config.value?.path ?? "配置文件"}`;
  }
}

async function testDmm(): Promise<void> {
  dmmTest.value = await run("测试 DMM", () => window.kura.testDmm("SSIS-001"));
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

    <div class="body">
      <aside class="side">
        <div class="side-head">
          <span>媒体库</span>
          <button class="ghost" type="button" :disabled="busy" @click="addLibrary">+</button>
        </div>
        <ul class="libs">
          <li v-for="library in libraries" :key="library.id" :class="{ active: library.id === selectedId }">
            <button type="button" @click="selectedId = library.id">
              <strong>{{ library.name }}</strong>
              <small :title="library.root">{{ library.root }}</small>
            </button>
          </li>
          <li v-if="libraries.length === 0" class="muted">还没有媒体库</li>
        </ul>

        <div class="actions">
          <button type="button" :disabled="busy || !selected" @click="doScan">扫描</button>
          <button type="button" :disabled="busy" @click="doScrape">刮削待处理</button>
          <button type="button" :disabled="busy || !selected" @click="preview">整理预览</button>
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
          <button type="button" :class="{ on: tab === 'plan' }" @click="tab = 'plan'">整理预览</button>
          <button type="button" :class="{ on: tab === 'settings' }" @click="tab = 'settings'">设置</button>
          <span class="spacer" />
          <span v-if="busy" class="muted">进行中…</span>
        </nav>

        <p v-if="error" class="error">{{ error }}</p>
        <p v-else-if="note" class="note">{{ note }}</p>

        <div v-else-if="tab === 'settings'" class="pane settings">
          <h2>数据源</h2>
          <p class="muted">
            DMM 走官方 API, 需要 affiliate 凭据。配置保存在本地文件, 环境变量优先。
          </p>

          <label class="field">
            <span>API ID</span>
            <input
              v-model="apiIdInput"
              type="password"
              spellcheck="false"
              :placeholder="config?.settings.dmm.apiId || '未设置'"
            />
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

          <h2>代理</h2>
          <label class="field">
            <span>代理地址</span>
            <input
              v-model="proxyInput"
              spellcheck="false"
              :placeholder="config?.settings.proxy || '留空 = 跟随系统代理'"
            />
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

        <div v-if="tab === 'items'" class="pane">
          <table>
            <thead>
              <tr>
                <th>番号</th>
                <th>类型</th>
                <th>标题</th>
                <th>片商</th>
                <th>演员</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in items" :key="item.key">
                <td class="mono">{{ item.number }}</td>
                <td>{{ TYPE_LABEL[item.contentType] ?? item.contentType }}</td>
                <td>{{ item.title ?? "未刮削" }}</td>
                <td>{{ item.studio ?? "—" }}</td>
                <td>{{ item.actors?.join("、") ?? "—" }}</td>
              </tr>
              <tr v-if="items.length === 0">
                <td colspan="5" class="muted">没有条目。先扫描一个媒体库。</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else class="pane">
          <div v-if="!plan" class="muted">点左侧「整理预览」生成计划。</div>
          <template v-else>
            <p class="summary">
              移动 {{ plan.summary.move }} · 写 NFO {{ plan.summary.writeNfo }} · 跳过 {{ plan.summary.skip }}
              <span class="muted">(库根 {{ plan.libraryRoot }})</span>
            </p>
            <ul class="plan">
              <li v-for="(entry, index) in plan.entries.slice(0, 200)" :key="index" :data-action="entry.action">
                <span class="tag">{{ entry.action }}</span>
                <span v-if="entry.action === 'move'" class="mono">
                  {{ entry.from }} → {{ entry.to }}
                </span>
                <span v-else class="mono">{{ entry.to ?? entry.from }} {{ entry.reason ?? "" }}</span>
              </li>
            </ul>

            <div class="apply">
              <template v-if="!confirmApply">
                <button type="button" class="primary" :disabled="busy || plan.summary.move === 0" @click="confirmApply = true">
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
  padding: 14px 20px;
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

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.side {
  width: 260px;
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
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}

.libs li.active button {
  background: #1d2431;
  border-color: #2f3b52;
}

.libs small {
  color: var(--muted);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sources {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.8;
}

.sources .ready {
  color: var(--ok);
  margin-right: 6px;
}

.sources .todo {
  color: #6b7285;
  margin-right: 6px;
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
  color: #06101f;
  font-weight: 600;
}

button.danger {
  background: #b3403a;
  border-color: #b3403a;
  color: #fff;
}

button.ghost {
  padding: 2px 8px;
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
  gap: 10px;
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

.pane {
  flex: 1;
  min-height: 0;
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
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  background: var(--bg);
}

td {
  padding: 7px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.error {
  margin: 0;
  color: #ff7b72;
  font-size: 13px;
}

.note {
  margin: 0;
  color: var(--ok);
  font-size: 13px;
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
  gap: 10px;
  align-items: baseline;
  padding: 5px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.plan .tag {
  flex: none;
  width: 78px;
  text-align: center;
  border-radius: 999px;
  background: #232833;
  color: var(--muted);
  font-size: 11px;
  padding: 2px 0;
}

.plan li[data-action="move"] .tag {
  color: var(--warn);
}

.apply {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.warn {
  color: var(--warn);
  font-size: 13px;
}

.settings h2 {
  font-size: 14px;
  margin: 18px 0 8px;
  color: var(--text);
}

.settings h2:first-child {
  margin-top: 0;
}

.settings .field {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.settings .field span {
  width: 110px;
  color: var(--muted);
  font-size: 13px;
}

.settings .field input {
  flex: 1;
  max-width: 420px;
  background: #0d0f14;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--text);
  font-family: ui-monospace, monospace;
  font-size: 13px;
}

.settings .row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 0 10px;
}

.src-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.src-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  font-size: 13px;
}

.tag[data-ready="true"] {
  color: var(--ok);
}

.events {
  display: flex;
  gap: 12px;
  overflow: hidden;
  white-space: nowrap;
  color: var(--muted);
  font-size: 11px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
}

.events [data-type="file.added"] {
  color: var(--ok);
}
.events [data-type="file.removed"] {
  color: #ff7b72;
}
</style>
