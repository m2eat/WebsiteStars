# Starts 浏览器扩展框架选型研究

- 需求依据：`docs/requirements.md`，草案日期 2026-09-22；本文提供研究与建议，不修改需求。[1]
- 访问日期：2026-09-22（本次会话日期）；已实际联网搜索、抓取，只采用官方文档、第一方仓库及其 GitHub API。
- 证据口径：“事实”可由编号来源核对；“建议”是针对 Starts 的判断；“未验证”表示未运行样例或证据不足。
- 日期口径：访问日、文档更新时间、release 发布时间分别处理；GitHub 列表可能省略年份，发布日以 API 的 `published_at` 为准。[8][17][25]
- 版本口径：下列版本是访问时实际看见的发布记录，不宣称为 npm 最新版本；主分支文档可能领先于已发布包，落地前须锁版本验证。

## 1. 结论及适用条件

**建议首选 WXT + React + TypeScript，生产目标为 Chrome Manifest V3；CRXJS + Vite 是主要备选。**
WXT 覆盖多页面入口、网页内 UI 挂载、按浏览器构建、Vitest 适配和商店提交，较贴合 Starts 的完整扩展形态。[2][3][4][5][6][7]
前提是接受 WXT 的入口约定、检查生成的 manifest，并接受网页内 Shadow DOM UI 不具备原地 HMR。[3][4]
若团队已有成熟 Vite 工程，或重心转向复杂网页内 React UI、特别重视内容脚本 HMR，则优先比较 CRXJS。[19][21]
Plasmo 的 React 页面与 CSUI 约定省配置；团队熟悉它，且依赖兼容、维护响应和生产构建验证通过时，也可采用。[10][11][12]
原生 MV3 适合极小原型、学习浏览器机制或明确希望自行维护构建链的团队；Starts 的多入口使手工维护成本较高，这是工程判断。
**四者都能实现核心收藏流程；框架减少工程工作，不能替代权限、数据层、正文抽取和浏览器兼容性设计。**

## 2. 从需求提取的选型依据

| 需求事实 | 对选型的影响（建议） |
| --- | --- |
| Chrome 优先；Firefox 在 P2 | 先交付 Chrome MV3，不为跨浏览器承诺牺牲 P0；保留可分离的浏览器适配层。[1] |
| GitHub 仓库页和 Stars 页按钮 | 需要内容脚本、样式隔离、动态挂载与卸载；按钮失效时保留工具栏和 URL 解析兜底。[1] |
| 任意网页主动收藏、DOM 抽取、划词 | 按用户操作注入正文抽取脚本；框架无需承担服务器爬取或绕过登录墙。[1] |
| P0 弹窗搜索、筛选、笔记；侧栏为产品入口之一 | 框架需覆盖 popup 与 sidepanel；首版主入口取舍见[综合分析](requirements-analysis.md)，两者可共享组件和数据访问。[1] |
| 本地优先，AI、向量、同步可关闭 | 本地收藏与关键词搜索必须独立于云端、登录和框架附带服务。[1] |
| 模型和 Key 必须可配置，但详细设置列入 P1 | 建议 P0 就提供最小 options 页：关闭 AI、配置 Key/端点；高级提示词和同步配置再分期。[1] |

工作区核查：调研开始时只有需求文档；第 10 节描述“已有 Workers + React 原型”，但本工作区没有对应源码，不能据此确认可直接复用的 API 或构建配置。
因此推荐按新建扩展评估；如果原型在别处，实际复用范围仍需另行核查。这不改变需求中“云端可关闭”的约束。[1]

## 3. 能力比较：官方已证实事实

“原生 MV3”指手写 manifest 和浏览器 API，可另配通用编译器；它是平台方案，不是与前三者平级的 npm 框架。
“HMR”指模块热替换；“重载”可能重启扩展、重新打开页面或刷新宿主页，不能承诺保留所有运行状态。

