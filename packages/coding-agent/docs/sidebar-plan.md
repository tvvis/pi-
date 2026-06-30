# TUI Sidebar 实施计划

## 目标

在 interactive-mode 增加一个左侧栏。先把视觉布局和样式锁定，再补控制权、
行为、内容、最后做适配收尾。

## 阶段总览

| 阶段 | 范围 | 验收 |
|------|------|------|
| 1 | 固定拥有一个侧边栏，调样式到我满意 | 始终显示一个侧边栏，宽度/分隔线/边距/背景/标题样式定稿 |
| 2 | 通过 `/命令` 和快捷键唤起 | 可手动 toggle，默认状态与持久化确定 |
| 3 | 特定操作自动唤起 | 若干操作触发自动展开，关闭策略明确 |
| 4 | 注入我需要的内容 | 替换占位组件为真实内容（待你点单） |
| 5 | 其他适配性问题 | 窄终端/footer 指示/按键提示/焦点/scrollback/测试/文档/changelog |

---

## 阶段 1 — 固定侧边栏 + 样式定稿

**目标**：sidebar 永远存在，先把视觉锁死再谈其他。

### 1.1 基础设施

> **实施变更**：HSplit 方案在实施中被阶段 5 引入的 `leftPanel` 机制替代
> （见下"关键架构改动"），未提交。下方 1.1 / 1.2 描述保留为设计参考。

- `packages/tui/src/components/hsplit.ts` 新增 `HSplit` 组件
  - `new HSplit(left: Component, right: Component, options?)`
  - 选项：`width`（绝对/百分比）、`minWidth`、`maxWidth`、`separator`（接收
    `(line: string) => string`）、`paddingX`、`visible`
  - `render(width)`：两侧分别 `render(width)`，按行 zip 合并，用
    `visibleWidth` / `sliceByColumn`（`packages/tui/src/utils.ts`）处理列对齐
  - 阶段 1 不实现 focus 代理，只做纯展示
  - 单元测试：等高、不等高、最小宽、separator、theme 注入、嵌套

- `packages/tui/src/index.ts` 导出 `HSplit`

### 1.2 interactive-mode 接入

- `interactive-mode.ts` 构造函数新增：
  - `mainColumn: Container` —— 收编现有 8 个 child
  - `sidebarColumn: Container` —— 占位容器，初始塞 `SidebarPlaceholder`
  - `sidebarSplit: HSplit` —— root 布局
- 根布局改为 `this.ui.addChild(this.sidebarSplit)`，split 内部
  `(sidebarColumn, mainColumn)`
- `init()` 中把 `headerContainer / chatContainer / pendingMessagesContainer /
  statusContainer / widgetContainerAbove / editorContainer /
  widgetContainerBelow / footer` 全部 `addChild` 到 `this.mainColumn`

### 1.3 占位组件

- 新增 `packages/coding-agent/src/modes/interactive/components/sidebar-placeholder.ts`
- 渲染：
  - 顶部 1 行标题（`theme.fg("borderAccent", ...)` 或 theme.bold）
  - 几行 muted 文案：`Sessions`、`Files`、`Todos`、`Tools` 分组标题
  - 不响应输入
- 这一阶段唯一目的：让我看到布局并调样式

### 1.4 样式定稿（需要你过目）

- 宽度：建议 32 列。等价 IDE 文件树宽度。
- 高度范围：跨整列（顶到 header 顶，底到 footer 底），不留空隙
- 分隔线：单列 `│` 字符 + `theme.fg("borderMuted", ...)`
- padding：左 1、内 1（与 editor 对齐）
- 背景：与 main 一致（无背景色），靠分隔线区分
- 标题：底边一条 `─` 横线 + `theme.fg("accent", ...)`
- 窄终端策略：阶段 1 先固定死宽度，窄于 80 列时强制保留 32 列，main 列被压
  缩；具体降级留到阶段 5

> 阶段 1 结束条件：你看着样式说"OK"。

---

## 阶段 2 — `/命令` + 快捷键唤起

**目标**：用户能主动显隐侧边栏。

### 2.1 设置

