# 来源(爬虫)开发

> 每个来源 = 一个 `Source`, 只做「番号 → RawFields」。聚合、整理、NFO 都不需要改。
> 字段语义见 [CONTEXT](../../CONTEXT.md), 输出契约见 [cli-contract](cli-contract.md)。

## 加一个来源

1. **实现接口** — `packages/core/src/sources/<site>.ts`

   ```ts
   export function createXxxSource(http: HttpClient): Source {
     return {
       id: "xxx", label: "XXX",
       status: "ready" | "todo",          // 没实现就别写 ready, `source list` 会照实显示
       contentTypes: [...],                // 这个站能提供哪些类型
       requirements: () => [],             // 缺哪些配置(环境变量名)
       async fetch(key, ctx) { ... },      // 返回 RawFields 或 null(站点确实没有这条)
     };
   }
   ```

2. **解析函数独立出来** — `parseDetail(html)` / `parseSearch(html)` 必须是纯函数, 不碰网络。
   这样它们才能用 fixture 穷举测试。

3. **抓一份真实页面做 fixture** — 见下方"fixture 规矩"。

4. **注册并排路由** — `sources/builtin.ts` 的 `createSources`, 以及 `sources/index.ts` 的 `DEFAULT_ROUTES`。
   路由顺序 = 逐字段择优顺序。

5. **实时验证** — `kura source test <id> --probe <番号>`, 它会真的打站点并报告取到哪些字段。

## fixture 规矩

**真实页面里的正文不进仓库。** 用脚本把文本全部占位化, 只留结构:

```bash
cd packages/core
bun scripts/sanitize-fixture.mjs /tmp/real.html tests/fixtures/<site>-detail.html
# 自查: 必须为 0
grep -ciE "女優|素人|人妻" tests/fixtures/*.html
```

脚本做两件事: 按选择器替换已知字段, 再把不在白名单里的文本节点整体换成"示例"(白名单只保留解析器要读的标签名、日期、时长、番号)。属性里的 `title`/`alt`/`content` 也会被清掉 —— 内容经常藏在那里。

**为什么不用 mock HTML**: 手写的 HTML 只能验证"我以为的结构", 真实页面能验证"站点的结构"。
**为什么不用真实内容**: 仓库是公开的, 内容与测试目标无关。

## 已知的站点坑

| 站点 | 坑 | 处理 |
|---|---|---|
| JavBus | 不带 `dv=1` cookie 会 302 到 `/doc/driver-verify` | 每次请求带该 cookie(跟随重定向也能到, 但多一次往返) |
| JavBus | 直达 `/番号` 未必命中; 站内检索是模糊匹配 | 逐条比对 `<date>` 里的番号, **不取首条** |
| JavBus | 开头数字段可能被站点省略(`259LUXU-1234` vs `LUXU-1234`) | `numberVariants` 生成候选写法逐个试 |
| JavDB | 字段是 `<strong>标签:</strong><span class="value">值</span>` 的行式结构, 值可能是链接也可能是纯文本 | 按标签找 `strong`, 再取相邻 `span.value` |
| JavDB | 番号不在正文里, 在按钮的 `data-clipboard-text` 上 | 直接读属性 |
| JavDB | **登录页同样返回 200**, 无码条目需要账号 | 只认 `form[action*="user_sessions"] + input[type=password]`, 命中即 `NEEDS_INPUT` |
| JavDB | 检索结果番号恒省略开头数字段 | 复用 javbus 的 `selectCandidateIndex` |
| DMM | 网页版对非日本 IP 301 到地区封锁页 | 改走官方 API, 不做 HTML 解析 |
| DMM | 凭据无效返回 HTTP 400 + `errors.api_id` | 翻译成 `NEEDS_INPUT`, 不伪装成 NOT_FOUND |
| Jav321 | 地址用 DMM 的 content_id(小写厂牌 + 集号补零), 补几位各时期不一致 | `contentIdCandidates` 依次试 5 位 / 3 位 / 原样, 404 就试下一个 |
| Jav321 | 字段是 `<b>标签</b>: <a>…</a>` 平铺在一个 div 里, **没有行容器** | `nextUntil("b")` 取到下一个标签之前的兄弟节点 |
| Jav321 | 标题的 h3 里演员名是**裸文本**接在后面 | `stripTrailingActors` 去掉结尾的演员名 |
| Jav321 | 简介、播放器、广告位都是 `div.col-md-12` | 只认**没有子元素**的那个(播放器带 script/video, 广告位带 script) |

## 简介(plot)从哪来

**JavBus 与 JavDB 的详情页没有简介栏** —— 这不是解析漏了, 是页面上真的没有
(实体页确认: JavBus 的字段区只有 識別碼/發行日期/長度/導演/製作商/發行商/系列/類別/演員)。
所以「AV 条目没有简介」是常态, 想有简介必须换来源:

| 来源 | 有简介吗 | 能用吗 |
|---|---|---|
| Jav321 (一木道) | ✓ 整段日语 あらすじ | 直连可达、无 Cloudflare |
| DMM 商品页 | ✓ あらすじ | 只在商品页(API v3 明确移除了商品説明), 且对非日本 IP 是 JS 空壳 |
| r18.dev | ✓ `comment_ja` | **只在官方 PostgreSQL dump 里**, HTTP 接口返回的 comment 是空的 |
| MGStage / Prestige / 片商官网 | ✓ | 只覆盖自家作品, 且大多 403 |
| Airav / AVSOX / iqqtv(麻豆) | ✓ | 前两个 403/空结果, iqqtv 只覆盖麻豆系 |

做法是 **按需补缺**: `scrape` 聚合完之后如果 `plot` 还是空, 才去 `PLOT_FALLBACK_SOURCES`
(`jav321`) 补一次, 然后把它的记录排在路由末尾重新聚合 —— 前面来源已经给的字段不会被它覆盖。
显式 `--source` 时不补(用户点名要哪几个源就只跑哪几个)。

拿到的是日语, 交给翻译管线(`translateMetadata` 只翻 title/plot)转成中文。

## 字段取舍

JavDB 的评分(`span.score-stars` 后面的文本)与剧照、预告片**不进域模型** —— 见 ADR 0002。
解析器里不实现它们, 将来要加字段时按"改 types → 改 schema 迁移 → 改 NFO → 补测试"的顺序走。

## 状态语义

- `ready`: 能运行。缺配置时由 `requirements()` 说明缺什么, `fetch` 抛 `NEEDS_INPUT`。
- `todo`: 未实现。**不参与刮削**, `scrape` 会跳过并在报告里列出, 绝不假装成功。
- `fetch` 返回 `null` = 这个站确实没有这条; 抛异常 = 这个站出问题了。两者在 `scrape` 里分别处理。
