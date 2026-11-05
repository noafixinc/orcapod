# SPEC-INCIDENT-REMOVAL-001: incident 層の削除と failed Run の Attention モデル

## 1. 依頼内容

orcapod の incident 層（失敗経路の問題解決サブシステム: `investigate` / `approve` / `incident` コマンド、調査・適用の子 Run、提案の承認）を削除し、failed Run の扱いを「Orca のタブが開いている間だけ monitor の Attention に出す」モデルに戻す。

確定要件:

- `src/incidents.ts` / `src/incident-contract.ts` / `src/approval.ts` / `src/incident-prompt.ts` と対応テスト 3 ファイルを削除し、全参照を外す。CLI から `incident` / `investigate` / `approve` を消す
- failed Run は `phase.tabClosed` が false の間だけ Attention に出る（hint `→ orcapod stop <id>`）。タブが閉じると Recent に移る。`status` の `Unresolved` 節は消し、failed は Recent に summary 付きで出る現状のまま
- 判断待ちで止まる場合も `failed` のまま（運用判断として確定）。全 prompt の末尾指示の failed の説明に「summary に理由と、人間がこの失敗を解消するための具体的な次のアクションを書く」を足す。`prompts/` 配下のユーザー prompt ファイルは変更しない
- failed の通知は既存の `failed:<run.id>` 通知（`src/tick.ts:553`）をそのまま使う。追加しない
- 既存 `state.json` の Run が持つ `incident` / `recovery` / `recoveryResult` は読み込み時に除去する。`recovery` を持ち未完了（done / failed / aborted 以外）の Run は読み込み時に `failed`（reason `incident layer removed; the run was not finished`、`tabClosed` は元 phase が queued のとき true、それ以外は false）にする。削除後に通常 prompt で誤起動する経路を塞ぎ、タブが残っていれば既存の failed 追跡と `orcapod stop` で閉じられる。完了済みの旧子 Run（kindName `Incident investigation` / `Approved fix`）は通常の履歴 Run として残す
- `pnpm check`（typecheck → lint → test）を通す。ブランチ `chore/remove-incidents`、main への PR

背景: incident 層は 8 件の incident・11 件の子 Run を生み、適用されたコード修正は 0。現在 Attention に残る 7 件は参照 issue がすべて CLOSED（1 件は意図的な deferred）で、タブは全て `tabClosed=true`。削除すれば 7 件は手作業なしで Attention から消える。issue #4（resolve コマンド追加案）はこの方針により not planned で閉じた。

## 2. 調査結果

- 基準コミット: `edcb3c3face6d5725bdde0dad98dd221c8977289`
- 調査: iflow 前段（本セッション）の調査結果を流用し、Explore（項目 1〜8）と task-worker（項目 9〜11）を実行

### 参考にすべき既存パターン

- failed Run のタブ追跡: `src/tick.ts:384-388`（`track`）。`run.orca !== null && !tabClosed && isVanished(sightPane(...))` で `phase.tabClosed = true`
- Attention の判定: `src/monitor-model.ts:163-171`（`attentionOf`）。166 行目が「failed && !tabClosed → `!` / hint `→ orcapod stop`」。失敗を Recent に出す経路は `finishedRuns`（234-238 行）と `isFinished`（`src/status.ts:110-112`）
- 1 回だけの通知: `fail()`（`src/tick.ts:550-554`）が `failed:<id>` の notify effect を直接 push。`trackResult` の 3 箇所（420 / 426 / 434）はいずれも直後に return し、failed になった Run は 385 行で continue するので 2 度呼ばれない
- Request の variant を消すときに触る場所: `src/types.ts:60`、`src/state.ts:281-302`（`parseRequest`）、`src/tick.ts:85-102`（`serveRequest`）、`src/cli.ts:27-42`（COMMANDS 表）、`test/state.test.ts` の describe「request files」
- state の読み込み: `runShapeError`（`src/state.ts:74-108`）は列挙フィールドだけを検査し、未知キーを拒否しない。`parseState`（200-206 行）は `fillFieldsAbsentBefore002(parsed)` → `stateShapeError(parsed)` の順に呼び、`parsed as State` をそのまま返す。`saveState`（243-249 行）は全キーを書き戻す
- 読み込み時に形を整える既存パターン: `fillFieldsAbsentBefore002`（`src/state.ts:178-186`）。未検証の `parsed` を `isRecord` / `Array.isArray` で守りながら、その場で書き換える（戻り値なし）。今回の除去・failed 化はこれと同じ形で、同じ位置（`fillFieldsAbsentBefore002` の直後、`stateShapeError` の前）に置く
- `status --json`（`src/cli.ts:76-78`）は `loadState` の結果を `JSON.stringify` でそのまま出す。変換後の Run が出力される

### 関連ファイルと依存関係

| 削除ファイル | 行数 | import 元 |
|---|---|---|
| `src/incidents.ts` | 137 | `src/tick.ts` |
| `src/incident-contract.ts` | 83 | `src/tick.ts` `src/state.ts` `src/status.ts` `src/monitor-model.ts` `src/cli.ts` |
| `src/approval.ts` | 29 | `src/cli.ts` `src/daemon.ts` |
| `src/incident-prompt.ts` | 41 | `src/launch.ts` |
| `test/incidents.test.ts` | 513 | — |
| `test/incident-contract.test.ts` | 128 | — |
| `test/approval.test.ts` | 83 | — |

修正ファイルの該当行（基準コミット時点）:

| ファイル（行数） | 該当行 |
|---|---|
| `src/tick.ts`（586） | 2-3 import / 30 ステップ列 `advanceIncidents` / 46, 552 `attachIncident` / 96-101 investigate・approve の分岐と recovery の rerun 拒否 / 296-298 `recoveryAdmission` / 385 `run.recovery !== undefined && done` / 418-424 recovery 結果の検証と `recoveryResult` / 526-534 `proposal` `verification` の解析 |
| `src/daemon.ts`（430） | 4 import / 240-244 `hasTrackableOpenResolutionTab` / 308-312 `checkProposal` |
| `src/cli.ts`（296） | 4-5 import / 37-39 COMMANDS / 166 rerun の recovery 拒否 / 173-218 `incidentRun` `showIncident` `investigate` `approve` |
| `src/status.ts`（155） | 1 import / 37 `Unresolved` 節 |
| `src/monitor-model.ts`（350） | 1 import / 165 unresolved の規則 |
| `src/types.ts`（80） | 42-45 `Proposal` `ProposalSnapshot` `Incident` `RecoveryTask` / 46 `ResultFile.proposal?` `verification?` / 56 `Run.incident?` `recovery?` `recoveryResult?` / 60 `Request` の investigate・approve |
| `src/state.ts`（428） | 5 import / 96-103 incident・recovery・recoveryResult の検証 / 290-295 `parseRequest` の approve・investigate。`SHA256_HEX_PATTERN`（111）は 127 行で使うので残す |
| `src/launch.ts`（111） | 3 import / 12-13 `runTitle` の `Pick` と recovery タイトル / 24 `run.recovery === undefined` / 32-40 `recoveryPrompt` 分岐 |
| `src/prompt.ts`（54） | 50 failed の説明 |
| `README.md`（201） | 25-27 Usage / 39 Highlights「Incident workflow」/ 95-105 コマンド例と request file の文 / 112 「attaches an incident」 |
| `README.ja.md`（92） | 62-72 |
| `CLAUDE.md`（107） | 23 CLI 一覧 / 50 tick のステップ列 / 54 request を置くコマンド一覧 / 82-84 「Failure-path problem solving」節 |

