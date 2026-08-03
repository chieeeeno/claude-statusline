"""statusline.py のユニットテスト（/usr/bin/python3 の標準 unittest で実行）。"""

import contextlib
import io
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import statusline as sl

ANSI = re.compile(r"\033\[[0-9;]*m")


def plain(s):
    """ANSI エスケープを除いた見た目の文字列を返す。"""
    return ANSI.sub("", s)


class TestColorFor(unittest.TestCase):
    def test_閾値ごとに色が切り替わる(self):
        self.assertEqual(sl.color_for(0), "\033[38;5;71m")
        self.assertEqual(sl.color_for(49), "\033[38;5;71m")
        self.assertEqual(sl.color_for(50), "\033[38;5;179m")
        self.assertEqual(sl.color_for(74), "\033[38;5;179m")
        self.assertEqual(sl.color_for(75), "\033[38;5;208m")
        self.assertEqual(sl.color_for(89), "\033[38;5;208m")
        self.assertEqual(sl.color_for(90), "\033[1;38;5;203m")
        self.assertEqual(sl.color_for(100), "\033[1;38;5;203m")


class TestBar(unittest.TestCase):
    def test_使用率に応じて塗り数が変わる(self):
        self.assertEqual(plain(sl.bar(0)), "░" * 10)
        self.assertEqual(plain(sl.bar(50)), "▓" * 5 + "░" * 5)
        self.assertEqual(plain(sl.bar(100)), "▓" * 10)

    def test_四捨五入される(self):
        self.assertEqual(plain(sl.bar(9)), "▓" + "░" * 9)
        self.assertEqual(plain(sl.bar(67)), "▓" * 7 + "░" * 3)

    def test_範囲外の値でも幅が保たれる(self):
        self.assertEqual(len(plain(sl.bar(-10))), 10)
        self.assertEqual(len(plain(sl.bar(150))), 10)

    def test_色付けとリセットを含む(self):
        self.assertTrue(sl.bar(10).startswith("\033[38;5;71m"))
        self.assertTrue(sl.bar(10).endswith(sl.RESET))


class TestFmtTokens(unittest.TestCase):
    def test_単位を切り替える(self):
        self.assertEqual(sl.fmt_tokens(999), "999")
        self.assertEqual(sl.fmt_tokens(1000), "1k")
        self.assertEqual(sl.fmt_tokens(97531), "98k")
        self.assertEqual(sl.fmt_tokens(200000), "200k")
        self.assertEqual(sl.fmt_tokens(1000000), "1M")
        self.assertEqual(sl.fmt_tokens(1500000), "1.5M")


class TestFmtReset(unittest.TestCase):
    def test_残り時間の単位を切り替える(self):
        now = 1000000.0
        self.assertEqual(sl.fmt_reset(now + 2820, now), "47m")
        self.assertEqual(sl.fmt_reset(now + 7380, now), "2:03")
        self.assertEqual(sl.fmt_reset(now + 432000, now), "5d")

    def test_過去や欠損ではNoneを返す(self):
        now = 1000000.0
        self.assertIsNone(sl.fmt_reset(now - 1, now))
        self.assertIsNone(sl.fmt_reset(now, now))
        self.assertIsNone(sl.fmt_reset(None, now))


class TestFmtElapsed(unittest.TestCase):
    def test_一時間未満は分のみ(self):
        self.assertEqual(sl.fmt_elapsed(752586), "12m")

    def test_一時間以上は時分(self):
        self.assertEqual(sl.fmt_elapsed(5000000), "1h23m")


class TestTruncate(unittest.TestCase):
    def test_上限以下はそのまま(self):
        self.assertEqual(sl.truncate("abc", 5), "abc")
        self.assertEqual(sl.truncate("abcde", 5), "abcde")

    def test_超過分は省略記号になる(self):
        self.assertEqual(sl.truncate("abcdef", 5), "abcd…")


class TestSanitize(unittest.TestCase):
    def test_端末制御文字を落とす(self):
        # OSC 52 はクリップボード書き込み、CSI 2J は画面消去
        self.assertEqual(sl.sanitize("a\033]52;c;cHdu\007b"), "a]52;c;cHdub")
        self.assertEqual(sl.sanitize("x\033[2Jy"), "x[2Jy")
        self.assertEqual(sl.sanitize("a\rb\nc\td"), "abcd")

    def test_ゼロ幅文字を落とす(self):
        self.assertEqual(sl.sanitize("a​b"), "ab")

    def test_通常の表示文字は残す(self):
        self.assertEqual(sl.sanitize("my-repo_v2.0"), "my-repo_v2.0")
        self.assertEqual(sl.sanitize("日本語 の 名前"), "日本語 の 名前")
        self.assertEqual(sl.sanitize("café ✅"), "café ✅")

    def test_空文字はそのまま(self):
        self.assertEqual(sl.sanitize(""), "")


