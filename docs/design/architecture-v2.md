# Grok Code 架構 v2 設計文檔

> 狀態：草案（待 review）
> 日期：2026-06-10
> 範圍：核心循環大重構、純 stateless 對話、四層上下文壓縮系統、LLMProvider 抽象、Sandbox 集中強制

---

## 1. 背景與目標

本項目定位從「單一供應商的個人 CLI 工具」升級為**可重用的 agent 框架**：可 headless 嵌入其他程式、可換模型供應商、核心循環可獨立測試。

現狀的主要設計債（完整分析見 review 紀錄，此處列驅動本設計的四項）：

1. **`AgentLoop.ts`（634 行）是 god object**：15+ 個可變狀態變數構成隱式狀態機；三個 response guard 各有 ad-hoc 計數器；verifier 在循環內直接實例化；工具語義（`apply_patch` 名稱判斷、shell exit code 特判）洩漏進循環。
2. **對話狀態雙重記帳**：`ContextManager`（本地）與 Responses API `previous_response_id`（伺服器端）兩套狀態會分歧；`relevant()` 讀取有副作用導致非決定性；session resume 不還原 chain。
3. **Token 預算形同虛設**：估算為 `length/4`；`SECTION_BUDGET` 定義但從未 enforce；壓縮器只做字串拼接且摘要永久 pin 住（洩漏）。
4. **Sandbox 非統一強制**：檔案工具各自呼叫檢查，`run_shell` 只設 `cwd` 可路徑逃逸；read-only 工具清單為手動硬編碼 Set。

## 2. 已定案的決策

| 決策 | 結論 | 理由 |
|---|---|---|
| 對話狀態 | **刪除 stateful/hybrid，純 stateless** | 壓縮系統與伺服器端 chain 邏輯上不相容；provider 抽象需要 messages-based 形狀；可重現性 |
| 重構策略 | **一次性大重構**（先補測試再換骨架） | 漸進抽取無法解決狀態機與三模式分支的糾纏 |
| 上下文壓縮 | **必做**，四層保真度設計（§6） | 長任務的核心能力 |
| 安全層優先項 | **Sandbox 集中強制**（§9） | 目前最實質的安全洞 |
| Token 成本控制 | prefix-cache 友善的輸入分層（§5） | 補償放棄伺服器端 chain 的成本 |
| **Provider 層** | 每個 model source 用其**官方 SDK**；無官方 JS SDK 者**直接打 HTTP 端點**。xAI 無第一方 JS SDK → `XaiResponsesProvider` 直接 `fetch` `/v1/responses`，移除 `openai` SDK 依賴。`LLMProvider` 中性接縫保留（§4） | 用戶政策；脫鉤特定 SDK；OpenAI/Anthropic 日後各用其官方 SDK 實作同一介面 |
| **執行工具** | `run_python` **完全取代** `run_shell`；外部程序（git/npm/tsc）經 Python `subprocess` 呼叫（§9.4） | 跨平台一致性（本項目跑 Windows）+ 結構化表達力；安全為輔（Python ≠ sandbox） |
| **read-before-write** | 前置證據**與操作失敗模式成比例**：modify→被改**行範圍**內容已讀且快照新鮮；create→無；delete→只需**存在性 provenance**（非內容讀取）。否則拒絕（§6.6 + §9.5） | 防模型幻覺；delete 用存在性而非內容，避免拉全檔污染/浪費；寫入後使該檔 read-range 失效防 staleness |
| **破壞性操作復原** | `WorkspaceSnapshotStore`：所有突變（delete/overwrite）前快照 pre-image 至 sandbox-deny 的 `.grok-code/.trash/`，保留最近 M 輪；CLI 還原，模型無還原權（§9.6） | 類 git 安全網——模型誤刪/破壞可復原，不致「直接完蛋」；事後復原層，補 §9.5 事前防呆 |

## 3. 目標架構總覽

```
Agent（組裝根，無副作用建構 + 顯式 initialize()）
 └─ AgentLoop（薄編排器，目標 ≤150 行）
     ├─ LLMProvider          messages-based 介面；XaiResponsesProvider 為其一實作
     ├─ InputBuilder         cache 分層排版 + 段落預算分配器
     ├─ ContextEngine        store + 四層壓縮 + 無副作用選取（取代 ContextManager）
     ├─ ResponseGuard[]      空回應 / 純敘述 / 多工具 → 統一介面，各自 budget
     ├─ QualityGate[]        Verifier 為其一實作；統一 retry / feedback 協議
     ├─ ToolExecutor         平行策略由工具自宣告的 metadata 驅動
     └─ AgentEvents          事件匯流排；console 渲染只是一個 listener
```

主循環的目標形狀：

