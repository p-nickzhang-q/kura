import { describe, expect, test } from "bun:test";
import { detectContentType, extractNumber, identify, parseFileInfo } from "../src/domain/identify";

describe("extractNumber", () => {
  test("有码: 大小写与分隔符都归一", () => {
    expect(extractNumber("ABC-123.mp4")).toBe("ABC-123");
    expect(extractNumber("abc_123.mp4")).toBe("ABC-123");
    expect(extractNumber("Abc 123 1080p.mkv")).toBe("ABC-123");
  });

  test("全角输入", () => {
    expect(extractNumber("ＡＢＣ－１２３.mp4")).toBe("ABC-123");
  });

  test("FC2 单独成格式", () => {
    expect(extractNumber("FC2-PPV-1234567.mp4")).toBe("FC2-PPV-1234567");
    expect(extractNumber("fc2ppv_1234567.mp4")).toBe("FC2-PPV-1234567");
    // PPV 段经常被省略: 老片子与中转站普遍写成 FC2-xxx
    expect(extractNumber("[FC2-1122370][完全业余45] Momo.mp4")).toBe("FC2-PPV-1122370");
    expect(extractNumber("FC2-2752957.mp4")).toBe("FC2-PPV-2752957");
  });

  test("站点编号前缀不属于番号 (真实文件名)", () => {
    // 中转站习惯在番号前加站点编号, 104/261/300 这些都不是番号的一部分
    expect(extractNumber("104DANDY-574.mp4")).toBe("DANDY-574");
    expect(extractNumber("261MARA-029.mp4")).toBe("MARA-029");
    expect(extractNumber("200GANA-3003.mp4")).toBe("GANA-3003");
    expect(extractNumber("300MIUM-949.mp4")).toBe("MIUM-949");
    expect(extractNumber("413INSTV-325.mp4")).toBe("INSTV-325");
    expect(extractNumber("[104DANDY-574]「我一个人与我美丽的成熟妻子.mp4")).toBe("DANDY-574");
  });

  test("前缀里带数字的番号 (T28-) 与 6 位数字 (MYT-)", () => {
    expect(extractNumber("[T28-642]我父母不在的那天.mp4")).toBe("T28-642");
    expect(extractNumber("MYT-250004.mp4")).toBe("MYT-250004");
    expect(detectContentType("T28-642")).toBe("censored");
  });

  test("无码: 6 位-3 位", () => {
    expect(extractNumber("123456-789.mp4")).toBe("123456-789");
  });

  test("认不出来就是 null, 不猜", () => {
    expect(extractNumber("holiday.mp4")).toBeNull();
    expect(extractNumber("2024.01.01.mp4")).toBeNull();
  });
});

describe("detectContentType", () => {
  test("顺序固定: fc2 → uncensored → 其余", () => {
    expect(detectContentType("FC2-PPV-1234567")).toBe("fc2");
    expect(detectContentType("123456-789")).toBe("uncensored");
    expect(detectContentType("ABC-123")).toBe("censored");
  });

  test("关键词只作提示, 不改已有判定", () => {
    expect(detectContentType("ABC-123", "hhd800 国产")).toBe("chinese");
    expect(detectContentType("ABC-123", "SIRO-1234")).toBe("amateur");
  });
});

describe("identify", () => {
  test("有番号时 number 与 key 一致", () => {
    expect(identify({ text: "ABC-123-C.mp4" })).toEqual({
      value: "ABC-123",
      number: "ABC-123",
      contentType: "censored",
    });
  });

  test("无番号走 site:id, 且与真番号分命名空间", () => {
    const key = identify({ text: "素人", site: "javdb", siteId: "2X9K1" });
    expect(key?.value).toBe("javdb:2x9k1");
    expect(key?.number).toBeNull();
  });
});

describe("parseFileInfo", () => {
  test("-C 是中字, -CD1 是分集", () => {
    expect(parseFileInfo("ABC-123-C.mp4").hasSubtitle).toBe(true);
    const cd = parseFileInfo("ABC-123-CD1.mp4");
    expect(cd.cd).toBe(1);
    expect(cd.hasSubtitle).toBe(false);
  });

  test("-U / -UC 的相位", () => {
    expect(parseFileInfo("ABC-123-U.mp4").mosaic).toBe("uncensored");
    const uc = parseFileInfo("ABC-123-UC.mp4");
    expect(uc.mosaic).toBe("uncensored");
    expect(uc.hasSubtitle).toBe(true);
  });

  test("破解优先于流出, 流出优先于无码", () => {
    expect(parseFileInfo("ABC-123 破解 流出.mp4").mosaic).toBe("cracked");
    expect(parseFileInfo("ABC-123 流出.mp4").mosaic).toBe("leaked");
  });

  test("分辨率", () => {
    expect(parseFileInfo("ABC-123-4K.mp4").definition).toBe("4k");
    expect(parseFileInfo("ABC-123-1080p.mp4").definition).toBe("1080p");
  });
});

describe("国产线索不能撞上番号", () => {
  // 这条是被真事故逼出来的: 裸 MD / 91 会把 SNIS-191、MDON-027 判成国产,
  // 而国产只路由到 javdb —— javdb 一被 Cloudflare 拦, 这些条目一条源都拿不到。
  test("番号里带 191 / 091 的仍是日本有码", () => {
    for (const file of ["SNIS-191.mkv", "IPX-191.mp4", "ABP-091.mkv"]) {
      expect(detectContentType(extractNumber(file) ?? "", file)).toBe("censored");
    }
  });

  test("以 MD 开头的日本番号不被当成麻豆", () => {
    expect(detectContentType(extractNumber("MDON-027.mkv") ?? "", "MDON-027.mkv")).toBe("censored");
  });

  test("真正的国产写法照样认得出来", () => {
    for (const file of ["MD-0123.mp4", "MDX-0123.mp4", "91CM-123.mp4", "91KZ-666.mp4", "国产-某某.mp4"]) {
      expect(detectContentType(extractNumber(file) ?? "", file)).toBe("chinese");
    }
  });
});
