# 子代理系統設計（Sub-Agent Orchestration v1）

> 狀態：草案（待 review）
> 日期：2026-06-11
> 依賴：architecture-v2.md（transcript 迴圈、AgentLoop、ContextEngine、LLMProvider、apply_patch、read-before-write、snapshot 都已落地）

## 1. 目標與定位

把單代理升級為**主代理編排 + 多子代理並行執行**，透過**本地 GitHub-shaped 協作看板**（Issue/PR/Comment + 私訊）協調。

- **主代理（Orchestrator）**：唯一的狀態擁有者。用 issues 維護工作項，用工具生成子代理、**親自撰寫每個子代理的 system prompt（角色）**、在 issue/PR 串派工與審查（review/merge）。**自己不直接編輯檔案**，只指揮。
- **子代理（Worker）**：拿主代理寫的角色 prompt + 標準安全骨架，在 issue/PR 串與私訊裡可**持續與主代理及其他子代理討論**，在自己的 git worktree 做實際工作（讀/搜/apply_patch/run_python），就緒時開 PR。**任務 merge 後自動刪除**。
- **協作看板**：Issue（=工作項/plan）、PR（=合併 + review gate）、Comment（=討論串）、@mention、私訊側管道。
- **並行**：多個子代理可同時活動，各自 git worktree 隔離（§7.2）。

定位語：**看板承載協調（decisions / status / 派工），git 工作區承載資料（檔案內容）。** 這條線是整個 token 效率的根。

## 2. 已定案的決策

| 項目 | 結論 | 理由 |
|---|---|---|
| 編排模型 | 主代理只維護 plan/狀態、用指派子代理推進，不自己動手 | 關注點分離；plan 變成編排骨幹 |
| 並行 | 多子代理並行執行，**每個寫檔子代理一個 git worktree 隔離**，主代理 merge（§7.2） | 用戶定案；git 分支把 race 轉成可解的 merge conflict |
| 子代理生命週期 | 任務範圍內可持續對話；**任務完成即自動刪除** | 只有在工作的代理持有 context，死掉的釋放 → 有界 token |
| 子代理 prompt | 由主代理親自撰寫（角色），系統套安全骨架 | 彈性編排；安全不交給模型 |
| Token 策略 | **重新安置 + 引用，取代複製 + 內聯**（§6） | 並行下不損失資訊地省 token（用戶研究點） |
| 協調模型 | **本地 GitHub-shaped**：Issue（=plan）/ PR（=merge gate）/ Comment（=討論串）+ 私訊側管道（§4） | 借 GitHub 概念；串綁定天然過濾 context、PR 給 review gate |

## 3. 架構總覽

```
Orchestrator (AgentLoop + 編排 system prompt + 編排工具)
  狀態：issue tracker（open issues = 待辦）
  工具：spawn_agent, open_issue, assign_issue, comment, review_pr, merge_pr, close_issue, send_dm
        + 唯讀工具（git_status/diff/read 以掌握全局，但不 apply_patch）
        │
   協作看板（Issue / PR / Comment + 私訊 + artifact 引用；每代理串綁定視圖）
        │
  ┌─────┴─────┬───────────┐
 Worker A    Worker B    Worker C        ← 並行，各自 AgentLoop + 隔離 context
  worktree A  worktree B  worktree C     ← 各自 git worktree/分支，物理隔離檔案樹
  工作工具(read/search/apply_patch/run_python) + comment/open_pr/send_dm
        │
   git 整合分支（主代理 merge 各子代理分支） + 共享 .git object store
```

**重用既有元件**：每個代理就是一個 `AgentLoop` 實例（已經各自有 transcript）。看板視圖像 system preamble 一樣注入該代理 transcript。GitHub 動詞工具（open_issue/comment/open_pr/...）只是工具。Provider/ContextEngine/壓縮/apply_patch/snapshot 全部沿用。地基已在。

## 4. 協作看板（本地 GitHub-shaped）

借用 GitHub 概念，在**本地真 git**（branch/worktree）之上，用 in-process 的 **Issue / PR / Comment** 存儲做協調。無網路/auth/rate-limit；可選之後再匯出到真 GitHub。**保留私訊側管道**。