```ts
async run(task: string, signal?: AbortSignal): Promise<string> {
  while (this.state.advance()) {
    const input = this.inputBuilder.build(task, this.contextEngine);
    const response = await this.provider.complete(input, { tools, signal });

    const blocked = this.guards.evaluate(response, this.state);
    if (blocked) { this.state.recordReprompt(blocked); continue; }

    if (response.toolCalls.length > 0) {
      const results = await this.executor.executeBatch(response.toolCalls, signal);
      this.contextEngine.ingest(results);
      continue;
    }

    const verdict = await this.gates.evaluate(response.text, this.contextEngine);
    if (!verdict.pass && this.state.canRetryGate(verdict)) {
      this.contextEngine.ingestFeedback(verdict); continue;
    }
    return verdict.pass ? response.text : verdict.exhaustedReport;
  }
  return this.state.terminationReport();
}
```

所有現存行為（reprompt budget、verifier retry、重複失敗阻擋）都保留，但搬進對應的物件，循環本體不再持有裸計數器。

## 4. LLMProvider 抽象

### 4.1 介面

```ts
// src/api/LLMProvider.ts
export type ModelMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "tool"; toolCallId: string; content: string };

export type CompletionRequest = {
  messages: ModelMessage[];
  tools: ToolSchema[];
  toolChoice: "auto" | "required" | "none";
  signal?: AbortSignal;
};

export type CompletionResult = {
  text: string;
  toolCalls: { id: string; name: string; argsJson: string }[];
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  warnings: string[];          // 解析期異常不再靜默吞掉（現 responseParser 過度寬容）
};

export interface LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  // 預留 streaming 形狀，本次不實作，但介面先定避免日後 breaking change：
  stream?(req: CompletionRequest): AsyncIterable<CompletionChunk>;
}

export type ProviderCapabilities = {
  serverTools: string[];        // 例如 xAI 的 web_search / x_search
  promptCaching: boolean;
};
```

### 4.2 設計要點

- **messages-based 是通用最大公約數**：OpenAI Chat Completions、Anthropic Messages、本地模型都能適配。xAI Responses API 由 `XaiResponsesProvider` 內部轉換（messages → Responses input items），`previous_response_id` 從此不出現在 provider 介面以上的任何地方。
- **Server tools 是 provider capability**：現 config 的 `serverTools` / `enableWebSearch` / `enableXSearch` 是 xAI 特有功能。InputBuilder 透過 `capabilities.serverTools` 詢問可用性，換供應商時自動退化，不需改循環。
- **`usage` 必須回傳**：是 §6.4 動態 token 校準的數據來源。
- **解析收嚴**：`responseParser` 現在對缺失欄位靜默回空（`call_id ?? ""`）。新 provider 對缺 `id`/格式異常擲錯，可疑模式（如超多 tool calls）進 `warnings` 由事件系統上報。

### 4.3 Provider 實作政策（已定案）

調查結論（2026-06，xAI 官方文件）：**xAI 沒有第一方 JS/TS SDK**，官方只推薦 (a) OpenAI SDK 指向 `https://api.x.ai/v1`，或 (b) Vercel AI SDK `@ai-sdk/xai`。xAI 的 API 是 **Responses API**（`/v1/responses`）。

政策：

1. **有官方 SDK 的 source → 用該官方 SDK**（OpenAI → `openai`、Anthropic → `@anthropic-ai/sdk`），各自實作 `LLMProvider`。
2. **無官方 JS SDK 的 source → 直接打 HTTP 端點**。xAI 屬此類：`XaiResponsesProvider` 用 `fetch` POST 到 `/v1/responses`，`Authorization: Bearer`，**不依賴 `openai` SDK**。
3. `LLMProvider` 中性接縫在所有路線下保留，換 source 只換實作。

實作備註（已落地）：
- xAI provider 與 OpenAI SDK 的 JSON 進出形狀相同（SDK 本是同一 HTTP API 的薄傳輸層），故 `parseResponse` 直接沿用，遷移風險低。
- 逾時用 `AbortSignal.timeout` 與呼叫端 signal 經 `AbortSignal.any` 合併；非 2xx 擲 `XaiHttpError`（含 status + body 摘要），供 gate/事件診斷。
- client-tool 的 Zod 單源 schema：因 xAI 走直 HTTP（無 SDK `tool()` helper），JSON schema 由我方從 Zod 生成（`zod-to-json-schema` 或等價），而非依賴特定 SDK helper。用官方 SDK 的 provider 則可用該 SDK 的 helper。

## 5. InputBuilder：prefix-cache 分層 + 預算分配

### 5.1 核心不變式：穩定前綴

純 stateless 每步重送全部上下文，成本靠 provider 的 prefix caching 補償。因此**輸入段落順序是硬性約束**，由穩定到易變：

```
層 A（穩定前綴 — 跨步驟逐字節相同，吃 cache）
  1. system prompt
  2. tool schemas + tool index
  3. 選中的 skills（任務期間固定，不逐字步變動）
  4. 專案指示（GROK.md）
  5. pinned context（user_task、repo_summary、environment_*）
層 B（半穩定 — 僅壓縮事件時變動）
  6. 滾動歷史摘要（單一 item，見 §6.3）
層 C（易變尾部 — 每步變）
  7. 最近 N 步的完整工具結果（未降級的 context items）
  8. 當前 guard/gate 回饋訊息
```

