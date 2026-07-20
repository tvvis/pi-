# Plan mode 优化

## 概览

3 块改动，按重要性排序：

| 块 | 范围 | 用户痛点 |
|----|------|---------|
| A | Footer 重复修复 | `setExtensionFooter` 管错了容器，重复渲染 |
| B | Draft review 移到 chat + sidebar | popup 18 行截断，无法滚动/复制/编辑器内改 |
| C | Choice 3 改 fork | popup hint 写 fork，实现调 newSession，session tree 断开 |

文件关联贯穿 3 块 — 落盘文件名 `sessionId` 化。

---

## A. Footer 重复修复

### 根因

`init()` 把 footer 加到 `bottomPanel`（固定底栏，不滚动）：

```ts
// interactive-mode.ts:748-750
const bottomPanel = this.ui.getBottomPanel();
bottomPanel.addChild(this.editorContainer);
bottomPanel.addChild(this.footer);
```

但 `setExtensionFooter()` 还是管 `mainColumn`：

```ts
// interactive-mode.ts:1999, 2009
this.mainColumn.removeChild(this.footer);   // no-op，footer 从来没在 mainColumn
this.mainColumn.addChild(this.footer);     // 加到 mainColumn → 与 bottomPanel 重复
```

`setExtensionFooter(undefined)` 被 `resetExtensionUI()` 调，触发链：
- plan mode choice 3（newSession → setBeforeSessionInvalidate）
- `/new` 命令
- reload
- 任何 extension 卸载/替换

### 修复

`setExtensionFooter` 改为管理 `bottomPanel`：

```ts
// interactive-mode.ts:1985
private setExtensionFooter(factory?: ...): void {
    if (this.customFooter?.dispose) this.customFooter.dispose();

    // Remove current footer from bottom panel
    if (this.customFooter) {
        this.bottomPanel.removeChild(this.customFooter);
    } else {
        this.bottomPanel.removeChild(this.footer);
    }

    if (factory) {
        this.customFooter = factory(...);
        this.bottomPanel.addChild(this.customFooter);
    } else {
        this.customFooter = undefined;
        this.bottomPanel.addChild(this.footer);
    }
    this.ui.requestRender();
}
```

`init()` 不动（已经正确加到 `bottomPanel`）。`mainColumn` 不再碰 footer。

### 验证

- 进 plan mode → 写 draft → 选 3 → footer 还是一行
- extension 装/卸 footer → footer 还是一行
- reload → footer 还是一行

### 文件

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`（setExtensionFooter）

---

## B. Draft review 移到 chat + sidebar

### 设计

**核心**：plan mode draft 落盘到项目里（`<cwd>/.pi/.plan-draft-<sid8>.md`），
不再放 `~/.pi/draft/<sid>/`。文件名带 sessionId 前缀 8 字符（既短又唯一）。

**信息流**：

```
model write tool ──> <cwd>/.pi/.plan-draft-<sid8>.md
                          │
                          ├──> recordRecentFile() ──> sidebar 显示
                          │
                          └──> 后续 read tool 直接读这个文件

model plan(ready=true)
   ├──> chat 推一个 Markdown 渲染块（draft 全文）
   └──> 3 选项 popup（不嵌 plan 内容，简化）