- `packages/coding-agent/src/core/settings-manager.ts` 追加：
  - `getSidebarVisible(): boolean` —— 默认 `true`（阶段 1 是固定显示，阶段 2
    起允许关闭）
  - `setSidebarVisible(b: boolean)`
- `applyRuntimeSettings()`（`interactive-mode.ts:1540`）中把值灌进
  `sidebarSplit.setVisible(...)` + `ui.requestRender()`

### 2.2 快捷键

- `packages/coding-agent/src/core/keybindings.ts`：
  - `AppKeybindings` 加 `"app.sidebar.toggle": true`
  - `KEYBINDINGS` 加 `"app.sidebar.toggle": { defaultKeys: "ctrl+b", description: "Toggle sidebar" }`
- `setupKeyHandlers()`（`interactive-mode.ts:2441` 附近）加：
  ```ts
  this.defaultEditor.onAction("app.sidebar.toggle", () => this.toggleSidebar());
  ```
- `toggleSidebar()`：翻转设置 → 调 `sidebarSplit.setVisible` → `ui.invalidate()` →
  `ui.requestRender()`

### 2.3 `/sidebar` 命令

- 注册内置 slash command（参考 `BUILTIN_SLASH_COMMANDS`）：
  - `/sidebar` —— 切换
  - `/sidebar on|off` —— 显式设
- 走 `createBaseAutocompleteProvider()` 现有路径，让其出现在 `/` 自动补全里

### 2.4 启动提示

- `interactive-mode.ts:618` 附近 startup hints 补一行
  `hint("app.sidebar.toggle", "to toggle sidebar")`

> 阶段 2 结束条件：`/sidebar` 和快捷键都能切换；窄终端策略（见阶段 5）暂
> 沿用阶段 1 的固定宽度。

---

## 阶段 3 — 操作自动唤起

**目标**：特定业务事件触发 sidebar 自动展开。

### 3.1 触发点（候选清单，等你确认）

- 工具执行报错：tool 出错时 sidebar 展开并定位到该 tool 的渲染
- 长 bash 输出被截断：截断时 sidebar 展开并定位到 bash 全量输出
- 文件编辑完成：sidebar 展开并显示本次 diff
- todo list 更新：sidebar 展开并滚动到 todo
- 切换 session：sidebar 展开 session 树
- 上下文接近限额：sidebar 展开 token 详情

### 3.2 实现机制

- `InteractiveMode` 新增 `private autoShowSidebar(reason: AutoShowReason)`：
  - 若当前 `getSidebarVisible() === false`，临时展开（不入设置 / 会话内有效）
    或者写设置（策略待你定，见下）
  - 调用 `sidebarSplit.setVisible(true)` + `ui.requestRender()`
- 各业务钩子里调用 `this.autoShowSidebar(...)`：
  - `ToolExecutionComponent` 完成 onError 路径
  - `BashExecutionComponent` 输出截断路径
  - `renderCurrentSessionState` / 切换 session 路径
  - `setTodoList` 之类扩展点

### 3.3 自动关闭策略

- 选项 A：永久展开（不主动收回）
- 选项 B：用户滚动过 main 列后收回
- 选项 C：一段时间无操作后收回
- 选项 D：context-specific 收回（比如查看完 diff 后收回）

> 阶段 3 结束条件：自动唤起 + 自动收回策略明确。**触发点列表和关闭策略
> 都要你点单**。

---

## 阶段 4 — 注入内容

**目标**：替换占位组件为真实内容。

### 4.1 内容方案（待你点单）

- 候选：
  - **会话树**（只读、嵌在 sidebar，复用 `SessionSelectorComponent` 的数据源）
  - **文件树**（cwd 下文件列表，懒加载）
  - **Todo 列表**（与 `todo.ts` 扩展对接）
  - **当前工具面板**（最近一次工具执行的参数/结果）
  - **Diff 面板**（最近一次文件改动）
  - **Token 详情**（取代 footer 那行简略数字）

### 4.2 实现路径

- 新增 `packages/coding-agent/src/modes/interactive/components/sidebar-content.ts`
  - 内部分组组件，每个分组成员按 `state` 渲染
  - 各分组件订阅对应的 `FooterDataProvider` 风格的数据源（必要时新增 provider）