| 维度 | WXT | Plasmo | CRXJS + Vite | 原生 Manifest V3 |
| --- | --- | --- | --- | --- |
| React / TS | 官方 React module，入口接受 TS/TSX。[2][3] | 一等 React/TS 支持，约定式 TSX 页面。[10][11] | 官方 React/TS 模板，结合 Vite React 插件。[19][21] | 可接 React/TS，但自行编译打包；Chrome 提供类型包指引。[27] |
| popup / options / sidepanel | 三类文件入口并生成 manifest。[3] | `popup.tsx`、`options.tsx`、`sidepanel.tsx` 或对应目录入口。[11] | manifest 发现页面入口；模板有 popup、sidepanel，支持 options 声明。[19][20] | 自行声明 action、options 与 side_panel，维护各 HTML/JS 页面。[27][32] |
| 内容脚本和页面按钮 | 提供集成式、Shadow Root、iframe UI 辅助及动态挂载。[4] | CSUI 将 React 等组件挂载到网页，默认采用 Shadow DOM。[12] | 打包内容脚本与资源；按钮定位、挂载及样式边界由应用处理。[21] | 原生内容脚本可读写 DOM，挂载、样式隔离和消息均自行组织。[28] |
| 开发热更新 | 提供 HMR/快速重载；集成式和 Shadow Root UI 无原地 HMR，iframe UI 有。[4][44] | Live reload + React HMR；新建扩展页面可能需手动刷新扩展。[10][11][13] | 内容脚本支持 HMR；所见文档含 isolated/MAIN world；IIFE 脚本需刷新宿主页。[21][25] | 无内建 HMR；manifest、worker 需重载，内容脚本还需刷新宿主页。[27] |
| 多浏览器构建 | `-b` 与 MV2/MV3 目标；文档默认 Firefox/Safari 为 MV2，其他为 MV3。[5] | Chrome MV3、Firefox MV2；Firefox MV3 明确标为 experimental。[14] | 以 Chrome MV3 为主要定位；release 有 Firefox 修复，不能据此认定完整适配。[24][45] | 自行维护 manifest/API 差异和产物；同为 MV3 也不保证 API 一致。[32][33] |
| 测试支持 | 官方 `WxtVitest` 和内存 browser API；仍需真实浏览器 E2E。[6][39] | 本轮未核实专用测试适配；可按通用扩展方法对构建产物做 E2E。[39] | 官方文档介绍基于 Playwright 的 `vitest-environment-web-ext`，该栏目标注 Beta。[22] | 自配单测；官方指引支持 Puppeteer、Playwright 等 E2E。[39] |
| 打包和发布 | ZIP、提交 Chrome/Firefox/Edge；首次商店条目手动建立；Safari 不支持自动发布。[7] | build/package ZIP；BPP GitHub Action 提交；需商店凭据。[15][16] | 官方打包指南使用额外 ZIP 插件；该页未提供完整商店提交工作流。[23] | 自行构建 ZIP、上传、提交审核或配置发布自动化。[41] |
| 核心许可证 | WXT：MIT。[9] | Plasmo CLI：MIT。[18] | CRXJS Vite 插件和 Vite：MIT。[26] | 无单一框架许可证；取决于实际采用的代码和依赖。[27] |

跨浏览器补充：WXT 可生成两种侧栏声明，但 Chrome `sidePanel` 与 Firefox `sidebarAction` 不兼容，运行时调用仍须适配。[3][33]
Plasmo 文档对 Safari 要求额外转换；WXT 的 Safari 构建也不等于已具备原生包装、签名和上架流程。[7][14]
CRXJS 不能简单评价成“完全不支持 Firefox”：所见 2.2.0 release 有 Firefox 匹配修复；完整 Firefox 能力、侧栏与后台差异仍未验证。[24]
React 内容脚本 HMR 如选 CRXJS，官方建议 `@vitejs/plugin-react`；SWC 版本未被其集成测试覆盖，并链接了未解决报告。[21]
这些是能力范围和证据边界，不是本项目已通过兼容性测试的承诺。

## 4. 维护证据、日期与许可证

以下维护判断不使用 star 数；发布记录证明发生过具体维护，不保证未来响应时效或没有安全问题。