```

**为什么 2 个位置**：
- chat 渲染：scrollback、复制、看上去跟普通 assistant 输出一样
- sidebar 文件：用户用 `$EDITOR` 打开看/改（行号、diff、习惯工具），不阻塞 TUI

**改动的边界**：

- 现有 `~/.pi/draft/<sessionId>/` 路径**完全废弃**
- `getDraftRoot()` 返回 `<cwd>/.pi/.plan-draft-<sid8>.md`（注意：之前返回的是目录，
  现在返回单文件路径，需要调整类型/调用方）
- `isPathAllowedInPlanMode()` 白名单改为精确匹配这个文件
- `enterPlanMode()` 接收 `cwd` 参数（之前隐式用 session cwd）
- 所有受影响的测试更新

### 文件命名

`<cwd>/.pi/.plan-draft-<sid8>.md`

- `.plan-draft-` 前缀：标记 plan 相关，dot-prefix 在 `.pi/` 里也隐藏
- `<sid8>`：sessionId 前 8 字符，足够唯一（实际 8 hex = 32 bit，重名概率极低）
- 不带 `/` 防止误读为目录
- `<cwd>/.pi/` 已经在 plan mode 写白名单讨论范围内（终稿就是这里）

### 改动清单

#### 1. `plan-mode-state.ts`

- `PlanModeState`：
  - `draftRoot: string` 改 `draftPath: string`（目录 → 文件）
  - 新增 `draftFileName: string`（debug/UI 用）
  - 删 `sessionId` 字段（文件名已经带 sid，不需要重复存）
- `EnterPlanModeOptions`：
  - 新增 `cwd: string`（强制要求）
  - 删 `sessionId`（从 caller 算 sid8）
  - 删 `description`（保留）
- `enterPlanMode()`：
  - 计算 `sid8 = opts.sessionId.slice(0, 8)`
  - `draftPath = path.join(opts.cwd, ".pi", \`.plan-draft-${sid8}.md\`)`
- `isPathAllowedInPlanMode(absolutePath)`：
  - 改为精确匹配 `currentState.draftPath`
  - 之前是 `startsWith(root + sep)`，现在直接 `===`
- `getDraftRoot()` → `getDraftPath()`（或保留旧名但改返回类型）
  - 倾向改名为 `getDraftPath()`，调用方更明确
  - `isInPlanMode()` 不变

#### 2. `write.ts` / `edit.ts`

- import `getDraftPath` 而非 `getDraftRoot`
- error 信息里的 `draftRoot` 改 `draftPath`

#### 3. `interactive-mode.ts`

- `enterPlanModeInternal()`：
  - `enterPlanMode({ sessionId, cwd: this.sessionManager.getCwd(), description })`
- `handlePlanModeChoice()` choice 1：
  - `writePlanModeFinal()` 读 `getDraftPath()` 写 `<cwd>/.pi/<slug>.md`
  - 不再读 `~/.pi/draft/<sid>/current.md`
- `handlePlanModeChoice()` choice 3：
  - fork 后 draft 文件留在 `<cwd>/.pi/.plan-draft-<sid8>.md`，新 session 可读
- `writePlanModeFinal()`：
  - 源 = `getDraftPath()`
  - 目标不变 = `<cwd>/.pi/<slug>.md`
- 状态消息更新：
  - `Plan mode: on — drafts to <draftPath>` 替代 `drafts to ~/.pi/draft/<sid>/`

#### 4. `system-prompt.ts`

Plan Mode 段落：
```md
Available tools:
- read, grep, find, ls: read project files
- ask: ask the user structured questions
- write, edit: ONLY to `${planMode.draftPath}` (other paths throw PlanModeWriteError)
- bash: disabled
- plan: call with `ready=true` to request user confirmation

Workflow:
1. Discuss with the user (conversationally or via the `ask` tool)
2. Write your evolving plan to `${planMode.draftPath}` using `write` or `edit`
3. The plan file is auto-mirrored to the recent-files sidebar so you can review it
4. When the plan is complete and you are ready for the user to confirm, call `plan({ready: true})`
5. The plan will be rendered in the chat for scrollback; a 3-option popup will appear
6. Wait for the user to choose: execute / refine / new session (branch)
```

#### 5. Plan 工具 (`plan.ts`)

- `execute()`：
  - `draftPath = getDraftPath()`
  - **新行为**：调 `ctx.ui.pushChatMarkdown(draftPath)` 之前（chat 推 markdown）
  - 然后弹 popup（不带 draft 内容，只带 3 选项）
- `CHOICE_INSTRUCTIONS[3]` 更新（C 块联动）
- `CHOICE_LABELS` 不变

#### 6. `PlanConfirmPopup`

- **删 draft 内容渲染逻辑**（chat 接管了）
- 删 `MAX_PLAN_LINES` 常量
- 删 `POPUP_INNER_WIDTH` 常量（popup 现在很小）
- 删 `draftPath` 字段（不需要再读文件）
- `PlanConfirmPopupOptions` 简化为空对象（或只保留 `sessionLabel` 之类的展示用）
- popup 高度 1-3 行菜单 + hint（不需要 scroll）

#### 7. `recordRecentFile` 集成

- `recordRecentFile` 已经监听 `tool_execution_start/end` 事件，记录 write/edit 路径
- **问题**：model 写到 `<cwd>/.pi/.plan-draft-<sid8>.md` 时，路径已经在项目内，
  recordRecentFile 自动捕获 → sidebar 自动出现
- **不**需要特殊处理，与现有 sidebar 流程一致
- 验证：sidebar 显示 `.plan-draft-<sid8>.md`，`alt+1` 打开用 `$EDITOR`

#### 8. Chat markdown 推入

- `ctx.ui` 需要一个新方法：`pushChatMarkdown(content: string, opts?: { title?: string })`
- 或更简单：plan tool 直接 import `Markdown` + `chatContainer`（不行，跨模块）
- **方案**：在 `ExtensionUIContext` 加 `pushChatMarkdown(content, opts)`，由
  interactive-mode 实现：构造 `Markdown` 组件，加到 `chatContainer`
- `chatContainer` 在 plan tool 不可见，所以走 ctx callback

具体接口：
```ts
// extensions/types.ts
interface ExtensionUIContext {
    // ...
    pushChatMarkdown(content: string, options?: { title?: string; maxHeight?: number }): void;
}
```

`plan.ts` 调用：
```ts
const draftContent = await readFile(draftPath, "utf-8");
ctx.ui.pushChatMarkdown(draftContent, {
    title: `Plan draft (${path.basename(draftPath)})`,
});
```

`interactive-mode.ts` 实现：
```ts
pushChatMarkdown(content, opts) {
    const title = opts?.title ?? "Markdown";
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DynamicBorder());
    this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Markdown(content, 1, 0, this.getMarkdownThemeWithSettings()));
    this.ui.invalidate();
}
```

#### 9. 测试更新

- `plan-mode-state.test.ts`：
  - `enterPlanMode` 新签名（cwd required）
  - `isPathAllowedInPlanMode` 精确匹配文件路径
  - `derivePlanSlug` 不变
- `plan-mode-integration.test.ts`：
  - draftPath 改为 `<cwd>/.pi/.plan-draft-<sid8>.md`
  - write 工具 test 用新路径
  - system prompt test 用新路径
- 新增：`plan-mode-filename.test.ts`（文件名生成：sid8 截断、collision 概率、特殊字符处理）
- 新增：UI 集成 test for `pushChatMarkdown`（mock ctx.ui）

#### 10. 文档 / CHANGELOG

- `CHANGELOG.md` [Unreleased] ### Changed：
  ```
  - Plan mode draft is now written to `<cwd>/.pi/.plan-draft-<sessionId8>.md`
    instead of `~/.pi/draft/<sessionId>/current.md`. The file is automatically
    tracked in the recent-files sidebar. The plan tool also renders the draft
    as a markdown message in the chat history when `plan({ready: true})` is
    called, and the confirmation popup no longer embeds the plan content.
  ```
- `docs/plan-mode-design.md`：阶段 5 段同步；3 选项 popup 简化；文件路径全改

### 风险

1. **`<cwd>/.pi/.plan-draft-*.md` 误提交**：建议在 `CHANGELOG` 提一句"add
   `.pi/.plan-draft-*` to `.gitignore`"。不强制自动写 .gitignore。
2. **旧的 `~/.pi/draft/<sid>/` 数据**：用户升级前如果还在 plan mode，draft 丢了。
   这是 in-memory state，关闭就清，没持久化问题。OK。
3. **getDraftRoot 改名 getDraftPath 的破坏面**：grep 一下所有调用方，更新。
   影响：plan-mode-state.ts, write.ts, edit.ts, bash.ts, plan.ts, plan-confirm-popup.ts,
   interactive-mode.ts, system-prompt.ts, agent-session.ts, tests
4. **chat markdown 推入可能扰乱 viewport scroll**：与现有 `chatContainer.addChild`
   行为一致，不需要特殊处理
5. **写 `<cwd>/.pi/.plan-draft-*.md` 在 plan mode 白名单**：精确白名单，
   `isPathAllowedInPlanMode` 只允许一个文件路径，最小权限

---

## C. Choice 3 改 fork

### 现状

`handlePlanModeChoice(3)` 调 `runtimeHost.newSession()` 创建**空白 session**，
但 popup hint 写的是 "fork to a new session, execute there"。这是原始实现的 bug。

### 修复

```ts
case 3: {
    const leafId = this.sessionManager.getLeafId();
    if (!leafId) {
        // Empty session, fall back to blank newSession
        const result = await this.runtimeHost.newSession();
        if (result.cancelled) return;
        this.renderCurrentSessionState();
        this.showStatus(`New session. Plan: ${getDraftPath()}`);
        return;
    }
    const finalPath = await this.writePlanModeFinal();
    this.exitPlanModeInternal("execute");
    try {
        const result = await this.runtimeHost.fork(leafId, { position: "at" });
        if (result.cancelled) return;
        this.renderCurrentSessionState();
        this.showStatus(
            finalPath
                ? `Branched. Plan: ${finalPath} (also in session draft)`
                : `Branched. Draft: ${getDraftPath()}`,
        );
    } catch (error: unknown) {
        await this.handleFatalRuntimeError("Failed to branch session", error);
    }
    return;
}
```

要点：
- `position: "at"` 包含 leaf（plan(ready=true) 的 assistant 消息）
- 失败或无 leaf 时 fall back 到 `newSession()`
- **不**写终稿 — draft 文件留在 `<cwd>/.pi/.plan-draft-<sid8>.md`，新 session 可读
  （B 块改完后，draft 在项目里，新 session 走 `read` 工具直接读）
- 状态消息清晰说明 draft 在哪

### Popup label 同步

```ts
// plan-confirm-popup.ts
{ key: 3, label: "新 session (branch)", hint: "fork current session, execute plan" },
```

hint 改 "execute plan" 因为 branch 是为了执行（不是探索）。

### CHOICE_INSTRUCTIONS[3]

```ts
3: "User chose to branch. The new session is a fork of the current one with the " +
    "full planning conversation preserved. The draft remains at " +
    "`${draftPath}` and is readable by the new session. Proceed to implement the plan.",
```

### 测试

- 集成 test：choice 3 → `runtimeHost.fork(leafId, { position: "at" })` 被调
- fallback test：empty session → `runtimeHost.newSession()` 被调
- 不写终稿：choice 3 后 `<cwd>/.pi/<slug>.md` 不存在（B 块改完后的语义）

---

## 实施顺序

按依赖关系：

1. **A**（footer 修复，独立，无依赖）
2. **B**（draft 路径重构 + chat markdown + popup 简化，独立）
3. **C**（fork 改 choice 3，依赖 B 的 draft 路径）

## 验证

每个块跑：
- `npm run check`（biome + tsgo + shrinkwrap + browser-smoke）
- `./test.sh`
- 受影响 package 跑 vitest targeted：
  ```
  node ../../node_modules/vitest/dist/cli.js --run test/suite/plan-mode-integration.test.ts
  node ../../node_modules/vitest/dist/cli.js --run test/plan-mode-utils.test.ts
  node ../../node_modules/vitest/dist/cli.js --run test/suite/plan-mode-state.test.ts
  ```

手动（TUI 验证）：
- `/plan foo` → footer 一行不重复（A 验证）
- 写 draft → sidebar 出现 `.plan-draft-<sid8>.md`（B 验证）
- `alt+1` → `$EDITOR` 打开 draft，编辑保存（B 验证）
- model 调 `plan(ready=true)` → chat 推 markdown + popup 简化（B 验证）
- 选 3 → 新 session 是 branch，footer 不重复（A+C 验证）

## 文件清单

**修改**
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`（A: setExtensionFooter; B: enterPlanMode 调用; C: handlePlanModeChoice case 3）
- `packages/coding-agent/src/modes/interactive/plan-mode-state.ts`（B: draftPath 重构）
- `packages/coding-agent/src/modes/interactive/components/plan-confirm-popup.ts`（B: 删 draft 渲染 + label 改）
- `packages/coding-agent/src/core/system-prompt.ts`（B: 路径 + 工作流描述）
- `packages/coding-agent/src/core/tools/write.ts`（B: 用 getDraftPath）
- `packages/coding-agent/src/core/tools/edit.ts`（B: 用 getDraftPath）
- `packages/coding-agent/src/core/tools/bash.ts`（B: 用 getDraftPath 提 error）
- `packages/coding-agent/src/core/tools/plan.ts`（B: 调 pushChatMarkdown + CHOICE_INSTRUCTIONS[3]）
- `packages/coding-agent/src/core/agent-session.ts`（B: _buildPlanModeContext 用 draftPath）
- `packages/coding-agent/src/core/extensions/types.ts`（B: 加 pushChatMarkdown 到 UI ctx）
- `packages/coding-agent/test/suite/plan-mode-integration.test.ts`（B + C: 测试更新）
- `packages/coding-agent/test/suite/plan-mode-state.test.ts`（B: 测试更新）
- `packages/coding-agent/test/plan-mode-utils.test.ts`（B: 测试更新）
- `packages/coding-agent/CHANGELOG.md`（A + B + C）
- `docs/plan-mode-design.md`（B + C: 同步设计 doc）

**新增**
- `packages/coding-agent/test/suite/plan-mode-filename.test.ts`（B: 文件名生成测试）
- `packages/coding-agent/test/suite/plan-mode-ui-ctx.test.ts`（B: pushChatMarkdown 测试）
- `packages/coding-agent/test/suite/plan-mode-fork.test.ts`（C: fork 路径测试）

## 不在范围

- 修其他 plan mode 痛点（popup 滚动、推荐 plan 结构、popup 改 plan）— B 块后
  这些自然消失（用户用 chat scrollback + `$EDITOR` 改 draft）
- 把 `<cwd>/.pi/.plan-draft-*.md` 自动加入 `.gitignore` — 文档提一句，不强制
- 老的 `~/.pi/draft/<sid>/` 路径兼容 — 完全废弃（in-memory state，无持久化问题）
- extension API 暴露 plan mode 控制给 extensions — 未来工作
