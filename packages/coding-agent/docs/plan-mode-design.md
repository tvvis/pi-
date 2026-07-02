# Plan Mode 设计文档

## 目标

在 pi interactive mode 加一个 **plan mode**：用户进入后，model 只能读、只能
写 plan 草稿，**禁止**对项目文件做修改；通过对话 + `ask` 工具的混合问答把需求
整理成一份 plan；用户确认后退出 plan mode，model 拿到执行权限按 plan 落代码。

## 用户流程

```
┌─ /plan [description]   或  alt+o ──┐
│                                            │
│   [plan mode 开启]                         │
│       │                                    │
│       ▼                                    │
│   Model:                                    │
│     - 用 ask 工具问结构化问题               │
│     - 用对话问开放式问题                     │
│     - 不断把想法写到 ~/.pi/draft/<sid>/     │
│                                            │
│   Model 调 plan(ready=true)                │
│       │                                    │
│       ▼                                    │
│   Popup: 显示 plan 内容 + 3 选项            │
│     1. 执行   → 退出 plan mode，写           │
│                <cwd>/.pi/<slug>.md，执行     │
│     2. 继续完善 → 留在 plan mode，draft 保留 │
│     3. 新 session → 干净新 session，plan 路径   │
│                  注入新 session 系统提示       │
│                                            │
│   (执行模式下 model 正常读写，按 plan 改代码) │
└────────────────────────────────────────────┘
```

## 关键设计决策

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | Q&A 形式 | 混合：对话 + 现有 `ask` 工具 | 复用现成 UI，不造新轮子；自由文本用对话，结构化用 ask |
| 2 | 草稿位置 | `~/.pi/draft/<session-id>/` | 不污染 cwd；按 session 隔离避免互相覆盖 |
| 3 | 终稿位置 | `<cwd>/.pi/<slug>.md` | 跟项目历史放一起；slug 由 model 从标题/目标自动提取 |
| 4 | 终稿写入时机 | plan mode **退出后**写 | 写权限白名单只覆盖 draft；终稿写入是正常写权限 |
| 5 | 进入入口 | `/plan` + `alt+o` 双入口 | slash 命令显式 / 快捷键快速 toggle |
| 6 | 退出 | popup 3 选项（执行/继续/新 session）| 单一确认点，不打断用户；3 选项覆盖主要分流 |
| 7 | 写权限范围 | write/edit 允许但仅 `~/.pi/draft/<sid>/*`，其他路径抛异常；bash 完全禁用；read/grep/find/ls/ask 全部可用 | 写权限收紧到极致；读和问答不动 |
| 8 | Plan 格式 | 推荐结构（Goal / Approach / Files / Verification / Risks），迭代中逐步固定高频章节 | v1 灵活优先；后续按需把高频章节升级为强制 |
| 9 | Plan 工具 API | 极简：v1 只有 `plan(ready=true)` 触发 popup | 其他操作（save_draft/add_section）暂不考虑 |
| 10 | Plan 模式 state | 仅内存（session 退出/换 session 就丢） | 退出需要重新进入；但 drafts 持续可查 |
| 11 | Model 知道在 plan mode | system prompt **条件追加** plan mode 段落 | model 始终能见到规则；不需要每 turn reminder |
| 12 | 提示注入时机 | `/plan <description>` 立即注入；裸 `/plan` 或快捷键延迟到第一条 user message | 没有上下文就别浪费注入；`<description>` 是天然上下文 |
| 13 | UI 指示 | footer 角标 `◧ plan`（与 sidebar 风格一致） | 轻量不抢眼；与已有模式风格统一 |
| 14 | Popup 形式 | 居中弹窗覆盖 chat（plan 内容 + 底部 3 选项） | 居中聚焦决策；plan 内容滚读 + 选项固定底栏 |

## 数据模型

### Plan mode state（内存）

```ts
interface PlanModeState {
  active: boolean;                  // 是否在 plan mode
  sessionId: string;                // 绑定的 session（用于 draft 隔离）
  description?: string;             // /plan <description> 的 description
  enteredAt: number;                // 进入时间（用于 prompt 注入判断）
  pendingPromptInjection: boolean;  // 是否需要在下一条 user message 注入 prompt
}
```

不存盘、不进 session 文件。`/resume` 一个旧 session 不会恢复 plan mode。

### Draft 文件

```
~/.pi/draft/
  └─ <session-id>/
      └─ draft.md       # 最新草稿（model 每次 write 覆盖）
```

读取：popup 触发时读 `draft.md`。历史 draft 不保留（v1 简化）。

