# MemoCat 测试与验证指南

本文档说明 MemoCat 桌面端、后端服务、浏览器扩展与公开站点的自动化验证方法及范围。

## 1. 核心单元与集成测试

需要 **Node.js 24+**（内置 `node:test` 与 `node:sqlite`）：

```bash
npm test
```

覆盖模块与场景（全部使用隔离临时目录与合成模拟数据，不读取个人真实日志）：

- **日志解析适配器（`test/core.test.js`、`test/large-log.test.js`、`test/new-sources.test.js`、`test/unicode-jsonl.test.js`）**：
  - `Codex`、`Claude Code`、`Grok Bot`、`Antigravity` 只读发现、解析与敏感块/副代理过滤。
  - `>64 MB` 大日志文件流式导入、CRLF 换行、Unicode 行分隔符与损坏尾部行回退保护。
  - 多快照副本合并去重与幂等统计（`test/enhancements.test.js`）。
- **召回引擎与存储（`test/core.test.js`、`test/history-media.test.js`、`test/documents.test.js`）**：
  - CJK Bigram 分词、主查询/补充词双轨加权、邻域平滑、9,600 token 预算裁剪。
  - SQLite WAL + FTS5 trigram 索引、图片哈希缓存与原始图删除后的缓存复用、长粘贴文档安全下载。
  - 7/30 天按日入库统计、分页与存储字节核算。
- **跨 AI HTTP MCP 与本地安全边界（`test/interop.test.js`、`test/sync-schedule.test.js`）**：
  - `recall` 与 `list_conversations` JSON-RPC 2.0 行为、`process_id` 去重、三态交付审计与调用方隔离。
  - 客户端独立开关与来源白名单校验、`Host` / `Origin` / `Sec-Fetch-Site` 跨站拦截。
  - 定时同步（1–1440 分钟）持久化与重启恢复。
- **浏览器扩展协议与桌面生命周期（`test/browser-extension.test.js`、`test/extension-lifecycle.test.js`、`test/enhancements.test.js`）**：
  - `MemoCore.reconcile` / `MemoCore.replace`、URL 身份校验、9 平台规则、256 位密钥配对、CAS Outbox 并发确认。
  - 悬浮球交互、失效扩展上下文自动停止、Electron 托盘与 Security-Scoped Bookmarks 生命周期模拟。

## 2. 浏览器扩展真实 MV3 端到端测试

```bash
npm run build:extension
npm run test:extension:browser
```

- 通过 `scripts/run-extension-e2e.mjs` 与 `scripts/verify-extension.mjs` 启动独立临时浏览器配置目录加载 `extension/`。
- 使用 CDP `Fetch` 拦截将 9 个 AI 平台网址路由至本地合成 HTML 夹具，不访问真实账号或公网站点。
- 端到端验证：9 平台 DOM 采集、内容脚本权限隔离、局部窗口合并、重启 Service Worker 后 IndexedDB 持久化、桌面端自动配对与删除同步、MCP 召回及 `480px` 窄屏响应式布局。
- 默认使用 macOS `/Applications/Microsoft Edge.app`，可通过 `MEMO_BROWSER_BINARY` 指定其他支持 `--load-extension` 的 Chromium 浏览器。

## 3. 打包与产品站点校验

- **macOS 桌面安装包结构校验**：
  - `npm run build:dmg` 会自动运行 `scripts/verify-packaged.mjs` 与 `codesign --verify` / `hdiutil verify`。
  - `npm run build:mas` 会校验 `build/PrivacyInfo.xcprivacy`、`build/entitlements.mas.plist` 与 `build/entitlements.mas.inherit.plist` 格式与签名结构。
- **Chrome Web Store 交付件生成与校验**：
  - `npm run build:cws` 生成并检查扩展 ZIP 包、128×128 图标与 1280×800 / 440×280 / 1400×560 无透明通道 JPEG 素材。
- **GitHub Pages 静态站点校验**：
  - `node scripts/deploy-pages.mjs --dry-run` 校验 `docs/site/` 下所有中英文页面、样式脚本、截图及 `CNAME` 引用完整且无越界路径。