該当なし（確認済み）: `Makefile`、`docs/setup.md`、`examples/`（`approvals` は Codex のフラグ名）、`src/records.ts`、`src/monitor-layout.ts`、`src/doctor.ts`、`src/up.ts`、`src/log.ts`、`src/notify.ts`、`src/github.ts`、`src/config.ts`、`src/config-view.ts`、`test/fixtures/`、`test/helpers/`。

### 修正が必要なテスト

| ファイル | 該当箇所 |
|---|---|
| `test/cli.test.ts` | 8 import / 394-414 A7 の到達モジュール配列（`incident-contract.ts` `incident-prompt.ts` を外す）/ 417-462 describe「incident recovery CLI」削除 / 595 usage の一覧 / 651-694 describe「G1: incident recovery command rejection」削除 / 703-747 `everyStatusState` と `incident` コマンドのループ |
| `test/state.test.ts` | 5, 8 import / 124-152 G4 の incident・recovery 行 / 569-582 describe「incident recovery save contract」削除 / 新規: 旧フィールド除去と未完了子 Run の failed 化 |
| `test/daemon.test.ts` | 204-223 C43（221 の `incident?.status`）/ 597-663 `incident()` `recoverySource()` と `describe.each(['incident','recovery'])` / 950-990 describe「incident recovery cycle persistence」削除 |
| `test/monitor-model.test.ts` | 314-320 A15（failed・tabClosed=true が Attention に残る → Recent に移る契約へ）/ 362-377 A21 の hint / 476 |
| `test/monitor-layout.test.ts` | 317 は 80 桁固定の行全体を比較している。hint が `→ orcapod stop 7a44f0` に変わり note（`not investigated`）が消えるので、実際の描画結果を確認して行全体を更新する |
| `test/status.test.ts` | 131-132 `Unresolved:` 節 |
| `test/launch.test.ts` | 226-239 describe「incident recovery launch」削除 |
| `test/prompt.test.ts` | 2, 5 import / 15 CLOSING の failed 行（prompt.ts:50 の写し。114 / 122 / 128 / 134 / 140 が `${CLOSING}` で全文比較）/ 22-98 recovery 専用定数 / 149-172 describe「recoveryPrompt」削除 |
| `test/tick.test.ts` | 852 C16 / 871 C17 / 1346 A6-1 の failed 通知（文言は変えないので修正不要の見込み） |

### 規約

- Node 24 の type stripping で `.ts` を直接実行。imports は `.ts` 拡張子付き、型のみの import は `import type`、enum / namespace / parameter properties は使わない（`erasableSyntaxOnly` / `verbatimModuleSyntax`）
- コメントは書かない（外部制約の why だけ）。`tick` は純粋関数で I/O をしない。I/O は `daemon.ts` だけ
- 文書とテスト fixture は中立名（`alice` / `taylor` / `acme-corp` / `todos`）
- テストは `test/<module>.test.ts`、describe / it 名が契約の列挙。既存 ID 体系（A15 / C43 / G4 …）に倣う
- 利用者から見える変更は `CHANGELOG.md` の `## [Unreleased]` に追記する（`CONTRIBUTING.md:31`）。形式は Keep a Changelog（`### Added` / `### Changed` / `### Removed`）

### テスト基盤

vitest（`vitest.config.ts`: `include: ['test/**/*.test.ts']`）。実 DB・外部プロセスなし。一時ホームは `mkdtempSync`、`CycleDeps` / `ExecFile` を注入。`test/cli.test.ts` だけは `bin/orcapod.js` を子プロセスで起動する（CLAUDE.md「CLI process tests」）。A7（`test/cli.test.ts:394-414`）は monitor から到達するモジュール 14 件を期待配列で持つ（`incident-contract.ts` と `incident-prompt.ts` を含む）。

### 知識ベース

未生成（`kb route` が終了コード 3）。

### 試して確かめたこと

| 問い | 実行したもの | 観測結果 |
|---|---|---|
| 基準 main は check を通るか | `pnpm check` | typecheck / lint 合格、28 ファイル・1020 テスト合格 |
| 進行中の recovery 子 Run があるか | `state/state.json` を node で集計 | 0 件（`recovery` 付き子 Run 12 件は done 10 / failed 1 / aborted 1）。未処理 request 0 件 |
| failed の通知は出ているか | `src/tick.ts:550-554` を読む | `fail()` が `failed:<id>` を毎回 push。追加不要 |
| 現在の Attention 7 件はどう消えるか | `state.json` の 7 件の `phase.tabClosed` | 全て true。`unresolved()` の規則を消せば Recent に移る |
| 旧子 Run でタブ追跡をやめると表示が残るものがあるか | `state.json` の `recovery` 付き 12 件を node で集計 | done 10 件は全て tabClosed=true、failed 1 件 tabClosed=true、aborted 1 件（tabClosed 未設定）、done・tabClosed=false・`orca !== null` は 0 件 |

## 3. 実装計画

### 設計スケッチ

使用例（変更後）:

```
# Run が failed になる → macOS 通知 "orcapod: failed" (summary = 理由 + 次アクション)
# monitor の Attention:
!  3f9a1c  cardfolio  "issue 一括対応 ×3"  failed  12m   → orcapod stop 3f9a1c
# 人間がタブで AI の summary を読み、対処してタブを閉じる（または orcapod stop 3f9a1c）
# → 行は Recent に移る。orcapod status の Recent に summary 付きで残る
```

型の素描（`src/types.ts`）:

```ts
export interface ResultFile { status: 'done' | 'failed'; summary: string; links: string[] }
export interface Run { paneRecoveredAt?: string; launchUncertain?: boolean; id: string; project: string; target: ProjectSnapshot; rule: Rule; kindName: string; items: Item[]; createdAt: string; startedAt: string | null; phase: RunPhase; history: { kind: RunPhase['kind']; at: string }[]; orca: OrcaRef | null; notified: string[]; bypassLimit: boolean; manual: boolean; lastMessage: string | null }
export type Request = { type: 'run'; … } | { type: 'stop'; runId: string } | { type: 'rerun'; runId: string }
```

読み込み時の変換（`src/state.ts`、`parseState` 内で `fillFieldsAbsentBefore002(parsed)` の直後・`stateShapeError(parsed)` の前。`fillFieldsAbsentBefore002` と同じその場書き換えの形）:

```ts
function dropIncidentLayer(parsed: unknown): void
```

