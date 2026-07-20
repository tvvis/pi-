# Plan: 为 plan mode 增加两段系统提示词（做 plan / 执行 plan）

## 目标

把当前单一的 `## Plan Mode` 段落升级为两段提示词（做 plan / 执行 plan），
提示词的**正文由用户从一份 markdown 文件提供**，代码只负责：

- 文件发现（project/global 两级，**文件级整文件胜出**，与 `settings.json` 一致）
- H2 section 解析（slot 系统，可扩展到任意数量的 named prompt）
- 把 slot 内容插入到 `## Plan Mode` / `## Executing Plan` 段落里
- 保持结构性骨架（工具列表、draft 路径、终稿路径等）由代码硬管，确保
  用户忘记写关键约束时系统仍正确

不动现有 plan-mode 工具限制、写权限校验、popup、slash 命令。

## 设计决策

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | 整体形态 | 引入命名 prompt slot 系统；`BuildSystemPromptOptions` 加 `customPrompts?: Record<slotKey, string \| undefined>` 字段 | 与现有 `planMode` / `executePlan` 字段同层；slot 仅承载**用户正文**，结构性骨架仍由代码硬管 |
| 2 | 配置文件路径 | settings.json 双层：`~/.pi/agent/prompts.md`（global）→ `<cwd>/.pi/prompts.md`（project，整文件胜出） | 沿用既有 `~/.pi/agent/...` 与 `<cwd>/.pi/...` 布局；找到 project 文件时**不再读 global**，与 settings.json 合并语义对齐（虽然 settings.json 是 merge，这里是 whole-file 替换） |
| 3 | 文件格式 | 单一 markdown 文件；`## <Slot Heading>` 标记一段；slot 正文 = 该 H2 节 body，直到下一个 `## ` | 单文件、可读、可被 stat/git；不引入 frontmatter；保留用户用普通文本编辑器的便利 |
| 4 | 内置 slot 注册 | `PLAN_PROMPT_SLOTS` 常量表：`{ planMode: "Plan Mode", executePlan: "Executing Plan" }` | 注册表驱动，未来增删 slot 只改常量 + builder 调用点；不强求文件必须有这些 H2 |
| 5 | 系统骨架 vs 用户正文 | 骨架（"must NOT modify"、"Available tools:"、`draftRoot/*`、 `# Plan: <title>` 要求、"An approved plan is at <planPath>"）由代码硬管；slot 内容只放**指引性正文**（如何问问题、Plan 结构建议、执行行为） | 用户写错或忘记骨架时系统仍正确；同时用户不被骨架束缚 |
| 6 | slot 缺失行为 | 文件不存在 / H2 不匹配 → 该 slot 不向 system prompt 注入任何内容；保留现有 plan-mode 默认行为（plan mode 段保留现有骨架；executing plan 段暂无默认） | 渐进式升级；不破现有 |
| 7 | executePlan 的动态字段 | `planPath` / `title` 由代码注入骨架；用户正文里可用 `${planPath}` `${planTitle}` 占位符做行内替换（无模板引擎，纯 `${var}` regex） | 把动态值与用户文本解耦，用户不必在文件里维护路径 |
| 8 | 互斥 | `planMode` 与 `executePlan` 互斥（写在 agent-session 的 `_rebuildSystemPrompt`），但与 slot 系统互不影响（slot 只是另一维度） | 与本次变更正交 |
| 9 | 缓存与重载 | 每次 `_rebuildSystemPrompt` 都读一遍文件（成本低，单文件文本）；`/reload` 自然刷新（已存在） | 简单；和 settings.json 的热重载级别不同，但足够 |

## 文件与数据模型

### 新增：用户配置文件

路径（按这个顺序找，第一个存在者用之）：

1. `<cwd>/.pi/prompts.md`（project scope，胜出）
2. `~/.pi/agent/prompts.md`（global scope，fallback）
3. 都没有 → 视为空文件

