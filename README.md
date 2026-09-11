# @chieeeeno/claude-statusline

**日本語** | [English](README.en.md)

[Claude Code](https://claude.com/claude-code) 用の、速くて依存ゼロの status line。

```
📁 my-repo  ⧉ feature-branch
⑂ feature/add-search  🧠 Opus 5 (1M)  ⚡ xhigh  📖 Explanatory  🤔 on
ctx ▓░░░░░░░░░ 10% 98k/1M │ 🔥 5h ▓▓▓▓▓▓▓░░░ 67% ↺2:03 (12:33) │ 📅 7d ▓▓░░░░░░░░ 22% ↺5d (5/23 10:30) │ 💰 $2.69 · 12m
```

## なぜもう 1 つ status line を作ったのか

- **描画時に Node を起動しない。** 描画は Python が担当する（約 40ms）。Node を使うのはセットアップ時に設定を書き込むときだけ。Node 製の status line は再描画のたびに 100ms 以上を起動に費やすが、Claude Code のデバウンスは 300ms しかない
- **レート制限枠が見える。** 5 時間枠と 7 日枠の使用率を、リセットまでの残り時間とリセット時刻（`↺2:03 (12:33)`）と一緒に出す。作業を続けるか切り上げるかを判断できる。時刻はローカルタイムゾーンで、日をまたぐ場合は日付も付く
- **依存ゼロ。** Python 標準ライブラリのみ

## インストール

```bash
npm install -g @chieeeeno/claude-statusline
claude-statusline --install
```

`~/.claude/settings.json` に `statusLine` の項目を書き込む（既存ファイルは事前に退避する）。Claude Code は再起動なしで反映する。

更新:

```bash
npm update -g @chieeeeno/claude-statusline
```

`--install` をやり直す必要はない。設定はパッケージのディレクトリを指しているので、新しい版がそのまま効く。

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
claude-statusline --install [--runcat]  ~/.claude/settings.json に statusLine を書き込む
claude-statusline --uninstall           statusLine の項目を消す
claude-statusline --print               stdin のペイロードを描画する（デバッグ用）
claude-statusline --version             バージョンを出す
```

設定を変えずに見た目だけ確かめる:

```bash
echo '{"model":{"display_name":"Opus 5"},"context_window":{"used_percentage":25,"total_input_tokens":50000,"context_window_size":200000}}' \
  | claude-statusline --print
```

`--uninstall` は、`statusLine` が別のプログラムを指していれば手を付けない。他のツールの設定を黙って壊さないため。

### インタプリタを指定する

セットアップは `/usr/bin/python3` を最優先し、無ければ `PATH` 上の最初の `python3` に落ちる。`/usr/bin/python3` を持たない環境（NixOS、Alpine、一部のコンテナ）では、セットアップ時点の `PATH` が解決した先がそのまま `settings.json` に焼かれ、以後そこが毎分実行される。明示的に固定できる:

```bash
claude-statusline --install --python /opt/homebrew/bin/python3
```

指定したパスは書き込む前に検査する。実際に実行できること、そして Python 3.8 以上を名乗ることを確かめる。

### RunCat Neo 連携

`--install --runcat` を付けると、[RunCat Neo](https://apps.apple.com/app/runcat) が読む形式で `~/.claude/runcat-usage.json` も書き出す。モデル・コンテキスト・レート制限の使用率が macOS のメニューバーに出る。既定では無効で、明示的に有効にしない限り何も書かない。

## 動作要件

- macOS または Linux（Windows は非対応）
- Python 3.8 以上（標準ライブラリのみを使う）
- Node 18 以上（セットアップ時のみ）
- git（ブランチのセグメント用。無くても他は描画される）

## 開発

```bash
npm test         # 両方
npm run test:py  # statusline.py を unittest で
npm run test:js  # bin/claude-statusline.js を node:test で
```

開発用の依存もゼロ。Python 側は `unittest`、CLI 側は Node 組み込みのテストランナーを使う。どちらの包みも、収集されたテストが想定件数を下回ったら失敗する。空のテストファイルも存在しないテストファイルもそれ自体は exit 0 で通ってしまい、テストを消したことが緑の CI になってしまうため。CLI のテストは毎回使い捨ての `HOME` の中で走るので、実際の `~/.claude` には触れない。

## ライセンス

MIT