`isRecord(parsed) && Array.isArray(parsed.runs)` のときだけ、各 Run（`isRecord` のもの）を次の順で処理する。(a) `recovery` を持ち `phase.kind` が done / failed / aborted 以外なら、phase を `{ kind: 'failed', at: <元 phase の since か at、無ければ createdAt>, reason: 'incident layer removed; the run was not finished', tabClosed: <元 phase.kind === 'queued'> }` に置き換え、`history` に `{ kind: 'failed', at }` を足す。(b) その後に `incident` / `recovery` / `recoveryResult` を削除する。判定は削除前の `recovery` と phase で行うので、2 回目の読み込みでは `recovery` が無く (a) は何もしない（I2 の冪等性はこの順序に依る）。queued は `terminal create` を一度も出していないので閉じるタブが無い。launching 以降は、`orca === null` や `launchUncertain` でもタブが存在し得る（`pane.json` が遅れて届く）ので false にし、人間が `orcapod stop` で閉じる。`launchUncertain` と `paneRecoveredAt` は残す: `readPanes`（`src/daemon.ts:261-268`）は `launchUncertain === true` の Run と stop 対象の Run の `pane.json` を読み、`recover`（`src/tick.ts:360-365`）は `launchUncertain && orca === null` なら遅延ペインを `run.orca` に回収する（phase は変えない）。`stopRun`（`src/tick.ts:135-144`）も `run.orca ??= panes[run.id]` で回収してから close effect を出す。failed の Run に対して AI を起動する経路（`recover` の launching 分岐、`schedule`）は無い。`parseState` は `loadState` と `readStateSnapshot` の両方から呼ばれるので、両経路で同じ結果になる。読み取り専用コマンド（`status` / `monitor`）はメモリ上で変換した状態を表示し、ファイルは daemon の次サイクル（20 秒以内）の `saveState` で書き換わる。

`RunPhase` の状態機械、`fail()` の通知、`attentionOf` の 166 行目以降は変えない。

### 検討した代替案

- 採用: 層の削除 + 既存の「failed && !tabClosed」規則に戻す
- 却下: 層を残して `orcapod resolve <id>` を足す（issue #4 案）。1,000 行の層が 0 件の修正しか生んでいないので、出口を足すより消す方が小さく、Attention の意味も単純になる
- 却下: 旧フィールドを未知キーとして放置する（変更 0 行）。state.json と meta.json に旧データが永久に残り、未完了の子 Run が残っていれば通常 prompt で誤起動する。1 ファイル・約 15 行で塞げるので採用しない
- 却下: 未完了の旧子 Run を `aborted` に変換する。`aborted` は `track` と `isObservationTarget` の対象外なので、子 Run の Orca タブが開いていても閉じる手段がなく、追跡を足すと tick に約 20 行増える。`failed`・タブ未閉に変換すれば、既存の failed 追跡（タブ消失で `tabClosed`）と `orcapod stop` がそのまま効く
- 受け入れたトレードオフ: Attention の意味が「未対応」ではなく「タブが開いている」になる。タブを対処せずに閉じると失敗が Attention から消える。耐久する記録は `result.json` の summary と `status` の Recent なので、summary に次アクションを書く契約でこれを補う

### 並列化の確認

- 先に済ませる工程: `src/types.ts` の型削除（他ファイルの typecheck がこれに依存する）
- 並列にできる作業: なし（型削除後は typecheck エラーを追って各ファイルを直す直列作業が最短）
- 共有する可変状態: `src/tick.ts`（複数箇所を直す）。1 人の作業者が触る
- 最小の分割: 1 つのエージェントで行う。削除は typecheck のエラー一覧を順に消す作業で、分けると境界の調整コストが削除そのものより大きい

### 変更ファイル

- 削除（7）: `src/incidents.ts` `src/incident-contract.ts` `src/approval.ts` `src/incident-prompt.ts` `test/incidents.test.ts` `test/incident-contract.test.ts` `test/approval.test.ts`
- 修正（22）: `src/tick.ts` `src/daemon.ts` `src/cli.ts` `src/status.ts` `src/monitor-model.ts` `src/types.ts` `src/state.ts` `src/launch.ts` `src/prompt.ts` / `test/cli.test.ts` `test/state.test.ts` `test/daemon.test.ts` `test/monitor-model.test.ts` `test/monitor-layout.test.ts` `test/status.test.ts` `test/launch.test.ts` `test/prompt.test.ts` `test/tick.test.ts`（必要時のみ）/ `README.md` `README.ja.md` `CLAUDE.md` `CHANGELOG.md`
- 新規: なし

### 影響を受ける既存機能

| 機能 | 判定の内訳 | 対処 |
|---|---|---|
| monitor の Attention / Recent（`attentionOf` / `sectionsOf`） | 不成立 1（意図した挙動変更: tabClosed=true の failed が Attention から Recent へ）、成立 2 | テスト A15 / A21 / 476 行を新しい契約に書き換え、I1 を契約テストにする |
| `status` の出力 | 不成立 1（`Unresolved:` 節の廃止）。failed は Recent に `(reason)` 付きで出る（AI 報告の reason は `AI reported failed: <summary>`）。表示は変えない | `test/status.test.ts:131-132` を更新、I9 を契約テストにする |
| CLI コマンド表と usage | 成立 1（usage は COMMANDS 表から生成される）。`status --json` も成立 1 | `test/cli.test.ts:595` と A1-2 を更新、I10 を契約テストにする |
| state の読み込み（`parseState`） | 未確認 1 → 設計で確定（変換の置き場所と形を Section 3 で決定）。保護なし | I2 / I3 を契約テストにする |
| failed タブの追跡（`track` 385 行） | 成立、テストで保護あり（A37 / A53、1232-1240） | 不変条件にしない。既存テストで受け入れる |
| daemon の観測対象（`isObservationTarget`） | 不成立 1（意図: done / aborted の旧子 Run のタブ追跡をやめる。運用 state に該当 0 件）。failed は `hasTrackableOpenFailedTab` が残る | `test/daemon.test.ts:597-663` の incident・recovery 分を削除 |
| 起動（`runTitle` / `prepareRun`） | 成立 6（呼び出し元は Run 全体を渡す） | `test/launch.test.ts:226-239` 削除 |
| prompt の末尾指示 | 不成立 1（テストの完全一致） | `test/prompt.test.ts:15` を更新、I5 を契約テストにする |
| request の処理（`parseRequest` / `serveRequest`） | 成立（default のエラー文は現状のまま） | I6（非回帰）を契約テストにする |
| 文書（README 2 言語・CLAUDE.md・CHANGELOG.md） | 不成立 1（記述が実装とずれる。CONTRIBUTING.md:31 は利用者から見える変更に CHANGELOG の Unreleased 追記を求める） | 変更範囲に含める。受け入れ条件の識別子検索で確認 |
| 通知 | `incident:` 系 3 通知が無くなる（意図）。`failed:<id>` は維持 | I4（非回帰）を契約テストにする |

### Phase 分割

単一 Phase（基盤 → コア → 統合を 1 本の直列作業で行う）:

1. 型と削除: `src/types.ts` の型削除、4 ソースファイルと 3 テストファイルの削除
2. 利用側の修正: typecheck のエラーを追って `tick` `daemon` `cli` `status` `monitor-model` `state` `launch` を直す。`state.ts` に読み込み時の除去・未完了子 Run の failed 化を足す。`prompt.ts:50` を直す
3. テストと文書: 既存テストの修正・削除、新規の契約テスト（Section 5）、README 2 言語と CLAUDE.md

