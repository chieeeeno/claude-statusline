# コードレビュー観点 — @chieeeeno/claude-statusline

作成日: 2026-08-02

## この文書の使い方

`quality-reviewer` と `security-reviewer` の 2 エージェントは、レビュー開始時に**必ずこの文書を読んでから**差分を見る。審査項目の唯一の情報源はここであり、エージェント定義側には項目を複製しない。観点を足したいときはこの文書だけを直す。

- 第 2 章「共通の規律」と第 3 章「重大度の定義」は**両エージェントが読む**
- 第 4 章は `quality-reviewer` が、第 5 章は `security-reviewer` が担当する
- 第 6 章「検証手段」と第 7 章「指摘しないもの」も両方が読む

担当外の章を読むこと自体は構わないが、担当外の指摘は出さない。重複した指摘は統合時のノイズになる。

## 1. このパッケージについて（判断の前提）

`@chieeeeno/claude-statusline` は Claude Code の status line を 3 行で描画する npm パッケージ。

描画エンジンは `statusline.py`（Python、標準ライブラリのみ）。**npm はインストーラとしてのみ使う。** `bin/claude-statusline.js` が `~/.claude/settings.json` に「Python インタプリタの実体パス + パッケージ内 `statusline.py` の絶対パス」を直接書き込むため、**描画時に Node は起動しない**。

Claude Code は 300ms のデバウンスで status line を呼ぶ。実測の描画時間は 46ms。競合パッケージはいずれも Node 製で毎描画 100ms 以上を消費しており、そこに勝つことがこのパッケージの存在理由そのものである。

判断に迷ったときの原則は 2 つ。

1. **利用者の環境を壊さないこと。** このパッケージは利用者の `settings.json` を書き換え、そこに書いたコマンドが利用者の環境で毎分実行される
2. **描画を速く保つこと。** 遅くなった時点で、このパッケージを選ぶ理由が消える

## 2. 共通の規律

両エージェントが従う。

- **裏付けの取れない指摘は捨てる。** 検証できず、検証手段もないものは仮説であって指摘ではない
- **再現シナリオを必ず添える。** 具体的な入力・状態 → 具体的に誤った結果。これが書けないなら、その指摘は実在しない。消すこと
- **検証に使ったコマンドと結果を書く。** 検証できなかった場合は、その理由を明示して「未検証」と示す
- **実際の `~/.claude/settings.json` には絶対に触らない。** CLI の挙動確認は `HOME=$(mktemp -d)` の隔離環境で行う
- **沈黙は有効な結果。** 問題がなければ「問題なし」と一行で返す。指摘を捻り出さない
- **`Consider` は 3 件まで。** それ以上あるなら水増しである

## 3. 重大度の定義

| 重大度 | 定義 | ループ継続 |
| --- | --- | --- |
| **Blocker** | 第 4 章の不変条件に違反する、文書化された挙動を壊す、利用者の `settings.json` を破損させる | ✅ 修正対象 |
| **Security: Critical** | 利用者環境での任意コード実行、認証情報や機微情報の外部流出 | ✅ 修正対象 |
| **Security: High** | 条件付きで上記に至る経路、機微情報のローカル漏えい、公開物への混入 | ✅ 修正対象 |
| **Should fix** | 具体的な失敗シナリオを持つ実在の欠陥。ただしリリースを止めるほどではない | ❌ 報告のみ |
| **Security: Medium** | 悪用に前提条件が多い、影響が限定的 | ❌ 報告のみ |
| **Consider** | 明瞭性・堅牢性の実質的な改善 | ❌ 報告のみ |
| **Security: Low** | 理論上の懸念、多層防御としての改善 | ❌ 報告のみ |

**Blocker とセキュリティ High 以上のみが修正対象**であり、これらが 0 件になった時点で LGTM。ここを緩めるとリリースに関係のない改善で永久にループが回る。

## 4. 品質観点（quality-reviewer 担当）