class TestShortenHome(unittest.TestCase):
    def test_ホーム配下はチルダになる(self):
        home = str(Path.home())
        self.assertEqual(sl.shorten_home(home + "/work/x"), "~/work/x")

    def test_ホーム自身はチルダだけになる(self):
        home = str(Path.home())
        self.assertEqual(sl.shorten_home(home), "~")

    def test_ホーム名を接頭辞に持つ別ディレクトリは変換しない(self):
        home = str(Path.home())
        self.assertEqual(sl.shorten_home(home + "2/project"), home + "2/project")

    def test_ホーム外はそのまま(self):
        self.assertEqual(sl.shorten_home("/tmp/x"), "/tmp/x")


def payload(**over):
    """実測ペイロード相当の辞書を作り、キーワード引数で上書きする。"""
    d = {
        "cwd": "/Users/x/work/brooklyn-aura",
        "model": {"display_name": "Opus 5 (1M context)"},
        "workspace": {
            "current_dir": "/Users/x/work/brooklyn-aura",
            "project_dir": "/Users/x/work/brooklyn-aura",
            "git_worktree": "fix-DEVT-9189-task-05-followup",
            "repo": {"host": "github.com", "owner": "bloomo-inv", "name": "brooklyn-aura"},
        },
        "output_style": {"name": "Explanatory"},
        "effort": {"level": "xhigh"},
        "thinking": {"enabled": True},
        "fast_mode": False,
        "cost": {
            "total_cost_usd": 2.687,
            "total_duration_ms": 752586,
            "total_lines_added": 156,
            "total_lines_removed": 23,
        },
        "context_window": {
            "total_input_tokens": 97531,
            "context_window_size": 1000000,
            "used_percentage": 10,
        },
        # 基準時刻 1999992620 に対して five_hour は +7380 秒(2:03)、seven_day は +432000 秒(5d)
        "rate_limits": {
            "five_hour": {"used_percentage": 67, "resets_at": 2000000000},
            "seven_day": {"used_percentage": 22, "resets_at": 2000424620},
        },
    }
    d.update(over)
    return d


class TestLineLocation(unittest.TestCase):
    def test_リポジトリ名とworktree名を出す(self):
        self.assertEqual(
            plain(sl.line_location(payload(), True)),
            "📁 brooklyn-aura  ⧉ fix-DEVT-9189-task-05-followup",
        )

    def test_メインツリーではworktree部分が消える(self):
        d = payload()
        del d["workspace"]["git_worktree"]
        self.assertEqual(plain(sl.line_location(d, True)), "📁 brooklyn-aura")

    def test_originがなければディレクトリ名にフォールバックする(self):
        d = payload()
        del d["workspace"]["repo"]
        del d["workspace"]["git_worktree"]
        self.assertEqual(plain(sl.line_location(d, True)), "📁 brooklyn-aura")

    def test_git外ではチルダ短縮パスを出す(self):
        home = str(Path.home())
        d = payload(workspace={"current_dir": home + "/tmp/scratch"})
        self.assertEqual(plain(sl.line_location(d, False)), "📁 ~/tmp/scratch")

    def test_長いworktree名は切り詰める(self):
        d = payload()
        d["workspace"]["git_worktree"] = "w" * 40
        self.assertIn("w" * 31 + "…", plain(sl.line_location(d, True)))

    def test_git内でworkspaceがなくてもcwdから名前を取る(self):
        self.assertEqual(
            plain(sl.line_location({"cwd": "/tmp/some-repo"}, True)),
            "📁 some-repo",
        )

    def test_名前が取れなければ行ごと消える(self):
        self.assertEqual(sl.line_location({}, True), "")
        self.assertEqual(sl.line_location({}, False), "")

    def test_名前が取れなくてもworktreeがあれば出す(self):
        d = {"workspace": {"git_worktree": "wt"}}
        self.assertEqual(plain(sl.line_location(d, True)), "⧉ wt")

    def test_リポジトリ名の制御文字を落とす(self):
        d = payload()
        d["workspace"]["repo"]["name"] = "evil\033]52;c;cHdu\007repo"
        del d["workspace"]["git_worktree"]
        self.assertEqual(plain(sl.line_location(d, True)), "📁 evil]52;c;cHdurepo")

    def test_worktree名の制御文字を落とす(self):
        d = payload()
        d["workspace"]["git_worktree"] = "wt\033[2J"
        self.assertNotIn("\033[2J", sl.line_location(d, True))

    def test_ディレクトリ名の制御文字を落とす(self):
        d = payload(workspace={"current_dir": "/tmp/a\033[2Jb"})
        self.assertEqual(plain(sl.line_location(d, False)), "📁 /tmp/a[2Jb")

    def test_制御文字だけの名前はセグメントごと消える(self):
        d = payload()
        d["workspace"]["repo"]["name"] = "\033\007"
        del d["workspace"]["git_worktree"]
        self.assertEqual(sl.line_location(d, True), "")

    def test_切り詰めはサニタイズ後の長さで測る(self):
        # 落とした制御文字が表示幅を食わないこと
        d = payload()
        d["workspace"]["git_worktree"] = "\033" * 20 + "w" * 32
        self.assertIn("w" * 32, plain(sl.line_location(d, True)))