### 终稿文件

```
<cwd>/.pi/
  └─ <slug>.md           # 用户确认后由 model 写入
```

slug 由 model 从 plan 的 `# Plan: <Title>` 或 `## Goal` 提取。如
`Add rate limiting` → `add-rate-limiting.md`。

`<cwd>/.pi/` 推荐加入 `.gitignore`（不是强制；用户自己决定）。

## 工具限制

plan mode 下 model 可用的工具：

| 工具 | plan mode 下 | 说明 |
|------|--------------|------|
| `read` | ✓ | 读项目文件 |
| `grep` | ✓ | 搜索 |
| `find` | ✓ | 查找文件 |
| `ls` | ✓ | 列目录 |
| `ask` | ✓ | 结构化 Q&A（**复用现成工具，不新增**）|
| `write` | ⚠ 受限 | 仅允许 `~/.pi/draft/<sid>/*`；其他路径抛 `PlanModeWriteError` |
| `edit` | ⚠ 受限 | 同上 |
| `bash` | ✗ 禁用 | 完全 block |

实现路径：复用 `createReadOnlyTools` 风格，新增 `createPlanModeTools`
（或在 `createReadOnlyTools` 上加 path whitelist），由
`interactive-mode` 根据 plan mode state 决定调哪一套。

write/edit 的 path 校验放在 tool execution 之前（hook 或 guard），失败抛
`PlanModeWriteError` 给 model 看到（model 可以用这个 error 自我修正）。

## Model Prompt

### System prompt 条件追加段（plan mode 激活时）