規則：**任何會逐步變動的內容禁止出現在層 A**。現有 `buildModelInput` 把 relevance 選取結果混排在前段，每步重洗順序，cache 命中率為零——這是要修掉的根本問題。層 A 內部 item 順序也必須確定性（按 type + id 排序，不按 `lastUsedAt`）。

### 5.1.1 載重上下文的壓縮處置對照（防「壓完忘記在幹嘛」）

壓縮系統的首要保證：**「在幹嘛 / 任務 / 專案規則 / 架構」永不進入可壓縮集合**。明確對照每類內容的處置：

| 內容 | 層 | 壓縮處置 | 現況來源 |
|---|---|---|---|
| 當前任務 `user_task` | A | **永不壓縮**（pinned） | `AgentLoop` upsert pinned, priority 100 |
| 專案架構 `repo_summary` | A | **永不壓縮**（pinned） | `Agent.ts` scanRepo, pinned |
| 環境規則/政策 `environment_*` | A | **永不壓縮**（pinned） | `Agent.ts` environment-policy, pinned |
| 專案指示 GROK.md | A | **永不壓縮**（每步外部注入，不存 context） | `skillLoader.projectInstructions()` |
| 啟用 skills + 工具索引 | A | **永不壓縮**（每步外部注入，不存 context） | `skillLoader.select` / `toolSkills` |
| system prompt | A | **永不壓縮**（每步重建） | `prompts.ts` |
| 滾動歷史摘要 | B | 僅壓縮事件時更新（確定性合併，§6.3） | 新 `history_summary` 單一 item |
| 工具結果 / 檔案讀取（可重取） | C | 降級為一行指標，**不刪除**（§6.2） | file_range/search/shell |
| 中間觀察 / 失敗紀錄 | C | 進結構化摘要（`failedAttempts` 為一級欄位，§6.3） | action/failure record |

讀取 provenance（§6.6）獨立於壓縮：內容可降級，「讀過/存在」的事實索引恆在——壓縮不會放鬆 read-before-write（§9.5）。

### 5.2 段落預算分配器

`SECTION_BUDGET`（現為死代碼）改為真實分配：

```ts
export type SectionBudget = {
  total: number;            // 模型上下文上限 × 安全係數
  sections: Record<SectionName, { max: number; overflow: "degrade" | "truncate" | "error" }>;
};
```

- InputBuilder 組裝時逐段記帳；超出 `max` 時按 `overflow` 策略處理：`degrade` 觸發 ContextEngine 對應層級的降級（§6），`truncate` 確定性截斷（skills 尾部裁切），`error` 擲錯（system prompt 永遠不該超）。
- 所有 magic numbers（90_000、20_000、12_000、`slice(-80)`…）集中到 `src/config/tuning.ts` 單一物件，可被 `.grok-code/tuning.json` 覆寫。

## 6. ContextEngine：四層壓縮系統

取代 `ContextManager` + `ContextCompressor`。核心觀念：**壓縮不是刪除，是讓每個 item 沿保真度階梯降級，且永遠保留可回溯指標**。

### 6.1 第一層：攝入時整形（deterministic）

工具輸出進入 context 時即結構化截斷（shell 留頭尾+錯誤行；檔案讀取記錄範圍+符號）。沿用現有 `helpers.ts` 的做法，但截斷參數移入 tuning config。

### 6.2 第二層：可重取項目的指標化丟棄

`ContextItem.source` 改為**必填的 discriminated union**，據此區分降級策略：

```ts
export type ItemProvenance =
  | { kind: "file"; path: string; startLine?: number; endLine?: number }   // 可重取
  | { kind: "search"; query: string; scope?: string }                       // 可重取
  | { kind: "shell"; command: string }                                      // 半可重取（可能有副作用）
  | { kind: "process"; processId: string }                                  // 可重取（ring buffer）
  | { kind: "user" }                                                        // 不可重取
  | { kind: "model"; confidence: FactConfidence };                          // 不可重取
```

- **可重取** item 降級時不需摘要：內容替換為一行指標（`已讀 src/foo.ts:10-80，需要時用 read_file_range 重讀`）。這是最便宜、無資訊損失風險的壓縮。
- **不可重取**（用戶指示、決策、模型推論）保留至第三層才進摘要，且摘要時標註 confidence。

### 6.3 第三層：LLM 結構化滾動摘要

預算壓力到閾值時，把最舊/低優先的 eligible items 交給模型摘要。三個關鍵設計決定：

**(a) 輸出是 JSON schema，不是散文：**

```ts
export type EpisodeSummary = {
  facts: { text: string; provenance: string; confidence: FactConfidence }[];
  filesTouched: { path: string; action: "read" | "modified" | "created" }[];
  decisions: string[];
  failedAttempts: { what: string; why: string }[];   // 一級欄位 — 丟了模型就會重複犯錯
  openQuestions: string[];
};
```

結構化摘要可以**確定性合併**：兩份摘要的 `facts` 直接 union + 按 `text` 去重，不需再過 LLM，誤差不累積。散文摘要做不到這點。

**(b) 單一滾動摘要 item，不累積：**

