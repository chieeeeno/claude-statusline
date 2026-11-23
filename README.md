# @chieeeeno/claude-statusline

**日本語** | [English](README.en.md)

[Claude Code](https://claude.com/claude-code) / [Google Antigravity CLI (`agy`)](https://antigravity.google) 用の、速くて依存ゼロの status line。

```
📁 my-repo  ⧉ feature-branch
⑂ feature/add-search  🧠 Opus 5 (1M)  ⚡ xhigh  📖 Explanatory  🤔 on
ctx ▓░░░░░░░░░ 10% 98k/1M │ 🔥 5h ▓▓▓▓▓▓▓░░░ 67% ↺2:03 (12:33) │ 📅 7d ▓▓░░░░░░░░ 22% ↺5d (5/23 10:30) │ 💰 $2.69 · 12m
```

## なぜもう 1 つ status line を作ったのか

- **描画時に Node を起動しない。** 描画は Python が担当する（約 40ms）。Node を使うのはセットアップ時に `statusline.py` をコピーして設定を書き込むときだけ。Node 製の status line は再描画のたびに 100ms 以上を起動に費やすが、Claude Code / Antigravity CLI のデバウンスは 300ms しかない
- **レート制限枠・クォータが見える。** 5 時間枠と 7 日枠（Antigravity CLI の `quota` バケットを含む）の使用率を、リセットまでの残り時間とリセット時刻（`↺2:03 (12:33)`）と一緒に出す。作業を続けるか切り上げるかを判断できる。時刻はローカルタイムゾーンで、日をまたぐ場合は日付も付く
- **依存ゼロ。** Python 標準ライブラリのみ

## インストール

```bash
npx @chieeeeno/claude-statusline --install
```

グローバルインストールは不要。`statusline.py` を各 CLI 配下の安定した場所（Claude Code は `~/.claude/claude-statusline/statusline.py`、Antigravity CLI は `~/.gemini/antigravity-cli/claude-statusline/statusline.py`）へ原子的にコピーし、`settings.json` からそのコピー先を直接実行する。`npx` のキャッシュが消えても動作し続け、描画時に Node は起動しない。

対話端末（TTY）で `--install` を実行すると、各 CLI の導入状態を表示した選択メニューが出る:

```
Select target to install statusLine:
  1) Claude Code (~/.claude/settings.json) [installed v2.1.0]
  2) Antigravity CLI (~/.gemini/antigravity-cli/settings.json) [not installed]
  3) Both
Enter choice [1-3] (default: 1):
```

対象の `settings.json`（Claude Code は `~/.claude/settings.json`、Antigravity CLI は `~/.gemini/antigravity-cli/settings.json`）に `statusLine` の項目を書き込む（既存ファイルは事前に退避する）。どちらも再起動なしで反映する。

非対話環境やスクリプトからは `--target` で明示できる（非 TTY で省略した場合は後方互換のため `claude` が選ばれる）:

```bash
npx @chieeeeno/claude-statusline --install --target claude
npx @chieeeeno/claude-statusline --install --target antigravity
npx @chieeeeno/claude-statusline --install --target all
```

### 更新

```bash
npx @chieeeeno/claude-statusline@latest --install
```

`statusline.py` は各 CLI 配下へコピーされるため、最新版へ更新する際は `--install` を再実行する（コピー先のスクリプトは一時ファイル経由の `rename` で原子的に置き換わり、バージョンも記録される）。

### 旧バージョン（グローバルインストール）からの移行

以前の `npm install -g @chieeeeno/claude-statusline` による設定（パッケージディレクトリを直接指す `settings.json`）はそのままでも壊れず動き続ける。`npx @chieeeeno/claude-statusline@latest --install` を実行すると新しいコピー方式へ切り替わり、その後は `npm uninstall -g @chieeeeno/claude-statusline` でグローバルパッケージを削除してよい。

## 表示するもの

| 行 | 内容 |
|---|---|
| 1 | リポジトリ名（`origin` リモート由来）と git worktree 名 |
| 2 | ブランチ、モデル、推論の深さ、出力スタイル、thinking、fast mode |
| 3 | コンテキスト使用率、5 時間枠、7 日枠、コスト / 経過時間 / 増減行数 |

使用率のバーは 50% / 75% / 90% を境に、緑 → 黄 → 橙 → 赤 と変わる。

データが無いセグメントは枠ごと消える。`--` のようなプレースホルダは出さない。レート制限枠は Claude.ai の購読者（Pro/Max）にしか報告されないため、従量課金の API プランでは表示されない。

## コマンド

```
npx @chieeeeno/claude-statusline --install [--target <target>] [--runcat]  statusline.py をコピーして settings.json に書き込む
npx @chieeeeno/claude-statusline --uninstall [--target <target>]           statusLine の項目とコピー済みファイルを消す
npx @chieeeeno/claude-statusline --print                                   stdin のペイロードを描画する（デバッグ用）
npx @chieeeeno/claude-statusline --version                                 CLI 版と各ターゲットの導入済み版を出す
```

`--target` には `claude`・`antigravity`・`all` を指定できる。TTY 上で省略すると対象選択メニューが出る。

設定を変えずに見た目だけ確かめる:

```bash
echo '{"model":{"display_name":"Opus 5"},"context_window":{"used_percentage":25,"total_input_tokens":50000,"context_window_size":200000}}' \
  | npx @chieeeeno/claude-statusline --print
```

`--uninstall` は、`statusLine` が別のプログラムを指していれば設定にもコピー先ディレクトリにも手を付けない。他のツールの設定を黙って壊さないため。

### インタプリタを指定する

セットアップは `/usr/bin/python3` を最優先し、無ければ `PATH` 上の最初の `python3` に落ちる。`/usr/bin/python3` を持たない環境（NixOS、Alpine、一部のコンテナ）では、セットアップ時点の `PATH` が解決した先がそのまま `settings.json` に焼かれ、以後そこが毎分実行される。明示的に固定できる:

```bash
npx @chieeeeno/claude-statusline --install --python /opt/homebrew/bin/python3
```

指定したパスは書き込む前に検査する。実際に実行できること、そして Python 3.8 以上を名乗ることを確かめる。

### RunCat Neo 連携

`--install --runcat` を付けると、[RunCat Neo](https://apps.apple.com/app/runcat) が読む形式で `runcat-usage.json` も書き出す（Claude Code は `~/.claude/runcat-usage.json`、Antigravity CLI は `~/.gemini/antigravity-cli/runcat-usage.json`）。モデル・コンテキスト・レート制限／クォータの使用率が macOS のメニューバーに出る。既定では無効で、明示的に有効にしない限り何も書かない。

## 動作要件

- macOS または Linux（Windows は非対応）
- Python 3.8 以上（標準ライブラリのみを使う）
- Node 24 以上（セットアップ時のみ）
- git（ブランチのセグメント用。無くても他は描画される）

## 開発

開発には [Bun](https://bun.sh/) を使う。

```bash
bun install        # devDependencies（typescript / @types/node）を入れる
bun run typecheck  # 型チェック
bun run build      # src/claude-statusline.ts → bin/claude-statusline.js
bun run test       # 両方
bun run test:py    # statusline.py を unittest で
bun run test:js    # ビルド後に bin/claude-statusline.js を node:test で
bun test           # ローカルで CLI テストだけを素早く回す（要ビルド）
```

実行時依存（`dependencies`）はゼロのまま維持している。開発用依存も TypeScript のビルド・型検査に必要な `typescript` と `@types/node` だけに留めており、Python 側は `unittest`、CLI 側は Node 組み込みの `node:test` を使う。どちらの包みも、収集されたテストが想定件数を下回ったら失敗する。空のテストファイルも存在しないテストファイルもそれ自体は exit 0 で通ってしまい、テストを消したことが緑の CI になってしまうため。CLI のテストは毎回使い捨ての `HOME` の中で走るので、実際の `~/.claude` には触れない。

### 開発・リリース用スキル

リポジトリには Claude Code / Antigravity CLI（`.agents/skills.json` 経由で共有）の両方から使える開発・リリース用スキルを同梱している:

- `statusline-review`（[設計書](docs/01-review-skill-design.md)）: PR 差分に対して品質・セキュリティの 2 エージェントで並列レビューと修正ループを回す
- `statusline-release`（[設計書](docs/03-release-skill-design.md)）: 差分収集・semver 決定・バージョン上げ PR 作成/マージ・`vX.Y.Z` タグプッシュによる OIDC 公開（`.github/workflows/publish.yml`）の監視・GitHub Release 作成までを安全に実行する。ローカルからの `npm publish` 等は `.claude/settings.json`・`.agents/hooks.json`・`package.json` の `prepublishOnly` で多層的にブロックしている

## ライセンス

MIT
