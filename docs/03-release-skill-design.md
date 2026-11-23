# リリーススキル設計書 — statusline-release

作成日: 2026-11-23

## この文書は何か

`@chieeeeno/claude-statusline` の npm リリース作業を安全かつ一貫した手順で実行するためのスキル `statusline-release` と、ローカル環境からの誤公開を防ぐ多層防御設定の設計書。

対象はこのリポジトリのみ。`.github/workflows/publish.yml` による Trusted Publishing (OIDC) 公開を前提に固定することで、ローカルの長期 npm トークンや手動 `npm publish` を完全に排除する。

## なぜ作るのか

PR #26（#10）により、`vX.Y.Z` タグをプッシュするだけで `verify` → `build` → `publish`（OIDC + Provenance 自動付与）まで完了する基盤が整った。一方で、その前後に必要な作業は手作業のまま残っていた：

- 前回タグ以降の差分・PR 収集と `statusline-review` 実施状況の確認
- semver 判定とローカル事前検査（型検査・テスト・tarball 検査）
- `release/vX.Y.Z` ブランチでの `package.json` 更新・PR 作成・CI 待機・マージ
- マージ後の `main` に対する整合性検証とタグ作成・プッシュ
- `publish.yml` の監視・npm 公開反映確認・GitHub Release 作成

これらを手順化してスキルにまとめることで、タグ不一致や未マージコミットへのタグ打ち、GitHub Release の作成漏れを防ぐ。また、プロンプト上の指示だけに頼らず、コマンド禁止設定とフックによって**ローカルからの `npm publish` 等を機械的にブロック**する。

## 現行のリリース基盤（`.github/workflows/publish.yml` の前提）

スキルが必ず満たさなければならない CI 側の制約は以下の通り：

| 制約 | 内容 |
| --- | --- |
| トリガー | `v*` タグのプッシュ |
| タグ形式 | 安定版 semver（`^v[0-9]+\.[0-9]+\.[0-9]+$`）。プレリリース表記は CI で拒否される |
| バージョン一致 | タグ名から先頭 `v` を除いた値が `package.json` の `version` と完全一致すること |
| ジョブ構成 | `verify`（`test.yml` 再利用）→ `build`（`bin/claude-statusline.js` 生成＋SHA-256）→ `publish`（`environment: npm` で OIDC 公開） |
| 公開コマンド | `npm publish --ignore-scripts`（検証済みバイナリを使い `prepack` 等のスクリプト実行を抑止） |
| tarball 厳密検査 | 6 ファイル（`LICENSE`, `README.en.md`, `README.md`, `bin/claude-statusline.js`, `package.json`, `statusline.py`）のみ、`dependencies` 空、`publishConfig.access == "public"`、`os == ["darwin", "linux"]`、`.py`/`.js` 実行権限あり |

## 構成

```text
.claude/
├── settings.json                       Claude Code 用 permissions.deny（ローカル publish 禁止）
└── skills/
    └── statusline-release/
        └── SKILL.md                    リリーススキル本体（Claude Code / Antigravity CLI 共通）

.agents/
├── skills.json                         .claude/skills を Antigravity CLI へ共有（既存）
├── hooks.json                          Antigravity CLI 用 PreToolUse フック設定
└── hooks/
    └── block-local-publish.py          run_command のローカル publish 検出・拒否スクリプト

docs/
└── 03-release-skill-design.md          この文書（設計・テンプレートの唯一の情報源）

package.json                            scripts.prepublishOnly による CLI 非依存の最終防壁
tests/
└── test_block_local_publish.py         フック判定・設定整合性・prepublishOnly の自動テスト
```

スキル名を `statusline-release` にするのは、既存の `statusline-review` と命名規則を揃えつつ、汎用的な `/release` スキルとの名前衝突を避けるため。`.claude/skills/statusline-release/SKILL.md` に配置すれば、既存の `.agents/skills.json` により Claude Code と Antigravity CLI (`agy`) の両方から追加設定なしで認識される。

## 実行フローと 4 つのユーザー確認ゲート

外部影響や不可逆な操作を伴う箇所には、必ずユーザー確認ゲートを挟む。