| 方案 | 本次可核实的维护证据 | 对 Starts 的判断（建议） |
| --- | --- | --- |
| WXT | 所见 `wxt-v0.21.4`，API 发布日 **2026-08-11 UTC**，非预发布；修复运行时内容脚本的空 manifest 数组及不支持 `use_dynamic_url` 的浏览器兼容问题。[8] | 与本项目注入和浏览器目标相关的维护仍有近期证据；仍需锁定版本。 |
| Plasmo | 所见 `v0.90.5`，API 发布日 **2025-05-17 UTC**，非预发布；修复锚点消失后的卸载、ENOENT 与 BPP action。[17] | 发布证据距访问日较久，维护风险应提高权重；不能据此断言项目已停更。 |
| CRXJS | 所见 `vite-plugin-v2.7.0`，API 发布日 **2026-06-19 UTC**，非预发布；新增 MAIN world HMR 并修复内容脚本 HMR。[25] | 有明确开发体验维护证据；不能继续仅依据旧印象把整个项目称为长期 beta。 |
| 原生 MV3 | Chrome 官方更新记录在 **2026-08-25** 发布 Chrome 153 `publicSuffix` API 公告；侧栏 API 文档也列出版本门槛。[42][32] | 浏览器平台持续演进，但自身工程工具和 API 变化由项目承担；公告不代表所有用户已升级。 |

Plasmo release 页面只显示“17 May”时，不能补成访问年份；其 API 明确是 2025 年。主仓库 README 还保留 alpha 提示。[17][10]
CRXJS 2.6.1 的 release 说明列出 Vite 3/6/7/8 测试矩阵；这属于上游维护证据，不替代本项目依赖组合验证。[24]
MIT 允许使用、修改和商业分发，但仍须保留相应版权与许可声明；上述结论仅覆盖核对的核心许可文件。[9][18][26]
原生开发不要求把 Starts 开源；采用何种项目许可证是另一项决定，引用官方示例及引入依赖时仍须遵守各自许可。
Chrome 文档页注明文档内容通常为 CC BY 4.0、示例代码通常为 Apache 2.0；不能把文档许可直接当作整个扩展的许可证。[27]
开源框架也不等于商店账号、云服务或模型调用全部免费；本次没有核实各商店费用或 Plasmo 商业服务条款。

## 5. WXT 在本项目中的使用边界（建议）

选择 WXT 的主要收益是减少多入口与扩展开发工具的组装，而不是让云端模型或数据库成为框架的一部分。
建议保留以下职责分工；这只是选型后的设计方向，不是实现代码或已完成架构。

| 部分 | 建议职责 | 框架能帮助的范围 |
| --- | --- | --- |
| GitHub 内容脚本 | 在仓库及 Stars 列表定位目标、显示收藏按钮，点击后才抽取和入库 | WXT 提供挂载、卸载和 SPA 导航辅助；GitHub 选择器及目标仓库识别仍由应用维护。[4] |
| 通用网页抽取 | 用户点击工具栏或右键后读取当前文档、meta 和选区 | WXT 打包脚本；正文识别、长度截断、canonical 校验及失败降级仍自行处理。[1][3] |
| background | 注册右键菜单、处理消息、网络调用和可恢复任务 | WXT 提供入口；权限校验、幂等和恢复机制由应用实现。[3][31] |
| popup / sidepanel | 关键词搜索、筛选、短笔记与持续阅读辅助 | React 组件和业务逻辑共享，但每个入口是独立应用实例。[2] |
| options | Key、模型端点、AI 开关及后续存储/同步配置 | 使用标准扩展设置页面；设置校验、授权和数据迁移仍需设计。[1][3] |
| 本地资料库 | 收藏记录、正文摘录、标签及关键词索引 | 建议评估扩展源内的 IndexedDB；框架存储封装不能自动提供全文索引或向量库。[31][35] |

