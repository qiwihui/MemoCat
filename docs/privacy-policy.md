# MemoCat 隐私政策 / Privacy Policy

生效日期 / Effective Date: 2026-11-20  
项目主页 / Homepage: https://memocat.qiwihui.com/  
在线隐私政策 / Online Privacy Policy: https://memocat.qiwihui.com/privacy.html  
适用产品 / Covered Products:
- **MemoCat 桌面端 / MemoCat Desktop**（Bundle ID: `com.qiwihui.memocat.desktop`）
- **MemoCat 浏览器扩展 / MemoCat Browser Extension**（`MemoCat · AI 对话归档`）

---

## 中文版隐私政策

### 1. 核心承诺
MemoCat 采用**纯本机离线架构**。我们不设云端账号体系，不运行远程数据服务器，不收集、出售、共享或上传任何用户对话内容、文件目录信息或行为遥测。

### 2. 数据读取与本地存储
- **用户主动授权的本机目录（桌面端）**：
  桌面应用不会静默扫描未授权的系统目录。在 Mac App Store 沙盒环境下，仅当您通过原生文件选择器主动授予目录访问权限后，应用才以只读方式读取该目录中的 AI 工具本地日志（如 Codex、Claude Code、Grok Bot、Antigravity），并通过 macOS Security-Scoped Bookmark 在本机持久化保留该目录的只读授权。
- **网页对话采集（浏览器扩展）**：
  扩展仅在 `manifest.json` 明确列出的 AI 对话网页域名运行页面脚本，并在您点击保存或主动开启对应站点自动保存时，提取当前页面已加载的对话文本与标题，保存于浏览器本机 IndexedDB 与 `chrome.storage.local`。
- **本机资料库存储**：
  桌面端将导入并结构化后的对话正文、本地图片缓存、同步状态与召回取用记录保存在本机数据库（`memo.sqlite`）中。所有文件均留存在您的设备本地存储空间。

### 3. 本地网络回环与跨工具互通
- 桌面端与浏览器扩展之间的增量同步、以及桌面端提供给本机 AI 客户端的 MCP 检索服务，**仅监听本机回环地址 `127.0.0.1`**（默认端口 `3792`），不会向互联网或局域网广播或发送任何数据。
- 浏览器扩展与桌面端连接时使用本机生成并保存的 256 位随机配对密钥校验请求来源；所有跨 AI 召回开关与授权范围均默认由用户控制。

### 4. 第三方追踪与广告
- MemoCat **不包含**任何第三方分析 SDK、崩溃上报 SDK、广告 SDK 或追踪域名（`NSPrivacyTracking = false`）。
- 我们不会向任何外部模型训练服务、广告平台或数据经纪商传输您的任何数据。

### 5. 数据控制与删除
- 您可以随时在浏览器扩展中删除单条对话或清空扩展本地资料库，并可导出标准 Markdown / JSON 备份。
- 在桌面端，您可以随时关闭特定 AI 来源采集、撤销目录配置，或通过系统设置/直接删除本机数据目录永久清除全部数据库及缓存文件。

---

## English Privacy Policy

### 1. Overview
MemoCat is built with a **local-first, offline-only architecture**. MemoCat has no user accounts, no remote backend servers, and no telemetry, analytics, or advertising SDKs. We do not collect, transmit, sell, or share your conversations, files, or usage data.

### 2. Data Accessed and Stored Locally
- **User-Selected Local Folders (Desktop App)**:
  MemoCat Desktop only reads local AI conversation directories that you explicitly authorize through the macOS file open dialog (such as Codex, Claude Code, Grok Bot, or Antigravity log directories). In Mac App Store sandboxed builds, folder access is strictly read-only and persisted locally via macOS Security-Scoped Bookmarks (`com.apple.security.files.user-selected.read-only` and `com.apple.security.files.bookmarks.app-scope`).
- **Supported AI Web Pages (Browser Extension)**:
  Content scripts execute solely on the explicit AI chat origins declared in `manifest.json`. When you manually click Save or opt in to auto-save for a specific site, visible conversation text from the active tab is stored locally in the browser's `IndexedDB` and preferences in `chrome.storage.local`.
- **Local Database**:
  Imported messages, local media caches, sync history, and MCP audit logs are stored exclusively on your device in local SQLite (`memo.sqlite`).

### 3. Local Loopback Communication
- Optional communication between the Chrome Extension and MemoCat Desktop, as well as the local MCP endpoints for local AI clients, operates **strictly over the localhost loopback interface (`127.0.0.1`)** using a locally generated 256-bit pairing secret. No conversation data leaves your computer.

### 4. Tracking and Third Parties
- MemoCat sets `NSPrivacyTracking = false` and declares zero collected data types in `PrivacyInfo.xcprivacy`.
- No third-party tracking libraries, remote scripts (`script-src 'self'`), or external network beacons are used.

### 5. User Control and Deletion
- You can delete individual conversations or clear the entire archive inside the browser extension at any time, or export your data as Markdown/JSON.
- On macOS, you can disable any ingestion source, revoke access, or delete the local MemoCat data directory to permanently remove all stored data.

### 6. Contact
For privacy inquiries or support requests, please open an issue in the project repository at https://github.com/qiwihui/MemoCat/issues or visit https://memocat.qiwihui.com/support.html.