| Step | 内容 | 確認ゲート / 停止条件 |
| --- | --- | --- |
| 1. 事前条件 | `gh auth status`・リモート・作業ツリークリーン・`origin/main` 同期・前回タグ以降の差分/PR 収集・レビュー状況確認 | 未認証・dirty・差分 0 件で停止 |
| 2. バージョン決定 & 検証 | semver 根拠の提示、安定版 `X.Y.Z` の重複確認、`bun run typecheck`・`bun run test`・`npm pack --dry-run --ignore-scripts --json` 実行 | **ゲート 1: バージョン `X.Y.Z` の確定**。重複や検証失敗で停止 |
| 3. バージョン上げ PR | `release/vX.Y.Z` 作成 → `package.json` の 1 行更新 → `X.Y.Z に上げる` で PR 作成 → `gh pr checks --watch` で CI 確認 → squash マージ | **ゲート 2: PR マージの承認**。CI 失敗で停止 |
| 4. タグプッシュ & 監視 | `main` 切替 & `pull --ff-only` → 5 項目ガードレール再検証 → 注釈付きタグ `vX.Y.Z` 作成 & push → `publish.yml` 監視 → `npm view` で公開反映確認 | **ゲート 3: タグ作成 & push の承認**。`publish.yml` 失敗時はログ報告して停止（タグ削除・Release 作成はしない） |
| 5. GitHub Release | 変更サマリ・検証結果のリリースノート作成 → `gh release create vX.Y.Z` | **ゲート 4: リリースノート確認 & 作成承認**。既存 Release があれば停止 |

### プッシュ前 5 項目ガードレール（Step 4）

タグを作成する直前に、以下 5 つすべてを満たすことを機械的に確認する。1 つでも欠けていれば即停止する。

1. 現在のブランチが `main` であること
2. 作業ツリーが完全にクリーンであること（`git status --porcelain` が空）
3. `HEAD` が `origin/main` と同一コミットであること
4. `package.json` の `version` が目標バージョン `X.Y.Z`（`^[0-9]+\.[0-9]+\.[0-9]+$`）と完全一致すること
5. ローカル（`refs/tags/vX.Y.Z`）およびリモート（`origin`）の双方に同名タグが存在しないこと

## ローカルからの publish 禁止設定（多層防御）

スキル手順書への記載だけでは、別セッションや通常対話中に誤って `npm publish` を実行するリスクを消せない。3 層でブロックする。

### 第 1 層: Claude Code（`.claude/settings.json`）

リポジトリ管理下の `.claude/settings.json` の `permissions.deny` で以下を明示拒否する：

- `Bash(npm publish)` / `Bash(npm publish *)`
- `Bash(bun publish)` / `Bash(bun publish *)`
- `Bash(pnpm publish)` / `Bash(pnpm publish *)`
- `Bash(yarn publish)` / `Bash(yarn publish *)`
- `Bash(yarn npm publish)` / `Bash(yarn npm publish *)`

### 第 2 層: Antigravity CLI（`.agents/hooks.json` + `.agents/hooks/block-local-publish.py`）

リポジトリ管理下の `.agents/hooks.json` で `PreToolUse`（`matcher: "run_command"`）を登録し、コマンド実行前に `.agents/hooks/block-local-publish.py` で解析する。

- Python 3.8 互換・標準ライブラリのみ（`shlex` による単純コマンド分解）で実装する。
- `npm` / `bun` / `pnpm` / `yarn` の `publish`（`yarn npm publish` を含む）を検出した場合、`{"decision": "deny", "reason": "..."}` を出力して即ブロックする。フラグ前置（`npm --prefix . publish`）、環境変数・ラッパー前置（`env`/`sudo`/`corepack`/`npx`）、複合コマンド（`&&`/`;`/改行）、コマンド置換（`$(...)`/バッククォート）、ネストシェル（`sh -c` / `eval`）も検出対象。
- `git commit -m "block npm publish"` や `grep "npm publish"`、`npm pack --dry-run`、`npm view` のような正当なコマンドは誤検知せず `{"decision": "allow"}`（既定の権限ポリシーへ委譲）を返す。
- 不正 JSON 等の解析不能な入力はフェイルクローズで `deny` を返す。

#### ローカル `/permissions` との併用（推奨）

Antigravity CLI を利用する開発者は、リポジトリ側の `.agents/hooks.json` に加えて、ローカルの `/permissions`（Project または Global スコープの **Denylist**）にも以下を登録しておくと、フック無効化時や別リポジトリ作業時の保険になる：

