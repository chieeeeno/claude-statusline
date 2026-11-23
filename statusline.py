#!/usr/bin/python3
"""Claude Code / Google Antigravity CLI status line。

stdin で受け取った status line ペイロード(JSON)から 3 行を組み立てて stdout に出力する。
CLAUDE_STATUSLINE_RUNCAT が設定されている場合のみ runcat-usage.json
(RunCat Neo 連携) を更新する。

shebang を /usr/bin/python3 に固定しているのは、/usr/bin/env 経由だと PATH 上の
pyenv shim を掴んでしまい、1 描画あたり 60ms 以上を余計に消費するため。
"""

import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

RESET = "\033[0m"
GRAY = "\033[38;5;245m"
YELLOW = "\033[38;5;179m"
GREEN = "\033[38;5;71m"
BLUE = "\033[38;5;75m"

BAR_WIDTH = 10
SEP = f" {GRAY}│{RESET} "
_ISO_FRAC = re.compile(r"(\.\d+)(?=[+-]\d{2}:\d{2}$|$)")


def color_for(pct):
    """使用率に対応する ANSI 色の開始シーケンスを返す。

    @param pct 使用率（0-100）
    @returns ANSI エスケープシーケンス
    """
    if pct < 50:
        return "\033[38;5;71m"
    if pct < 75:
        return "\033[38;5;179m"
    if pct < 90:
        return "\033[38;5;208m"
    return "\033[1;38;5;203m"


def bar(pct, width=BAR_WIDTH):
    """使用率を塗りつぶしバーとして描画する。

    @param pct 使用率（0-100）。範囲外でも幅は width に保たれる
    @param width バーのセル数
    @returns 色付きバー文字列（末尾に RESET を含む）
    """
    filled = max(0, min(width, round(pct / 100 * width)))
    return f"{color_for(pct)}{'▓' * filled}{'░' * (width - filled)}{RESET}"


def fmt_tokens(n):
    """トークン数を短い単位付き文字列にする。

    @param n トークン数
    @returns "999" / "98k" / "1M" / "1.5M" のいずれかの形式
    """
    if n >= 1_000_000:
        return f"{round(n / 1_000_000, 1):g}M"
    if n >= 1000:
        return f"{round(n / 1000)}k"
    return str(n)


def is_antigravity(d):
    """Antigravity CLI 由来のペイロードかどうか。"""
    return d.get("product") == "antigravity"


def _is_finite_number(value):
    """bool を除く有限数値かどうか。"""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def parse_iso_timestamp(value):
    """ISO 8601 / RFC 3339 文字列を Unix 秒へ変換する（Python 3.8 互換）。

    Python 3.8 の datetime.fromisoformat は末尾の 'Z' や 3/6 桁以外の小数秒
    （Go の RFC3339Nano 等）を受け付けないため、ここで正規化してから解析する。

    @param value ISO 8601 文字列
    @returns Unix 秒（float）。解析できなければ None
    """
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip()
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1] + "+00:00"
    s = _ISO_FRAC.sub(lambda m: "." + (m.group(1)[1:] + "000000")[:6], s)
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        return dt.timestamp()
    except (OSError, OverflowError, ValueError):
        return None


def _quota_meta(bucket_id):
    """クォータのバケット ID から表示順・絵文字・短縮ラベルを決める。"""
    low = bucket_id.lower()
    if "5h" in low or "five_hour" in low or "five-hour" in low or "hourly" in low:
        return 0, "🔥", "5h"
    if "daily" in low or "24h" in low or "1d" in low:
        return 1, "📆", "1d"
    if "weekly" in low or "7d" in low or "seven_day" in low or "seven-day" in low:
        return 2, "📅", "7d"
    return 3, "📊", truncate(sanitize(bucket_id), 16)