- 在 interactive-mode 替换 `SidebarPlaceholder` 为 `SidebarContent`
- 同一组件根据 sidebar 高度自动决定显示哪些分组（窄行数时折叠 todo / files）

### 4.3 扩展点

- `ExtensionUIContext`（`packages/coding-agent/src/core/extensions/types.ts`）加：
  ```ts
  setSidebarContent(group: SidebarGroup): void;
  removeSidebarContent(id: string): void;
  ```
- sidebar 内容由"内置组 + 扩展组"聚合而成，扩展组位于底部

> 阶段 4 结束条件：内容列表由你确认；内置内容渲染正确；扩展 API 可用。

---

## 阶段 5 — 适配收尾

### 5.0 鼠标滚轮滚动历史（优先于 5.1-5.8）

**用户报告**：
- 滑动滚轮，输入区会变（"输入区会变" 表明事件确实被收到）
- 右侧 main 输出区（chat history）完全无法滚动查看历史
- 以前能用滚轮查看历史，现在不行了
- 可能原因：sidebar 引入后输入区抢走了 wheel 事件，或 viewport 滚动机制本就没接过外部输入

**根因调查**（先看，不要猜）：
1. `packages/tui/src/terminal.ts`：是否发送过任何 mouse mode 启用序列
   （`\x1b[?1000h` 老式、`\x1b[?1002h` 含 wheel、`\x1b[?1003h` 全跟踪、`\x1b[?1006h` SGR）
2. `packages/tui/src/stdin-buffer.ts`：是否识别过 `\x1b[<64;x;yM` / `<65;x;yM`（wheel up/down）
3. `packages/tui/src/tui.ts`：
   - `viewportTop` 是什么、在哪调；是不是只被 render 路径设
   - 是不是有外部滚轮事件被吞掉/转成别的东西
4. `packages/tui/src/components/editor.ts`：有没有 `scrollOffset` 响应 wheel 的代码
5. `packages/coding-agent/src/modes/interactive/interactive-mode.ts`：
   - input handler 是否把某种序列当作了输入
   - main viewport 的滚动现在是谁调

**实现路径**：
- Phase A：开 mouse 模式
  - `terminal.ts` 启动时发送 `\x1b[?1002h\x1b[?1006h`（wheel tracking + SGR），退出时发关闭
  - 不需要 `\x1b[?1003h`（避免移动也要事件，量太大）
- Phase B：解析 wheel
  - `stdin-buffer.ts` 在识别 SGR 鼠标后通过 `data` 事件转发（已有 `mouseMatch` 正则，确认转发的形状）
  - 识别出 wheel up (`<64`) / wheel down (`<65`) 后携 `(x, y)` 转交 TUI
  - 注意：SGR mouse 事件中 y 是终端坐标（1-based，8=最低行）；x 也是 1-based
- Phase C：TUI 分发
  - `tui.ts` 拿坐标：x < leftPanelWidth → sidebar 区域；x ≥ leftPanelWidth → main 区域
  - y < headerHeight → header；y ≥ termHeight - footerHeight → footer / input
  - 在 main 区域且 wheel down：减小 `viewportTop`（往下）；wheel up：增大（往上）
  - 在 sidebar 区域且有溢出：调 sidebar 内部 scroll（如果实现了）
  - 在 input 区域：不调，或者给 editor 一个 “cursor 上下” 动作
- Phase D：editor 拦截
  - `editor.ts` onInput 中加一个不响应 wheel 的逻辑，或者 TUI 在 input area 吃 wheel 不传
- Phase E：viewport 限位
  - `viewportTop` 不能超最大可滚位置；到底/到顶后 wheel 是 no-op
  - 跟现有的 `maxLinesRendered` 跟踪联动，别掉