1. Antigravity CLI で `/permissions` を実行する
2. スコープ（Project または Global）を選択し、**Denylist** タブへ移動する
3. 以下をそれぞれ追加する：
   - `command(npm publish)`
   - `command(bun publish)`
   - `command(pnpm publish)`
   - `command(yarn publish)`
   - `command(yarn npm publish)`

### 第 3 層: `package.json` の `prepublishOnly`（CLI 非依存の最終防壁）

```json
"prepublishOnly": "node -e \"console.error('Local publish is disabled. Push a vX.Y.Z tag to publish via GitHub Actions OIDC (.github/workflows/publish.yml).'); process.exit(1)\""
```

- 人間の手打ちや他ツールからの `npm publish` / `bun publish` 等を即座にエラー終了させる。
- `prepublishOnly` は `npm install`・`npx`・`npm pack` では実行されないため、利用者環境や `test.yml` に影響しない。
- `.github/workflows/publish.yml` は `npm publish --ignore-scripts` を使用しているため、CI の OIDC 公開にも影響しない。

---

## テンプレート（唯一の情報源）

以下のテンプレート内の数値・ファイル一覧・PR 番号は記入例であり、実行時は必ず**実測値**で置き換える。

### バージョン上げ PR 本文テンプレート（PR #28 形式）

```markdown
## 概要

`package.json` の `version` を **<前バージョン> → <次バージョン>** に上げます。変更は 1 行のみです。

## v<前バージョン> 以降の変更

<前回タグ以降に main へ取り込まれた PR / コミットの要約。PR 番号と対応 Issue 番号を添える>

- <変更点 1>（PR #<番号>）
- <変更点 2>（PR #<番号>）

## なぜ <patch | minor | major> か

<semver 判定の根拠。配布物の挙動変化・後方互換性の有無を明記する>

## リリース前の確認

- ✅ `statusline-review`: <各機能 PR の LGTM 状況（例: PR #XX で 2 周実施し LGTM）>
- ✅ `bun run typecheck`: エラーなし
- ✅ `bun run test`: Python <件数> 件 / CLI <件数> 件（計 <合計> 件）全件通過
- ✅ `npm pack --dry-run --ignore-scripts`: `chieeeeno-claude-statusline-<次バージョン>.tgz`（6 ファイルのみ、`.py`/`.js` 実行権限あり）

マージ後、最新 `main` へ `v<次バージョン>` タグをプッシュして GitHub Actions（`publish` ワークフロー）による Trusted Publishing (OIDC) 公開を実施します。
```

### GitHub Release ノートテンプレート

```markdown
v<前バージョン> 以降の変更。<代表的な変更を一文で要約>

## <新機能 | 変更点 | 修正>

- <利用者視点での変更点（関連 PR #XX / Issue #YY）>
  - <補足が必要な詳細>

## 検証

- `bun run typecheck`: エラーなし
- `bun run test`: <合計> 件すべて pass（Python <件数> / Node CLI <件数>）
- CI: `publish` ワークフロー（`verify` → `build` → `publish` / OIDC Trusted Publishing）全ジョブ pass
- npm: `@chieeeeno/claude-statusline@<次バージョン>` 公開反映を確認済み
```

---

## スコープ外

- **プレリリース版（`-alpha` / `-rc` 等）の配信**: `publish.yml` 側が安定版 semver（`^v[0-9]+\.[0-9]+\.[0-9]+$`）のみを許可しているため対象外。
- **複数パッケージ・モノレポ対応**: 本リポジトリ専用。
- **承認なしでの完全無人リリース**: 公開操作の不可逆性を踏まえ、4 つの確認ゲートは常に維持する。

## 検証観点

実装後に以下を確認する：

- `.claude/skills/statusline-release/SKILL.md` が Claude Code と Antigravity CLI の両方から認識されること
- `.claude/settings.json` の `permissions.deny` にローカル publish コマンドが網羅されていること
- `.agents/hooks.json` + `.agents/hooks/block-local-publish.py` がローカル publish を拒否し、正当なコマンドを誤検知せず、異常入力でフェイルクローズすること
- `package.json` の `prepublishOnly` がローカル実行で非ゼロ終了し、かつ `npm pack --dry-run --ignore-scripts` の配布物 6 ファイルに一切影響しないこと
- `tests/test_block_local_publish.py` が `bun run test` に自動収集され Python 3.8 互換で全件パスすること