典型内容（用户自己写）：

```markdown
# Prompts

## Plan Mode

<!-- 用户正文：如何问问题、Plan 结构、迭代策略等 -->

## Executing Plan

<!-- 用户正文：执行行为指导（顺序、验证、遇阻、超范围、完成回报等） -->

## <Other Scene>    <!-- 未来新增场景，往下追加即可 -->

<!-- 正文 -->
```

### 新增：slot 注册表

放 `packages/coding-agent/src/core/prompt-slots.ts`：

```ts
export const PLAN_PROMPT_SLOTS = {
  planMode: "Plan Mode",
  executePlan: "Executing Plan",
} as const;

export type PlanPromptSlotKey = keyof typeof PLAN_PROMPT_SLOTS;
```

未来加新 slot（例如 `compaction`、`bashSession`），往这张表加一行 + 调一次
`buildSystemPrompt` 即可。**不引入新的顶层文件或框架**。

### 内置 slot 名 → 系统 prompt 渲染位

| slot key | 渲染位置 | 骨架（代码硬管） | 用户可写（slot 内容） |
|----------|---------|-----------------|----------------------|
| `planMode` | `## Plan Mode` 段落（在文件末尾 `<date> <cwd>` 之前） | "must NOT modify" + "Available tools" + draftRoot + "plan({ready: true})" + "# Plan: &lt;title&gt; 必填" + "The user is planning: &lt;desc&gt;" | 工作流细节、ask 用法、Plan 结构模板、如何迭代 |
| `executePlan` | `## Executing Plan` 段落（紧跟 `## Plan Mode` 之后或独立出现） | "An approved plan is at `<planPath>`" + 可选 title | 执行行为（顺序、范围、验证、遇阻、超范围、完成回报） |

## 改动清单

### 1. `packages/coding-agent/src/core/prompt-slots.ts`（新文件）

定义 `PLAN_PROMPT_SLOTS` 常量与 slot key 类型。注释里写明"加 slot 改两处"。

### 2. `packages/coding-agent/src/core/system-prompt.ts`

- `BuildSystemPromptOptions` 新字段：

  ```ts
  /**
   * User-authored prompt bodies keyed by slot id (see PLAN_PROMPT_SLOTS).
   * Each value is the body of the matching `## ` section in the user's
   * prompts.md file. Missing keys → no contribution for that slot.
   */
  customPrompts?: Partial<Record<PlanPromptSlotKey, string | undefined>>;
  ```

- `buildSystemPrompt`：
  - 当前 `if (planMode) { ... }` 整段拆分为两段：
    - **骨架部分**（永远 emit 当 `planMode` 为真时）：工具限制、draftRoot、`# Plan: <title>` 要求、`plan({ready: true})`、description
    - **slot 部分**（emit 当 `customPrompts?.planMode` 有值）：在该 section 中以 slot 内容为主、骨架做锚
  - 同理新增 `## Executing Plan` 段落：emit 当 `executePlan` 为真；正文优先取 `customPrompts?.executePlan`，再做 `${planPath}` / `${planTitle}` 占位符替换；缺失 slot 时骨架仍是"An approved plan is at `<planPath>`"加一行总执行行为提醒（避免完全空白）

- 占位符替换：在文件内做，函数 `substitutePromptVars(template, vars)`，仅支持 `${name}` 形式；缺失变量保留字面 `${name}`

### 3. `packages/coding-agent/src/core/agent-session.ts`

- 增字段 `_customPrompts: Record<PlanPromptSlotKey, string | undefined> | undefined = undefined`
- 增方法：
  - `_readPromptsFile(): string | undefined` — 通过 `getAgentDir()` + `cwd` 找文件；同步 `readFileSync`；ENOENT → undefined
  - `_parsePrompts(content: string): Record<PlanPromptSlotKey, string | undefined>` — 按 `^## (.+)$` 切分，每段拿首行做 key（去 trim），case-insensitive 匹配到 `PLAN_PROMPT_SLOTS[slotKey]`
  - `_buildCustomPromptsContext()` — 调用上面两个
