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
| DMM | 网页版对非日本 IP 301 到地区封锁页 | 改走官方 API, 不做 HTML 解析 |
| DMM | 凭据无效返回 HTTP 400 + `errors.api_id` | 翻译成 `NEEDS_INPUT`, 不伪装成 NOT_FOUND |

## 状态语义

- `ready`: 能运行。缺配置时由 `requirements()` 说明缺什么, `fetch` 抛 `NEEDS_INPUT`。
- `todo`: 未实现。**不参与刮削**, `scrape` 会跳过并在报告里列出, 绝不假装成功。
- `fetch` 返回 `null` = 这个站确实没有这条; 抛异常 = 这个站出问题了。两者在 `scrape` 里分别处理。