**涉及文件**（但不要从这些名字出发，先看实际代码）：
- `packages/tui/src/terminal.ts`
- `packages/tui/src/stdin-buffer.ts`
- `packages/tui/src/tui.ts`
- `packages/tui/src/components/editor.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

**验收**：
- main 区域 wheel up：看到上面更多历史
- main 区域 wheel down：往下推到底
- sidebar 区域 wheel：不响 main，sidebar 内部 scroll（可选）
- input 区域 wheel：不响输入框
- 终端/进程退出后 mouse mode 恢复原始状态（不留 `\x1b[?1002h`）

**测试**：
- `packages/tui/test/stdin-buffer.test.ts` 加 SGR wheel 正向 case
- `packages/tui/test/tui.test.ts`（如果存在）或新建：mock 序列，验证 `viewportTop` 改变
- integration：输入 `\x1b[<64;50;20M` 给 TUI，验证 `viewportTop` 变了且只变了期望值

**注意**：
- 很多终端（iTerm2、WezTerm、Kitty）默认 mouse mode = off，xterm 默认 = off。
  需要明确选 button-event-tracking (1002) 还是 any-event (1003)。
  1002 足以应付 wheel + click。
- SSH 连接下如果启用 mouse 可能让滚动变慢
  （每次 event 一个 TCP 包），可以后面做 setting 开关

### 5.1 窄终端降级（其余子项保持原状）

- **窄终端降级**：`HSplit.visible` 阈值（建议 ≤ 80 列时自动隐藏 sidebar，
  把空间还回 main）
- **Footer 状态指示**：在 footer 右侧加一个小角标 `◧ sidebar`（hidden 时
  `theme.fg("dim", ...)`）
- **滚动行为**：sidebar 内容超出高度时支持 `j/k` 滚动；与 main 列独立
- **焦点切换**：可选 `Tab` 在 main / sidebar 之间切换焦点
- **scrollback 回归**：长输出场景验证 `TUI.maxLinesRendered` 跟踪仍然正确
- **overlay 嵌套**：现有 overlay 走 `terminal` 直绘，确认在 HSplit 之上仍正常
  覆盖全屏
- **主题**：sidebar 占满高度时确认与各主题（暗/亮/高对比）协调
- **测试**：
  - `packages/tui/test/hsplit.test.ts`
  - `packages/coding-agent/test/suite/regressions/<n>-sidebar-layout.test.ts`
  - 覆盖：宽度、显隐切换、自动唤起、内容注入、keybinding 可配置
- **文档**：
  - `packages/coding-agent/docs/tui.md` 加一节 "Custom Sidebar"
  - 两份 `CHANGELOG.md` `[Unreleased]` 补 `### Added` 条目

---

## 风险点

1. **HSplit 与 overlay**：HSplit 在 root 之下，overlay 仍应能覆盖全屏；走
   `terminal` 直绘，不依赖 root 布局（已确认 `tui.ts` 的 overlay 行为）。
2. **scrollback / `maxLinesRendered`**：TUI 用 `tui.ts:281` 的 `maxLinesRendered`
   跟踪滚动区，HSplit 内嵌的 chat 区域行高由 chat 自身负责，需要长输出场景
   回归。
3. **焦点查找**：`TUI.containsComponent` 递归 root children（`tui.ts:393`），
   HSplit extends Container 兼容。阶段 1 不暴露焦点，阶段 5 决定是否做
   focus 代理。
4. **窄终端下 main 列被压**：阶段 1 用固定宽度时 main 会被压到不可读；阶段 2
   起允许关闭；阶段 5 加自动隐藏阈值。临时折中：阶段 1 至少把宽度调到 main
   还剩 ≥ 60 列再启动。

## 待你拍板（阶段 1 启动前）

- 默认宽度（建议 32，最小 60 列留给 main）
- 分隔线风格（单竖线 / 双竖线 / 短横线 / 纯背景色）
- 标题样式（底边横线 / 上方间距 / 加粗 / accent 色）
- 阶段 1 占位要不要分多个分组（建议 3-4 个：`Sessions` / `Files` / `Todos` /
  `Tools`），方便你判断分组视觉

---

## 当前进度（2026-06-15 session 收尾）

### 已完成

**Phase 1 — 固定 sidebar + 样式**
- `packages/tui/src/components/hsplit.ts` — `HSplit` 组件
- `packages/coding-agent/src/modes/interactive/components/sidebar-placeholder.ts` — mock 占位（**已删除**）
- 宽度 24、borderMuted 分隔线、SIDEBAR 标题 + rule

**Phase 2 — 唤起控制**
- `ctrl+b` 键绑 `app.sidebar.toggle`（transient，**不写 settings**）
- `/sidebar` / `/sidebar on` / `/sidebar off` slash command
- `getSidebarVisible`/`setSidebarVisible` 设置项
- `toggleSidebar()` 用 `sidebarSplit.isVisible()` 作状态源

**Phase 4 — Recent Files 内容（**替代原占位组件**）**
- 删 `sidebar-placeholder.ts`，新增 `sidebar-recent-files.ts`
- `RecentFile = { absPath, lastTouchedAt, tool: "edit" | "write" }`
- `SidebarRecentFiles` 组件，MRU 列表 max 9
- 显示 `n. M path/to/file`，cwd-relative，截断带 `…`
- write：空图标 + 路径绿色（success）
- edit：`M` 图标 + 路径蓝色（accent）
- `interactive-mode.ts`：
  - `private recentFiles: RecentFile[]` 字段（session-only，不持久化）
  - `private pendingToolArgs: Map<string, unknown>` 在 `tool_execution_start`
    缓存 args，`tool_execution_end` 取出来调 `recordRecentFile()`
  - `recordRecentFile(toolName, args)` — edit/write 时记录；首次记录自动唤起
  - `MAX_RECENT_FILES = 9` 常量
  - `ordinalSuffix(n)` helper
  - `openRecentFile(n)` + `openFileInEditor(filePath)`
  - `openFileInEditor` 走 `$VISUAL`/`$EDITOR`，`spawn` + `detached` + `unref`，不 stop TUI
- 9 个 keybinding `app.recentFile.open.1`–`.9`（默认 `alt+1`–`alt+9`）
- `setupKeyHandlers` 绑 9 个 `onAction`

**Phase 4.1 — Recent Files 会话级持久化**
- 拆出 `sidebar-recent-files-store.ts`（独立模块，sidebar 组件仍为纯渲染器）
  - `RecentFile` 类型 / `MAX_RECENT_FILES` 常量（从 `sidebar-recent-files.ts` 迁出）
  - `SIDEBAR_RECENT_FILES_CUSTOM_TYPE = "sidebar-recent-files"`
  - `loadRecentFiles(sessionManager)` — 沿 `getBranch()` 倒序找最新 custom entry，校验后返回
  - `persistRecentFiles(sessionManager, files)` — 调 `appendCustomEntry`，in-memory session no-op
- `interactive-mode.ts`：
  - `rebindCurrentSession()` 开头调 `loadRecentFiles` 灌入 `this.recentFiles` + `invalidate`
  - `recordRecentFile()` 末尾调 `persistRecentFiles`
  - 移除本地的 `MAX_RECENT_FILES` 常量（改 import）
- 语义：
  - `pi --session <resume>` / `/resume <file>` / `/fork` → 列表从最新 custom entry 恢复
  - `/new` → 全新 session 无 entry，列表为空（你点单的结果）
  - `branch()` 切到没记录过文件的分支 → 该分支路径上无 entry，列表为空
  - `createBranchedSession` 拷贝全部 entry → fork 继承列表
- `test/suite/sidebar-recent-files-store.test.ts` 7 个 case：custom type id、empty、latest-wins、survives reopen、malformed fallback、branch path isolation、MAX cap

**Phase 4.2 — sidebar 标题 & 不阻塞打开**
- 标题改为 `PI MINUS v<VERSION>`，版本从 `config.ts` 的 `VERSION` 动态取（读 `package.json`），不再硬编码
  - `SidebarRecentFiles` 构造函数加 `getVersion: () => string` 参数
  - `interactive-mode.ts` 传入 `() => VERSION`
- `openFileInEditor` 改为 detached 启动，**TUI 不再暂停**：
  - `spawn(..., { stdio: "ignore", detached: true, shell: win32 })` + `child.unref()`
  - 去掉 `this.ui.stop()` / `this.ui.start()` / `process.stdout.write` 唤醒提示
  - 启动失败（async）走 `showWarning` 反馈
  - 副作用：`stdio: "ignore"` 意味着 `$EDITOR=vim` 这种 TUI 编辑器不可用（需要 TTY），需 GUI 编辑器；你明确要求不阻塞，接受这个 trade-off

**Phase 4.3 — Recent Files 路径展示：键帽前缀 + 2 行 wrap**

**目标**：
1. 超长路径拆 2 行（dirname / basename），basename 优先保留完整
2. 砍掉冗余的 `M` 图标（信息已被路径颜色编码：`edit`=accent、`write`=success），省 1 列给路径
3. 序号从 `1.` 改为 `1-` 键帽标记（**无尾空格、紧贴路径**），`1` borderAccent（高亮色）、`-` muted，2 列宽
4. 标题 `PI MINUS v...` 改为 white，与数字一起作为“UI chrome”层
5. rule 与 `Recent Files` 之间不设空行

**决策记录**：
- 原提案"路径不可省略、超长换行"否决：wrap 把 9 条 MRU 压到 24 行终端只能看前 4-5 条，垂直吃光后续组空间，续行缩进噪音，Phase 5 滚动未实现
- 原方案 `foldMiddle`（1 行 + 中点折）仍不购：超长路径 line 1 仍顶死，basename 不一定能装下，改 `wrapPath` 拆 2 行
- 保留 `M` 图标否决：`M` 与路径颜色编码信息冗余，砍掉视觉损失 0、收益 1 列
- `1.` 改 `1-`（无尾空格）：hyphen 作为键帽装饰，比 `[1]` 省 1 列、视觉更轻
- 数字色 `accent` 改 `borderAccent`：与路径色（accent/success）区分，“UI chrome vs content”双层
- 标题 `borderAccent` 改 `white`：与 borderAccent 区分（cyan/teal 太高调）又能与路径色拉开距离
- rule 与 `Recent Files` 之间取消空行：紧贴，节省 1 行垂直空间

**实现**：
- `sidebar-recent-files.ts`：
  - 删 `icon` 字段计算；`formatRow` 前缀由 5 列（`M 1. `）改为 2 列（`1-`，无尾空格）：
    - edit：`1` borderAccent + `-` muted
    - write：`1` borderAccent + `-` muted（同样显示键帽，靠路径色 `success` 区分）
  - `foldMiddle` 改 `wrapPath(text, lineWidth)` 返回 1 或 2 行：
    - line 1 = dirname（包含末段 `/`），line 2 = basename
    - dirname 自身 > lineWidth 时，找 dirname 内最右一个能装下的 `/` 截断
    - basename 自身 > lineWidth 时 truncateText
    - 无 `/` 走 truncateText fallback
  - `formatRow` 改返回 `string[]`，第 2 行用 `↳ ` 缩进与第 1 行 `1-` 等宽
  - `buildLines` 拍平多行结果，删 rule 和 `Recent Files` 之间的空行
  - 标题 `PI MINUS v...` 从 `borderAccent` 改 `white`
  - 主题 `theme.ts` / `dark.json` / `light.json` 增 `white: "#ffffff"`（var + colors 映射）
  - `truncateText` 保留作 fallback
  - 不动 `displayPath` 的 cwd-relative 判定
- 测试 `packages/coding-agent/test/suite/sidebar-recent-files.test.ts`（15 case）：
  - 短路径 1 行，无 `↳`
  - 长路径 2 行：dirname + basename 拆开，basename 能装下时无 `…`
  - basename 超长：line 2 truncateText
  - dirname 超长：line 1 在 `/` 处截断
  - 数字 borderAccent vs 路径 accent/success 着色差异
  - 标题 white
  - edit/write 前缀形状相同，路径色区分
  - 无 `/` 走 truncateText fallback
  - cwd 外 abs 路径同规则
  - 多文件 1-9 序号
  - 空列表 (none)
  - rule 与 Recent Files 无空行
  - 右边界 `│` 渲染

**取舍**：
- 路径列 18 → 21（+3 列）
- 数字 borderAccent 与路径色（accent/success）区分，标题 white / 数字 borderAccent / hyphen muted / 路径 accent-success 四层色阶
- 1 行 / 2 行 wrap 兼顾扫读节奏和长路径可读性
- 第 2 行 `↳ ` 缩进与第 1 行 `1-` 等宽，列对齐
- rule 与 Recent Files 之间删空行，紧凑
- 9 条文件 × 平均 1.5 行 ≈ 14 行（24 行终端能装下）
- 不阻塞 Phase 5 滚动实现

**Phase 4.3 — Recent Files 路径展示：键帽前缀 + 2 行 wrap**
- `sidebar-recent-files.ts`：
  - 刪 `foldMiddle` / `pickDirnameTail`，加 `wrapPath(text, lineWidth)` 返回 1 或 2 行
  - `formatRow` 改返回 `string[]`；`buildLines` 拍平插入
  - 前缀 2 列：`1` borderAccent（高亮色，与路径色区分） + `-` muted
  - 第 2 行缩进 `↳ ` muted，与第 1 行 `1-` 等宽
  - 路径色不变：edit=accent、write=success
  - 标题 `PI MINUS v...` 从 `borderAccent` 改 `white`
  - 主题 `theme.ts` / `dark.json` / `light.json` 增 `white: "#ffffff"` var + colors 映射
  - `buildLines` 删 rule 与 `Recent Files` 之间的空行
- `test/suite/sidebar-recent-files.test.ts` 15 个 case：`1-` 前缀、数字 borderAccent vs 路径色、标题白、1 行 vs 2 行 wrap、dirname/basename 超长截断、无 `/` fallback、abs 路径、多文件序号、空列表 (none)、rule 与 Recent Files 无空行、右边界 `│`

**关键架构改动：TUI `leftPanel`（**替代 HSplit 作 root 布局**）**
- 原因：HSplit 拼接成 3442 行输出，TUI 滚到底部时 sidebar（行 0-4）完全在
  屏幕外
- `packages/tui/src/tui.ts`：
  - `setLeftPanel(component | undefined, width)` 方法
  - `compositeLeftPanel(lines, termWidth, termHeight)` 在 viewport 应用后
    画 panel，**不被滚动影响**
  - children 渲染用 `contentWidth = width - panelWidth` + 右移 panelWidth cols
  - panel 区域所有可见行画 separator（内容行用 sidebar 自带，空行用 TUI 补）
- `interactive-mode.ts` 删 `sidebarSplit` / `sidebarColumn` 字段，`mainColumn`
  直接作 TUI child，通过 `setSidebarVisible()` 调 `ui.setLeftPanel()`

### 文件清单

**新增**
- `packages/coding-agent/src/modes/interactive/components/sidebar-recent-files.ts`（Phase 4）
- `packages/coding-agent/src/modes/interactive/sidebar-recent-files-store.ts`（Phase 4.1）
- `packages/coding-agent/test/suite/sidebar-recent-files-store.test.ts`（Phase 4.1）
- `packages/coding-agent/test/suite/sidebar-recent-files.test.ts`（Phase 4.3）
- `packages/tui/test/tui-viewport-scroll.test.ts`（Phase 5.0）

**删除**
- `packages/coding-agent/src/modes/interactive/components/sidebar-placeholder.ts`（Phase 4 替代）

**修改**
- `packages/tui/src/tui.ts`（Phase 4 — `leftPanel` 机制；Phase 5.0 — `viewportTopLine` 滚动 + SGR mouse 拦截 + `onMouseWheel`/`onMouseButton` + `parseSgrMouse`/`SgrMouseEvent` export + `compositeOverlays`/`compositeLeftPanel` 接受 `viewportStart`）
- `packages/tui/src/terminal.ts`（Phase 1 — `enterAltScreen`/`exitAltScreen`；Phase 5.0 — SGR mouse tracking `?1002h`/`?1006h` start/stop + `PI_TUI_NO_MOUSE=1` 逃逸口）
- `packages/tui/src/index.ts`（Phase 5.0 — export `parseSgrMouse`/`SgrMouseEvent`/`SgrMouseButton`）
- `packages/coding-agent/src/core/keybindings.ts`（Phase 2 + 4）
- `packages/coding-agent/src/core/settings-manager.ts`（Phase 2）
- `packages/coding-agent/src/core/slash-commands.ts`（Phase 2）
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`（所有阶段 + Phase 5.0 — `setupMouseWheelHandler` 在 sidebar/input 以外区域调 `ui.scrollUp`/`scrollDown`）
- `packages/coding-agent/src/modes/interactive/components/sidebar-recent-files.ts`（Phase 4.2 — 动态 version 回调；Phase 4.3 — `wrapPath` 2 行 wrap + 前缀 `1-` borderAccent + 标题 white + no-gap）
- `packages/coding-agent/src/modes/interactive/theme/theme.ts`（Phase 4.3 — 增 `white` ThemeColor）
- `packages/coding-agent/src/modes/interactive/theme/dark.json`（Phase 4.3 — 增 `white` var + 映射）
- `packages/coding-agent/src/modes/interactive/theme/light.json`（Phase 4.3 — 增 `white` var + 映射）
- `packages/coding-agent/CHANGELOG.md`（Phase 4.1 + Phase 5.0 — Added 条目）
- `packages/tui/CHANGELOG.md`（Phase 5.0 — Added/Changed 条目）
- `packages/coding-agent/test/edit-tool-no-full-redraw.test.ts`（Phase 1 — `FakeTerminal` 加 alt screen）
- `packages/tui/test/tui-render.test.ts`（Phase 5.0 — 更新 shrink/height/Termux 期望以反映新 viewport 语义：高度变化总是 full redraw；shrink 不再触发 full redraw；append 不再触发 full redraw）

### 已知问题

- Pre-existing `model-resolver.ts(37,2)` 错误（ark provider，rebrand 引起）跟本工作无关
- Pre-existing 5080 测试 `pi --session` vs `pi- --session` 不匹配（rebrand 引起）
- `$EDITOR=vim|nano|emacs -nw` 等 TUI 编辑器在 detached 模式下不可用（需 TTY），需 GUI 编辑器；如要兼容需额外的"是否 TUI 编辑器"探测
- **Phase 5.0 follow-up**：auto-follow 不会丢位置（已验证）；但 滚下到底 的动作目前是相对 3 行滚，不是"跳到底"。如果用户期望"wheel down 到最底要立刻 snap"，需要加个 page-down 状态机。这是一个独立的 P2，先记下。
- **Phase 5.0 follow-up**：sidebar 内部 overflow 未实现（`onMouseWheel` 在 sidebar 区域只 eat，不滚动 sidebar 内容）—— sidebar 当前 24 列 + 9 条近期文件，不超 24 行终端；后续 Phase 5.1 真加 overflow 时再上 `SidebarRecentFiles` 内部 scroll。

### 验证状态

- `./test.sh` 680/680 过（665 原 + 15 新 viewport/mouse case）
- vitest suite 123/124 过（1 个 5080 pre-existing failure，与本工作无关）
- `npm run check`（biome + tsgo + shrinkwrap + browser-smoke）全过
- Phase 5.0：vitest targeted `tui-viewport-scroll.test.ts` 15/15 过
  - 初始默认看底（offset=0、isAtBottom=true、maxOffset=5）
  - scrollUp(2) 往上 2 行，isAtBottom=false
  - scrollUp 上限 = maxOffset（不超过 top）
  - scrollDown(2) 往下 2 行；scrollToBottom snap 到底
  - 滚上后新内容 append，可见 viewport 内容不变（anchor 生效）
  - 在底时新内容 append，auto-follow（视口跟着下移）
  - content shrink 越过 anchor 时 auto-reset 到 auto-follow
  - parseSgrMouse：wheel up/down、press/release/move、button bits 0-2、非 mouse 输入 undefined
  - onMouseWheel 收到 wheel、focused component 不会拿到原始 SGR（不会被插入文本）
  - onMouseButton 收到 press/release
  - 非 mouse 输入不触发 mouse callback
  - `ProcessTerminal.start` 发 `?1002h`/`?1006h`；stop 发对应关闭
  - `PI_TUI_NO_MOUSE=1` 抑制 mouse 启用
- 手动验证：tmux 100x30 启动 TUI，连续发 3 条消息收 3 个回复，状态栏 TPS / context 实时更新；wheel up 3 行/下 3 行通过 `ui.scrollUp/scrollDown` 生效（视口层 + interactive-mode 路由层都过单测）
- 待用户验证：实际 terminal（iTerm2/WezTerm/Kitty）滚轮手感；wheel down 到底是否需要 snap 到底（上面 follow-up）
