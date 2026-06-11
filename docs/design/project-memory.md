# 項目核心記憶設計（Project Core Memory）

> 狀態：草案（待 review）
> 日期：2026-06-11
> 關聯：architecture-v2.md（§5.1.1 載重上下文永不壓縮）、subagents-v1.md（主代理維護）

## 1. 目的與定位

跨 run 的**項目核心記憶**：存放**程式碼裡讀不出來、但不能丟**的durable 知識——

- **開發本意（Intent）**：用戶真正要解決的問題 / 這個項目存在的目的。
- **核心假設（Assumptions）**：必須成立的前提；一旦被違反東西就壞。
- **注意事項（Cautions / gotchas）**：地雷、易錯處、flaky 步驟、別踩的坑。
- **關鍵決策（Decisions）**：做了什麼選擇 + 簡短理由（避免日後重新爭論）。
- **慣例（Conventions）**：程式碼看不出來的項目慣例。

定位：**它是「為什麼 / 要小心什麼」，不是「是什麼 / 怎麼做」。**
- 「怎麼做」= skills（程序）。
- 「是什麼」= GROK.md（廣泛項目筆記，learn-project 產生）。
- 「為什麼 / 假設 / 守則」= **核心記憶**（本文件）。

由**主代理（單代理模式下即唯一代理）自己維護**。

## 2. 位置與結構

- **位置**：`.grok-code/memory.md`（藏在項目本地資料夾，符合用戶定案）。
- **是否進版控**：**預設進版控**（核心意圖/假設對團隊有價值，值得共享）；用戶可選 gitignore 設為本地私有。對比：`.grok-code/skills`、`config.json` 進版控；`sessions`、`.trash` 不進。
- **結構**：固定區段，每條一個 entry：
```markdown
# Project Memory

## Intent
- <一句話：項目本意 / 目標>

## Assumptions
- <必須成立的前提>

## Cautions
- <地雷 / 易錯 / flaky>

## Decisions
- <決策 — 為什麼>

## Conventions
- <非顯而易見的慣例>
```
- **儲存實作**（建議）：JSON store `.grok-code/memory.json`（entry: `{ id, section, content, createdAt, updatedAt }`）+ 工具**渲染**人類可讀的 `memory.md`。機器編輯走結構化 JSON、人類讀 md，避免代理直接改 markdown 把格式弄壞。

## 3. 維護

**寫入走專用工具**（不走 apply_patch，保持結構化、避免格式被弄壞）：

| 工具 | 誰可用 | 簽名 | 說明 |
|---|---|---|---|
| `remember` | 主代理 | `{ section, content, id? }` | 新增 entry；給 id 則更新該條 |
| `forget` | 主代理 | `{ id }` | 刪除一條（謹慎；通常是過時/錯誤的記憶） |

- **單一寫者 = 主代理**：保持一致性。**子代理唯讀**（在 preamble 看得到）；子代理若發現值得記的注意事項，用 issue/PR 留言**建議**，主代理判斷後 `remember`（subagents-v1 §4）。
- **低風險、免審批**：記憶編輯是項目筆記，不需 approval；可在輸出標示「已更新記憶：…」讓用戶知道。

## 4. 載入

- 核心記憶**注入 system preamble**（architecture-v2 §5.1.1 的**載重上下文，永不壓縮**那一層）——每個 run、每個代理都看得到。
- 量小（幾條 bullet），多代理下放進所有代理的 preamble 成本低且重要（worker 該知道 cautions/conventions）。
- 它和 `user_task` / `repo_summary` / GROK.md / skills 同屬穩定前綴，prefix-cache 友善。

## 5. 與既有的關係

| 既有 | 角色 | 與核心記憶的界線 |
|---|---|---|
| `GROK.md`（root） | 廣泛項目筆記（結構、指令、慣例） | 核心記憶更聚焦、藏在 `.grok-code/`、且是 intent/假設/守則 |
| `.grok-code/skills` | 程序 SOP | 核心記憶是理由/守則，不是步驟 |
| ContextEngine（per-run） | 單次 run 的工作記憶，會壓縮/過期 | 核心記憶**跨 run durable**、永不壓縮 |
| subagents-v1 看板 | 單次 run 的協調 | 核心記憶是跨 run 的項目知識 |

## 6. 紀律（什麼該記 / 不該記）

借用成熟 memory 系統的紀律（與 Claude Code 的 CLAUDE.md/memory 同精神）：

**該記**：用戶明示的意圖/偏好/約束；非顯而易見的假設；會咬人的 gotcha；關鍵決策 + 理由。
**不該記**：
- 程式碼/git 歷史已記錄的（結構、過去的修法）。
- 只跟當前 run 有關的一次性細節。
- 推測未確認的「事實」（標為假設或別記）。
**存前先查重**：更新既有 entry，而非堆重複。**發現記憶過時/錯誤就 `forget`**。

## 7. 風險與取捨

- **記憶腐化/膨脹**：代理可能記太多或記過時。對策：紀律（§6）+ 定期由主代理 review/精簡；entry 有 `updatedAt` 可偵測陳舊。
- **錯誤記憶污染**：一條錯假設會誤導後續所有 run。對策：`forget` 隨手清；可選在更新時於輸出標示讓用戶把關。
- **與 GROK.md 重疊**：靠位置（hidden vs root）+ 用途（intent/假設 vs 廣泛筆記）區分；必要時互相 cross-ref。

## 8. 接點與實作

- **新元件** `ProjectMemory`（`src/memory/`）：load/render/remember/forget；JSON store + 渲染 md。
- **載入**：`Agent` 建構時讀 `.grok-code/memory.json`，注入 system preamble（與 GROK.md/skills 同處）。
- **工具**：`remember` / `forget` 進 registry（effects: 非 readOnly、modifiesWorkspace=false、countsAsProgress=true）；限主代理。
- **CLI**（可選）：`grok-code memory` 列出、`memory edit` 人工編輯。

實作階段：小，獨立可做。先 `ProjectMemory` + 工具 + 注入 + 單元測試（load/remember/forget/render），再接主代理。可在子代理系統之前或之後做，互不阻塞。