### 4.1 資料模型
```ts
type AgentId = string; // "orchestrator" | worker name
type Comment = { id: string; author: AgentId; body: string; mentions: AgentId[]; refs?: string[]; round: number };

type Issue = {                       // = 工作項；issue tracker 就是 plan
  number: number;                    // #1, #2 ...（issue 與 PR 共用編號空間，同 GitHub）
  title: string; body: string;
  author: AgentId; assignees: AgentId[]; labels: string[];
  status: "open" | "closed";
  comments: Comment[];
};

type PullRequest = {                 // = 提議合併 + review gate
  number: number;
  title: string; body: string; author: AgentId;
  branch: string; base: string;      // source 分支 → 整合分支
  linkedIssue?: number;
  status: "open" | "merged" | "closed";
  reviews: { by: AgentId; verdict: "approve" | "request_changes" | "comment"; body: string; round: number }[];
  comments: Comment[];
};

type DirectMessage = { id: string; from: AgentId; to: AgentId; body: string; refs?: string[]; round: number };
```
看板 = `{ issues, prs, dms }`，存記憶體（可持久化到 `.grok-code/board.json`）。

### 4.2 每代理視圖（token 效率第一槓桿 —— 結構即過濾）
代理 X 的 context 注入：
- **指派給 X 的 open issues** + 其討論串；X 作者/reviewer 的 **PRs** + 其串。
- 任何串中 **@mention X** 的留言。
- 與 X 相關的 **DM**（to/from X）。
- 一份**精簡索引**：所有 open issue/PR 的「#號 + 標題 + 狀態 + assignee」（讓 X 知道全局，但不載入每條串）。

→ X **不**載入別人 issue/PR 的完整討論串，只看索引。**討論綁在 issue/PR 上的串本身就是 token 過濾器**，比扁平房間 + 定址更省、更有條理。

### 4.3 私訊側管道
`send_dm({ to, body, refs? })`：issue/PR 公開串之外的代理對代理私訊，只進收發雙方視圖、不進公開串。用於不需公開的側協調；公開討論仍優先走 issue/PR 串（透明、可審計）。

### 4.4 artifact 引用（取代內聯大資料）
大輸出（檔案內容、命令輸出）不貼進留言，而是存進 artifact store 拿 id，留言/DM 帶 `refs:[id]`。需要者 `fetch_artifact(id)` 取（§6.2 可重取降級同精神）。資訊不丟，只是不複製到每個視圖。

## 5. 子代理生命週期（issue → PR → merge → dissolve）

```
主代理 open_issue(#N) → spawn_agent(name, role, brief) + worktree → assign_issue(#N, name)
   → worker 在自己的 worktree 工作；在 #N 串 comment 討論、可被 @mention、可 send_dm
   → worker open_pr(branch, linkedIssue:#N)        ← 完成信號
   → 主代理/reviewer review_pr：
        request_changes → worker 在同分支/PR 迭代
        approve → 主代理 merge_pr
   → merge 成功 → auto-close #N + git worktree remove + dissolve worker（釋放 transcript）
```

**關鍵**：dissolved worker 的 transcript 被釋放，只留下 **PR（diff + review 串）與 closed issue** 作為紀錄。→ 並行的活躍 context 上限 = 同時在工作的 worker 數，不是歷史總數。任務範圍內 worker 全程可在串/DM 討論（符合用戶定案）。

## 6. Token 效率：不損失資訊地省（核心研究點）

原則一句話：**重新安置 + 引用，取代複製 + 內聯。** 資訊不刪，搬到便宜處並用 id 引用，需要時 fetch。五個槓桿：

1. **子代理 context 隔離（最大槓桿）**：子代理**不**拿主代理的全局 issue tracker、也不拿其他代理的工作 transcript——只拿**聚焦 brief** + 指派給它的 issue/PR 串 + @自己 + 自己的 DM。編排者的大 context 只留在編排者身上，不複製進每個 worker。（這也是 Claude Code Task 子代理的做法：子代理拿 prompt、回傳結果，不共享父代理全 context。）
2. **協調 / 資料分離**：看板留言只放決策、狀態、派工（小）；**檔案資料留在 git 工作區**，代理直接讀寫，按需 fetch。留言不做資料傾倒。
3. **串綁定過濾（§4.2）**：代理只載入指派給它的 issue/PR 串 + @自己 + 自己的 DM + open 項精簡索引；別人的串不載入。結構即過濾。
4. **artifact 引用（§4.3）**：大輸出引用而非內聯，fetch-on-demand。
5. **結構化摘要交接**：子代理回報用 **PR body 的結構化摘要**（§6.3 EpisodeSummary 形狀）+ diff，不是整段 transcript。主代理累積的是 PR/issue 紀錄。

加上既有的**每代理 transcript 壓縮**（§6.3）與**事件驅動排程**（§7.1，沒被點到的代理不跑＝不花 token）。