class TestLineSession(unittest.TestCase):
    def test_全項目を出す(self):
        self.assertEqual(
            plain(sl.line_session(payload(), "fix/DEVT-9189")),
            "⑂ fix/DEVT-9189  🧠 Opus 5 (1M)  ⚡ xhigh  📖 Explanatory  🤔 on",
        )

    def test_ブランチがなければ省略する(self):
        self.assertNotIn("⑂", plain(sl.line_session(payload(), None)))

    def test_defaultスタイルとthinking無効は省略する(self):
        d = payload(output_style={"name": "default"}, thinking={"enabled": False})
        out = plain(sl.line_session(d, "main"))
        self.assertNotIn("📖", out)
        self.assertNotIn("🤔", out)

    def test_effort非対応モデルでは省略する(self):
        d = payload()
        del d["effort"]
        self.assertNotIn("⚡", plain(sl.line_session(d, "main")))

    def test_fast_mode有効時のみ表示する(self):
        self.assertIn("🚀 fast", plain(sl.line_session(payload(fast_mode=True), "main")))

    def test_ブランチ名の制御文字を落とす(self):
        out = sl.line_session(payload(), "main\033]52;c;cHdu\007")
        self.assertNotIn("\033]52", out)
        self.assertIn("main]52;c;cHdu", plain(out))

    def test_モデル名とスタイル名の制御文字を落とす(self):
        d = payload(
            model={"display_name": "Opus\0335"},
            output_style={"name": "Ex\007pl"},
            effort={"level": "xh\033igh"},
        )
        out = sl.line_session(d, "main")
        self.assertNotIn("\033", plain(out))
        self.assertNotIn("\007", out)
        self.assertIn("🧠 Opus5", plain(out))
        self.assertIn("📖 Expl", plain(out))
        self.assertIn("⚡ xhigh", plain(out))


class TestLineMeters(unittest.TestCase):
    def test_全セグメントを出す(self):
        out = plain(sl.line_meters(payload(), 1999992620.0))
        self.assertEqual(
            out,
            "ctx ▓░░░░░░░░░ 10% 98k/1M │ 🔥 5h ▓▓▓▓▓▓▓░░░ 67% ↺2:03"
            " │ 📅 7d ▓▓░░░░░░░░ 22% ↺5d │ 💰 $2.69 · 12m · +156/-23",
        )

    def test_rate_limits欠損時はctxとコストだけになる(self):
        d = payload()
        del d["rate_limits"]
        out = plain(sl.line_meters(d, 1999992620.0))
        self.assertNotIn("🔥", out)
        self.assertNotIn("📅", out)
        self.assertTrue(out.startswith("ctx "))
        self.assertIn("💰", out)

    def test_片方の枠だけでも動く(self):
        d = payload()
        del d["rate_limits"]["seven_day"]
        out = plain(sl.line_meters(d, 1999992620.0))
        self.assertIn("🔥", out)
        self.assertNotIn("📅", out)

    def test_リセット時刻を過ぎていれば残り時間を省略する(self):
        # 両方の枠のリセット時刻を過ぎた時刻を渡す
        out = plain(sl.line_meters(payload(), 2000424621.0))
        self.assertNotIn("↺", out)

    def test_200kモデルでは分母が200kになる(self):
        d = payload()
        d["context_window"] = {
            "total_input_tokens": 50000,
            "context_window_size": 200000,
            "used_percentage": 25,
        }
        self.assertIn("50k/200k", plain(sl.line_meters(d, 1999992620.0)))

    def test_増減行数が0なら省略する(self):
        d = payload()
        d["cost"]["total_lines_added"] = 0
        d["cost"]["total_lines_removed"] = 0
        out = plain(sl.line_meters(d, 1999992620.0))
        self.assertIn("💰 $2.69 · 12m", out)
        self.assertNotIn("+0/-0", out)

    def test_使用率に応じて色が変わる(self):
        d = payload()
        d["context_window"]["used_percentage"] = 95
        self.assertIn("\033[1;38;5;203m", sl.line_meters(d, 1999992620.0))

    def test_増減行数の制御文字を落とす(self):
        # 3 行目で唯一、書式指定を挟まずに補間される値
        d = payload()
        d["cost"]["total_lines_added"] = "1\033]52;c;cHdu\007"
        d["cost"]["total_lines_removed"] = 2
        out = sl.line_meters(d, 1999992620.0)
        self.assertNotIn("\033]52", out)
        self.assertNotIn("\007", out)
        self.assertIn("+1]52;c;cHdu/-2", plain(out))


