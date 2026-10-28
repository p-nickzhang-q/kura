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