以下は**不変条件**である。違反はコードがどれだけ綺麗でも Blocker。

### 4.1 描画パスに Node を入れない

Node コードを書いてよいのは `bin/claude-statusline.js` だけで、それはセットアップ時にしか走らない。`statusline.py` は単独で実行できなければならない。

`settings.json` に書き込む `command` が `node` や `npx` を経由する形に変わっていたら Blocker。

### 4.2 Python 標準ライブラリのみ

`statusline.py` とテストに第三者パッケージの import を入れない。依存ゼロは README で謳っている差別化要素である。

### 4.3 Python 3.8 互換

macOS の `/usr/bin/python3` は 3.9、CI は Ubuntu ランナー標準の `python3` も使う。以下は使わない。

- `match` 文
- 実行時に評価される `X | Y` 型ユニオン
- `dict | dict` のマージ演算子
- `str.removeprefix` / `str.removesuffix`

`/usr/bin/python3 -m py_compile statusline.py` で構文レベルの確認ができる。

### 4.4 個人環境固有の値を書かない

ホームディレクトリの絶対パス、pyenv のパス、作者固有のファイル名を `statusline.py` に埋め込まない。

**例外**: `#!/usr/bin/python3` の shebang は意図的であり**指摘対象外**。むしろ `#!/usr/bin/env python3` へ変更されていたら Blocker とする。`env` 経由だと `PATH` 上の pyenv shim を掴み、1 描画あたり 60ms 以上を余計に消費するため。

### 4.5 `runcat-usage.json` のスキーマを凍結する

RunCat Neo（メニューバー常駐アプリ）が読む形式なので、キー名・入れ子・値の書式を変えない。書き込みは原子的（`tempfile.mkstemp` + `os.replace`）を維持する。途中で読まれても壊れた JSON を見せないため。

`tests/test_statusline.py` の `TestWriteRuncat` がスナップショット全体と書き込み機構の両方を固定している。`formattedValue` の改名も、通常の `open()` への退化も、ここだけが落ちる。**このクラスの検査を緩める差分は Blocker として扱う。** 検証は `npm run test:py`。

### 4.6 RunCat はオプトイン

環境変数 `CLAUDE_STATUSLINE_RUNCAT` が空でない値で設定されていない限り、`~/.claude/runcat-usage.json` に**一切書かない**。既定で他人の環境にファイルを作らない。

### 4.7 `settings.json` を壊さない

- 書き込み前に必ずタイムスタンプ付きのバックアップを取る
- 無関係なキー（`permissions` / `hooks` / `env` など）が書き込み後も残る
- `--install` は冪等。何度実行しても結果が同じ
- `--uninstall` は、`command` が自パッケージのパスを含まない `statusLine` を消さない。他ツールが設定したものを黙って壊さないため
- `settings.json` が壊れた JSON だったとき、上書きせずエラーで停止する

### 4.8 描画をブロックしない

- ネットワーク呼び出しを入れない
- `subprocess` には timeout を付ける
- 外部コマンドが失敗・タイムアウトしたら、エラー表示やハングではなく**そのセグメントの欠落**に退避する

status line が固まると Claude Code の画面が固まって見える。描画は必ず返ること。

### 4.9 データがなければセグメントごと消す

`--` / `N/A` / `0%` などのプレースホルダを出さない。セグメントは実データを持つか、存在しないかのどちらか。3 行に情報が詰まっているため、意味のない文字を並べる余地がない。

### 4.10 パッケージ衛生

- `files` に `tests/` `.github/` `docs/` `.claude/` を含めない。**`npm pack --dry-run` で確認する。** `files` フィールドの目視は確認したことにならない
- `publishConfig.access` は `"public"`。スコープ付きパッケージはこれがないと publish が権限エラーで落ちる
- `os` は `["darwin", "linux"]`。Windows は意図的に非対応
- `statusline.py` と `bin/claude-statusline.js` は実行可能（755）
- `dependencies` と `devDependencies` を増やさない。テストは Python の `unittest` と Node の `node:test` だけで回している