## 4. リスクと対策

### 不変条件

- **I1**: failed になった Run は、人間がまだ片付けていない間（タブが残っている、または launch 失敗でタブの有無を確定できない間）は Attention に表示され、タブの消失が観測されるか `orcapod stop` が処理されると Recent に移る。実装上は `phase.tabClosed` がこの区別を担い、true になるのは完全な観測でペインと agent の両方が消えたときと `stop` が処理されたとき（`stop` は close effect を出さずに true にする経路があり、その場合は実タブと一致しないことがある。これは変更前からの挙動）
  - 入力表現: 成り立つ（`launchFailed` の有無、reason の内容、manual / `--now` / rerun の別に関係なく同じ）
  - 実行順序: 成り立つ（true になる経路は消失検知と `stop` の 2 つで、どちらが先でも終状態は Recent）
  - 既存状態: 成り立つ（削除前に保存された failed 7 件は全て tabClosed=true なので Recent。`orca === null` の launch 失敗は `stop` まで Attention に残り、これは変更前と同じ）
  - 主体と対象: 成り立つ（全プロジェクト・全ルール・両 AI で同じ規則）
- **I2**: incident 層の削除前に保存された `state.json` は読み込め、読み込み後の Run は `incident` / `recovery` / `recoveryResult` を持たず、保存後のファイルにも現れない。変換は冪等で、3 フィールドと未完了子 Run の phase 以外（通常 Run、履歴、`processed`、`pending`、`watchedRules`、`daemonInfo` など state の他のキー）は変えない
  - 入力表現: 成り立つ（3 フィールドの値がどんな形でも、壊れていても、除去して読み込む）
  - 実行順序: 成り立つ（読み込み直後・tick 後・保存後のどの時点でも無い。2 回目以降の読み込みでも同じ結果）
  - 既存状態: 成り立つ（29 件すべて、全 phase。旧子 Run 11 件は通常の履歴 Run として残る）
  - 主体と対象: 成り立つ（daemon / status / monitor / cli のどの読み手も同じ `parseState` を通る）
- **I3**: `recovery` を持ち未完了だった Run は、読み込み後は failed であり、orcapod がその Run 自体を自動で起動・再開することも、遅れて届いた `pane.json` を契機に AI を起動したり通常 prompt を生成することもない。明示的な `orcapod rerun <id>` は通常作業として新しい Run を作る（旧調査・承認の内容は引き継がない）
  - 入力表現: 成り立つ（stage prepare / apply の両方）
  - 実行順序: 成り立つ（読み込み時点で変換するので `schedule` に queued として届かない。`recover` は launching だけを扱うので failed には触れない。タブが残っていれば failed の追跡と `stop` で閉じる）
  - 既存状態: 成り立つ（queued / launching / starting / running の各 phase から failed へ。done / failed / aborted は phase を変えない。`tabClosed` は queued（`terminal create` を一度も出していない）だけ true、launching 以降は `orca` の有無に関係なく false。参照が未取得（`orca === null`・`launchUncertain`）であることをタブ不在の証拠にしない）
  - 主体と対象: 成り立つ
- **I4（非回帰）**: failed の `result.json` を受領した Run は、そのサイクルで `failed:<run.id>` の通知を 1 回受け、以降のサイクルでは再送されず、phase は failed・tabClosed=false になる（通知後・保存前にプロセスが落ちて再起動した場合の再送は対象外。変更前からの挙動）
  - 実行順序: 成り立つ（`fail()` の 3 呼び出し元は直後に return し、failed になった Run は `track` に再入しない）
  - 既存状態: 成り立つ
- **I5**: すべての prompt の末尾指示は、failed のとき summary に失敗の理由と、人間がそれを解消するための具体的な次のアクションを書くことを求める
  - 入力表現: 成り立つ（kind × ai の全組合せで同じ末尾指示）
  - 実行順序: 成り立つ（静的な文字列で、生成の順序や並行実行に依存しない）
  - 既存状態: 成り立つ（既に起動済みの Run の prompt.md は書き換えないが、新しく起動する Run は全て新しい末尾指示を受ける）
  - 主体と対象: 成り立つ（manual / 自動検知 / rerun のどの起点でも同じ `renderPrompt`）
- **I6（非回帰）**: `run` / `stop` / `rerun` の request は変更前と同じ結果になり、それ以外の type の request は `type is not run / stop / rerun` の警告ログで消費される
  - 入力表現: 成り立つ（`investigate` / `approve` の request ファイルが残っていても同じ経路）
- **I7（非回帰）**: done Run の close 判定、aborted 判定、queued Run の起動判定（`maxConcurrentPerProject`・enabled・author）は変わらない
  - 既存状態: 成り立つ（通常 Run に `recoveryAdmission` は常に `'ready'` を返していた）
- **I9（非回帰）**: `status` の出力に `Unresolved:` 節が無く、failed Run は Recent に `(reason)` 付きで出る
  - 既存状態: 成り立つ（failed・tabClosed の真偽に関係なく Recent。`(tab remains)` の表示は done の tabClosed=false だけで、変更前と同じ）
- **I10（非回帰）**: CLI の usage と受け付けるコマンドは `config validate doctor status up start stop run rerun logs monitor` だけで、monitor から到達するモジュールは A7 の 14 件から `incident-contract.ts` と `incident-prompt.ts` を除いた 12 件
  - 入力表現: 成り立つ（`incident` / `investigate` / `approve` は unknown command として usage を出す）

failed Run のタブ消失検知（`tick.ts:385`）は既存テスト `test/tick.test.ts:1173-1179`（A37 / A53）と `1232-1240` が保護しているので不変条件にしない。

### 前提台帳