建议先本地保存 URL、标题与原始描述并反馈成功，再异步补全 AI 字段；模型失败不回滚收藏，刷新分析也按同一条目更新。[1]
正文与查询索引放在扩展自身存储上下文；内容脚本不把资料库写进宿主网页的 `localStorage`，因为那里属于网页上下文。[35]
模块边界保持可替换：抽取、条目规范化、去重、搜索和模型调用不依赖 WXT 入口助手；这样未来更换框架或接回 Web 后台成本更低。
P0 无需同时完整交付 popup 与 sidepanel。原需求列出弹窗搜索；[综合分析](requirements-analysis.md)建议将持续检索放在侧栏，并明确工具栏保存与搜索的入口关系。这是待确认的范围调整，两种选择都不改变框架推荐。[1]
最小 options 页应与“无 Key 也可用”一起验收；不能因复杂设置归入 P1，就让用户只能修改源码来关闭 AI。[1]

## 6. 框架不能替代的浏览器限制

### 6.1 权限与“用户主动收藏”

**事实：** `activeTab` 在工具栏 action、右键菜单等明确操作后授予当前页临时访问；跨来源导航或关页会撤销，不能访问受限页面。[29]
程序化注入还需 `scripting`；静态脚本通过 `content_scripts.matches` 声明站点，动态注册脚本则需相应注入权限。[28][30]
**建议：** 通用网页走 `activeTab` + `scripting`；右键入口声明 `contextMenus`，只有实现侧栏时才加入 `sidePanel`。[29][30][32]
GitHub 按钮若需在点击工具栏前就出现，应单独声明 GitHub 的静态匹配，或取得站点授权后动态注册；不能声称只靠 `activeTab` 就自动常驻。[28][29]
区分“注入轻量按钮”和“采集上传正文”：允许前者随 GitHub 页面出现，后者严格由用户点击触发，满足需求的不后台爬网原则。[1]
侧栏已打开后切换到另一网站，不应假设新标签自动拥有访问权；侧栏内普通点击也不属于文档列出的 `activeTab` 授权入口。[29]
应检测权限并引导通过工具栏/右键重新触发，或请求必要的可选站点权限；权限拒绝时保留手工 URL 收藏入口。

### 6.2 可抽取范围、页面隔离与站点改版

**事实：** 内容脚本可读写 DOM，但默认与页面 JavaScript 全局对象隔离；只有部分扩展 API 可直接使用，其余需消息通信。[28]
浏览器内部页、扩展商店等受限页面不能靠框架突破；“任意 http(s)”也不能保证这些受保护站点可注入。[29][43]
跨源 iframe 需要按目标 frame 和权限处理；仅注入顶层页面不意味着可读取所有嵌入内容。[28]
**建议：** P0 抽取以当前已加载 DOM 为边界，不保证尚未加载正文或付费墙后的内容；失败时保留可获得的标题、URL、meta 或选区。[1]
GitHub 动态导航、列表延迟加载及节点替换需要重新定位、幂等挂载与清理；框架 helper 不理解 GitHub 的业务 DOM。[4]
Stars 页每个按钮应绑定对应仓库链接，不能把整个 Stars 页 URL 当成仓库；定位失败时提供工具栏或手工仓库 URL 兜底。
Shadow DOM 有助于样式隔离，却不会授予额外页面权限，也不能保证网站改版后锚点不失效。[4][12][28]

### 6.3 Service worker、popup 与长任务

**事实：** Chrome MV3 后台 service worker 不能直接访问 DOM，且通常会在空闲约 30 秒后停止；全局内存随停止丢失。[31]
官方还列出单次任务超过 5 分钟、fetch 响应等待超过 30 秒等终止条件及版本相关例外，不能把它理解为常驻后端。[31]
popup 在焦点移到外部时自动关闭，无法强制维持打开；框架 HMR 不改变这种生产运行行为。[34]
**建议：** 在内容脚本中完成当前页面抽取；先落盘再分析，保存任务状态、重试次数和去重标识，允许重新打开 UI 后恢复。
Stars 批量导入应分页、限速、可中断和续传；AI 超时或 worker 中止后重试不得重复插入，也不得造成用户无法搜索已保存条目。[1]
测试要主动覆盖 worker 终止；调试器可能延长其生命周期，不能用开发时“始终在线”的体验推断生产可靠性。[39]