### 4.11 表示文字列は必ず `sanitize` を通す

git のツリーエントリは `/` と NUL 以外の任意バイトを許すため、細工したリポジトリのディレクトリ名・worktree 名に端末制御シーケンスを仕込める。status line は 60 秒ごとに描画されるので、素通しにすると OSC 52（クリップボード書き込み）や CSI（画面消去・出力偽装）が繰り返し端末に届く。

ペイロード由来か外部コマンド由来かを問わず、stdout に出す文字列は `statusline.py` の `sanitize` を通す。**新しいセグメントを足すときに通し忘れたら Blocker。** 「この値は安全」という個別判断を残さないための一律規則である。

検証は `npm run test:py`（`TestSanitize` と `line_location` / `line_session` の制御文字テスト）と、次の実行:

```bash
printf '{"workspace":{"current_dir":"/tmp/a\\u001b]52;c;cHdu\\u0007b"}}' | python3 statusline.py | cat -v
```

出力に `^[` や `^G` が現れたら違反。

### 4.12 テストの不在を成功にしない

`unittest` も `node --test` も、テストを 1 件も収集できないまま exit 0 を返す（テストファイルを空にすると再現する）。`tests/run_suite.py` と `tests/run_suite.js` が件数の下限を見ているのはこのため。

**下限を下げる差分、およびこの包みを外して素の `unittest` / `node --test` に戻す差分は Blocker。** テストの削除が緑の CI として通る状態に戻る。

## 5. セキュリティ観点（security-reviewer 担当）

**攻撃者の視点で読む。** 「この入力を細工したら何ができるか」「この経路で利用者の環境に何を仕込めるか」を先に考え、そのうえでコードがそれを防いでいるかを確かめる。

### 5.1 コマンド注入・`settings.json` 汚染

このパッケージの最大の攻撃面。`settings.json` に書いた `command` は**シェル経由で毎分実行される**。