現 `ContextCompressor` 每次壓縮生成新的 pinned 摘要、永不回收（長 session 洩漏）。改為：`新摘要 = mergeDeterministic(舊摘要, summarize(本次降級 items))`，context 中永遠只有一個 `history_summary` item。若 merge 後超過摘要自身的預算上限，對 `facts` 做一次 LLM 重摘（這是唯一允許摘要再進 LLM 的情況）。

**(c) 摘要模型可配置：** `tuning.summarizerModel`，預設同主模型。摘要呼叫走同一個 `LLMProvider` 介面。

`failedAttempts` 同時取代現 `FailureTracker` 的部分職責：重複失敗的歷史進入摘要後，跨壓縮邊界仍然可見。

### 6.4 第四層：真實預算 + 動態 token 校準

- **不引入 tokenizer 依賴**。每次 API 回應帶真實 `usage.inputTokens`，用 `實際 tokens / 發送字元數` 動態校準 chars-per-token 比率（指數移動平均）。首步用 4 估，之後逐步收斂；跨供應商天然適配（tokenizer 本來就不同）。
- 壓縮觸發點顯式化：預估輸入 > `budget × 0.8` 觸發第二層降級；> `0.95` 觸發第三層摘要。閾值入 tuning config。

### 6.5 消除非決定性

- `select()`（取代 `relevant()`）**純讀取，無副作用**——不再更新 `lastUsedAt`。
- 降級/淘汰只在步驟邊界（`ingest` 之後）發生，排序 tie-break 用 item id 而非時間戳。
- 同樣的 context 狀態 + 同樣的任務 ⇒ 逐字節相同的模型輸入。這是可測試性與 cache 命中率的共同基礎。

### 6.6 讀取 provenance 與 read-before-write 支援

ContextEngine 是「模型讀過什麼」的唯一事實來源，因此 read-before-write 強制（§9.5）背靠它。每個 `file` provenance 的 read item 需額外攜帶：

```ts
type FileReadRecord = {
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;   // 讀入當下該區域內容的 hash，用於偵測 staleness
  readAtStep: number;
  stale: boolean;        // 被後續寫入觸發失效後為 true
};
```

查詢 / 失效 API：

```ts
interface ContextEngine {
  // modify 用：回傳「尚未被新鮮讀取覆蓋」的行範圍；空陣列 → 允許寫入
  uncoveredForWrite(path: string, ranges: LineRange[]): LineRange[];
  // delete 用：模型是否有該檔的存在性證據（見過於 listing/search/overview/status）——不檢查內容
  hasFileExistenceEvidence(path: string): boolean;
  // 寫入後呼叫：使該檔所有 read record 失效，強制下次編輯前重讀
  invalidateReads(path: string): void;
}
```

**存在性索引**（餵 `hasFileExistenceEvidence`）：是一個輕量的「已知存在路徑」集合，由 `list_files`/`search_*`/`get_file_overview`/`git_status` 的結果在 `ingest` 時登錄路徑（不存內容）。成本是每路徑一筆，無污染。delete 只查這裡，不碰 read record / 內容。

- **新鮮度**：read record 的 `contentHash` 在強制檢查時與當前磁碟對應區域比對；不符即視為 stale（檔案在讀取後被改動過）。
- **可重取降級不影響**：§6.2 的可重取 item 即使內容被指標化降級，其 `FileReadRecord`（path/range/hash）保留——降級的是「塞進模型輸入的內容」，不是「是否讀過」的事實。這樣壓縮不會反而放鬆 read-before-write。
- 這些 record 不進壓縮摘要的內容欄位，是 ContextEngine 的旁路索引。

## 7. AgentLoop 重構：顯式狀態 + 統一守衛/閘門協議

### 7.1 LoopState

15+ 個裸變數收斂為一個顯式狀態物件：

```ts
class LoopState {
  step: number;
  repromptCounts: Map<GuardId, number>;
  gateAttempts: Map<GateId, number>;
  hasModifiedFiles: boolean;        // 由工具 metadata 設置，不再嗅探工具名
  advance(): boolean;               // step++ 並檢查 maxSteps / abort
  terminationReport(): string;
}
```

三模式（stateful/hybrid）相關狀態（`chainLength`、`consecutiveFailures`、`invalidResponses`、`previousResponseId`）隨模式刪除一併消失。

### 7.2 ResponseGuard 統一介面

```ts
export interface ResponseGuard {
  readonly id: GuardId;
  readonly maxReprompts: number;            // 來自 tuning config，不再是 magic number
  check(r: CompletionResult, s: LoopState): { blocked: boolean; feedback: string };
}
// 實作：EmptyResponseGuard、PlanOnlyGuard、MultiToolGuard
```

`PlanOnlyGuard` 現依賴英文 regex + 硬編碼中文 escape 判斷「行動型任務」——判斷邏輯封裝在 guard 內部並可注入語言規則表，循環不感知。

### 7.3 QualityGate 統一介面