- 在 `_rebuildSystemPrompt` 里把 `customPrompts: this._buildCustomPromptsContext()` 加进 `_baseSystemPromptOptions`
- `_refreshBaseSystemPrompt` 保持现有签名（每次都重新读文件 + 重 build）

### 4. `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

- 选项 1（同 session 执行，`handlePlanModeChoice` 分支 1）：
  - 保留 `writePlanModeFinal()` 与 `exitPlanModeInternal("execute")` 顺序
  - 在 `exitPlanModeInternal` 之后，调 `this.session.setExecutePlan({ planPath: finalPath, title: derivePlanTitle(content) ?? undefined })`
- 选项 3（新 session）：
  - 保留现有 `runtimeHost.newSession({ ... })` 调用
  - 把 `setSessionNote("Read that file first, then execute the plan it describes.")` 替换为 `this.session.setExecutePlan({ planPath: oldDraftPath, title: derivePlanTitle(content) ?? undefined })`
- 增 helper（已存在逻辑抽出来）：

  ```ts
  private async capturePlanTitle(path: string): Promise<string | undefined> {
    try {
      const content = await readFile(path, "utf-8");
      return derivePlanTitle(content);
    } catch {
      return undefined;
    }
  }
  ```

- 在 `enterPlanModeInternal` / `exitPlanModeInternal` 不动 `_customPrompts`，因为 slot 系统与 plan mode 正交

### 5. 不动文件

- `core/tools/plan.ts`
- `core/tools/write.ts` / `core/tools/edit.ts` / `core/tools/bash.ts`
- `modes/interactive/components/plan-confirm-popup.ts`
- `core/keybindings.ts`
- `core/slash-commands.ts`

## 注入时机

| 状态变化 | 谁触发 | 调用 | `planMode` | `executePlan` | slot |
|----------|--------|------|------------|---------------|------|
| `/plan [desc]` 或 `alt+o` 进 plan mode | `enterPlanModeInternal` | existing | ✓ | ✗ | `planMode` slot 若 file 有 |
| 选项 2 继续完善 | popup handler | existing | ✓ | ✗ | 不变 |
| 选项 1 执行（同 session） | `handlePlanModeChoice(1)` | **new**: `setExecutePlan` | ✗（先 exit） | ✓ | `executePlan` slot 若 file 有 |
| 选项 3 新 session | `handlePlanModeChoice(3)` | **new**: `setExecutePlan` 替换原 `setSessionNote` | ✗（干净新 session） | ✓ | 同上 |
| `alt+o` 退出 plan mode | `exitPlanModeInternal` | existing | ✗ | ✗（保持） | 不变 |

字段互斥与现有断言一致；与 slot 正交。

## 测试

### `test/system-prompt.test.ts`（单元）

新增 describe `buildSystemPrompt customPrompts`：

- 默认无 `customPrompts` → 无 slot 正文渲染（骨架仍 emit 当 planMode/executePlan 触发）
- 给 `customPrompts.planMode` 字符串 → 渲染在 `## Plan Mode` 节内
- 给 `customPrompts.executePlan` 含 `${planPath}` → 路径替换为 `executePlan.planPath`
- 给 `customPrompts.executePlan` 含 `${planTitle}` 但 `executePlan.title` undefined → 替换为空串、保留 warning 注释 or 保留字面 `${planTitle}`（选一）
- slot key 越界（不在 `PLAN_PROMPT_SLOTS` 表中） → 抛错或忽略（选一）

扩写 `buildSystemPrompt plan mode` / `buildSystemPrompt executing plan`：

- 骨架部分保留：`Available tools:`、`<draftRoot>/*`、`PlanModeWriteError`、`# Plan: <title>`、`plan({ready: true})`、`An approved plan is at`、`<planPath>` 等

