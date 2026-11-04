import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_PROXY,
  EMPTY_SETTINGS,
  proxyCandidates,
  resetProxyCache,
  resolveProxyUrl,
  isDmmConfigured,
  loadSettings,
  maskSecret,
  maskSettings,
  resolveDmmEnv,
  resolveTmdbEnv,
  resolveProxy,
  saveSettings,
  settingsPath,
  normalizeProxyUrl,
} from "../src/config";
import { openRuntime } from "../src/runtime";
import type { Paths } from "../src/paths";

let root: string;
let paths: Paths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-cfg-"));
  paths = { dataDir: root, dbFile: join(root, "kura.db"), logDir: join(root, "logs") };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("settings", () => {
  test("没有文件时是空设置", () => {
    expect(loadSettings(paths)).toEqual(EMPTY_SETTINGS);
  });

  test("保存后可读回, 且文件权限是 0600", async () => {
    saveSettings(paths, { dmm: { apiId: "id-123456", affiliateId: "aff-123456" } });
    expect(loadSettings(paths).dmm.apiId).toBe("id-123456");

    const mode = (await stat(settingsPath(paths))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("部分更新不清掉其它字段", async () => {
    saveSettings(paths, { dmm: { apiId: "id", affiliateId: "aff" } });
    saveSettings(paths, { dmm: { apiId: "id2" } });
    expect(loadSettings(paths).dmm).toEqual({ apiId: "id2", affiliateId: "aff" });
  });

  test("坏文件不阻塞启动, 退回空设置", async () => {
    await writeFile(settingsPath(paths), "{ not json", "utf8");
    expect(loadSettings(paths)).toEqual(EMPTY_SETTINGS);
  });

  test("环境变量优先于文件", () => {
    saveSettings(paths, { dmm: { apiId: "file-id", affiliateId: "file-aff" } });
    const settings = loadSettings(paths);

    expect(resolveDmmEnv(settings, {}).apiId).toBe("file-id");
    expect(resolveDmmEnv(settings, { KURA_DMM_API_ID: "env-id" }).apiId).toBe("env-id");
    expect(resolveDmmEnv(settings, { KURA_DMM_API_ID: "  " }).apiId).toBe("file-id");
  });

  test("脱敏只留后四位, 且不泄漏到 GUI 返回值", () => {
    expect(maskSecret("abcdefgh1234")).toBe("••••1234");
    expect(maskSecret("abc")).toBe("••••");

    const masked = maskSettings({ dmm: { apiId: "secret-api-id", affiliateId: "secret-aff" } });
    expect(JSON.stringify(masked)).not.toContain("secret-api-id");
  });

  test("代理: 环境变量优先, 空串视为未设置", () => {
    saveSettings(paths, { proxy: "http://127.0.0.1:7890" });
    const settings = loadSettings(paths);

    expect(resolveProxy(settings, {})).toBe("http://127.0.0.1:7890");
    expect(resolveProxy(settings, { KURA_PROXY: "socks5://127.0.0.1:7891" })).toBe("socks5://127.0.0.1:7891");
    expect(resolveProxy(settings, { KURA_PROXY: "  " })).toBe("http://127.0.0.1:7890");

    saveSettings(paths, { proxy: "" });
    expect(resolveProxy(loadSettings(paths), {})).toBeUndefined();
  });

  test("auto: 探测命中可用代理, 并在进程内缓存", async () => {
    resetProxyCache();
    saveSettings(paths, { proxy: AUTO_PROXY });

    let calls = 0;
    const probe = async (candidate: string): Promise<boolean> => {
      calls++;
      return candidate === "http://127.0.0.1:7897";
    };

    const first = await resolveProxyUrl(loadSettings(paths), {}, { platform: "linux", probe });
    expect(first).toBe("http://127.0.0.1:7897");

    const before = calls;
    const second = await resolveProxyUrl(loadSettings(paths), {}, { platform: "linux", probe });
    expect(second).toBe(first);
    expect(calls).toBe(before); // 命中缓存, 不再探测
  });

  test("显式地址不做探测", async () => {
    resetProxyCache();
    saveSettings(paths, { proxy: "http://10.0.0.9:8888" });

    let called = false;
    const url = await resolveProxyUrl(loadSettings(paths), {}, {
      probe: async () => {
        called = true;
        return true;
      },
    });
    expect(url).toBe("http://10.0.0.9:8888");
    expect(called).toBe(false);
  });

  test("没有可用代理时 auto 解析为空(回落直连/系统代理)", async () => {
    resetProxyCache();
    saveSettings(paths, { proxy: AUTO_PROXY });
    const url = await resolveProxyUrl(loadSettings(paths), {}, { probe: async () => false });
    expect(url).toBeUndefined();
  });

  test("候选覆盖本机与常见端口", () => {
    const list = proxyCandidates("linux");
    expect(list.some((c) => c.startsWith("http://127.0.0.1:"))).toBe(true);
    expect(list.some((c) => c.endsWith(":7890"))).toBe(true);
    expect(list.some((c) => c.endsWith(":7897"))).toBe(true);
  });

  test("配置完整性判定", () => {
    expect(isDmmConfigured({})).toBe(false);
    expect(isDmmConfigured({ apiId: "a" })).toBe(false);
    expect(isDmmConfigured({ apiId: "a", affiliateId: "b" })).toBe(true);
  });

  test("runtime 启动时就带上设置", async () => {
    saveSettings(paths, { dmm: { apiId: "id-runtime", affiliateId: "aff-runtime" } });
    const rt = await openRuntime({ dataDir: root });
    try {
      expect(rt.settings.dmm.apiId).toBe("id-runtime");
      expect(await readFile(settingsPath(paths), "utf8")).toContain("id-runtime");
    } finally {
      rt.close();
    }
  });
});

describe("代理地址规范化", () => {
  test("手写的 host:port 自动补 http://", () => {
    expect(normalizeProxyUrl("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(normalizeProxyUrl(" 127.0.0.1:7890 ")).toBe("http://127.0.0.1:7890");
  });

  test("已带 scheme 的原样保留", () => {
    expect(normalizeProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(normalizeProxyUrl("https://proxy.local:8443")).toBe("https://proxy.local:8443");
  });

  test("socks 统一成 socks5://", () => {
    expect(normalizeProxyUrl("socks://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
    expect(normalizeProxyUrl("socks5h://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
  });

  test("auto 不被当成地址", () => {
    const settings = { ...EMPTY_SETTINGS, proxy: "auto" };
    expect(resolveProxy(settings, {})).toBe(AUTO_PROXY);
    expect(resolveProxy({ ...EMPTY_SETTINGS, proxy: "127.0.0.1:7890" }, {})).toBe("http://127.0.0.1:7890");
  });
});

describe("图片落盘开关", () => {
  test("saveImages 默认开, 关掉后落盘能读回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kura-cfg-"));
    const paths = { dataDir: dir, dbFile: join(dir, "kura.db"), logDir: join(dir, "logs") };
    expect(loadSettings(paths).saveImages).toBe(true);

    saveSettings(paths, { saveImages: false });
    expect(loadSettings(paths).saveImages).toBe(false);

    saveSettings(paths, { saveImages: true });
    expect(loadSettings(paths).saveImages).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("tmdbApiKey 存取、环境变量优先、输出脱敏", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "kura-cfg-tmdb-"));
    try {
      const paths = { dataDir: dir } as Parameters<typeof loadSettings>[0];
      const saved = saveSettings(paths, { tmdbApiKey: "0123456789abcdef0123456789abcdef" });
      expect(saved.tmdbApiKey).toBe("0123456789abcdef0123456789abcdef");

      const reloaded = loadSettings(paths);
      expect(reloaded.tmdbApiKey).toBe("0123456789abcdef0123456789abcdef");
      // 回显必须脱敏: 只留后四位
      expect(maskSettings(reloaded).tmdbApiKey).toBe("••••cdef");

      // 环境变量优先
      expect(resolveTmdbEnv(reloaded, { KURA_TMDB_API_KEY: "from-env" }).apiKey).toBe("from-env");
      expect(resolveTmdbEnv(reloaded, {}).apiKey).toBe("0123456789abcdef0123456789abcdef");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