效果量級：naïve 多代理 ≈ N × (全局看板 + 各自 context)；本設計把看板留言壓到「只協調」、子代理 context 隔離且只載入自己的串、idle 代理不跑 → 成本接近 Σ(各代理自己聚焦工作) + 一份小看板索引，而非 N 倍放大。

## 7. 並行執行與排程

### 7.1 事件驅動 group-chat 排程
- 維護「活躍代理」集合。每個排程 tick：**只喚醒有新留言/@mention/DM 待回應、或正在執行任務中的代理**，這些代理**並行跑一回合**（`parallel()`），各自在看板留言、開 PR、或發 tool call。
- idle（沒被點到、無進行中工作）的代理**不跑** → 不花 token。
- 主代理也是參與者：它讀看板，open_issue/spawn/assign/review/merge。
- 全程結束條件：主代理判定 plan 全部 completed → 收尾。

### 7.2 並行隔離：每個子代理一個 git worktree（已定案）

**決策（用戶）：並行直接利用 git 分支。** 把「並行寫衝突」從無法偵測的 runtime race，轉成 git 可偵測、可解的 merge conflict。

機制：
1. **整合分支**：run 開始時主代理從乾淨 HEAD 建整合分支 `agents/run-<id>`（先 commit/stash 用戶未提交變更，記錄基準）。
2. **每個會寫檔的子代理 = 一個 git worktree + 自己的分支**：`git worktree add <dir> -b agents/run-<id>/<name> agents/run-<id>`。該子代理的 `WorkspaceSandbox.root` 指向**它自己的 worktree 目錄**——所有讀/apply_patch/run_python/build/test 都在隔離的檔案樹裡。**物理上不可能與其他代理 race。**
3. **完成即 commit + PR**：子代理 `open_pr` 時，系統把它 worktree 的變更 commit 到它的分支，並建立 PR（含結構化摘要 + diff）。
4. **主代理 merge**：子代理回報後，主代理把其分支 merge 進整合分支。
   - 乾淨 → 標記 plan 項 completed、`git worktree remove`（dissolve）。
   - **衝突** → 主代理處理：指派一個 resolver 子代理、或叫衝突雙方在 PR 串協調、或序列化重做。衝突是**顯式的**（git 明確告訴你哪些檔/區段），可處理。
5. **最終結果**：整合分支持有合併後的工作；主代理把它呈現為乾淨 diff / merge 回用戶分支。

**分工不重疊仍有價值**（但降級為最佳化，非正確性要求）：主代理把 plan 切成檔案/區域盡量不相交的子任務 → 減少 merge 衝突、更順。但即使重疊，git 也會擋住、給出可解的衝突，而不是靜默損壞。

**worktree 內各自驗證**：每個子代理能獨立 build/test 自己的 worktree → 並行驗證天然可行。

**前提與退化**：需要工作區是 git repo。非 git → 退化為序列執行（無並行隔離），或 `git init` 一個臨時 repo。`inspect_environment` 已偵測 git 可用性。

**與 snapshot（§9.6）的關係**：git 分支提供多代理場景的主要隔離與復原（branch/revert）；snapshot 仍用於非 git 工作區與 worktree 內的逐步 undo，兩者互補。merge 由主代理執行（git 三方合併），不受 read-before-write 約束。

### 7.3 預算與防失控
- `maxConcurrentAgents`、`maxTotalAgents`、`maxTotalAgentTurns`、每代理 `maxSteps`。
- 互相 @tag 的無限循環：總回合預算 + 「同一對代理連續往返 N 次無 plan 進度」即由排程器介入。

## 8. 工具（GitHub 動詞）

| 工具 | 誰可用 | 簽名 | 說明 |
|---|---|---|---|
| `spawn_agent` | 主代理 | `{ name, role, brief, tools? }` | 生成子代理 + worktree；`role`=主代理寫的角色 prompt（套安全骨架）；`brief`=聚焦說明 |
| `open_issue` | 全部 | `{ title, body, assignees?, labels? }` | 開工作項；主代理為 plan 子任務開，worker 可開（blocker/bug） |
| `assign_issue` | 主代理 | `{ number, assignees }` | 指派 issue 給子代理 |
| `comment` | 全部 | `{ on:"issue"\|"pr", number, body, mention?, refs? }` | 在串上留言 |
| `open_pr` | 子代理 | `{ title, body, branch, linkedIssue? }` | 工作就緒，提議合併（= 完成信號，取代 complete_task） |
| `review_pr` | 主代理/reviewer | `{ number, verdict:"approve"\|"request_changes"\|"comment", body }` | 審查 |
| `merge_pr` | 主代理 | `{ number }` | git merge 分支→整合分支；成功則 auto-close linked issue + dissolve 作者 |
| `close_issue` | 主代理 | `{ number }` | 關閉工作項 |
| `send_dm` | 全部 | `{ to, body, refs? }` | 私訊側管道（§4.3） |
| `fetch_artifact` | 全部 | `{ id }` | 取引用的大資料 |