### `test/core/prompt-slots.test.ts`（单元，新文件）

- `parsePrompts` 单元：mock 文件内容，验证 H2 节切分、case-insensitive 匹配、空白跳过、无匹配 → undefined
- `substitutePromptVars` 单元：基本替换、重复同名、缺失变量保留字面

### `test/suite/plan-mode-integration.test.ts`（集成）

新增：

- 选项 1：`writePlanModeFinal` 写完终稿后 `setExecutePlan`，断言 `systemPrompt` 含 `## Executing Plan` 与终稿路径
- 选项 3：`setExecutePlan` 后断言 system prompt 含终稿路径、**不**含旧的 `Read that file first` session note
- 用户提供 prompts.md → customPrompts 出现在 systemPrompt
- 用户没提供 prompts.md → 不影响 planMode 骨架渲染

## 风险与边界

1. **slot 命名冲突风险**：若用户 prompts.md 里写一个无意中的 `## Plan Mode` 节（用于别的目的），会被识别为 plan mode slot。规避：H2 文本严格匹配 `PLAN_PROMPT_SLOTS`（不做 fuzzy / substring）。文档里提示用户 H2 名是 contract
2. **占位符替换复杂度**：决定用最小 `${var}` regex，还是引入 mustache / handlebars 风格 ——选最小，避免引入模板引擎依赖
3. **删 `setSessionNote` 的破坏性**：现有用法只在 interactive-mode 一处；无外部 API 依赖。但 CHANGELOG 要写明
4. **不持久化**：slot 文件是磁盘状态、`executePlan` 是内存状态，分开；`/resume` 一个旧 session 不会有 `executePlan`，但 slot 内容每会话都能从 prompts.md 重新读到（用户期望）
5. **同名 H2 重复**：若文件里有两段 `## Plan Mode`，按"第一个胜出"处理。简单、不可配置
6. **`# Plan: <title>` 必填规则**：用户写 slot 内容可能忘记这条骨架规则；骨架仍由代码硬管，不依赖用户记得写

## 实施阶段

| 阶段 | 内容 | 依赖 | 验证 |
|------|------|------|------|
| 1 | 新增 `core/prompt-slots.ts` 常量表 | 无 | `npm run check` |
| 2 | `system-prompt.ts` 加 `customPrompts` 字段 + slot 渲染 + 占位符替换；扩展 planMode/executePlan 骨架 | 1 | `npm run check` + system-prompt.test.ts |
| 3 | `agent-session.ts` 加 `_readPromptsFile` / `_parsePrompts` / `_buildCustomPromptsContext`，注入到 `_rebuildSystemPrompt` | 1, 2 | `npm run check` + 新 prompt-slots.test.ts |
| 4 | `interactive-mode.ts` 选项 1、3 改 `setExecutePlan` 调 `setSessionNote`；抽 `capturePlanTitle` helper；删旧 note | 2, 3 | `npm run check` + plan-mode-integration.test.ts |
| 5 | 全套测试（system-prompt + prompt-slots + plan-mode-integration）+ 文档（plan-mode-design.md 引用新机制） | 1-4 | `./test.sh` |
| 6 | CHANGELOG：`packages/coding-agent/CHANGELOG.md` → `### Changed` + 可选 `### Added` | 5 | — |
| 7 | 手动 smoke：tmux 起 pi，准备 `~/.pi/agent/prompts.md` 含两段空 body、第二次写两段短正文，跑 plan mode 到执行，看到 slot 正文生效；删 prompts.md，确认回到骨架 | 5, 6 | pi-test.sh |

## 不动的东西

- `/plan` 命令语义
- `alt+o` 快捷键
- popup 三选项文字
- `plan-confirm-popup.ts`
- plan slug 提取规则
- draft 路径
- 现有 system prompt 段落（除拆分为骨架 + slot）
