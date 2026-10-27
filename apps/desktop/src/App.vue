<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

const info = ref<KuraAppInfo | null>(null);
const root = ref("");
const dryRun = ref(true);
const busy = ref(false);
const events = ref<KuraScanEvent[]>([]);
const report = ref<KuraScanReport | null>(null);
const error = ref<string | null>(null);

let unsubscribe: (() => void) | null = null;

onMounted(async () => {
  info.value = await window.kura.info();
  // 事件在主进程产生, 渲染进程只订阅; 不在这里做任何业务判断。
  unsubscribe = window.kura.onScanEvent((event) => {
    events.value = [event, ...events.value].slice(0, 300);
  });
});

onUnmounted(() => unsubscribe?.());

const summary = computed(() => {
  if (!report.value) return null;
  const { counts } = report.value;
  return `新增 ${counts.added} · 更新 ${counts.updated} · 未变 ${counts.unchanged} · 删除 ${counts.removed}`;
});

async function pick(): Promise<void> {
  const dir = await window.kura.pickDir();
  if (dir) root.value = dir;
}

async function run(): Promise<void> {
  if (!root.value || busy.value) return;
  busy.value = true;
  error.value = null;
  report.value = null;
  events.value = [];
  try {
    report.value = await window.kura.scan(root.value, dryRun.value);
    info.value = await window.kura.info();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="shell">
    <header class="top">
      <h1>Kura</h1>
      <span v-if="info" class="meta">
        v{{ info.version }} · {{ info.dbRuntime }} · schema v{{ info.schemaVersion }} · 库内 {{ info.itemCount }} 条
      </span>
    </header>

    <section class="card">
      <label class="field">
        <span>目录</span>
        <input v-model="root" placeholder="选择或粘贴一个目录" spellcheck="false" />
        <button class="ghost" type="button" @click="pick">选择…</button>
      </label>

      <div class="row">
        <label class="check">
          <input v-model="dryRun" type="checkbox" :disabled="busy" />
          仅预演 (不写库)
        </label>
        <button class="primary" type="button" :disabled="busy || !root" @click="run">
          {{ busy ? "扫描中…" : "开始扫描" }}
        </button>
      </div>

      <p v-if="summary" class="summary">{{ summary }} · 耗时 {{ report?.durationMs }}ms</p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="info" class="path">{{ info.dataDir }}</p>
    </section>

    <section class="card log">
      <div class="log-head">
        <span>事件</span>
        <span class="muted">{{ events.length }}</span>
      </div>
      <ul>
        <li v-for="(event, index) in events" :key="`${event.path}-${index}`">
          <span class="tag" :data-type="event.type">{{ event.type.replace("file.", "") }}</span>
          <span class="p" :title="event.path">{{ event.path }}</span>
        </li>
        <li v-if="events.length === 0" class="muted empty">暂无事件</li>
      </ul>
    </section>
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
  gap: 16px;
  padding: 20px 24px;
  min-height: 100vh;
  box-sizing: border-box;
}

.top {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

h1 {
  margin: 0;
  font-size: 20px;
  letter-spacing: 0.08em;
}

.meta,
.muted {
  color: var(--muted);
  font-size: 12px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px;
}

.field {
  display: flex;
  gap: 8px;
  align-items: center;
}

.field span {
  color: var(--muted);
  font-size: 13px;
  width: 40px;
}

input[type="text"],
input:not([type]) {
  flex: 1;
  background: #0d0f14;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 12px;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}

button {
  border-radius: 8px;
  border: 1px solid var(--line);
  background: #1e232d;
  color: var(--text);
  padding: 9px 16px;
  font-size: 13px;
  cursor: pointer;
}

button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #06101f;
  font-weight: 600;
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 14px;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
}

.summary {
  margin: 14px 0 0;
  color: var(--ok);
  font-size: 13px;
}

.error {
  margin: 14px 0 0;
  color: #ff7b72;
  font-size: 13px;
}

.path {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 12px;
  font-family: ui-monospace, monospace;
}

.log {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.log-head {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 8px;
}

.log ul {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  flex: 1;
}

.log li {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 5px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  font-size: 12px;
}

.tag {
  flex: none;
  width: 68px;
  text-align: center;
  border-radius: 999px;
  padding: 2px 0;
  background: #232833;
  color: var(--muted);
  font-size: 11px;
}

.tag[data-type="file.added"] {
  color: var(--ok);
}
.tag[data-type="file.updated"] {
  color: var(--warn);
}
.tag[data-type="file.removed"] {
  color: #ff7b72;
}

.p {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
  color: #b9c0d0;
}

.empty {
  padding: 8px 0;
}
</style>