| 仮定 | 根拠（基準コミット） |
|---|---|
| `runShapeError` は列挙フィールドだけを検査し、未知キーを拒否しない | `src/state.ts:60-63`（`fieldError`）、`74-108` |
| `parseState` は `fillFieldsAbsentBefore002` → `stateShapeError` の順に呼んで `parsed as State` を返し、`saveState` は全キーを書き戻す | `src/state.ts:200-206`、`178-186`、`243-249` |
| `parseState` は `loadState` と `readStateSnapshot` の両方から呼ばれる | `src/state.ts:208`、`225` |
| `fail()` は `failed:<id>` 通知を毎回 push し、同じ Run に 2 回呼ばれる経路がない | `src/tick.ts:550-554`、`384-389`（failed は continue）、`366`（recover は launching のみ） |
| `attentionOf` の 166 行目は「failed && !tabClosed」を Attention にし、それ以外の failed は null | `src/monitor-model.ts:163-171` |
| `finishedRuns` は `isFinished`（done / failed / aborted）で Recent を作る | `src/monitor-model.ts:234-238`、`src/status.ts:110-112` |
| `track` は `orca !== null && !tabClosed` の failed Run についてペイン消失で `tabClosed = true` にする | `src/tick.ts:384-388`、`446-448`（`isVanished`） |
| `stopRun` は failed Run の `tabClosed` を true にする | `src/tick.ts:135-142` |
| `recoveryAdmission` は `recovery === undefined` なら `'ready'` | `src/incidents.ts:113-115` |
| `hasTrackableOpenFailedTab` が failed のタブを観測対象に残す | `src/daemon.ts:236-238` |
| `runTitle` の呼び出し元 6 箇所は Run 全体を渡す | `src/tick.ts:573`、`src/status.ts:129`、`src/daemon.ts:325,383`、`src/monitor-model.ts:208`、`src/monitor-layout.ts:389` |
| `SHA256_HEX_PATTERN` は `configStatus.sha256` の検証でも使う | `src/state.ts:111`、`127` |
| `parseRequest`（`src/state.ts:278-303`）の default のエラー文は `type is not run / stop / rerun` | `src/state.ts:301` |
| `test/prompt.test.ts` の `CLOSING` は末尾指示の完全一致で、15 行目が `prompt.ts:50` の写し | `test/prompt.test.ts:7-18`、`114,122,128,134,140` |
| A7 は monitor から到達するモジュール 14 件を `toEqual` で持つ | `test/cli.test.ts:394-414` |
| `status` の failed 行は `phase.reason` を表示し、AI 報告の reason は `AI reported failed: <summary>` | `src/status.ts:40`、`src/tick.ts:426` |

### 影響台帳

| 契約（変更前 → 変更後） | 利用箇所 file:line | 利用側の前提 | 判定 | テストで保護 |
|---|---|---|---|---|
| `Run.incident` / `recovery` / `recoveryResult` と関連型 → 削除 | `src/tick.ts:46`, `552` | failed 設定後に `attachIncident` を呼ぶ | 成立（呼び出し行を消すだけ。553 の通知は不変） | `test/tick.test.ts:852,871,1346` |
| 同上 | `src/tick.ts:385` | failed または recovery の done でタブ消失を追う | 成立（`\|\| (run.recovery …)` を消す。failed の追跡は不変） | `test/tick.test.ts:1173-1179`（A37 / A53）、`1232-1240` |
| 同上 | `src/tick.ts:296-298` | `recoveryAdmission` の wait / gone | 成立（`admissionOf` のみに） | `test/tick.test.ts` queued 系 |
| 同上 | `src/tick.ts:418-424` | recovery の結果に proposal / verification を要求 | 成立（ブロック削除） | `test/tick.test.ts:850-872` |
| 同上 | `src/state.ts:96-103` | 3 フィールドを検証 | 未確認 → I2 / I3（設計で確定: 除去 + 未完了子の failed 化） | なし → I2 / I3 |
| 同上 | `src/launch.ts:12-13,24,32,40` | recovery なら専用タイトルと `recoveryPrompt` | 成立（通常分岐のみ。`Pick` から `'recovery'` を外す） | `test/launch.test.ts:73-77` |
| 同上 | `src/daemon.ts:240-243` | incident / recovery を持つ Run（done・aborted を含む）の開いたタブを観測 | 不成立（意図: done / aborted の旧子 Run のタブ追跡をやめる。failed は 236-238 が拾う。運用 state で該当する done・tabClosed=false・`orca !== null` の旧子は 0 件） | `test/daemon.test.ts:627-663`（incident・recovery 分は削除） |
| 同上 | `src/monitor-model.ts:136-145`（`sectionsOf`） | `attentionOf` が null の Run を `rest` に入れ Recent 候補にする | 成立 | `test/monitor-model.test.ts` |
| 同上 | `src/monitor-model.ts:234-238`（`finishedRuns`）、`62`（history） | `isFinished`（done / failed / aborted）で Recent と履歴を作る | 成立（failed・tabClosed=true は Recent に入る） | `test/monitor-model.test.ts:476` 付近（更新） |
| `status --json` の出力: 3 フィールドあり → なし（未完了子は failed） | `src/cli.ts:76-78`、`test/cli.test.ts:243,250,259,272` | `loadState` の結果を `JSON.stringify`。テストは incident 系キーを参照しない | 成立（リポジトリ外の利用者は対象外。CHANGELOG に記載） | `test/cli.test.ts:224-285` |
| 同上 | `src/daemon.ts:308-311` | apply 時に `checkProposal` | 成立（ブロック削除） | `test/daemon.test.ts:950-990`（削除） |
| 同上 | `src/monitor-model.ts:165` | unresolved なら tabClosed に関係なく Attention | 不成立（意図。166 行目のみ残す） | `test/monitor-model.test.ts:320,377,476`（更新） |
| 同上 | `src/status.ts:1,37` | `Unresolved:` 節 | 不成立（節を廃止） | `test/status.test.ts:131-132`（更新） |
| 同上 | `src/cli.ts:166,173-218` | incident / recovery を読む 4 関数 | 成立（関数ごと削除） | `test/cli.test.ts:417-462,651-694,703-747` |
| `Request` の investigate / approve → 削除 | `src/state.ts:290-295` | 2 case の検証 | 成立（default に落ちる） | `test/state.test.ts:569-582`（削除）→ I6 |
| 同上 | `src/tick.ts:96-101` | `serveIncidentRequest` と recovery の rerun 拒否 | 成立 | なし → I6 |
| `ResultFile.proposal?` / `verification?` → 削除 | `src/tick.ts:526-534` | 解析して返す | 成立 | `test/tick.test.ts` result 系 |
| 同上 | `src/types.ts:52` | running phase が `ResultFile` を保持 | 成立（proposal / verification を読む箇所は tick.ts:419 のみで、削除対象） | typecheck |
| CLI の 3 コマンド → 削除 | `src/cli.ts:27-42`、`usage()` | COMMANDS 表から usage を生成 | 成立 | `test/cli.test.ts:595`（更新） |
| 同上 | `README.md:25-27,39,95-105,112` / `README.ja.md:62-72` / `CLAUDE.md:23,50,54,82-84` | 旧コマンドと層を記述 | 不成立（文書を変更範囲に含める） | なし |
| `runTitle` の `Pick` → `'recovery'` を外す | 呼び出し元 6 箇所（前提台帳） | Run 全体を渡す | 成立 | 各テスト |
| 末尾指示の failed の文 → 変更 | `test/prompt.test.ts:15` | 完全一致 | 不成立（テスト更新）→ I5 | 当該テスト |
| `tick` のステップ列から `advanceIncidents` を外す | `src/tick.ts:30`、`CLAUDE.md:50` | 他ステップは出力に依存しない | 成立 | `test/tick.test.ts` |
| 読み込み時の変換（未完了子 Run → failed） | `src/daemon.ts:261-268`（`readPanes`） | `launching` か `launchUncertain === true` か stop 対象の Run の `pane.json` を読む | 成立（`launchUncertain` を残すので、変換後も遅延 `pane.json` を読む。stop 対象なら orca null でも読む） | なし → I3（K3-5 / K3-6） |
| 同上 | `src/tick.ts:360-365`（`recover`） | `launchUncertain && orca === null` なら遅延ペインを `run.orca` に回収。launching 以外は phase を変えない | 成立（failed には AI 起動の経路が無い） | なし → I3 |
| 同上 | `src/tick.ts:135-144`（`stopRun`） | failed で handle が無ければ `tabClosed = true`、handle があれば close effect | 成立（`orcapod stop` が変換後の Run の出口） | `test/tick.test.ts:1226`（R6） |
| 削除対象の副作用: `incident:<src>:<task>` 通知、子 Run の `runs.push`、`run.incident` の付与 | 提供元は `src/incidents.ts` のみ（`rg "incident:" src`、`rg "runs\.push\(" src` で確認） | 読み手は削除される利用側のみ | 成立（通知 3 種が無くなるのは意図） | — |
| A7 の到達モジュール集合 → 2 件減る | `test/cli.test.ts:404,409` | 14 件の完全一致 | 不成立（期待配列を 12 件に） | 当該テスト |