- **`command` 文字列の組み立て。** パスを引用符なしで連結していないか。パッケージパスや Python パスに空白・シェルメタ文字（`;` `|` `&` `$` `` ` `` `(` `)` 改行）が含まれたときに何が起きるか
- **環境変数プレフィックスの注入。** `--runcat` で付ける `CLAUDE_STATUSLINE_RUNCAT=1 ` の前後に任意の文字列が入り込む経路がないか
- **他ツール設定の破壊。** `--install` / `--uninstall` が意図しないキーを消していないか
- **バックアップの不備。** バックアップを取らずに書く経路、バックアップ自体が上書きされる経路
- **バックアップファイルのパーミッション。** `settings.json` に機微な設定が入っている場合、バックアップが緩い権限で作られていないか

### 5.2 機微情報の漏えい

status line のペイロードには `session_id`、`transcript_path`、`cwd` が含まれる。

- これらがログ・標準エラー出力・一時ファイル・`runcat-usage.json` に流れていないか
- 実測値を含むファイル（`handover/artifacts/statusline-payload.json` など）がコミットされていないか、npm 公開物に混入していないか。`handover/` は `.gitignore` で除外されている前提が崩れていないか
- エラーメッセージがパスやトークンをそのまま出していないか
- 一時ファイルが予測可能な名前で `/tmp` に作られ、他ユーザーから読めないか

### 5.3 サプライチェーン（npm 公開物）

- `postinstall` / `preinstall` などのライフサイクルスクリプトが**存在しないこと**。インストールしただけでコードが走る構造にしない
- `dependencies` が空であること。依存が増えた時点で、その依存の乗っ取りリスクを引き受けることになる
- `files` が最小であること。意図しないファイルが公開物に入っていないか
- パッケージ名が既存パッケージの typosquat と誤解される形になっていないか
- `repository` の URL が正しいこと。別のリポジトリを指していないか

### 5.4 ファイル操作・実行の安全性

- **一時ファイルの競合とパーミッション。** `mkstemp` を使っているか、`os.replace` で原子的に置き換えているか、作成されるファイルのモードは妥当か
- **シンボリックリンクの追従。** `~/.claude/settings.json` や出力先がシンボリックリンクだったときに、意図しない場所へ書かないか
- **`subprocess` の引数組み立て。** `shell=True` を使っていないか。ユーザー由来の値（ブランチ名、ディレクトリ名）を引数に渡すときの扱い。timeout の有無
- **`PATH` 上の `python3` を掴むことによるハイジャック。** インタプリタ解決が `PATH` に依存する経路と、その結果が `settings.json` に焼き込まれることの影響
- **`git` 実行時の作業ディレクトリ。** 攻撃者が用意したリポジトリ内で実行されたときに、`git` の設定（`core.fsmonitor` など）経由でコードが走らないか

## 6. 検証手段

報告する前に自分で確かめる。使えるコマンドは以下。

| 確認対象 | 手段 | 期待 |
| --- | --- | --- |
| テストの成否 | `npm test` | 全件 OK。実際の件数を報告に書く |
| 描画側だけ | `npm run test:py` | 全件 OK |
| インストーラだけ | `npm run test:js` | 全件 OK |
| テストが実在すること | テストファイルを空にして `npm test` | exit 1。exit 0 なら 4.12 違反 |
| Python 3.8 構文互換 | `/usr/bin/python3 -m py_compile statusline.py` | エラーなし |
| 描画時間 | ペイロードを渡して 10 回実行し合計を測る | 0.6 秒未満（1 回あたり 60ms 未満） |
| CLI の挙動 | `HOME=$(mktemp -d)` の隔離環境で再現する | 期待どおり。**実 `~/.claude` は触らない** |
| 配布物の中身 | `npm pack --dry-run` | `tests/` `.github/` `docs/` `.claude/` が含まれない |
| 依存の有無 | `package.json` の `dependencies` / `devDependencies` を確認 | 存在しない、または空 |

描画時間の計測例:

```bash
PAYLOAD='{"model":{"display_name":"Opus 5"},"context_window":{"used_percentage":25,"total_input_tokens":50000,"context_window_size":200000}}'
time (for i in $(seq 10); do echo "$PAYLOAD" | /usr/bin/python3 statusline.py > /dev/null; done)
```

ペイロードはインラインで組み立てる。リポジトリ外のファイルに依存しない。

## 7. 指摘しないもの

以下は毎回同じノイズになるため、指摘の対象外とする。

- **スタイルの好み。** 行の折り返し位置、命名の趣味、関数の並び順
- **テストフレームワークの変更提案。** `unittest` と `node:test` は依存ゼロを保つための意図的な選択。pytest や vitest を勧めない
- **依存の追加提案。** 「このライブラリを使えば短く書ける」は、このパッケージでは改悪
- **描画エンジンの別言語での書き直し。** Python であることが設計の中核
- **日本語のコメントと docstring。** コード内のコメントは日本語が規約。英語にするのは stderr メッセージと CLI のヘルプのみ
- **README が日本語であること。** `README.md`（日本語、GitHub と npm のトップに出る）と `README.en.md`（英語）の 2 本立てが規約。**ただし、片方だけを更新した差分は指摘する。** 内容の食い違いは実害になる
- **`#!/usr/bin/python3` の shebang。** 4.4 のとおり意図的
- **カスタマイズ機能・Windows 対応・`session_name` 表示・git のファイル変更数表示がないこと。** いずれも初版のスコープ外として明示的に見送った項目

## 8. 観点を追加するとき

この文書に追記する。エージェント定義には書かない。

追加する項目には、**それが Blocker なのかそうでないのか**と、**どう検証するのか**を必ず書く。検証手段のない観点は、書いた瞬間から偽陽性の温床になる。