```ts
export interface QualityGate {
  readonly id: GateId;
  readonly maxRetries: number;
  evaluate(answer: string, ctx: ContextEngine): Promise<GateVerdict>;
  buildFeedback(v: GateVerdict): string;
  buildExhaustedReport(v: GateVerdict): string;
}
```

- `VerifierGate` 在 `Agent` 組裝時建構一次（持有 provider 引用），不再於循環熱路徑 `new VerifierAgent`。
- Verifier 從「嵌在循環中段的特例分支」變成 gates 陣列的一員；未來加 SecurityGate 等不再動循環。

### 7.4 FailurePolicy

`FailureTracker` 的「重複呼叫阻擋」與「進度版本追蹤」拆為策略介面：

```ts
export interface FailurePolicy {
  shouldBlock(call: ToolCall): { blocked: boolean; reason: string };
  recordResult(call: ToolCall, result: ToolResult): void;
}
```

預設實作保留現行為（同名同參失敗且無進度則擋），但「什麼算進度」由工具 metadata（§8）宣告，不再由循環特判 shell/read-only。

### 7.5 AgentEvents

```ts
export interface AgentEventSink {
  emit(event: AgentEvent): void;   // step_started | response_received | tool_executed
}                                  // | guard_blocked | gate_verdict | compaction | warning | completed
```

- 循環內所有 `console.log` 移除，改為 emit。
- `ConsoleRenderer` 是預設 listener（CLI 行為不變）；headless 嵌入時換成自定 sink；測試時用 capture sink 斷言行為。
- 這也是日後 streaming UI、metrics、audit log 的掛載點，本次只建匯流排不做這些消費者。

## 8. ToolExecutor 與工具 metadata 自宣告（部分已落地）

`AgentTool` 增加 `effects` metadata，刪除 `READ_ONLY_LOCAL_TOOL_NAMES` 硬編碼 Set：

```ts
export type ToolEffects = {
  readOnly: boolean;             // 純讀取，可平行批次
  modifiesWorkspace: boolean;    // 取代循環內 call.name === "apply_patch" 嗅探
  isShell: boolean;              // 取代 isShellTool(name) / getShellExitCode 的名稱特判
  countsAsProgress: boolean;     // FailurePolicy 用；= !readOnly && !isShell
};
```

**已落地（Stage 1）：**
- `src/tools/toolEffects.ts` 為單一事實表 `TOOL_EFFECTS`；`createLocalToolRegistry` 啟動時呼叫 `validateToolEffects(LOCAL_TOOL_NAMES)`，缺項或矛盾組合（readOnly 同時 modifiesWorkspace/isShell/countsAsProgress）即擲錯——關閉「漏加就靜默變 mutable」footgun。
- `tests/toolEffects.test.mjs` 鎖住分類與歷史 read-only 集合逐一相符。

**待 Stage 2：**
- 循環改讀 `effects`（移除 `apply_patch` / `isShellTool` 名稱嗅探）。
- 效果內聯回各工具定義、`makeTool` 不給預設值（漏寫即編譯錯）；目前以集中表 + 啟動驗證達成等效安全，內聯留待換骨架時一併做。
- JSON Schema / Zod 雙重定義收斂：`makeTool` 只收 Zod，JSON Schema 自行從 Zod 生成（xAI 走直 HTTP，不用特定 SDK helper，見 §4.3）。

## 9. Sandbox 集中強制

### 9.1 檔案 I/O 單一入口

```ts
class WorkspaceSandbox {
  open(rel: string, intent: "read" | "write"): SandboxedPath;  // 唯一取得路徑的方式
}
// SandboxedPath 是 branded type：建構即完成 resolve + realpath + allow/deny 檢查
// 所有 fs 呼叫只接受 SandboxedPath，工具拿不到裸 string 路徑
```

- 路徑正規化收斂到一處（現分散在 `normalizeRel` / `relative` / `resolvePath` 三處且邏輯有差），統一處理大小寫不敏感（Windows）、分隔符混用、symlink。
- 拒絕行為統一：一律擲 `SandboxViolationError`，不再有「搜尋工具靜默跳過、讀取工具擲錯」的不一致。
- **`.grok-code/.trash/` 加入 sensitive deny 清單**（同 `.git`/secrets）：模型不可讀/改/刪快照備份——§9.6 安全網的前提。
- **破壞性寫入單一邊界**：`unlink`/overwrite 經 SandboxedPath 的破壞性方法，先觸發 §9.6 快照再執行；工具拿不到繞過的裸 fs 操作。

### 9.2 執行逃逸防護（含 run_python）

任意程式碼執行工具（不論 shell 或 Python）**無法完美沙箱化**（本質限制）。做到：

1. 執行前靜態掃描引用的絕對路徑與 `..` 跨界引用，命中 deny 規則即按 approval 升級風險等級（而非靜默放行）；
2. 工作區外的可疑寫入無法可靠偵測——明確記入已知限制，並在 approval 提示標示「執行工具不受路徑沙箱保護」。

誠實標示邊界比假裝有保護更安全。**`run_python` 同樣適用此限制**（見 §9.4）。

### 9.3 執行層中介

