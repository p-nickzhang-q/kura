import { describe, expect, test } from "bun:test";
import { AppError, EXIT } from "../src/exit";
import type { HttpClient } from "../src/net/http";
import { buildUrl, createDmmSource, matchDmmItem, normalizeCode, toRawFields, type DmmItem } from "../src/sources/dmm";
import type { ItemKey } from "../src/domain/types";

const key: ItemKey = { value: "SSIS-001", number: "SSIS-001", contentType: "censored" };

/** 与 DMM Web Service v3 ItemList 的字段形状一致(内容为占位)。 */
const ITEM: DmmItem = {
  content_id: "77ssis001",
  product_id: "ssis001",
  title: "サンプルタイトル",
  volume: "120",
  date: "2024-01-02 10:00:00",
  imageURL: {
    large: "https://pics.dmm.co.jp/large/ssis001.jpg",
    list: "https://pics.dmm.co.jp/list/ssis001.jpg",
    small: "https://pics.dmm.co.jp/small/ssis001.jpg",
  },
  iteminfo: {
    maker: [{ name: "メーカーA" }, { name: "" }],
    label: [{ name: "レーベルA" }],
    series: [{ name: "シリーズA" }],
    actress: [{ name: "女優A" }, { name: "女優B" }],
    director: [{ name: "監督A" }],
    genre: [{ name: "ジャンルA" }, { name: "ジャンルB" }],
  },
};

function stubHttp(payload: unknown): HttpClient {
  return { getJson: async () => payload } as unknown as HttpClient;
}

describe("normalizeCode / matchDmmItem", () => {
  test("只留字母数字, 便于跨格式比较", () => {
    expect(normalizeCode("SSIS-001")).toBe("SSIS001");
    expect(normalizeCode("77ssis001")).toBe("77SSIS001");
  });

  test("厂商前缀靠后缀匹配, 但不做模糊匹配", () => {
    const decoy: DmmItem = { content_id: "ssis999" };
    expect(matchDmmItem([decoy, ITEM], key)?.content_id).toBe("77ssis001");
    expect(matchDmmItem([decoy], key)).toBeNull();
  });

  test("完全相等优先于后缀匹配", () => {
    const prefixed: DmmItem = { content_id: "77ssis001" };
    const exact: DmmItem = { content_id: "ssis001" };
    expect(matchDmmItem([prefixed, exact], key)?.content_id).toBe("ssis001");
  });
});

describe("toRawFields", () => {
  test("字段映射 + 空值清理", () => {
    const fields = toRawFields(ITEM);
    expect(fields.title).toBe("サンプルタイトル");
    expect(fields.duration_min).toBe(120);
    expect(fields.release_date).toBe("2024-01-02");
    expect(fields.studio).toBe("メーカーA");
    expect(fields.actors).toEqual(["女優A", "女優B"]);
    expect(fields.tags).toEqual(["ジャンルA", "ジャンルB"]);
    expect(fields.poster_urls).toEqual(["https://pics.dmm.co.jp/large/ssis001.jpg"]);
  });

  test("缺字段时不产出空数组", () => {
    const fields = toRawFields({ content_id: "ssis001", title: "x" });
    expect(fields.actors).toBeUndefined();
    expect(fields.poster_urls).toBeUndefined();
    expect(fields.duration_min).toBeUndefined();
  });
});

describe("createDmmSource", () => {
  test("缺凭据时抛 NEEDS_INPUT, 并点名缺哪个环境变量", async () => {
    const source = createDmmSource(stubHttp({}), {});
    expect(source.requirements()).toEqual(["KURA_DMM_API_ID", "KURA_DMM_AFFILIATE_ID"]);

    const error = await source.fetch(key, { fixturesDir: null }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(EXIT.NEEDS_INPUT);
    expect((error as AppError).message).toContain("KURA_DMM_API_ID");
  });

  test("正常响应映射成 RawFields", async () => {
    const source = createDmmSource(stubHttp({ result: { status: 200, items: [ITEM] } }), {
      apiId: "id",
      affiliateId: "aff",
    });
    const fields = await source.fetch(key, { fixturesDir: null });
    expect(fields?.title).toBe("サンプルタイトル");
    expect(source.requirements()).toEqual([]);
  });

  test("API 报 401 视为凭据问题而非网络问题", async () => {
    const source = createDmmSource(stubHttp({ result: { status: 401, message: "unauthorized" } }), {
      apiId: "id",
      affiliateId: "aff",
    });
    const error = await source.fetch(key, { fixturesDir: null }).catch((err: unknown) => err);
    expect((error as AppError).exitCode).toBe(EXIT.NEEDS_INPUT);
  });

  test("没有匹配条目时返回 null, 不返回错误", async () => {
    const source = createDmmSource(stubHttp({ result: { status: 200, items: [{ content_id: "xxxx999" }] } }), {
      apiId: "id",
      affiliateId: "aff",
    });
    expect(await source.fetch(key, { fixturesDir: null })).toBeNull();
  });
});

describe("buildUrl", () => {
  test("带上必需参数且做 URL 编码", () => {
    const url = buildUrl({ apiId: "a&b", affiliateId: "c" }, "SSIS-001");
    expect(url).toContain("api_id=a%26b");
    expect(url).toContain("keyword=SSIS-001");
    expect(url).toContain("site=FANZA");
  });
});