完成信號：worker 不用 `complete_task`，改**開 PR**；主代理 review→merge 即代表任務完成。
安全骨架：子代理 system prompt = 我方標準前綴（工具規則、sandbox、看板規則、read-before-write）+ 主代理寫的 `role`。主代理控制**角色**，不控制安全。

## 9. 與既有系統的接點

- **AgentLoop**：泛化為「一個代理一個迴圈實例」，建構時注入 `board` 與 `agentId`；每步輸入 = system preamble（含角色）+ 看板視圖（自己的 issue/PR 串 + @自己 + DM + open 索引）+ 自己的 transcript。
- **plan → issue tracker**：先前的 plan/update_plan 在這裡**被 issues 取代**——open issues = 待辦、closed = 完成。收尾 gate = 「還有 open issue 就不准結束」，內建在主代理迴圈。
- **read-before-write / snapshot / sandbox**：**每代理在自己的 worktree 內各自生效**（子代理 B 用 B 自己的 ContextEngine + sandbox root=worktree B 先讀後寫）——天然安全，且檔案物理隔離。
- **git**：新增 worktree 生命週期管理（建/移除）、整合分支、merge 與衝突處理；經 run_python 的 subprocess 呼叫 git，或一個專用的內部 git 服務層。
- **ContextEngine 壓縮**：每代理 transcript 各自壓縮。

## 10. 風險與取捨

- **複雜度**：這是把產品升級成多代理框架，是大工程。並行 + 共享工作區是最難的部分（§7.2）。
- **成本**：即使有 §6 的節流，多代理仍比單代理貴；主代理應**只在任務夠複雜/可分工時才 spawn**（簡單任務單代理做完即可）。
- **並行寫衝突**：用 git worktree 隔離（§7.2），race 不再發生；殘留的是 **merge conflict**，顯式且可解（主代理指派 resolver / PR 串協調 / 序列化）。代價：worktree 建立/移除開銷（每代理數百 ms + 磁碟）、需要 git repo（非 git 退化為序列）。
- **merge 品質**：自動 merge 衝突的解決依賴主代理或 resolver 子代理；複雜衝突可能需序列重做。
- **主代理寫壞子代理 prompt**：安全骨架保底，但角色品質依賴主代理；可給 role 範本降低變異。
- **可觀測性**：看板（issues/PRs/留言）是天然的 audit log，且可選匯出到真 GitHub 給人類看；事件系統（architecture-v2 §7.5）可把多代理活動串出來。

## 11. 本次不做（記錄）
- 跨 session 的代理持久化（代理只活在單次 run）。
- 巢狀 spawn（子代理再 spawn 子代理）——v1 只允許主代理 spawn，避免樹狀失控。
- 人類即時介入看板（在 issue/PR 留言指揮）——先做全自動，介入留後續。
- 匯出本地看板到真 GitHub（issues/PRs）——本地為主，真 GitHub 同步留後續。

## 12. 實作階段（待 review 後）

```
階段 0 — 安全網
  協作看板（Issue/PR/Comment/DM 資料模型 + 串綁定視圖 + artifact）、排程器、預算 的單元測試（不接 LLM）。
階段 1 — 骨架（先序列驗證再開並行）
  AgentLoop 注入 board+agentId；GitHub 動詞工具（open_issue/comment/open_pr/review_pr/merge_pr/...）；
  主代理迴圈（讀看板 → open_issue/spawn/assign → review/merge → 收尾 gate：還有 open issue 不准結束）。
  先以「一次喚醒一個」跑通 issue→PR→merge 流程（並行先關），驗證看板/串視圖/生命週期正確。
階段 2 — 並行（git worktree）
  git 服務層（worktree 建/移除、整合分支、commit、merge、衝突偵測）+ 單元測試（真實 temp git repo）。
  事件驅動 parallel 排程：每子代理一個 worktree、完成 commit、主代理 merge、衝突處理。
  §6 token 節流（隔離/引用/摘要交接）。
  端到端：用一個可分工的多檔任務驗證並行隔離、merge 乾淨、token 不爆；再用一個故意重疊的任務驗證 merge 衝突被正確偵測與處理。
階段 3 — 打磨
  預算/防失控、可觀測性（事件）、role 範本。
```
