# 发版

> 一次发版 = 一个 tag + 三个产物。产物在 `apps/desktop/release/` 与 `dist/`。

## 0. 版本号

版本散在 4 个 `package.json` 与一个手写常量里，用脚本一次改完：

```bash
node scripts/bump-version.mjs 0.2.0
```

改到：根、`apps/desktop`、`packages/core`、`packages/cli` 的 `version`，以及 `packages/cli/src/version.ts`。

## 1. 发版前必过

```bash
bun test            # 必须全绿, 且全程离线
pnpm typecheck
bun run build:cli && ./dist/kura --version
kura doctor --json  # 用真实数据目录跑一次, 确认 schema 迁移正常
```

## 2. 打三个产物

```bash
# a) CLI (Windows x64, 交叉编译)
bun run build:cli:win                    # -> dist/kura.exe

# b) portable (Linux 上不需要 wine)
pnpm --filter @kura/desktop package:win  # -> apps/desktop/release/Kura-<ver>-portable.exe

# c) NSIS 安装包
#    Linux 上需要 wine (makensis 有 Linux 版, 但 rcedit 改卸载器 stub 只能经 wine)
pnpm --filter @kura/desktop package:installer
#    没有 wine 时: 在 Windows 侧构建, 见 packaging.md
```

## 3. 推 tag 与 release

```bash
mkdir -p /tmp/kura-release
cp apps/desktop/release/Kura-<ver>-setup.exe     /tmp/kura-release/
cp apps/desktop/release/Kura-<ver>-portable.exe  /tmp/kura-release/
cp dist/kura.exe /tmp/kura-release/kura-<ver>-win-x64.exe
```

**必须先换成这四个名字再上传**。electron-builder 在 Windows 上产出的文件名带空格
（`Kura 0.6.40.exe` / `Kura Setup 0.6.40.exe`），`gh` 上传时会把空格换成点
（`Kura.0.6.40.exe`）；而 `dist/kura.exe` 根本不含版本号。两者都会让“按名字下载”的
脚本断掉 —— 包括更新检查。

| 资源 | 文件名 | 大小 |
|---|---|---|
| 安装包 | `Kura-<ver>-setup.exe` | ~98MB |
| 安装包 + 命令行工具 | `Kura-<ver>-setup-cli.exe` | ~125MB |
| 便携版 | `Kura-<ver>-portable.exe` | ~90MB |
| CLI | `kura-<ver>-win-x64.exe` | ~110MB |

`-setup-cli` 是**可选**的:它比普通安装包多一个 `kura.exe`(压缩后 ~40MB),装完能把
`kura` 直接敲进终端。不想让所有下载的人都付这 40MB,所以做成第二个安装包,而不是
把普通安装包做大。

它由 `apps/desktop/electron-builder.cli.yml` 单独构建(见 packaging.md),配置里
`extends` 普通那份再补 `extraFiles` + `nsis.include`。

已经传错了名字就 `gh release delete-asset` 删掉重传，不要留着两份。

网络不稳定时，`git` 与 `gh` 分别试一次直连和代理再决定用哪个（两者打的是不同域名，
可能一条通、一条不通）：

```bash
curl -s -o /dev/null -w "git 域名直连 %{http_code}\n" --max-time 15 https://github.com/
curl -s -o /dev/null -w "gh 域名直连 %{http_code}\n" --max-time 15 https://api.github.com/
```

不通的那条加 `HTTPS_PROXY=http://<host>:7890`，或者反过来去掉环境变量走直连。

```bash
git push origin main
env -u HTTPS_PROXY -u HTTP_PROXY gh release create v<ver> \
  --title "Kura v<ver> — <一句话>" \
  --notes-file /tmp/release-notes.md \
  --target main \
  /tmp/kura-release/*
```

## 4. 验收

```bash
gh release view v<ver> --json assets -q '.assets[] | "\(.name) \(.size) \(.state)"'
```

四个资源都应为 `uploaded`。再抽查：下载 `setup.exe`，在 Windows 上装一次、启动、卸载。

`-setup-cli` 还要额外验一遍(**会改 HKCU 的 Path,先备份再测**):

```powershell
$before = (Get-ItemProperty HKCU:\Environment -Name Path).Path
# 装 → 新开的终端里 `kura --version` 应打印版本 → 卸载
$after = (Get-ItemProperty HKCU:\Environment -Name Path).Path
$before -eq $after   # 必须 True: 卸载要逐字符还原
```

## 发布说明要点

每次都要写清楚的：

- **未签名**：Windows 会报"未知发布者"，点「更多信息 → 仍要运行」。
- **卸载不删** `%APPDATA%\kura`（媒体库索引与配置）。
- 数据源状态：DMM 需要自己的 affiliate 凭据；JavDB 部分地区需代理、无码条目需登录。
- 本次新增/变更的命令行行为（agent 依赖退出码语义）。

## 不要做的事

- 不要在没有 `bun test` 全绿时发版 —— 测试是唯一能证明"站点解析没退化"的东西。
- 不要把 `release/`、`dist/` 提交进仓库（已 gitignore）。
- 不要改已发布 tag；要修就发新版本。