def _select_quota_buckets(quota, model):
    """複数モデル群のクォータがある場合、アクティブモデルに合う枠を優先抽出する。"""
    items = [
        (str(k), v)
        for k, v in quota.items()
        if isinstance(k, str) and isinstance(v, dict) and not v.get("disabled")
    ]
    if len(items) <= 1 or not isinstance(model, dict):
        return items

    model_text = (
        str(model.get("id") or "") + " " + str(model.get("display_name") or "")
    ).lower()
    for token in ("gemini", "claude", "flash", "pro"):
        if token in model_text:
            matched = [item for item in items if token in item[0].lower()]
            if matched and len(matched) < len(items):
                items = matched
    return items


def quota_windows(d, now):
    """レート制限・クォータ枠を共通形式 (emoji, label, used_pct, resets_at) で返す。

    Claude Code の rate_limits と Antigravity CLI の quota を同じ描画・RunCat
    経路へ正規化する。

    @param d status line ペイロード
    @param now 現在時刻（Unix 秒）
    @returns (emoji, label, used_pct, resets_at) のリスト
    """
    windows = []
    rate_limits = d.get("rate_limits")
    if isinstance(rate_limits, dict):
        for emoji, key, label in (("🔥", "five_hour", "5h"), ("📅", "seven_day", "7d")):
            window = rate_limits.get(key)
            if not isinstance(window, dict):
                continue
            pct = window.get("used_percentage")
            if pct is not None:
                windows.append((emoji, label, pct, window.get("resets_at")))
        if windows:
            return windows

    quota = d.get("quota")
    if not isinstance(quota, dict):
        return windows

    selected = _select_quota_buckets(quota, d.get("model"))
    entries = []
    for bucket_id, bucket in selected:
        rem = bucket.get("remaining_fraction")
        if not _is_finite_number(rem):
            continue
        used_pct = max(0.0, min(100.0, (1.0 - rem) * 100.0))
        resets_at = parse_iso_timestamp(bucket.get("reset_time"))
        if resets_at is None:
            reset_in = bucket.get("reset_in_seconds")
            if _is_finite_number(reset_in) and reset_in > 0:
                resets_at = now + reset_in
        order, emoji, label = _quota_meta(bucket_id)
        entries.append((order, bucket_id, emoji, label, used_pct, resets_at))

    label_counts = {}
    for _, _, _, label, _, _ in entries:
        label_counts[label] = label_counts.get(label, 0) + 1

    entries.sort(key=lambda e: (e[0], e[1]))
    for _, bucket_id, emoji, label, used_pct, resets_at in entries:
        final_label = truncate(sanitize(bucket_id), 16) if label_counts.get(label, 0) > 1 else label
        if not final_label:
            continue
        windows.append((emoji, final_label, used_pct, resets_at))
    return windows


def reset_window(resets_at, now):
    """リセットまでの残り秒数とリセット時刻を組で返す。

    「表示してよい resets_at か」の判定はここ 1 か所に集める。残り時間と時刻で
    別々に判定すると、片方だけが値を返して噛み合わない表示になる。

    resets_at はペイロード由来なので、秒ではなくミリ秒が来たり、Infinity や
    文字列が来たりしうる。datetime にできない値はリセット時刻として意味を
    なさないので、残り時間ごと出さない。4.9 のとおり、意味のない文字列を
    並べるくらいならセグメントごと消す。ミリ秒を素通しすると ↺20684798d の
    ような、秒として読んだ日数がそのまま出る表示になる。

    @param resets_at リセット時刻（Unix 秒）。None 可
    @param now 現在時刻（Unix 秒）
    @returns (残り秒数, リセット時刻の datetime) の組。表示すべきでなければ None
    """
    if not resets_at:
        return None
    try:
        sec = int(resets_at - now)
        if sec <= 0:
            return None
        return sec, datetime.fromtimestamp(resets_at)
    except (OSError, OverflowError, TypeError, ValueError):
        return None


def fmt_reset(sec):
    """レート制限枠がリセットされるまでの残り時間。

    @param sec 残り秒数（正の整数）
    @returns "5d" / "2:03" / "47m"
    """
    if sec >= 86400:
        return f"{sec // 86400}d"
    if sec >= 3600:
        return f"{sec // 3600}:{(sec % 3600) // 60:02d}"
    return f"{sec // 60}m"