検索パターンと件数（削除対象 4 ファイルを除く `src/`）: `rg -n "incident|Incident|recovery|Recovery|proposal|Proposal|verification|investigat|approve|unresolved|checkProposal" src -g '!incidents.ts' -g '!incident-contract.ts' -g '!approval.ts' -g '!incident-prompt.ts'` → types.ts 7、launch.ts 6、cli.ts 23、monitor-model.ts 2、tick.ts 21、status.ts 2、daemon.ts 6、state.ts 14（計 81）。`rg -n "runTitle\(" src` → 8。`rg "could not complete"` → `src/prompt.ts:50`、`test/prompt.test.ts:15` の 2 件。文書: README.md 8 行、README.ja.md 4 行、CLAUDE.md 5 行。`docs/` `examples/` `Makefile` は 0。

### 見送るリスク

| リスク | 理由 | 修正コスト |
|---|---|---|
| Attention の意味が「未対応」から「タブが開いている」に変わり、対処せずにタブを閉じると失敗が Attention から消える | 要件として選択済み。耐久する記録は `result.json` の summary と `status` の Recent。summary に次アクションを書く契約は prompt による予防で、機械的な保証ではない | 対処しない（設計の選択） |
| 読み取り専用コマンド（`status` / `monitor`）が表示する変換後の状態と、`state.json` の内容が daemon の次サイクル（20 秒以内）まで食い違う | daemon が単一の書き手で、次サイクルの `saveState` で解消する | 0（設計上の性質） |
| `runs/<id>/meta.json` に旧フィールドが残り、変換された未完了子 Run の meta.json は古い phase（queued / running）のまま残る（`recordRunChanges` は変換済みの before / after を比べるので遷移を記録しない） | 運用データ（CLAUDE.md「Operational data」）で、meta.json は記録用。読み手はない。該当 Run は現在 0 件 | 変換前の Run も `recordRunChanges` に渡すなら `src/daemon.ts` 1 ファイル・約 10 行だが、読み手のない記録のために daemon の読み込み経路を 2 本にするので見送る |
| 旧子 Run を明示 `rerun` すると、kindName `Incident investigation` / `Approved fix` のまま通常 prompt の新 Run が作られる | 履歴の kindName は改変しない。rerun は人間の明示操作で、タイトルから旧子 Run 由来と分かる | `src/state.ts` 1 ファイル・約 3 行（見送り不可の条件に該当。履歴の改変になるので見送りを Step 4 で承認に出す） |
| `incident:` 系の通知（approval needed / incident resolved / incident on hold）が無くなる | 層ごと削除する意図 | — |
| 旧子 Run 12 件の kindName `Incident investigation` / `Approved fix` が履歴に残る | 履歴の改変はしない | — |

### 知識ベース由来の項目

未生成。なし。

## 5. 実装指示

### 対象ファイル

削除:
- `src/incidents.ts` `src/incident-contract.ts` `src/approval.ts` `src/incident-prompt.ts`
- `test/incidents.test.ts` `test/incident-contract.test.ts` `test/approval.test.ts`

修正（ソース）:

| ファイル | 変更内容 |
|---|---|
| `src/types.ts` | `Proposal` `ProposalSnapshot` `Incident` `RecoveryTask`（42-45）を削除。`ResultFile`（46）から `proposal?` `verification?` を外す。`Run`（56）から `incident?` `recovery?` `recoveryResult?` を外す。`Request`（60）から `investigate` / `approve` variant を外す |
| `src/tick.ts` | 2-3 の import を削除。30 のステップ列から `advanceIncidents` を外す。46 と 552 の `attachIncident` 呼び出しを削除（553 の `failed:` 通知は維持）。96-101 を `rerun` の処理だけにする（`investigate` / `approve` の分岐と recovery の rerun 拒否を削除）。296-298 を `const admission = admissionOf(obs.config, run)` にする。385 の `\|\| (run.recovery !== undefined && …)` を外す。418-424 の recovery ブロックを削除。526-534 の `parseResultFile` から proposal / verification の解析を外し、`{ status, summary, links }` だけ返す |
| `src/daemon.ts` | 4 の import を削除。240-244 の `hasTrackableOpenResolutionTab` と `isObservationTarget` からの参照を削除。308-312 の `checkProposal` ブロックを削除 |
| `src/cli.ts` | 4-5 の import を削除。37-39 の COMMANDS 3 行を削除。166 の recovery 拒否分岐を削除。173-218 の `incidentRun` `showIncident` `investigate` `approve` を削除 |
| `src/status.ts` | 1 の import を削除。37 の `Unresolved` 節を削除 |
| `src/monitor-model.ts` | 1 の import を削除。165 の行を削除（`attentionOf` は 166 行目以降のまま） |
| `src/state.ts` | 5 の import を削除。96-103 の検証を削除。290-295 の `parseRequest` の 2 case を削除。`dropIncidentLayer(parsed)` を追加し、`parseState` で `fillFieldsAbsentBefore002(parsed)` の直後・`stateShapeError(parsed)` の前に呼ぶ（Section 3 の設計スケッチ。`fillFieldsAbsentBefore002` と同じ防御とその場書き換え）。`SHA256_HEX_PATTERN` は残す |
| `src/launch.ts` | 3 の import を削除。12-13 の `Pick` から `'recovery'` を外し recovery タイトルの分岐を削除。24 の `&& run.recovery === undefined` を外す。32-40 を `renderPrompt(...)` のみにし、`template!` の非 null アサーションを不要にする |
| `src/prompt.ts` | 50 を次に変える: `- failed: you could not complete it. Write in summary the reason and the concrete next action a human must take to resolve it. When you stop because the user has to make a decision, also use failed and write in summary what you need them to decide` |

### テスト対象

既存テストの修正・削除は Section 2「修正が必要なテスト」の表どおり。加えて次の契約テストを追加する（describe / it 名は既存 ID 体系に倣う）。