class TestRuncatEnabled(unittest.TestCase):
    def test_環境変数がなければ無効(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(sl.runcat_enabled())

    def test_環境変数があれば有効(self):
        with mock.patch.dict(os.environ, {"CLAUDE_STATUSLINE_RUNCAT": "1"}):
            self.assertTrue(sl.runcat_enabled())

    def test_空文字は無効(self):
        with mock.patch.dict(os.environ, {"CLAUDE_STATUSLINE_RUNCAT": ""}):
            self.assertFalse(sl.runcat_enabled())


class RuncatCase(unittest.TestCase):
    """HOME を一時ディレクトリに差し替えて runcat の書き出しを隔離する。

    Path.home() は POSIX では HOME を見るため、これで実 ~/.claude に触れずに済む。
    """

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        env = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        self.out = self.home / ".claude" / "runcat-usage.json"

    def snapshot(self):
        return json.loads(self.out.read_text(encoding="utf-8"))


class TestWriteRuncat(RuncatCase):
    """RunCat Neo 側のスキーマ。観点 4.5 により、この形は凍結されている。

    キー名・入れ子・値の書式を変えると、テストは黙って通るのに
    メニューバー常駐アプリだけが壊れる。ここが唯一の歯止め。
    """

    def test_スキーマ全体を固定する(self):
        sl.write_runcat(payload())
        snap = self.snapshot()
        stamp = snap.pop("lastUpdatedDate")
        self.assertRegex(stamp, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(
            snap,
            {
                "title": "Claude Code",
                "symbol": "staroflife",
                "metrics": [
                    {"title": "Model", "formattedValue": "Opus 5 (1M context)"},
                    {"title": "Context", "formattedValue": "10%", "normalizedValue": 0.1},
                    {"title": "5h", "formattedValue": "67%", "normalizedValue": 0.67},
                    {"title": "7d", "formattedValue": "22%", "normalizedValue": 0.22},
                ],
                "metricsBarValue": "10%",
            },
        )

    def test_小数の使用率は不要な0を付けない(self):
        d = payload()
        d["context_window"]["used_percentage"] = 12.5
        sl.write_runcat(d)
        snap = self.snapshot()
        self.assertEqual(snap["metrics"][1]["formattedValue"], "12.5%")
        self.assertEqual(snap["metricsBarValue"], "12.5%")

    def test_normalizedValueは小数4桁に丸める(self):
        d = payload()
        d["context_window"]["used_percentage"] = 33.333333
        sl.write_runcat(d)
        self.assertEqual(self.snapshot()["metrics"][1]["normalizedValue"], 0.3333)

    def test_ctx欠損時はContextとmetricsBarValueが消える(self):
        d = payload()
        del d["context_window"]
        sl.write_runcat(d)
        snap = self.snapshot()
        self.assertNotIn("metricsBarValue", snap)
        self.assertEqual([m["title"] for m in snap["metrics"]], ["Model", "5h", "7d"])

    def test_rate_limits欠損時はその項目が消える(self):
        d = payload()
        del d["rate_limits"]
        sl.write_runcat(d)
        self.assertEqual([m["title"] for m in self.snapshot()["metrics"]], ["Model", "Context"])

    def test_model欠損時は既定の表示名にフォールバックする(self):
        d = payload()
        del d["model"]
        sl.write_runcat(d)
        self.assertEqual(self.snapshot()["metrics"][0]["formattedValue"], "Claude Code")

    def test_親ディレクトリを作る(self):
        self.assertFalse(self.out.parent.exists())
        sl.write_runcat(payload())
        self.assertTrue(self.out.is_file())

    def test_原子的に書き込む(self):
        # 途中で読まれても壊れた JSON を見せないための機構そのものを固定する。
        # 通常の open() に退化させると、他のテストは全部通ったままここだけ落ちる
        with mock.patch.object(sl.tempfile, "mkstemp", wraps=sl.tempfile.mkstemp) as mkstemp, \
                mock.patch.object(sl.os, "replace", wraps=sl.os.replace) as replace:
            sl.write_runcat(payload())
        self.assertEqual(mkstemp.call_count, 1)
        # 一時ファイルは出力先と同じディレクトリに作る。別ファイルシステムだと
        # os.replace が原子的にならないため
        self.assertEqual(mkstemp.call_args[1]["dir"], str(self.out.parent))
        self.assertEqual(replace.call_count, 1)

    def test_一時ファイルを残さない(self):
        sl.write_runcat(payload())
        sl.write_runcat(payload())
        self.assertEqual([p.name for p in self.out.parent.iterdir()], ["runcat-usage.json"])


def run_main(raw, **env):
    """隔離した環境で main() を実行し、(stdout, stderr) を返す。

    git_branch は実際の git 実行を避けるため差し替える。
    """
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env, clear=True), \
            mock.patch.object(sl.sys, "stdin", io.StringIO(raw)), \
            mock.patch.object(sl, "git_branch", return_value=None), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        sl.main()
    return out.getvalue(), err.getvalue()


class TestMain(RuncatCase):
    def test_値の型が違っても他の行は出る(self):
        # 観点 4.8「描画は必ず返ること」の保険。ペイロードのスキーマは
        # Claude Code 側の都合で変わりうる
        raw = '{"cwd":"/tmp/some-repo","model":{"display_name":"Opus 5"},' \
              '"context_window":{"used_percentage":"25"}}'
        out, err = run_main(raw, HOME=str(self.home))
        self.assertEqual(out.count("\n"), 2)
        self.assertIn("some-repo", plain(out))
        self.assertIn("Opus 5", plain(out))
        self.assertIn("行の描画に失敗", err)

    def test_壊れた入力でも例外を投げない(self):
        out, err = run_main("not json at all", HOME=str(self.home))
        self.assertEqual(out, "")
        self.assertIn("入力の解析に失敗", err)

    def test_辞書でないペイロードでも例外を投げない(self):
        out, _ = run_main("[1,2,3]", HOME=str(self.home))
        self.assertEqual(out, "")

    def test_RUNCAT未設定ならファイルを作らない(self):
        # 観点 4.6。既定で他人の環境にファイルを作らない
        run_main(json.dumps(payload()), HOME=str(self.home))
        self.assertFalse(self.out.exists())

    def test_RUNCAT設定時に書き出す(self):
        run_main(json.dumps(payload()), HOME=str(self.home), CLAUDE_STATUSLINE_RUNCAT="1")
        self.assertEqual(self.snapshot()["title"], "Claude Code")

    def test_RUNCAT書き出しが型例外で落ちても描画は返る(self):
        # OSError しか捕まえていないと、--runcat を有効にした利用者だけが
        # スキーマ外のペイロードで 3 行とも失う
        raw = '{"cwd":"/tmp/some-repo","model":{"display_name":"Opus 5"},' \
              '"context_window":{"used_percentage":"25"}}'
        out, err = run_main(raw, HOME=str(self.home), CLAUDE_STATUSLINE_RUNCAT="1")
        self.assertIn("some-repo", plain(out))
        self.assertIn("Opus 5", plain(out))
        self.assertIn("runcat-usage.json", err)
        self.assertFalse(self.out.exists())

    def test_RUNCAT書き出しが属性例外で落ちても描画は返る(self):
        raw = '{"cwd":"/tmp/some-repo","model":"Opus 5"}'
        out, err = run_main(raw, HOME=str(self.home), CLAUDE_STATUSLINE_RUNCAT="1")
        self.assertIn("some-repo", plain(out))
        self.assertIn("runcat-usage.json", err)


if __name__ == "__main__":
    unittest.main()
