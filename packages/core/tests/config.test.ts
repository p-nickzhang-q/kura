import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_SETTINGS,
  isDmmConfigured,
  loadSettings,
  maskSecret,
  maskSettings,
  resolveDmmEnv,
  saveSettings,
  settingsPath,
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
