# 打包

> 目标平台 Windows x64。产物在 `apps/desktop/release/`。

## 两种包

| 目标 | 命令 | 需要 wine? | 产物 |
|---|---|---|---|
| NSIS **安装包** | `pnpm --filter @kura/desktop package:installer` | **在 Linux 上需要** | `Kura-<ver>-setup.exe` |
| portable 便携版 | `pnpm --filter @kura/desktop package:win` | 不需要 | `Kura-<ver>-portable.exe` |

安装包用 NSIS: 可选安装目录、桌面/开始菜单快捷方式、卸载器。
**卸载不删 `%APPDATA%\kura`** —— 里面有媒体库索引与配置, 误删代价远大于残留。

## 为什么 NSIS 在 Linux 上需要 wine

`makensis` 本身有 Linux 版, 但 electron-builder 还要用 `rcedit` 改写**卸载器 stub** 的图标/版本资源,
这一步是 Windows PE 操作, 只能经 wine。portable 目标不走这条路径, 所以不需要。

没有 sudo 装 wine 时的替代方案(实测可行): **在 Windows 上构建**。

```
# 1. 把打包输入拷到 Windows 侧(只需 4 个东西)
dist/  dist-electron/  electron/preload.cjs  package.json  build/icon.ico

# 2. 在 Windows 侧(有 node/npx 即可)
cd D:\kura-build
npx --yes electron-builder@26.18.0 --win nsis
```

## 网络受限时

electron-builder 会下载 electron 的 win32 包与 nsis 工具, 直连 GitHub 基本会超时。三种解:

1. 镜像(注意 **cmd 里 `set` 要加引号**, 否则尾随空格会拼进 URL):
   `set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"`
2. 预热缓存: 把 WSL 里已有的 `~/.cache/electron-builder/*` 拷到
   `%LOCALAPPDATA%\electron-builder\Cache\`。
3. **完全离线**: 解压一份 `electron-v<ver>-win32-x64.zip` 到本地目录, 配置 `electronDist: <目录>`,
   electron-builder 就不再下载。

## 尚未做

- **代码签名**: 未签名, Windows 会弹 SmartScreen 警告。需要证书与 `CSC_LINK`/`CSC_KEY_PASSWORD`。
- **自动更新**: 已生成 `.blockmap`, 但没接更新服务器(electron-updater)。
- **安装包图标/版本信息**: 由 `build/icon.ico` 与 package.json 决定, 已生效。