### 6.4 侧栏、浏览器差异与版本门槛

**事实：** Chrome Side Panel API 为 Chrome 114+、MV3+；程序化 `sidePanel.open()` 为 Chrome 116+，只能响应用户操作调用。[32]
Firefox 的 `sidebarAction` 与 Chrome `sidePanel` 不兼容，构建目标切换和 API 命名空间包装不能补齐浏览器未实现的能力。[33]
**建议：** 如果首期使用 `open()`，把 116 作为该能力的最低版本依据，并按实际其他 API 要求确定最终最低支持版本。
直接在用户操作路径上开启侧栏，异步分析随后进行；不要等模型调用完成后再假定用户手势依然有效。
Firefox P2 单独验证后台模型、权限和侧栏；缺少相同体验时，可复用 popup/options 页面作为功能回退。

### 6.5 存储配额、密钥与可选云端

**事实：** Chrome `storage.local` 默认约 10 MB，可用 `unlimitedStorage` 扩大；卸载扩展会清除其中的数据。[35]
`storage.sync` 总量约 100 KB、单项约 8 KB，适合少量设置，不能作为收藏全文库或跨浏览器通用同步数据库。[35]
`storage.local` 默认对内容脚本可见，可通过访问级别限制；`storage.session` 默认不暴露给内容脚本，但不跨浏览器重启持久化。[35]
**建议：** 显式选择本地存储区域；正文和索引做容量评估、迁移与导出，不能把框架的 storage helper 当成无限空间或加密保险箱。
Key 只由需要发请求的扩展上下文读取，不嵌入打包文件、不交给网页；是否跨会话保存及如何保护是独立设计项。
GitHub/模型请求宜从扩展页面或后台发出：内容脚本请求仍受页面来源的跨源规则约束，扩展跨源访问则需目标 host 权限。[36]
自定义模型端点不能仅“存一个 URL”；需设计可选 host 授权、端点校验、错误反馈，并限制消息能请求的资源。[30][36]

### 6.6 CSP、远程代码与商店审核

**事实：** MV3 的常规扩展执行代码须随包发布；远程 JavaScript/WASM 与远程 JSON 数据不是同一类，框架不能豁免远程代码规则。[37]
扩展页面 CSP 禁止任意放开 `unsafe-eval`；在 MAIN world 执行还受宿主页 CSP 影响，不能把开发 HMR 能运行视为生产证明。[38][28]
**建议：** 模型返回只作为经过校验的数据；可配置提示词不等于允许服务器下发脚本。生产包应检查远程代码、开发客户端和不必要权限。
商店发布仍需开发者账号、条目资料、数据处理声明和审核；WXT submit、Plasmo BPP 或任意 CI 只能自动化其中部分步骤。[7][16][41]
首次试用可用本地加载；是否正式上架应按需求待确认项决定，不由框架选型替用户决定。[1][27]

## 7. 选型落地前的验证门槛（建议，尚未执行）

1. 锁定 WXT、React、TypeScript 及构建依赖组合，验证安装、类型检查、开发模式和生产 ZIP；检查生成的权限、入口及资源声明。
2. 单测优先覆盖 URL/canonical 规范化、仓库去重、抽取降级与关键词匹配；WXT 的内存 API 不能模拟真实权限或 worker 生命周期。[6]
3. 真实浏览器验证 GitHub 仓库页、Stars 动态列表与站内导航：按钮不重复，目标仓库正确，节点消失能清理，工具栏兜底可用。
4. 生产产物验证普通网页、跨源 iframe、受限页和权限拒绝；UI 应能解释不可抽取并保留适当的降级收藏方式。
5. 关闭 AI、向量和云端后，收藏、笔记、筛选与关键词搜索仍成立；断网时网页元数据可保存，GitHub API 失败也不阻塞基础收藏。
6. 验证关闭 popup、切换标签及强制停止 worker 后的数据和任务恢复；长 AI 请求失败后不重复收藏，不丢已保存内容。
7. 如果交付侧栏，实测用户手势开启、标签切换和权限变化；把 HTML 页面在普通标签中打开测试，不能替代真正的侧栏交互测试。
8. E2E 可用 Playwright 自带 Chromium 和 persistent context；其官方文档提示品牌 Chrome/Edge 已移除相关命令行侧载旗标，不能照搬旧 CI 脚本。[40]
9. 停止开发服务器后测试 ZIP 中解压出的生产扩展；检查依赖、远程代码和隐私声明，再决定是否接入商店提交自动化。[37][41]

