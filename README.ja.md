# orcapod

GitHub の issue / PR のラベルを監視し、Orca のタブで AI CLI を起動する常駐ツール。

English version: [README.md](README.md)

orcapod は macOS 用の常駐 CLI です。GitHub の open な issue / PR をラベルと書き手の条件で検知し、待機時間の後に [Orca](https://www.onorca.dev/) のタブで Claude Code / Codex CLI をテンプレートから組んだプロンプト付きで起動します。AI は `runs/<id>/result.json` に結果を書き、orcapod はそれを読んで成功ならタブを閉じ、失敗・入力待ちならデスクトップ通知を出します。orcapod 自身は GitHub に書き込みません。コミット・コメント・マージはプロンプトに従って AI CLI が行います。

状態: 実験的。設定の形と `result.json` の契約は変わる可能性があります。issue と PR を歓迎します。

## 必要なもの

- macOS（通知は `osascript`、タブ操作は `orca` CLI）
- Node.js 24 以上（`.ts` を型剥がしで直接実行するためビルド工程は無い）
- pnpm
- [Orca](https://www.onorca.dev/)。Orca を起動し、監視するリポジトリを worktree として登録して `orca agent hooks on` を実行する
- GitHub CLI（`gh`）。`config.yaml` に書くアカウントでログインしておく
- 使う AI CLI（Claude Code / Codex CLI）。監視対象フォルダの信頼承諾を済ませておく（`orcapod doctor` が確認する）。Codex は `launch.sh` が `--no-daemon` を付けて起動する

## 導入

npm には公開していません。リポジトリを clone して使います。

```sh
git clone https://github.com/noafixinc/orcapod.git
cd orcapod
pnpm install --frozen-lockfile
```

サンプルから設定を作ります。`cp -n` は既存ファイルを上書きせず、飛ばすと終了コード 1 を返すため、各行を個別に実行してください。

```sh
cp -n examples/config.yaml config.yaml
mkdir -p prompts
cp -n examples/prompts/*.md prompts/
```

`config.yaml` のプロジェクト名・パス・リポジトリ・GitHub アカウント・監視条件を編集し、条件で使う `kind` / `ai` の組ごとに `prompts/<kind>.<ai>.md` を用意します。設定例は [examples/config.yaml](examples/config.yaml) を参照してください。無人実行用の AI 起動コマンドとプロンプトの内容も確認してください。

```sh
make validate
make doctor
make start
```

`validate` と `doctor` は、`config.yaml` が実在するリポジトリと `gh` にあるアカウントを指すまで失敗します。

## 基本操作

| コマンド | 操作 |
| :--- | :--- |
| `make start` | 常駐をバックグラウンド起動して監視画面を開く |
| `make daemon` | 常駐を前景で起動する（Ctrl-C で終了） |
| `make stop` | 常駐を停止する（個別の AI・タブは継続） |
| `make monitor` | 監視画面だけを開く |
| `make status` | 状態を 1 回表示する |
| `make logs` | ログを追跡する |
| `make validate` | 設定を検証する |
| `make doctor` | 実行環境を診断する |
| `make check` | 型チェック・Lint・全テストを実行する |

監視画面の `q` / Ctrl-C は画面だけを閉じます。設定は自動で再読込されますが、コード更新後は常駐を再起動してください。コマンド一覧は `make`、CLI の使い方は `node bin/orcapod.js` で表示できます。

ラベル条件と待機時間を無視して手動で起動する:

```sh
node bin/orcapod.js run --project your-project --issue 42 --kind feature --ai claude --now
```

実行の停止・再実行、失敗した実行の問題解決:

```sh
node bin/orcapod.js stop 20261023-0917-3f9a1c
node bin/orcapod.js rerun 20261023-0917-3f9a1c
node bin/orcapod.js incident 20261023-0917-3f9a1c
node bin/orcapod.js investigate 20261023-0917-3f9a1c
node bin/orcapod.js approve 20261023-0917-3f9a1c <revision>
```

`run` / `stop` / `rerun` / `investigate` / `approve` は `state/requests/` に依頼ファイルを置くだけで、常駐が次の 20 秒サイクルで読んで処理します。

## 設定

`config.yaml` の各項目は `src/config.ts` が検証し、`make validate` が誤りの位置を表示します。プロンプトの `{{変数}}`（`project.name` / `project.path` / `repo` / `kind.name` / `items` / `items.count` / `run.id` / `result.path`、`batch: each` 専用の `item.number` / `item.title` / `item.url` / `item.target`）は `src/prompt.ts` にあります。詳細は英語版 README の Configuration 節を参照してください。

環境変数: `ORCAPOD_HOME` は `config.yaml`・`prompts/`・`state/`・`runs/`・`logs/` の置き場所（既定はリポジトリ直下。自分自身のリポジトリを監視するときはリポジトリ外にする）。`CLAUDE_CONFIG_DIR` と `CODEX_HOME` は `doctor` が信頼承諾を確認するときに読みます。

`config.yaml`・`prompts/`・`state/`・`runs/`・`logs/` は Git 管理外です。`state/`・`runs/` は処理済み判定と実行記録に使うため、常駐の動作中に手作業で削除しないでください。

### セキュリティ上の注意

既定の起動コマンドは AI CLI の許可確認を無効にして起動します（`--dangerously-skip-permissions`、`--dangerously-bypass-approvals-and-sandbox`）。誰もタブを見ていない前提のためです。AI がそのタブで行うことは、あなたのローカルの資格情報と設定したアカウントの `GH_TOKEN` で実行されます。書き手の条件を絞り、プロンプトを確認し、信頼できるリポジトリだけを監視対象にしてください。

## 貢献

[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。セキュリティの報告は [SECURITY.md](SECURITY.md) の手順で行ってください。

## ライセンス

MIT © 2026 Noafix, Inc. [LICENSE](LICENSE) を参照してください。
