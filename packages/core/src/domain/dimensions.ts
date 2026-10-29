import type { ContentType } from "./types";

/**
 * 整理维度: 一个库只选一个, 决定第一层目录; 模板负责其余层级。
 *
 * 与 Amane 的对应关系: 它没有"维度"这个概念, 而是让用户直接写模板。
 * 这里把常见模板固化成预设, 但**落库的是展开后的模板字符串**, 不是预设 id ——
 * 以后改预设定义不会让已有库的行为漂移。
 */
export interface Dimension {
  id: string;
  label: string;
  template: string;
  /** 多值维度(演员)的说明, GUI 直接展示。 */
  note?: string;
}

export const DIMENSIONS: Dimension[] = [
  { id: "number", label: "按番号", template: "{number}" },
  {
    id: "actor",
    label: "按演员",
    template: "{actor}/{number}",
    note: "多演员时取第一演员; 想全部列进目录名用 {actors}",
  },
  {
    id: "actors",
    label: "按演员(全部)",
    template: "{actors}/{number}",
    note: "全部演员拼成一个目录名; 同一演员的片会分散在多个组合目录里",
  },
  { id: "studio", label: "按片商", template: "{studio}/{number}" },
  { id: "label", label: "按厂牌", template: "{label}/{number}" },
  { id: "series", label: "按系列", template: "{series}/{number}" },
  { id: "content_type", label: "按类型", template: "{content_type}/{number}" },
  { id: "year", label: "按年份", template: "{year}/{number}" },
];

export function findDimension(id: string): Dimension | undefined {
  return DIMENSIONS.find((dimension) => dimension.id === id);
}

export function dimensionTemplate(id: string): string | null {
  return findDimension(id)?.template ?? null;
}

/** 模板里出现过的占位符, 供 GUI 提示与校验。 */
export function templatePlaceholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!))];
}

export const TEMPLATE_PLACEHOLDERS: Record<string, string> = {
  number: "番号",
  title: "标题",
  studio: "片商",
  label: "厂牌",
  series: "系列",
  release_date: "发行日期",
  year: "年份",
  content_type: "类型(有码/无码/…)",
  actor: "第一演员",
  actors: "全部演员(顿号分隔)",
  cd: "分集号",
};

export function unknownPlaceholders(template: string): string[] {
  return templatePlaceholders(template).filter((name) => !(name in TEMPLATE_PLACEHOLDERS));
}

/** 与 CONTENT_TYPE_LABEL 同源, 避免中文类型名在多处各写一遍。 */
export type DimensionContentType = ContentType;