以上门槛若主要卡在网页内 React HMR，比较 CRXJS 原型；若卡在权限、服务端超时或 worker 恢复，换框架通常不能解决根因。
不建议只因一个示例能运行就承诺 Firefox/Safari 支持；这些浏览器应按需求分期建立独立验收范围。

## 8. 未验证项与证据限制

- 未安装、构建或运行四种方案；体积、冷启动、HMR 延迟、抽取准确率及大资料库搜索性能均未实测，没有性能排名。
- 未核实 npm dist-tag、所有包的最新版本、完整依赖漏洞或所有传递许可证；正式立项应重新核对锁定版本。
- 未全面统计提交频率、issue 响应和维护者持续投入；Plasmo 较早的 release 不能证明主分支完全没有后续维护。
- CRXJS 的完整 Firefox 工作流、Plasmo 专用测试工具、四者的真实跨浏览器侧栏体验均未验证；不能把缺乏证据表述为明确不支持。
- 未执行商店上传、签名、审核或自动发布；BPP/WXT 的现行商店鉴权可用性、收费和 Safari 完整流程仍待核对。
- 需求中云同步、默认模型、正文保存范围及是否上架仍未决定；这些决定会影响权限、容量和发布工作，不改变可以采用扩展框架的结论。[1]
- WXT 站点部分页面抓取只返回导航，已改读同一官方仓库的 Markdown；404 页面和失败搜索未用作支持结论的证据。
- 官方资料也可能存在时效差异：例如 WXT 不同页面对 MAIN world 的跨浏览器描述并不完全一致，本文不据此承诺 Firefox MAIN world 能力。[4][5]

## 9. 编号来源与链接

以下网络来源均于本次访问查询；同一编号可含文档与第一方原文，release 的准确日期可在对应 API JSON 中复核。