| 不変条件 | テストファイル | 観点 |
|---|---|---|
| I1 | `test/monitor-model.test.ts` | failed・tabClosed=false は Attention（hint `→ orcapod stop <id>`）、tabClosed=true は Recent で Attention に無い。A15 / A21 / 476 行の書き換え |
| I2 | `test/state.test.ts` | `incident`（awaiting_approval + proposal）、`recovery`、`recoveryResult` を持つ旧形式の state を一時ホームに書き、`loadState` が成功し、Run に 3 キーが無く、`saveState` 後のファイルにも無い。壊れた `incident`（文字列）でも拒否しない。`readStateSnapshot` でも同じ |
| I3 | `test/state.test.ts` | `recovery` 付き queued / launching / running の Run が failed（reason 固定文、`tabClosed` は元 phase が queued のときだけ true、history に追記、`launchUncertain` は維持）になり、done の子は phase 不変。2 回読み込んでも同じ（冪等） |
| I3 | `test/daemon.test.ts`（変換は `loadState` の中で起きるので `runCycle` を通す） | 旧形式の state.json を一時ホームに置いて 1 サイクル回しても launch effect が出ない。遅延 `pane.json` は `recover` が `orca` に回収するが phase は failed のまま（K3-5）。`stop` request は `pane.json` を回収して close effect を出す（K3-6） |
| I4 | `test/tick.test.ts` | 既存 C16 / C17 / A6-1 が通ることを確認（文言不変） |
| I5 | `test/prompt.test.ts` | `CLOSING` 15 行目を新文に更新し、全 kind × ai で末尾指示に `concrete next action` を含む |
| I6 | `test/state.test.ts` | `{"type":"investigate",…}` と `{"type":"approve",…}` の request ファイルが `type is not run / stop / rerun` のエラーになる |
| I9 | `test/status.test.ts` | 出力に `Unresolved:` が無く、failed・tabClosed=true と tabClosed=false の両方が Recent に `(reason)` 付きで出る |
| I10 | `test/cli.test.ts` | usage の一覧が `config validate doctor status up start stop run rerun logs monitor` だけ。`incident` を渡すと unknown command。A7 の到達集合から `incident-contract.ts` `incident-prompt.ts` を外した 12 件 |

修正（文書）:

| ファイル | 変更内容 |
|---|---|
| `README.md` | 25-27 の 3 行を削除。39 の Highlights「Incident workflow」を「Failed runs stay visible: a failed run keeps its tab open and stays in the monitor's Attention until you close the tab (`orcapod stop`); the AI's summary says what to do next」に置き換える。95 を「Stop one run (this closes its tab) or rerun it:」に、100-102 の 3 行を削除、105 のコマンド列から `investigate` and `approve` を外す。112 の「on `failed` it leaves the tab open and attaches an incident」を「on `failed` it leaves the tab open and shows the run in Attention until the tab is closed」に |
| `README.ja.md` | 62 を「実行の停止・再実行:」に、67-69 を削除、72 のコマンド列から `investigate` / `approve` を外す |
| `CHANGELOG.md` | `## [Unreleased]` に `### Changed`（failed Run は Orca のタブが開いている間だけ monitor の Attention に出る。`status` の `Unresolved` 節を廃止。`status --json` から `incident` / `recovery` / `recoveryResult` が消え、未完了だった調査・適用の子 Run は failed として読み込まれる。prompt の末尾指示が failed の summary に次アクションを求める）と `### Removed`（`incident` / `investigate` / `approve` コマンドと incident 層）を追加 |
| `CLAUDE.md` | 23 の一覧から `incident` `investigate` `approve` を外す。50 のステップ列を `serve → detect → fire → schedule → recover → track → watchOrca` に。54 のコマンド列から `investigate` / `approve` を外す。78 の末尾に「A failed run stays in the monitor's Attention while its tab is open and moves to Recent once the tab is closed」を足す。82-84 の「Failure-path problem solving」節を削除 |

### 受け入れ条件

- `pnpm check` が通る（typecheck / lint / 全テスト）
- `node bin/orcapod.js` の usage に `incident` / `investigate` / `approve` が無い
- 削除したモジュール・型・関数・コマンドへの参照が無い: `rg -n "incidents\.ts|incident-contract|approval\.ts|incident-prompt|\bIncident\b|RecoveryTask|ProposalSnapshot|\bProposal\b|checkProposal|parseProposal|proposalRevision|unresolved|incidentLabel|formatIncident|advanceIncidents|attachIncident|recoveryAdmission|serveIncidentRequest|recoveryPrompt|recoveryResult|\binvestigate\b|\bapprove\b" src test README.md README.ja.md CLAUDE.md` が 0 件。移行コード（`dropIncidentLayer`、除去するキー名の文字列 `'incident'` `'recovery'` `'recoveryResult'`、reason の固定文 `incident layer removed`）と、移行を検証するテストの名前・fixture、incident 層と無関係な既存テスト名の `recovery`（例: `fix/launch-recovery` の文脈、ペインの recover）は許容する
- 現在の運用 state（`ORCAPOD_HOME` 既定）を `node bin/orcapod.js status` で読むと `Unresolved:` 節が無く、エラーなく表示される
- Section 5 の契約テストが全て存在し通る

### Phase ごとの完了の証拠

- Phase 1（型と削除）: 4 + 3 ファイルが無い。確認: `ls src/incidents.ts src/incident-contract.ts src/approval.ts src/incident-prompt.ts test/incidents.test.ts test/incident-contract.test.ts test/approval.test.ts` が全て失敗する
- Phase 2（利用側の修正）: `pnpm typecheck 2>&1 | grep '^src/'` が空（テストのエラーは Phase 3 で消える）。受け入れ条件の識別子検索を `src` に限定して 0 件
- Phase 3（テストと文書）: `pnpm check` が全テスト合格、`node bin/orcapod.js` の usage に 3 コマンドが無い、受け入れ条件の識別子検索が `src test README.md README.ja.md CLAUDE.md` で 0 件、`CHANGELOG.md` の Unreleased に Changed / Removed がある

### 既存データ確認

対象は `state/state.json`（SQL ではなく JSON）。確認済み: Run 29 件、`recovery` 付きで未完了の Run 0 件、`state/requests/` 0 件。実装後に `node bin/orcapod.js status` で読み込めること、daemon 再起動後の `state.json` に 3 キーが無いことを確認する（`node -e` で `runs.some(r => 'incident' in r || 'recovery' in r || 'recoveryResult' in r)` が false）。

### 攻撃ケース一覧