def fmt_reset_at(at, now):
    """レート制限枠がリセットされるローカル時刻。

    日付を添える条件を「24 時間以上先か」ではなく「暦日が今日と違うか」にしている。
    23:00 に翌 01:00 リセットのような場合、残りは 2 時間でも時刻だけでは翌日と読めない。

    @param at リセット時刻（ローカル datetime）
    @param now 現在時刻（Unix 秒）
    @returns "12:33" / "5/23 10:30"
    """
    if at.date() == datetime.fromtimestamp(now).date():
        return at.strftime("%H:%M")
    return "{}/{} {}".format(at.month, at.day, at.strftime("%H:%M"))


def fmt_elapsed(ms):
    """セッション経過時間を整形する。

    @param ms 経過ミリ秒
    @returns "12m" / "1h23m"
    """
    sec = int(ms // 1000)
    if sec >= 3600:
        return f"{sec // 3600}h{(sec % 3600) // 60:02d}m"
    return f"{sec // 60}m"


def truncate(s, limit):
    """長すぎる文字列を省略記号付きで切り詰める。

    @param s 対象文字列
    @param limit 表示上限の文字数
    @returns limit 以下に収まる文字列
    """
    return s if len(s) <= limit else s[: limit - 1] + "…"


def sanitize(s):
    """表示用文字列から端末制御文字を落とす。

    git のツリーエントリは / と NUL 以外の任意バイトを許すため、細工した
    リポジトリのディレクトリ名や worktree 名に OSC 52（クリップボード書き込み）や
    CSI（画面消去）を仕込める。status line は 60 秒ごとに描画されるので、
    そのまま流すと制御シーケンスが繰り返し端末に届く。

    表示に使う文字列は、ペイロード由来か外部コマンド由来かを問わず全部ここを通す。
    「どれが安全か」の判断を残すと、後から足した項目で漏れる。

    @param s 対象文字列
    @returns 印字可能な文字だけを残した文字列
    """
    return "".join(c for c in s if c.isprintable())


def shorten_home(path):
    """ホームディレクトリを ~ に置き換える。

    区切り文字まで見るのは、ホーム名を接頭辞に持つ別ディレクトリ
    （/Users/foo に対する /Users/foo2/x）を誤って短縮しないため。

    @param path 絶対パス
    @returns ~ 短縮したパス
    """
    home = str(Path.home())
    if path == home or path.startswith(home + os.sep):
        return "~" + path[len(home):]
    return path


def line_location(d, in_git):
    """1 行目: 作業対象のリポジトリと worktree。

    リポジトリ名はパスから推測せず origin リモート由来の値を優先する。
    ディレクトリ構造に依存させないため。

    @param d status line ペイロード
    @param in_git git リポジトリ内かどうか
    @returns 1 行目の文字列
    """
    ws = d.get("workspace") or {}
    name = ((ws.get("repo") or {}).get("name") or "").strip()
    if not name:
        if in_git:
            name = Path(ws.get("project_dir") or ws.get("current_dir") or d.get("cwd") or "").name
        else:
            name = shorten_home(ws.get("current_dir") or d.get("cwd") or "")
    # 切り詰めより先にサニタイズする。落とした制御文字が表示幅を食わないように
    name = sanitize(name)
    # 名前が取れないときはセグメントごと出さない。データのない枠を描かないため
    parts = [f"📁 {YELLOW}{name}{RESET}"] if name else []
    worktree = sanitize(ws.get("git_worktree") or "")
    if worktree:
        parts.append(f"⧉ {YELLOW}{truncate(worktree, 32)}{RESET}")
    return "  ".join(parts)


def line_session(d, branch):
    """2 行目: ブランチとセッションの設定状態。

    @param d status line ペイロード
    @param branch ブランチ名。git 外なら None
    @returns 2 行目の文字列
    """
    parts = []
    branch = sanitize(branch or "")
    if branch:
        parts.append(f"⑂ {GREEN}{truncate(branch, 40)}{RESET}")
    model_obj = d.get("model") or {}
    model_raw = model_obj.get("display_name") or model_obj.get("id") or ""
    model = sanitize(model_raw.replace(" context)", ")"))
    if model:
        parts.append(f"🧠 {BLUE}{model}{RESET}")
    effort = sanitize((d.get("effort") or {}).get("level") or model_obj.get("effort") or "")
    if effort:
        parts.append(f"⚡ {GRAY}{effort}{RESET}")
    style = sanitize((d.get("output_style") or {}).get("name") or "")
    if style and style != "default":
        parts.append(f"📖 {GRAY}{style}{RESET}")
    cycle_mode = sanitize(d.get("cycle_mode") or "")
    if cycle_mode:
        parts.append(f"⚙ {GRAY}{cycle_mode}{RESET}")
    if (d.get("thinking") or {}).get("enabled"):
        parts.append(f"🤔 {GRAY}on{RESET}")
    if d.get("fast_mode"):
        parts.append(f"🚀 {GRAY}fast{RESET}")
    return "  ".join(parts)


def _meter(emoji, label, pct, resets_at, now):
    """使用率メーター 1 セグメントを組み立てる。

    @param emoji 先頭に置く絵文字
    @param label ラベル文字列
    @param pct 使用率（0-100）
    @param resets_at リセット時刻（Unix 秒）。None 可
    @param now 現在時刻（Unix 秒）
    @returns セグメント文字列
    """
    seg = f"{emoji} {GRAY}{label}{RESET} {bar(pct)} {color_for(pct)}{pct:.0f}%{RESET}"
    window = reset_window(resets_at, now)
    if window:
        sec, at = window
        seg += f" {GRAY}↺{fmt_reset(sec)} ({fmt_reset_at(at, now)}){RESET}"
    return seg


def line_meters(d, now):
    """3 行目: コンテキスト・レート制限枠・コスト。

    @param d status line ペイロード
    @param now 現在時刻（Unix 秒）
    @returns 3 行目の文字列
    """
    segs = []

    cw = d.get("context_window") or {}
    used = cw.get("used_percentage")
    if used is not None:
        seg = f"{GRAY}ctx{RESET} {bar(used)} {color_for(used)}{used:.0f}%{RESET}"
        size = cw.get("context_window_size")
        if size:
            tokens = cw.get("total_input_tokens")
            if tokens is None:
                tokens = cw.get("used_tokens") or 0
            seg += f" {GRAY}{fmt_tokens(tokens)}/{fmt_tokens(size)}{RESET}"
        segs.append(seg)

    for emoji, label, pct, resets_at in quota_windows(d, now):
        segs.append(_meter(emoji, label, pct, resets_at, now))

    cost = d.get("cost") or {}
    bits = []
    usd = cost.get("total_cost_usd")
    if usd is None:
        usd = cost.get("total_usd")
    if usd is not None:
        bits.append(f"${usd:.2f}")
    duration = cost.get("total_duration_ms")
    if duration:
        bits.append(fmt_elapsed(duration))
    added = cost.get("total_lines_added") or 0
    removed = cost.get("total_lines_removed") or 0
    if added or removed:
        # この行で唯一、書式指定も算術演算も挟まない補間。他の値は :.0f や
        # fmt_tokens の比較が型を強制するので文字列は例外になって行ごと退避するが、
        # ここだけは素通りする。4.11 の一律規則どおり sanitize を通す
        bits.append(sanitize(f"+{added}/-{removed}"))
    if bits:
        segs.append(f"💰 {GRAY}{' · '.join(bits)}{RESET}")

    return SEP.join(segs)


def git_branch(cwd):
    """現在のブランチ名を取得する。

    detached HEAD では symbolic-ref が失敗するため短縮 SHA にフォールバックする。
    fsmonitor は status line の高頻度実行と相性が悪いので無効化して呼ぶ。

    @param cwd 対象ディレクトリ
    @returns ブランチ名または短縮 SHA。git リポジトリ外なら None
    """
    if not cwd:
        return None
    base = ["git", "-C", cwd, "-c", "core.fsmonitor=false"]
    for args in (["symbolic-ref", "--short", "HEAD"], ["rev-parse", "--short", "HEAD"]):
        try:
            proc = subprocess.run(base + args, capture_output=True, text=True, timeout=2)
        except (OSError, subprocess.SubprocessError):
            return None
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    return None


def runcat_enabled():
    """RunCat Neo 連携を有効にするかどうか。

    作者環境固有の連携なので既定は無効。利用者が明示的に有効化したときだけ書き出す。

    @returns 環境変数 CLAUDE_STATUSLINE_RUNCAT が空でない値で設定されていれば True
    """
    return bool(os.environ.get("CLAUDE_STATUSLINE_RUNCAT"))


def write_runcat(d):
    """RunCat Neo が読む使用量スナップショットを書き出す。

    メニューバー常駐アプリ側のスキーマなので形式を変更しない。
    Claude Code は ~/.claude/runcat-usage.json、Antigravity CLI は
    ~/.gemini/antigravity-cli/runcat-usage.json に分けて書き出す。

    @param d status line ペイロード
    """
    antigravity = is_antigravity(d)
    if antigravity:
        out = Path.home() / ".gemini" / "antigravity-cli" / "runcat-usage.json"
        default_title = "Antigravity"
    else:
        out = Path.home() / ".claude" / "runcat-usage.json"
        default_title = "Claude Code"

    ctx = (d.get("context_window") or {}).get("used_percentage")

    def metric(title, value):
        if value is None:
            return None
        return {
            "title": title,
            "formattedValue": f"{value:g}%",
            "normalizedValue": round(value / 100, 4),
        }

    model_obj = d.get("model") or {}
    model_name = model_obj.get("display_name") or model_obj.get("id") or default_title
    metrics = [
        {"title": "Model", "formattedValue": model_name},
        metric("Context", ctx),
    ]
    if antigravity:
        for _, label, pct, _ in quota_windows(d, time.time()):
            metrics.append(metric(label, round(pct, 1)))
    else:
        rate_limits = d.get("rate_limits") or {}
        metrics.append(metric("5h", (rate_limits.get("five_hour") or {}).get("used_percentage")))
        metrics.append(metric("7d", (rate_limits.get("seven_day") or {}).get("used_percentage")))

    snapshot = {
        "title": default_title,
        "symbol": "staroflife",
        "metrics": [m for m in metrics if m is not None],
        "lastUpdatedDate": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if ctx is not None:
        snapshot["metricsBarValue"] = f"{ctx:g}%"

    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".runcat-", dir=str(out.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False)
    os.replace(tmp, out)


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError) as e:
        print(f"statusline: 入力の解析に失敗しました: {e}", file=sys.stderr)
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    # RunCat 連携が壊れても status line 自体は描画する。OSError だけでは足りない。
    # ペイロードの型が想定と違えば ValueError や AttributeError が飛び、
    # それを通すと --runcat を有効にした利用者だけが 3 行とも失う
    if runcat_enabled():
        try:
            write_runcat(payload)
        except Exception as e:
            print(f"statusline: failed to update runcat-usage.json: {e}", file=sys.stderr)

    workspace = payload.get("workspace") or {}
    vcs = payload.get("vcs")
    branch = None
    if isinstance(vcs, dict) and isinstance(vcs.get("branch"), str) and vcs.get("branch").strip():
        branch = vcs.get("branch").strip()
    if not branch:
        # git_branch は OSError と SubprocessError しか見ない。current_dir が
        # 文字列でなければ subprocess.run が TypeError を投げてそこを素通りする
        try:
            branch = git_branch(workspace.get("current_dir") or payload.get("cwd"))
        except Exception:
            branch = None
    in_git = branch is not None or (isinstance(vcs, dict) and bool(vcs.get("type")))
    now = time.time()

    # 行ごとに独立して捕まえる。ペイロードのスキーマはホスト CLI 側の都合で
    # 変わりうるので、1 行が型例外で落ちても残りの行は出す
    for build in (
        lambda: line_location(payload, in_git),
        lambda: line_session(payload, branch),
        lambda: line_meters(payload, now),
    ):
        try:
            line = build()
        except Exception as e:
            print(f"statusline: 行の描画に失敗しました: {e}", file=sys.stderr)
            continue
        if line:
            print(line)


if __name__ == "__main__":
    main()
