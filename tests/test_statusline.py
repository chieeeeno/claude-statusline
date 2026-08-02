"""statusline.py のユニットテスト（/usr/bin/python3 の標準 unittest で実行）。"""

import os
import re
import sys
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


class TestShortenHome(unittest.TestCase):
    def test_ホーム配下はチルダになる(self):
        home = str(Path.home())
        self.assertEqual(sl.shorten_home(home + "/work/x"), "~/work/x")

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


if __name__ == "__main__":
    unittest.main()