`ToolRegistry.execute()` 包一層 middleware：每次工具執行 emit `tool_executed` 事件（含 sandbox 決策），為日後 audit log 留鉤子。

### 9.4 run_python：取代 run_shell（已定案，待實作）

**決策（用戶）：** `run_python` **完全取代** `run_shell`。

**動機（用戶確認「以上皆是」）：**
- **跨平台一致性（首要）**：本項目跑 Windows/PowerShell，模型慣寫的 bash 常跑不動。Python（`pathlib`/`subprocess`/`json`）三平台行為統一。
- **結構化與表達力**：複雜邏輯一次完成，輸出好捕捉。
- **安全為輔**：注意 **Python ≠ sandbox**——`subprocess`/`os`/`open`/網路一樣全開。光換 Python 不提升安全；真要受限需另案（受限解釋器／容器／seccomp）。

**設計要點：**
- 工具介面：`run_python({ code: string, timeoutMs? })`，於工作區 `cwd` 下執行（`python -c` 或暫存 `.py`），捕捉 stdout/stderr/exitCode；`effects = { readOnly:false, modifiesWorkspace:false, isShell:true, countsAsProgress:false }`（沿用 shell 的 exit-code 即有效失敗語義；`isShell` 旗標改名語義上涵蓋「退出碼決定成敗的執行工具」）。
- **外部程序不消失**：git/npm/tsc 等經 Python `subprocess.run([...])` 呼叫——沒有消滅 shell-out，只是包進 Python。「完全禁 bash」實務上 = 禁直接 bash、改 `subprocess`。
- **依賴**：需 Python 在 PATH。`inspect_environment` 應偵測並在缺失時給明確錯誤；config 可指定 `pythonPath`。
- **RiskClassifier 重新設計（連帶必做）**：現分類器對 shell 命令字串做 regex。任意 Python 程式碼幾乎無法可靠 regex 分類（`__import__('os').system(...)`）。風險審批模型需改為：掃描程式碼中的 `subprocess`/`os.system`/網路/檔案寫入等危險呼叫並升級審批，而非試圖完整解析語義。此項與 §12「RiskClassifier 資料驅動化」合併考量。
- **prompt 連帶**：系統提示與 tool-skill 需改寫成引導模型用 Python（含「外部命令走 subprocess」），移除 bash 範例。

### 9.5 read-before-write 強制（防幻覺，已定案待實作）

**決策（用戶）：** 模型要修改既有檔案的某區域，**必須先讀過該區域**；不准在沒讀的情況下盲改。且要確保被改的內容**確實存在於記憶上下文**中。硬強制於執行前置檢查，非僅 prompt 提示。

**核心原則：前置證據與操作的失敗模式成比例。** 不是一律要求讀內容——那會把無關內容灌進模型造成污染與浪費。

| 操作 | 失敗模式 | 要求的證據 |
|---|---|---|
| `modify` | 幻覺內容 | 被改**行範圍**已讀且快照新鮮（region-level，非整檔） |
| `create` | 無 | 無（無既有內容） |
| `delete` | 刪錯檔（身份錯） | **存在性 provenance**：曾出現於 list_files / search / get_file_overview / git_status——**不讀內容** |

**機制（modify）：**
1. 編輯工具執行前，從 patch hunks 取被改原始行範圍：`[hunk.oldStart, hunk.oldStart + hunk.oldLines - 1]`（`diff` 的 `parsePatch` 提供）。
2. 呼叫 `ContextEngine.uncoveredForWrite(path, ranges)`（§6.6）。
3. 回傳非空（有未讀或 stale 範圍）→ **拒絕**，feedback：「修改 `<path>` 前必須先用 `read_file_range` 讀取第 X–Y 行」。
4. 套用成功後 `ContextEngine.invalidateReads(path)`——下次編輯同檔前須重讀（防依過期記憶再盲改）。

**機制（delete）：**
- 呼叫 `ContextEngine.hasFileExistenceEvidence(path)`（存在性索引，由 listing/search/overview/status 餵入）；無 → 拒絕，feedback：「刪除 `<path>` 前請先 `list_files` 或 `get_file_overview` 確認該檔」。
- **不要求讀取內容**——刪檔風險是身份不是內容；一行 listing 即足夠，避免拉全檔污染。
- 既有 delete 已觸發 approval "ask"，與此互補（機器防身份幻覺 + 人工最終確認）。

**污染防護（回應「過多無關上下文寫入模型」的顧慮）：**
- modify 只需讀**改到的區域**，非整檔；模型寫 diff 本就需要該段 context，前置條件與其自然行為一致，無額外負擔。
- 即使讀入，§6.2 可重取項目在預算壓力下內容被**指標化降級**（從模型輸入移除），而 §6.6 的 `FileReadRecord`（path/range/hash）作為旁路索引保留——「為滿足前置條件而讀」不會永久膨脹模型輸入，freshness hash 仍在、檢查照常。