| ID | 不変条件 | 破る試み（入力・順序） | 期待 |
|---|---|---|---|
| K1-1 | I1 | failed・tabClosed=false・`launchFailed` 無し | Attention、hint `→ orcapod stop <id>`、Recent に無い |
| K1-2 | I1 | failed・tabClosed=true | Recent、Attention に無い、Attention タイトル `Attention none` |
| K1-3 | I1 | failed・`orca === null`・`launchFailed: true`・tabClosed=false → `stop` request を serve | serve 前は Attention、serve 後は tabClosed=true で Recent |
| K1-4 | I1 | failed・tabClosed=true で、旧 `incident: { status: 'awaiting_approval' }` を持つ state を読み込む | 読み込み後は incident 無し、Recent（現在の 7 件と同型） |
| K1-5 | I1 | failed・tabClosed=false と done・tabClosed=false を並べる | failed だけが Attention、done は Recent（`(tab remains)`） |
| K2-1 | I2 | 29 件相当の旧形式 state（incident / recovery / recoveryResult を持つ done・failed・aborted の Run） | `loadState` 成功、全 Run に 3 キー無し、`saveState` 後のファイルにも無し |
| K2-2 | I2 | `incident: "broken"`、`recovery: 42` のような壊れた値 | 拒否せず読み込み、キーは除去 |
| K2-3 | I2 | `readStateSnapshot` で同じファイルを読む | 同じ結果（status / monitor の経路） |
| K2-4 | I2 | 変換後に `saveState` → 再 `loadState` | 同じ内容（冪等） |
| K2-5 | I2 | 旧形式 state に通常 Run・`processed`・`pending`・`watchedRules`・`daemonInfo` を入れて読み込む | 3 フィールドと未完了子の phase 以外は入力と `toEqual` で一致 |
| K3-1 | I3 | `recovery: { stage: 'prepare' }`・phase queued・`orca: null` | phase failed、reason 固定文、tabClosed=true、history 末尾に failed、Recent |
| K3-2 | I3 | `recovery: { stage: 'apply' }`・phase running・`orca` あり | phase failed、tabClosed=false、Attention。次の tick で launch effect 無し。daemon の観測対象に入る（`hasTrackableOpenFailedTab`） |
| K3-3 | I3 | `recovery` 付き・phase done | phase 不変、`recovery` キーのみ除去 |
| K3-4 | I3 | 変換後の state で `orcapod rerun <子 id>` | 新しい通常 Run が作られる（生成時 queued、空き枠があれば同じ tick で launching）。元の failed Run は不変 |
| K3-5 | I3 | phase launching・`orca: null`・`launchUncertain: true` の子を変換 → 次のサイクルで `pane.json` が現れる | 変換後は failed・tabClosed=false・`launchUncertain` 維持で Attention。`recover` が `run.orca` に回収し、phase は failed のまま、launch effect と AI 起動は無い。その後ペインと agent の無い完全な観測で tabClosed=true → Recent |
| K3-6 | I3 | phase launching・`orca: null`・`launchUncertain` 無しの子を変換 → `pane.json` あり → `stop` request | `stopRun` が `pane.json` を回収して close effect を出す（handle あり） |
| K4-1 | I4 | running Run に `{"status":"failed","summary":"…"}` を与えて 2 サイクル回す | notify `failed:<id>` が 1 サイクル目に 1 回、2 サイクル目は無し。phase failed・tabClosed=false |
| K4-2 | I4 | 壊れた JSON を 60 秒超放置 | notify `failed:<id>` が 1 回だけ |
| K5-1 | I5 | kind × ai の全組合せで `renderPrompt` | 末尾指示に新しい failed の文を含む。`CLOSING` 完全一致テストが通る |
| K6-1 | I6 | `state/requests/` に `{"type":"investigate","runId":"…","evidence":""}` | warn ログ `type is not run / stop / rerun`、`consumeRequest` effect でファイルは消費される。runs / pending / processed は不変 |
| K6-2 | I6 | 同 `{"type":"approve","runId":"…","revision":"<64hex>"}` | 同上 |
| K6-3 | I6 | `rerun` request を通常 Run に | 変更前と同じ（新 Run が生成時 queued、tick 終了時は起動条件に従い launching になり得る） |
| K7-1 | I7 | queued 2 件・`maxConcurrentPerProject: 1` | 1 件だけ launching（既存テストで確認） |
| K7-2 | I7 | phase running・`closeAttempts: 0` の Run に有効な done result と、その mtime 以後に始まった agent done の観測 | close effect（既存テストで確認） |
| K9-1（非回帰） | I9 | failed・tabClosed=true と failed・tabClosed=false を含む state で `status` | `Unresolved:` が無い。両方が Recent に `(reason)` 付きで出る |
| K10-1（非回帰） | I10 | `node bin/orcapod.js` の usage | 11 コマンドのみ。`incident` `investigate` `approve` が無い |
| K10-2（非回帰） | I10 | `node bin/orcapod.js incident <id>` | unknown command として usage を出し非 0 で終了 |
| K10-3（非回帰） | I10 | monitor の到達モジュール（A7） | 12 件（`incident-contract.ts` `incident-prompt.ts` を除く） |

## 6. 次のアクション

- 変更規模: 削除 7 ファイル（約 1,014 行）、修正 22 ファイル（ソース約 130 行減 + state.ts 約 15 行増、テスト約 600 行減 + 契約テスト約 150 行増、文書約 25 行）
- 実行方式: ユーザー指示により Codex セッションに実装を委譲する（`/impl` ではなく spawn で Codex を起動し、この計画書のパスを渡す）。単一 Phase・直列作業なので 1 セッション
- 計画ファイル: `docs/history/plan/SPEC-INCIDENT-REMOVAL-001/plan.md`
- ブランチ: `chore/remove-incidents`、main への PR（merge commit）
- 3a 省略: なし。plan-reviewer の結果: Critical 0 / High 3 / Medium 9 / Low 1（CONDITIONAL PASS）。反映: 受け入れ条件と Phase 証拠の残存検索を削除識別子に限定（3b と同じ）、Section 2 / Phase 分割の「aborted 化」を failed 化に統一、I9（status）/ I10（CLI・A7）を非回帰の不変条件として追加、`dropIncidentLayer` の挿入位置を `fillFieldsAbsentBefore002` 直後に確定し同パターンを参考に追加、Phase 2 の typecheck 証拠を `src/` に限定、`daemon.ts:240-243` を「不成立（意図）」に直し運用 state の該当 0 件を確認、`tick.ts:385` を既存テスト保護ありに直して I8 を削除、`status --json` の行と monitor の成立 2 行を台帳に追加、CHANGELOG.md を変更範囲に追加、I1 を launch 失敗を含む形に書き直し、state.ts の行番号を修正（301 / 200-206 / 278-303）、monitor-layout テストの更新方法と I3 のテスト先（daemon.test.ts）を明記、meta.json の phase 残存と rerun 時の kindName を見送るリスクに追加
- 3b 実行手段: Codex（`codex exec gpt-6.1-sol high`）。構成済み 8 件・仮説 0 件・提案不変条件 5 件
- レビュー後の変更（3b 反映）: 未完了子 Run の `tabClosed` を `orca === null` 判定から「元 phase が queued のときだけ true」に変え、`launchUncertain` を残して遅延 `pane.json` の回収と `stop` の閉鎖経路を維持（K3-5 / K3-6 追加）。I1 を `tabClosed` の意味で定義し `stop` の非閉鎖経路を明記。I3 に明示 rerun の扱いと「参照未取得をタブ不在の証拠にしない」を追加。I4 を保存済みサイクル間の保証に限定。I8 を「ペインと agent の両方が無い完全な観測」に修正（K8-3 追加。その後 3a で I8 / K8-1〜3 は既存テスト保護ありとして削除）。K7-2 の入力を phase running に修正。K6-1〜3 の期待値を consumedRequests と起動条件込みに修正。受け入れ条件の残存検索を削除対象の識別子に限定し、移行コードと移行テストを許容。I2 に冪等性と他キー不変を追加（K2-5）。影響台帳に `readPanes` / `recover` / `stopRun` の 3 行を追加