- [1] 本项目需求：[docs/requirements.md](../requirements.md)。本地需求来源，不属于网络事实证据。
- [2] WXT 官方文档原文：[Frontend Frameworks](https://raw.githubusercontent.com/wxt-dev/wxt/main/docs/guide/essentials/frontend-frameworks.md)。
- [3] WXT 官方文档原文：[Entrypoints](https://raw.githubusercontent.com/wxt-dev/wxt/main/docs/guide/essentials/entrypoints.md)。
- [4] WXT 官方文档原文：[Content Scripts](https://raw.githubusercontent.com/wxt-dev/wxt/main/docs/guide/essentials/content-scripts.md)。
- [5] WXT 官方文档原文：[Targeting Different Browsers](https://raw.githubusercontent.com/wxt-dev/wxt/main/docs/guide/essentials/target-different-browsers.md)。
- [6] WXT 官方文档原文：[Unit Testing](https://raw.githubusercontent.com/wxt-dev/wxt/main/docs/guide/essentials/unit-testing.md)。
- [7] WXT 官方文档原文：[Publishing](https://raw.githubusercontent.com/wxt-dev/wxt/main/docs/guide/essentials/publishing.md)。
- [8] WXT：[发布记录](https://github.com/wxt-dev/wxt/releases)、[wxt-v0.21.4 发布元数据](https://api.github.com/repos/wxt-dev/wxt/releases/tags/wxt-v0.21.4)。
- [9] WXT：[MIT LICENSE](https://raw.githubusercontent.com/wxt-dev/wxt/main/LICENSE)。
- [10] Plasmo：[官方仓库与 README](https://github.com/PlasmoHQ/plasmo)。
- [11] Plasmo：[Browser Extension Pages](https://docs.plasmo.com/framework/ext-pages)。
- [12] Plasmo：[Content Scripts UI](https://docs.plasmo.com/framework/content-scripts-ui)。
- [13] Plasmo：[Development Server](https://docs.plasmo.com/framework/workflows/dev)。
- [14] Plasmo：[FAQ：支持的浏览器目标](https://docs.plasmo.com/framework/workflows/faq)。
- [15] Plasmo：[Production Build](https://docs.plasmo.com/framework/workflows/build)。
- [16] Plasmo：[Submit Your Extension](https://docs.plasmo.com/framework/workflows/submit)。
- [17] Plasmo：[发布记录](https://github.com/PlasmoHQ/plasmo/releases)、[v0.90.5 发布元数据](https://api.github.com/repos/PlasmoHQ/plasmo/releases/tags/v0.90.5)。
- [18] Plasmo CLI：[MIT LICENSE](https://raw.githubusercontent.com/PlasmoHQ/plasmo/main/cli/plasmo/LICENSE)。
- [19] CRXJS：[create-crxjs 与 React/TS 模板结构](https://crxjs.dev/guide/installation/create-crxjs)。
- [20] CRXJS：[Manifest](https://crxjs.dev/concepts/manifest)。
- [21] CRXJS：[Content Scripts、HMR 与 IIFE 限制](https://crxjs.dev/concepts/content/)。
- [22] CRXJS：[E2E Testing Quick Start](https://crxjs.dev/guide/test/installation)。
- [23] CRXJS：[Packaging](https://crxjs.dev/guide/packaging)。
- [24] CRXJS：[官方 releases，含 Vite 测试矩阵与 Firefox 修复](https://github.com/crxjs/chrome-extension-tools/releases)。
- [25] CRXJS：[vite-plugin-v2.7.0 发布元数据](https://api.github.com/repos/crxjs/chrome-extension-tools/releases/tags/vite-plugin-v2.7.0)。
- [26] [CRXJS Vite 插件 MIT LICENSE](https://raw.githubusercontent.com/crxjs/chrome-extension-tools/main/packages/vite-plugin/LICENSE)、[Vite MIT LICENSE](https://raw.githubusercontent.com/vitejs/vite/main/LICENSE)。
- [27] Chrome：[Hello World、手动重载、类型支持与页面许可说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)。
- [28] Chrome：[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)。
- [29] Chrome：[The activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)。
- [30] Chrome：[Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)。
- [31] Chrome：[Service workers 概述](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers)、[生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。
- [32] Chrome：[Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)。
- [33] Mozilla/MDN 官方原文：[sidebarAction 与 Chrome API 不兼容说明](https://raw.githubusercontent.com/mdn/content/main/files/en-us/mozilla/add-ons/webextensions/api/sidebaraction/index.md)。
- [34] Chrome：[Add a popup](https://developer.chrome.com/docs/extensions/develop/ui/add-popup)。
- [35] Chrome：[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)。
- [36] Chrome：[Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)。
- [37] Chrome：[Remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)。
- [38] Chrome：[Manifest Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)。
- [39] Chrome：[End-to-end testing](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing)。
- [40] Playwright 官方：[Chrome extensions](https://playwright.dev/docs/chrome-extensions)。
- [41] Chrome Web Store：[Publish](https://developer.chrome.com/docs/webstore/publish)。
- [42] Chrome：[What's new in Chrome extensions](https://developer.chrome.com/docs/extensions/whats-new)。
- [43] Mozilla/MDN 官方原文：[Content scripts：权限、受限域与页面限制](https://raw.githubusercontent.com/mdn/content/main/files/en-us/mozilla/add-ons/webextensions/content_scripts/index.md)。
- [44] WXT：[官方仓库与功能声明](https://github.com/wxt-dev/wxt)。
- [45] CRXJS：[Vite 插件官方 README](https://raw.githubusercontent.com/crxjs/chrome-extension-tools/main/packages/vite-plugin/README.md)。