**雙重保證疊加：** `diff` 套用時本就比對 context 與**磁碟**（不符則 false）；本機制再加比對**記憶快照**（§6.6 contentHash），堵住「盲猜 patch 剛好套得上磁碟」的幻覺缺口。
- **與 run_python 的已知限制**：`run_python` 可經 `open()`/`subprocess` 直接寫檔，**繞過**本前置檢查與 invalidation（同 §9.2「執行工具 ≠ sandbox」）。緩解：(a) prompt 明確引導「檔案編輯一律走 `apply_patch`，勿用 Python 直接寫檔」；(b) 每次 `run_python` 執行後，依 git status 偵測到變動的檔案保守地 `invalidateReads`，使後續編輯被迫重讀。無法完美攔截，明確記為限制。

**落點：** 屬編輯工具的執行前置條件，背靠 §6.6 的 ContextEngine 查詢。實作依賴 ContextEngine 的 read-provenance 追蹤（Stage 1 ContextEngine）+ 編輯工具接線（Stage 2）。是 verifier（§7.3，事後審計）之外的**事前**防幻覺控制，兩者互補。

### 9.6 WorkspaceSnapshotStore：類 git 的破壞性操作復原（已定案待實作）

**決策（用戶）：** 破壞性操作前先備份被影響檔案，保留數輪，模型誤刪/破壞時可還原，不會「直接完蛋」。是 read-before-write（§9.5，事前防呆）之外的**事後可復原**層。

**範圍（用戶：所有突變都快照）：** 每次 `delete` 與 `overwrite`（`apply_patch` 寫檔）執行前，快照被影響檔案的 **pre-image**。`create` 記 tombstone（無 blob，op=create），使還原能「撤銷建立」=刪除該新檔。等同對最近數輪的每筆編輯都有本地 undo 歷史。

**保留（用戶：按 agent step／輪）：** 滑動視窗＝最近 `M` 個 agent step（`tuning.snapshot.retainSteps`，預設 30）。SnapshotStore 持有**持久化的單調 round 計數器**，使視窗跨 session 連續（新 session 不會立刻清掉昨天的快照，除非已累積 M 輪新的破壞性活動）。另設**總大小硬上限**（`maxTotalBytes`）與筆數上限為 backstop，超出淘汰最舊。

**結構：**
```
.grok-code/.trash/
  manifest.json        // [{ id, path, op, round, sessionId, ts, sha, bytes }]
  blobs/<sha>          // 內容定址，相同內容去重
```

**關鍵安全規則：**
- `.grok-code/.trash/` **必須 gitignore + 加入 sandbox deny（§9.1）**——模型讀不到、改不到、刪不到自己的安全網。否則失控的模型連備份一起清，網就破了。**這條是本機制成立的前提。**
- **還原是人工/操作者控制**：CLI `grok-code trash list` / `grok-code restore <path|id>`。**模型不給還原或清備份的工具**——它是闖禍者，不該能動安全網。工具輸出附「已備份 round=R id=…」。
- 還原衝突（目標路徑已存在）：還原到 `<path>.restored` 旁置或由 CLI 互動處理。

**與 git 互補：** 已 commit 的 tracked 檔可 `git checkout` 還原；本 trash 對**未追蹤 / 未 commit / 非 git 工作區**才是救命的——正是 git 救不了的情況。內容定址去重讓「每次編輯都快照」的成本可控（未變部分不重存）。

**誠實邊界：** `run_python` 用 `os.remove`/`open(...,'w')` 直接動檔會**繞過**快照（同 §9.2）。緩解：(a) prompt 引導破壞性檔案操作走工具；(b) `run_python` 執行後依 git status 偵測變動檔，對「快照時未先備份」者事後補記警告。無法完美攔截，明確記為限制。

**落點：** 掛在 §9.1 的破壞性寫入單一邊界（`SandboxedPath` 的 unlink/overwrite 路徑），所有結構化破壞性操作自動經過，不靠各工具自覺呼叫。實作於 Stage 2（與 SandboxedPath 集中化、編輯工具接線一起）。

## 10. 配套變更

| 項目 | 變更 |
|---|---|
| Config | `GrokCodeConfig` 改 Zod schema 定義 + parse（Zod 已是依賴）；錯誤值報具體訊息而非靜默 fallback；刪除 `conversationMode` / `hybridResetAfterTurns` / `hybridResetAfterFailures` |
| Session | 增加 `version: number` + 載入時 Zod 驗證 + `migrate()`；純 stateless 下 resume 語義完整（context items 即全部狀態，無 chain 可丟） |
| Agent 建構 | 建構子去副作用（不掃 repo）；`Agent.create()` 靜態工廠執行顯式 `initialize()`；CLI 的 `{} as any` hack 隨之消除 |
| CLI | 六個子命令收斂為宣告式表（task 模板 → 統一 `runOneTask`）；新增 `trash list` / `restore <path\|id>`（§9.6 還原，人工控制） |
| Tuning | 新 `src/config/tuning.ts`：所有 magic numbers 集中，可被 `.grok-code/tuning.json` 覆寫；含 `snapshot`（retainSteps / maxTotalBytes，§9.6） |
| Sandbox deny | `.grok-code/.trash/` 加入 sensitive deny（§9.1），保護 §9.6 快照不被模型竄改 |