```markdown
## Plan Mode

You are in plan mode. You must NOT modify any project files.

Available tools:
- read, grep, find, ls: read project files
- ask: ask the user structured questions
- write, edit: ONLY to `~/.pi/draft/<session-id>/*` (other paths throw)
- bash: disabled
- plan: call with `ready=true` to request user confirmation

Workflow:
1. Discuss with the user (conversationally or via `ask` tool)
2. Write your evolving plan to `~/.pi/draft/<session-id>/draft.md`
   using `write` or `edit`
3. When the plan is complete and you are ready for the user to
   confirm, call `plan({ready: true})`
4. Wait for the user to choose: execute / refine / new session
```

### 注入时机

- `/plan <description>`：进入 plan mode 后**立即**追加 system 消息
  ```
  <system>
  Plan mode entered with goal: <description>
  Draft path: ~/.pi/draft/<session-id>/
  </system>
  ```
- `/plan`（裸）或快捷键：plan mode state 设为 active，但 system 消息**延迟**
  到下一条 user message 一起追加。同样的 `<system>` 块，description 字段空着。

实现：`PlanModeState.pendingPromptInjection` 标志。`interactive-mode` 在
构造下一条 user message 时检查这个标志，决定是否追加 `<system>` 块。

## UI 组件

### Footer 角标

在 footer 右侧追加（与 `◧ sidebar` 同风格）：

```
◧ plan     [plan mode 时显示]
```

非 plan mode 时不显示。实现：在 `sidebar-recent-files.ts` 旁边类似位置加
个 `plan-mode-indicator` 组件（或扩展现有 footer 状态栏）。

### Popup 居中弹窗

复用现有 overlay 渲染模式（参考 `AskSelectorComponent` 或 model selector）：

```
┌───────────────────── plan ready ──────────────────────┐
│                                                       │
│  → 1. 执行      exit plan mode, write final, execute │
│    2. 继续完善  stay in plan mode, continue Q&A      │
│    3. 新 session  clean session, execute from draft  │
│                                                       │
│  ↑/↓ 移动  1-3 快捷  Enter 确认  Esc = refine        │
└───────────────────────────────────────────────────────┘
```

Popup **不**嵌 plan 内容（不再有 18 行截断）。Draft 由 plan tool 在 popup
弹出前调 `ExtensionUIContext.pushChatMarkdown` 推到 chat history，
用户在 chat 里看完整版（可滚、可复制）。空 / 缺失 draft 推一条警告到
chat 代替 markdown。

## 三个选项的语义

### 1. 执行

- 退出 plan mode
- 写权限恢复（write/edit 全 cwd 范围，bash 启用）
- Model 继续当前 conversation，但 prompt 追加 system 消息：
  ```
  <system>
  Plan was approved. Final plan written to <cwd>/.pi/<slug>.md.
  Proceed to execute the plan.
  </system>
  ```
- Model 调 `write` 写终稿到 `<cwd>/.pi/<slug>.md`（slug 从 plan 标题/目标提）
- 之后 model 继续对话，按 plan 改代码

### 2. 继续完善

- 留在 plan mode
- draft 文件保留（`draft.md` 不动）
- Prompt 追加 system 消息：
  ```
  <system>
  User wants to continue refining. Draft is at
  ~/.pi/draft/<session-id>/draft.md. Continue Q&A.
  </system>
  ```
- Model 继续对话、继续改 draft

### 3. 新 session

- 退出 plan mode（当前 session）
- **创建干净的新 session**（`runtimeHost.newSession()`），不继承 plan mode
  期间的对话历史——新 session 上下文为空（隔离）
  - 新 session 有独立的 sessionId，重新进入 plan mode 时 draft 路径不会
    与旧 session 冲突（`~/.pi/draft/<新 sid>/`）
  - 新 session 处于普通执行模式（write/edit/bash 全开）
  - 把旧 draft 路径通过 `AgentSession.setSessionNote` 注入新 session 的
    system prompt，提示 model 先读 draft 再执行
  - 弹出 "New session (clean context). Plan draft: <draft path>"
- draft 文件保留在 `~/.pi/draft/<旧 sid>/draft.md`，新 session 可读
- 仅当 draft 文件真实存在时才注入 note；无 draft 时不注入（空白 session）

## Plan 工具定义

`packages/coding-agent/src/core/tools/plan.ts`（新文件）：

```ts
const planSchema = Type.Object({
  ready: Type.Optional(Type.Boolean({
    description: "Set to true when the plan is ready for user confirmation",
  })),
});

export function createPlanToolDefinition(): ToolDefinition<...> {
  return {
    name: "plan",
    label: "plan",
    renderShell: "self",
    description: "Plan mode tool. Call with ready=true to request user confirmation of the current plan draft.",
    promptSnippet: "Signal that the plan is ready for user confirmation",
    parameters: planSchema,
    executionMode: "sequential",
    async execute(_id, { ready }, signal, _onUpdate, ctx) {
      if (!ctx.inPlanMode) {
        throw new Error("plan tool can only be called in plan mode");
      }
      if (ready !== true) {
        throw new Error("plan tool currently only supports ready=true");
      }
      // Yield so the tool call render shows before the popup replaces the editor.
      await new Promise(r => setTimeout(r, 0));
      // Trigger the popup via UI custom
      const result = await ctx.ui.custom<{ choice: 1 | 2 | 3 }>((_tui, _theme, _kb, done) => {
        return new PlanConfirmPopup(...);
      });
      return { content: [{ type: "text", text: `User chose option ${result.choice}` }], details: { choice: result.choice } };
    },
    renderCall(...) { ... },
    renderResult(...) { ... },
  };
}
```

注册：加到 `ToolName` 联合类型、`allToolNames` 集合、`createCodingToolDefinitions`
/`createReadOnlyToolDefinitions` 的相关工厂里。Plan mode 时**包含**
`plan` 工具；非 plan mode 时**不包含**（避免误调）。

## Slash 命令

`/plan` 注册到 `BUILTIN_SLASH_COMMANDS`：

```ts
{ name: "plan", description: "Toggle plan mode (or: /plan <description>)" },
```

处理逻辑（`interactive-mode` 里加 `handlePlanCommand(args)`）：
- 解析 args：如果有非空字符串，视为 description
- 不在 plan mode：进入 plan mode
  - 有 description：立即注入 system 消息
  - 无 description：标记 `pendingPromptInjection = true`
- 已在 plan mode：忽略（避免误操作；用户想退出用 popup 选 2/3，或快捷键 toggle）

> **决定待补**：已在 plan mode 时 `/plan` 应该是
> (a) 强制弹 popup
> (b) 重新进入（刷新 description）
> (c) 忽略
> 默认采用 **(c) 忽略**，因为 popup 是唯一的"我在 plan mode 完成"信号；快捷键
> 是"toggle off"信号。

## 快捷键

`packages/coding-agent/src/core/keybindings.ts` 加：

```ts
"app.plan.toggle": {
  defaultKeys: "alt+o",
  description: "Toggle plan mode",
}
```

`setupKeyHandlers()` 绑 `app.plan.toggle` → `togglePlanMode()`。

`togglePlanMode()` 行为：
- 不在 plan mode：进入（无 description，pendingPromptInjection = true）
- 在 plan mode：退出（draft 保留，state 清除；不弹 popup）

快捷键不进 popup 是有意的：popup 是"plan 写完了请确认"，不是"我要退出"。
要重新进 plan mode 用 `/plan` 或再按一次快捷键。

## 写权限校验实现

`write` / `edit` tool 现有 path 校验之外加 plan mode guard：

```ts
// In createWriteTool / createEditTool, or wrapper
function planModePathGuard(filePath: string, ctx: ToolContext): void {
  if (!ctx.inPlanMode) return;
  const allowedRoot = path.join(os.homedir(), ".pi", "draft", ctx.sessionId);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(allowedRoot + path.sep) && resolved !== allowedRoot) {
    throw new PlanModeWriteError(
      `Plan mode: writes restricted to ${allowedRoot}/* (attempted: ${resolved})`
    );
  }
}
```

`PlanModeWriteError` 是新错误类，model 看到后可以：
- 把路径改到 `~/.pi/draft/<sid>/` 重试
- 或调 `plan(ready=true)` 触发 popup 让用户选 1 退出 plan mode

## 待补 / 待你拍板

- [ ] **已 plan mode 时 `/plan` 的行为**：默认 (c) 忽略
- [ ] **Plan slug 提取规则**：从 `# Plan: <Title>` 第一行？或 `## Goal` 第一句？
      还是 model 自己用 `path.basename` 风格的判断？建议：model 自由发挥，规则
      仅做"小写、连字符、空格替 - "
- [ ] **空 draft 调 `plan(ready=true)`**：popup 显示 "Plan is empty"，
      option 1 灰掉，只剩 2/3
- [ ] **`<cwd>/.pi/` 是否自动创建**：建议 plan mode 退出时自动 `mkdir -p`
- [ ] **`<cwd>/.pi/` 是否建议 gitignore**：文档里提示用户，不强制
- [ ] **draft 目录清理**：旧 session 的 draft 不自动删（用户可手动清理），
      避免误删

## 实施阶段

| 阶段 | 内容 | 依赖 |
|------|------|------|
| 1 | Plan mode state + slash 命令 + 快捷键 + 写权限 guard + plan 工具 | 无 |
| 2 | Footer 角标 | 1 |
| 3 | Popup（3 选项）+ 选项 1/2/3 行为 | 1 |
| 4 | System prompt 条件追加 + 注入时机 | 1 |
| 5 | 终稿写入（`<cwd>/.pi/<slug>.md`）+ slug 提取规则 | 3 |
| 6 | 测试（harness + 单元）+ 文档 + CHANGELOG | 全部 |

## 风险点

1. **write 工具 guard 抛异常 vs 静默失败**：选异常。model 必须看到错误
   才知道自己违规了；静默失败会误导 model。
2. **draft 路径绝对 vs 相对**：model 写 `draft/draft.md` 还是
   `~/.pi/draft/<sid>/draft.md`？建议 tool 接受相对路径（基于
   `<sid>` 自动 join），但 error 信息里给绝对路径让 model 知道
3. **新 session 选项的实现**：采用 `runtimeHost.newSession()` 创建干净新
   session（不 fork），通过 `AgentSession.setSessionNote` 把旧 draft 路径
   注入新 session 的 system prompt。不继承对话历史，上下文隔离。
4. **popup 在 sidebar 显示时的处理**：sidebar 是 leftPanel 不会被 popup
   覆盖（overlay 走 `terminal` 直绘）；确认 popup 也走直绘
5. **plan tool 的 execute 抛 cancelled**：signal abort 时 popup 关闭，
   行为与 `ask` tool 一致
6. **快捷键冲突**：`alt+o` 在所有平台目前无冲突（已查 keybindings.ts）

## 验证

- `./test.sh` 全过
- vitest suite：plan tool unit test、write guard unit test、plan
  mode state machine test
- 手动：
  1. `/plan foo` → footer 角标出现
  2. Model 用 ask 问问题 → 弹窗选项正常
  3. Model 写 draft → 文件出现在 `~/.pi/draft/<sid>/draft.md`
  4. Model 调 `plan(ready=true)` → popup 出现
  5. 选 1 → plan mode 退出，model 写终稿到 `<cwd>/.pi/foo.md`
  6. Model 按 plan 改代码（正常写权限）
  7. 选 2 → 留在 plan mode，draft 保留
  8. 选 3 → 干净新 session 弹出，旧 draft 路径注入新 session 系统提示
  9. `alt+o` → toggle plan mode
  10. 在 plan mode 试 `write foo.txt` → 抛 PlanModeWriteError
  11. 在 plan mode 试 `bash` → 抛禁用错误
  12. 退出 plan mode → 写权限恢复