## 10.1 交付狀態（2026-06-11，全部完成）

全部階段已實作，套件 **115 測試綠**（2 個 symlink 在 Windows 跳過）。實作中為控管風險所做的務實取捨（與純設計的差異，誠實記錄）：

- **#3 Zod 單源（§8）**：未「從 Zod 生成 JSON schema 取代手寫」——因生成的 schema 無法在本環境對實打 xAI API 驗證，風險過高。改為 `makeTool` 啟動時 `assertSchemaMatchesZod` 斷言兩者（屬性名 + required）一致，**漂移即 fail-fast**。達成「兩份定義不會分歧」這個真正目標；完整單源化待能對實 API 驗證後再做。
- **#2 SandboxedPath（§9.1）**：交付 `SandboxViolationError` 統一拒絕型別 + `.trash` deny + 破壞性寫入邊界快照（經 apply_patch）。強制本就集中在 `assertReadableFile`/`assertWritablePatchPath`（所有檔案工具都走它）。完整 branded `SandboxedPath` 型別（禁止工具拿裸字串）屬型別安全 gold-plating，未做。
- **ContextEngine 作為 live store**：為避免一次性遷移 21 個工具的 `context.add`，保留 `ContextManager` 為主存儲；ContextEngine 作為 read/existence provenance 旁路（背 #6）與壓縮元件並存。全面取代 ContextManager 留作後續。
- **延後的 cosmetic**：CLI 子命令宣告式表、移除 `conversationMode`（循環已忽略，保留為相容欄位）、Agent 建構子去 scanRepo 副作用（已加 `Agent.create()` 工廠）。

## 11. 重構順序與測試策略

大重構不等於無序：**先立安全網，再換骨架，最後遷移行為**。

```
階段 0 — 安全網（不動產品代碼）✅ 完成
  特徵測試（characterization tests）：
  - AgentLoop：guard 觸發、verifier retry、重複失敗阻擋、maxSteps 終止、empty-response guard ✅
  - ContextManager：淘汰順序、expiry、壓縮輸出 ✅（既有）
  - Sandbox：allow/deny 矩陣、symlink、.env 變體、generated-output profile ✅（既有）
  基線：73 測試（2 symlink 在 Windows 跳過）全綠。

階段 1 — 介面落地（新舊並存）⏳ 進行中
  ✅ src/config/tuning.ts（magic numbers 集中，數值對齊現行）
  ✅ LLMProvider 介面 + XaiResponsesProvider（直 HTTP，§4.3）+ tests
  ✅ AgentTool.effects + TOOL_EFFECTS 表 + 啟動驗證（§8）+ tests
  ☐ ContextEngine（新模組，先實作 §6.1/6.2/6.4 + 無副作用 select + §6.6 讀取 provenance/uncoveredForWrite/invalidateReads）← 下一個
  ☐ SandboxedPath 集中強制（§9.1，用戶安全優先項）
  ☐ Zod 單源 schema（§8）

階段 2 — 換骨架（一次切換）
  新 AgentLoop（LoopState / Guards / Gates / Executor / Events）+ InputBuilder 分層
  循環改讀 effects（移除 apply_patch / isShellTool 名稱嗅探）
  刪除三模式、舊 ContextManager 路徑、舊 openai-SDK 主循環路徑
  run_python 取代 run_shell（§9.4）+ RiskClassifier 重新設計
  read-before-write 強制接線（§9.5）：apply_patch 前置檢查 + 寫入後 invalidateReads
  WorkspaceSnapshotStore（§9.6）：破壞性寫入邊界快照 + .trash sandbox-deny + CLI restore
  特徵測試全綠 = 行為等價的證明

階段 3 — 壓縮系統完整化
  §6.3 LLM 滾動摘要（依賴階段 1 的 provider 介面與階段 2 的攝入管線）
  端到端長任務驗證：cache 命中率（usage.cachedInputTokens）、壓縮觸發正確性

階段 4 — 配套收尾
  Config Zod 化、Session versioning、CLI 收斂、Agent.create()
```

階段 3 排在骨架之後是刻意的：摘要品質問題和骨架行為問題混在一起會無法歸因。
run_python 排在階段 2 是因為它與循環的工具執行/失敗語義（effects、exit-code）綁定，且需連帶改 RiskClassifier 與 prompt。

## 12. 本次不做（記錄但延後）

- **Streaming**：provider 介面已預留 `stream?()` 形狀，實作延後。
- **兩套技能系統統一**：值得做（substring trigger 匹配脆弱、語言綁定），但與本次核心線路正交，獨立成案。
- **RiskClassifier 資料驅動化 + 命令組合解析**：已升級為階段 2 連帶必做項——`run_python` 取代 `run_shell` 後，風險分類對象從 shell 字串變成 Python 程式碼，分類器須重新設計（見 §9.4）。
- **Approval key 加細**（前兩詞 → 全命令 hash）：小改動，可隨手做但不在關鍵路徑。
- **BackgroundProcessManager 超時/資源上限**：獨立小案。
