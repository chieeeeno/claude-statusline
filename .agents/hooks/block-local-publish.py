#!/usr/bin/env python3
"""Antigravity CLI (agy) PreToolUse フック: ローカルからのパッケージ公開コマンドを拒否する。

.agents/hooks.json から run_command 実行前に呼び出される。
stdin で PreToolUse ペイロード（JSON）を受け取り、ローカル publish コマンドを
検出した場合は decision: "deny"、それ以外は decision: "allow" を stdout に返して
常に終了コード 0 で終了する（異常入力・解析不能時はフェイルクローズで deny を返す）。
"""

import json
import os
import re
import shlex
import sys

BLOCK_REASON = (
    "ローカルからのパッケージ公開コマンド（npm/bun/pnpm/yarn publish）は禁止されています。"
    "vX.Y.Z タグを main からプッシュして GitHub Actions（.github/workflows/publish.yml）の"
    " Trusted Publishing (OIDC) 経由で公開してください。"
)

INVALID_INPUT_REASON = (
    "block-local-publish フックが入力ペイロードを解析できなかったため、"
    "安全のためコマンド実行を拒否しました。"
)

PACKAGE_MANAGERS = frozenset(("npm", "bun", "pnpm", "yarn"))
SHELL_BINARIES = frozenset(("sh", "bash", "zsh", "dash", "ksh", "fish"))
SEGMENT_SEP_TOKENS = frozenset((";", "&&", "||", "|", "|&", "&", "(", ")", "\n"))
ALL_PUNCT_CHARS = frozenset(";&|()<>\n")
PUNCT_SPLIT_RE = re.compile(
    r"<<<|<<-|<<|&>>|&>|>>|>&|<&|>\||<>|\|\||&&|\|&|[;&|()<>\n]"
)
REDIR_CHARS = frozenset("<>")
LEADING_KEYWORDS = frozenset(
    (
        "if",
        "then",
        "elif",
        "else",
        "fi",
        "do",
        "done",
        "while",
        "until",
        "for",
        "in",
        "!",
        "{",
        "}",
        "coproc",
    )
)
ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
SHORT_C_FLAG_RE = re.compile(r"^-[A-Za-z]*c[A-Za-z]*$")
ENV_SHORT_S_RE = re.compile(r"^-[A-Za-z]*S(.*)$")

# 先頭引数（フラグなし）がこれらであれば publish 実行ではないと確定できるサブコマンド群
SAFE_PM_SUBCOMMANDS = frozenset(
    (
        "view",
        "info",
        "show",
        "pack",
        "test",
        "t",
        "tst",
        "run",
        "run-script",
        "install",
        "i",
        "ci",
        "add",
        "remove",
        "rm",
        "uninstall",
        "update",
        "up",
        "audit",
        "outdated",
        "ls",
        "list",
        "help",
        "version",
        "init",
        "create",
        "build",
        "start",
        "dev",
        "why",
        "explain",
        "ping",
        "whoami",
        "doctor",
        "cache",
        "config",
        "link",
        "unlink",
        "prune",
        "dedupe",
        "rebuild",
        "fund",
        "search",
        "s",
        "dlx",
    )
)

SUDO_VALUE_FLAGS = frozenset(
    (
        "-u",
        "--user",
        "-g",
        "--group",
        "-C",
        "--close-from",
        "-p",
        "--prompt",
        "-r",
        "--role",
        "-t",
        "--type",
        "-U",
        "--other-user",
        "-h",
        "--host",
        "-T",
        "--command-timeout",
        "-R",
        "--chroot",
        "-D",
        "--chdir",
    )
)
ENV_VALUE_FLAGS = frozenset(("-u", "--unset", "-C", "--chdir", "-P", "-S", "--split-string"))
TIMEOUT_VALUE_FLAGS = frozenset(("-k", "--kill-after", "-s", "--signal"))
NPX_VALUE_FLAGS = frozenset(("-p", "--package", "-c", "--call", "--userconfig"))
NICE_VALUE_FLAGS = frozenset(("-n", "--adjustment"))
SHELL_VALUE_FLAGS = frozenset(("-o", "+o", "--rcfile", "--init-file"))

MAX_DEPTH = 5


def _decode_ansi_c_escape(body):
    """ANSI-C クォート ($'...') のエスケープシーケンスを展開する。"""
    out = []
    i = 0
    n = len(body)
    simple = {
        "a": "\a",
        "b": "\b",
        "e": "\x1b",
        "E": "\x1b",
        "f": "\f",
        "n": "\n",
        "r": "\r",
        "t": "\t",
        "v": "\v",
        "\\": "\\",
        "'": "'",
        '"': '"',
        "?": "?",
    }
    while i < n:
        ch = body[i]
        if ch != "\\" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        nxt = body[i + 1]
        if nxt in simple:
            out.append(simple[nxt])
            i += 2
            continue
        if nxt == "x":
            m = re.match(r"[0-9A-Fa-f]{1,2}", body[i + 2:])
            if m:
                out.append(chr(int(m.group(0), 16)))
                i += 2 + len(m.group(0))
                continue
        if nxt == "u":
            m = re.match(r"[0-9A-Fa-f]{1,4}", body[i + 2:])
            if m:
                out.append(chr(int(m.group(0), 16)))
                i += 2 + len(m.group(0))
                continue
        if nxt == "U":
            m = re.match(r"[0-9A-Fa-f]{1,8}", body[i + 2:])
            if m:
                code = int(m.group(0), 16)
                if code <= 0x10FFFF:
                    out.append(chr(code))
                i += 2 + len(m.group(0))
                continue
        if "0" <= nxt <= "7":
            m = re.match(r"[0-7]{1,3}", body[i + 1:])
            if m:
                out.append(chr(int(m.group(0), 8) & 0xFF))
                i += 1 + len(m.group(0))
                continue
        out.append(nxt)
        i += 2
    return "".join(out)


def _normalize_ansi_c_quotes(command):
    """クォート外の $'...' を通常の単一引用符へ正規化する。"""
    out = []
    i = 0
    n = len(command)
    in_single = False
    in_double = False

    while i < n:
        ch = command[i]
        if in_single:
            out.append(ch)
            if ch == "'":
                in_single = False
            i += 1
            continue
        if in_double:
            if ch == "\\" and i + 1 < n:
                out.append(command[i:i + 2])
                i += 2
                continue
            out.append(ch)
            if ch == '"':
                in_double = False
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            out.append(command[i:i + 2])
            i += 2
            continue
        if ch == "$" and i + 1 < n and command[i + 1] == "'":
            j = i + 2
            while j < n:
                if command[j] == "\\" and j + 1 < n:
                    j += 2
                    continue
                if command[j] == "'":
                    break
                j += 1
            if j < n:
                decoded = _decode_ansi_c_escape(command[i + 2:j])
                out.append("'" + decoded.replace("'", "'\\''") + "'")
                i = j + 1
                continue
        if ch == "'":
            in_single = True
        elif ch == '"':
            in_double = True
        out.append(ch)
        i += 1
    return "".join(out)


def _make_heredoc_sentinel(command, index):
    """入力コマンド文字列と衝突しないヒアドキュメント参照トークンを生成する。"""
    prefix = "__HD"
    token = "{}_{}__".format(prefix, index)
    while token in command:
        prefix += "_"
        token = "{}_{}__".format(prefix, index)
    return token


def _parse_heredoc_line(line, in_single, in_double, in_ansi_c, command, next_index):
    """1 行のクォート状態を更新しながら、クォート外の << / <<- を抽出・置換する。

    複数行にまたがるクォート状態を引き継ぐことで、クォート文字列内の <<'EOF' 等を
    ヒアドキュメント開始と誤認するデグレを防ぐ。
    """
    specs = []
    out = []
    i = 0
    n = len(line)

    while i < n:
        ch = line[i]
        if in_single:
            out.append(ch)
            if ch == "'":
                in_single = False
            i += 1
            continue
        if in_ansi_c:
            if ch == "\\" and i + 1 < n:
                out.append(line[i:i + 2])
                i += 2
                continue
            out.append(ch)
            if ch == "'":
                in_ansi_c = False
            i += 1
            continue
        if in_double:
            if ch == "\\" and i + 1 < n:
                out.append(line[i:i + 2])
                i += 2
                continue
            out.append(ch)
            if ch == '"':
                in_double = False
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            out.append(line[i:i + 2])
            i += 2
            continue
        if ch == "$" and i + 1 < n and line[i + 1] == "'":
            in_ansi_c = True
            out.append("$'")
            i += 2
            continue
        if ch == "'":
            in_single = True
            out.append(ch)
            i += 1
            continue
        if ch == '"':
            in_double = True
            out.append(ch)
            i += 1
            continue
        if ch == "#" and (i == 0 or line[i - 1] in " \t;&|(){}"):
            out.append(line[i:])
            break
        if ch == "<" and i + 1 < n and line[i + 1] == "<":
            # ヒアストリング (<<<) は対象外
            if i + 2 < n and line[i + 2] == "<":
                out.append("<<<")
                i += 3
                continue
            j = i + 2
            strip_tabs = False
            if j < n and line[j] == "-":
                strip_tabs = True
                j += 1
            while j < n and line[j] in " \t":
                j += 1
            delim_chars = []
            quoted = False
            while j < n and line[j] not in " \t;&|()<>#\r\n":
                c = line[j]
                if c == "'" and j + 1 < n:
                    quoted = True
                    j += 1
                    while j < n and line[j] != "'":
                        delim_chars.append(line[j])
                        j += 1
                    if j < n:
                        j += 1
                elif c == '"' and j + 1 < n:
                    quoted = True
                    j += 1
                    while j < n and line[j] != '"':
                        if line[j] == "\\" and j + 1 < n:
                            j += 1
                        delim_chars.append(line[j])
                        j += 1
                    if j < n:
                        j += 1
                elif c == "\\" and j + 1 < n:
                    quoted = True
                    delim_chars.append(line[j + 1])
                    j += 2
                else:
                    delim_chars.append(c)
                    j += 1
            delim = "".join(delim_chars)
            if delim:
                sentinel = _make_heredoc_sentinel(command, next_index)
                next_index += 1
                specs.append((delim, strip_tabs, quoted, sentinel))
                out.append("<< " + sentinel)
                i = j
                continue
        out.append(ch)
        i += 1

    return "".join(out), specs, in_single, in_double, in_ansi_c, next_index


def _strip_heredocs(command):
    """ヒアドキュメント本文をシェル構文から分離し、対応セグメントへ紐付けるマップを返す。

    - クォート付き (<<'EOF' 等) の本文はシェル展開されないため置換スキャン対象外とし、
      heredoc_map のみに格納する（SHELL_BINARIES の標準入力として渡される場合は検査する）。
    - 非クォート (<<EOF) の本文は heredoc_map に加え、$(...) / `...` 検査用にも返す。
    """
    lines = command.splitlines(True)
    kept_lines = []
    unquoted_bodies = []
    heredoc_map = {}
    pending = []
    in_single = False
    in_double = False
    in_ansi_c = False
    next_index = 0

    for line in lines:
        if pending:
            delim, strip_tabs, quoted, sentinel, buf = pending[0]
            cmp_line = line.rstrip("\r\n")
            if strip_tabs:
                cmp_line = cmp_line.lstrip("\t")
            if cmp_line == delim:
                body = "".join(buf)
                heredoc_map[sentinel] = body
                if not quoted and body:
                    unquoted_bodies.append(body)
                pending.pop(0)
            else:
                buf.append(line)
            continue

        rewritten, specs, in_single, in_double, in_ansi_c, next_index = _parse_heredoc_line(
            line, in_single, in_double, in_ansi_c, command, next_index
        )
        kept_lines.append(rewritten)
        for delim, strip_tabs, quoted, sentinel in specs:
            pending.append((delim, strip_tabs, quoted, sentinel, []))

    # 終端行がないまま入力が終わった場合も回収した本文を保持する
    for _, _, quoted, sentinel, buf in pending:
        body = "".join(buf)
        heredoc_map[sentinel] = body
        if not quoted and body:
            unquoted_bodies.append(body)

    return "".join(kept_lines), unquoted_bodies, heredoc_map


def _strip_shell_comments(command):
    """クォート外の # コメントを行末改行を残して除去する。"""
    out = []
    i = 0
    n = len(command)
    in_single = False
    in_double = False

    while i < n:
        ch = command[i]
        if in_single:
            out.append(ch)
            if ch == "'":
                in_single = False
            i += 1
            continue
        if in_double:
            if ch == "\\" and i + 1 < n:
                out.append(command[i:i + 2])
                i += 2
                continue
            out.append(ch)
            if ch == '"':
                in_double = False
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            out.append(command[i:i + 2])
            i += 2
            continue
        if ch == "'":
            in_single = True
            out.append(ch)
            i += 1
            continue
        if ch == '"':
            in_double = True
            out.append(ch)
            i += 1
            continue
        if ch == "#" and (i == 0 or command[i - 1] in " \t\r\n;&|(){}"):
            while i < n and command[i] != "\n":
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _extract_substitutions(command):
    """単一引用符の外側にある $(...) と `...` の中身を抽出する。"""
    results = []
    n = len(command)
    i = 0
    in_single = False
    in_double = False

    while i < n:
        ch = command[i]
        if in_single:
            if ch == "'":
                in_single = False
            i += 1
            continue

        if ch == "\\" and i + 1 < n:
            i += 2
            continue

        if ch == "'" and not in_double:
            in_single = True
            i += 1
            continue

        if ch == '"':
            in_double = not in_double
            i += 1
            continue

        if ch == "$" and i + 1 < n and command[i + 1] == "(":
            start = i + 2
            j = start
            depth = 1
            sub_single = False
            sub_double = False
            while j < n and depth > 0:
                c = command[j]
                if sub_single:
                    if c == "'":
                        sub_single = False
                elif c == "\\" and j + 1 < n:
                    j += 2
                    continue
                elif c == "'" and not sub_double:
                    sub_single = True
                elif c == '"':
                    sub_double = not sub_double
                elif not sub_double:
                    if c == "(":
                        depth += 1
                    elif c == ")":
                        depth -= 1
                        if depth == 0:
                            break
                j += 1
            results.append(command[start:j])
            i = j + 1 if j < n else n
            continue

        if ch == "`":
            start = i + 1
            j = start
            while j < n:
                if command[j] == "\\" and j + 1 < n:
                    j += 2
                    continue
                if command[j] == "`":
                    break
                j += 1
            results.append(command[start:j])
            i = j + 1 if j < n else n
            continue

        i += 1

    return results


def _is_redirection_token(tok):
    """リダイレクト演算子トークン（<, >, >>, >&, <&, <<, <<< 等）か判定する。"""
    if not tok:
        return False
    if tok[0] in REDIR_CHARS and all(ch in "<>&|-" for ch in tok):
        return True
    return False


def _strip_redirections(tokens, heredoc_map):
    """セグメントからシェルリダイレクトを除去し、(残余トークン, 標準入力文字列一覧) を返す。"""
    cleaned = []
    here_inputs = []
    i = 0
    n = len(tokens)
    while i < n:
        tok = tokens[i]
        if _is_redirection_token(tok):
            if cleaned and cleaned[-1].isdigit():
                cleaned.pop()
            if tok == "<<<" and i + 1 < n:
                here_inputs.append(tokens[i + 1])
                i += 2
                continue
            if tok in ("<<", "<<-") and i + 1 < n:
                body = heredoc_map.get(tokens[i + 1])
                if body is not None:
                    here_inputs.append(body)
                i += 2
                continue
            # リダイレクト対象トークンもスキップする
            i += 2 if i + 1 < n else 1
            continue
        cleaned.append(tok)
        i += 1
    return cleaned, here_inputs


def _split_segments(command):
    """シェルコマンドを単純コマンド単位のトークン列に分解する。"""
    lex = shlex.shlex(command, posix=True, punctuation_chars=";&|()<>\n")
    # 空白と区切り・リダイレクト演算子のみで分割する（URL の : 等で割れないようにする）
    lex.whitespace_split = True
    # 改行を空白ではなくコマンド区切りトークンとして扱う
    lex.whitespace = " \t\r"
    # コメントは前処理で改行を残して除去済みのため shlex 側では無効化する
    lex.commenters = ""
    raw_tokens = list(lex)

    # 連続した記号トークン（\n<, (<, ;>, &&<, \n&>, \n\n 等）を個別のシェル演算子へ分解する
    expanded = []
    for tok in raw_tokens:
        if tok and all(ch in ALL_PUNCT_CHARS for ch in tok):
            expanded.extend(PUNCT_SPLIT_RE.findall(tok))
        else:
            expanded.append(tok)

    segments = []
    current = []
    for tok in expanded:
        if tok in SEGMENT_SEP_TOKENS:
            if current:
                segments.append(current)
                current = []
        elif tok in ("&>", "&>>"):
            # &> / &>> リダイレクトは次トークンとともに除去できるようリダイレクト扱いに変換
            current.append(">" + tok[1:])
        else:
            current.append(tok)
    if current:
        segments.append(current)
    return segments


def _pm_invokes_publish(args):
    """npm / bun / pnpm / yarn の引数リストが publish サブコマンドを起動するか判定する。

    既知オプション一覧に依存すると未登録オプションの値で誤判定されるため、
    フラグなしで先頭に明確な安全サブコマンドが来る場合を除き、-- より前に
    publish トークンが現れるかを検査する。
    """
    if not args:
        return False
    if args[0] in SAFE_PM_SUBCOMMANDS:
        return False
    for tok in args:
        if tok == "--":
            break
        if tok == "publish":
            return True
    return False


def _strip_package_version(token):
    """npx / bunx で指定されたパッケージ名（例: npm@latest）から @version を外す。"""
    base = os.path.basename(token)
    if base.startswith("@"):
        return base
    return base.split("@", 1)[0]


def _segment_is_publish(raw_tokens, depth, heredoc_map):
    """単一コマンドのトークン列がローカル publish を実行するか判定する。"""
    if depth > MAX_DEPTH:
        return True

    tokens, here_inputs = _strip_redirections(raw_tokens, heredoc_map)
    idx = 0
    n = len(tokens)

    while idx < n:
        tok = tokens[idx]
        if tok in LEADING_KEYWORDS or ENV_ASSIGN_RE.match(tok):
            idx += 1
            continue

        cmd = os.path.basename(tok)

        if cmd in ("command", "builtin", "nohup", "time"):
            idx += 1
            while idx < n and tokens[idx].startswith("-"):
                if tokens[idx] == "--":
                    idx += 1
                    break
                idx += 1
            continue

        if cmd == "nice":
            idx += 1
            while idx < n and tokens[idx].startswith("-"):
                flag = tokens[idx]
                if flag == "--":
                    idx += 1
                    break
                if flag in NICE_VALUE_FLAGS and idx + 1 < n:
                    idx += 2
                    continue
                idx += 1
            continue

        if cmd == "exec":
            idx += 1
            while idx < n and tokens[idx].startswith("-"):
                flag = tokens[idx]
                if flag == "--":
                    idx += 1
                    break
                idx += 2 if flag == "-a" else 1
            continue

        if cmd == "env":
            idx += 1
            while idx < n:
                arg = tokens[idx]
                if arg == "--":
                    idx += 1
                    break
                if arg in ("-S", "--split-string") and idx + 1 < n:
                    if is_local_publish_command(tokens[idx + 1], depth + 1):
                        return True
                    idx += 2
                    continue
                if arg.startswith("--split-string="):
                    if is_local_publish_command(arg[len("--split-string="):], depth + 1):
                        return True
                    idx += 1
                    continue
                m_short_s = ENV_SHORT_S_RE.match(arg)
                if m_short_s:
                    inline_val = m_short_s.group(1)
                    if inline_val:
                        if is_local_publish_command(inline_val, depth + 1):
                            return True
                        idx += 1
                    elif idx + 1 < n:
                        if is_local_publish_command(tokens[idx + 1], depth + 1):
                            return True
                        idx += 2
                    else:
                        idx += 1
                    continue
                if arg in ENV_VALUE_FLAGS and idx + 1 < n:
                    idx += 2
                    continue
                if arg.startswith("-") or ENV_ASSIGN_RE.match(arg):
                    idx += 1
                    continue
                break
            continue

        if cmd == "sudo":
            idx += 1
            while idx < n:
                arg = tokens[idx]
                if arg == "--":
                    idx += 1
                    break
                if arg in SUDO_VALUE_FLAGS and idx + 1 < n:
                    idx += 2
                    continue
                if arg.startswith("-") or ENV_ASSIGN_RE.match(arg):
                    idx += 1
                    continue
                break
            continue

        if cmd == "timeout":
            idx += 1
            while idx < n and tokens[idx].startswith("-"):
                flag = tokens[idx]
                if flag == "--":
                    idx += 1
                    break
                idx += 2 if flag in TIMEOUT_VALUE_FLAGS else 1
            # タイムアウト秒数トークンを飛ばす
            if idx < n:
                idx += 1
            continue

        if cmd == "corepack":
            idx += 1
            continue

        if cmd in ("npx", "bunx"):
            idx += 1
            while idx < n and tokens[idx].startswith("-"):
                flag = tokens[idx]
                if flag == "--":
                    idx += 1
                    break
                if flag in ("-c", "--call") or SHORT_C_FLAG_RE.match(flag):
                    if idx + 1 < n:
                        if is_local_publish_command(tokens[idx + 1], depth + 1):
                            return True
                        idx += 2
                        continue
                if flag.startswith("--call="):
                    if is_local_publish_command(flag[len("--call="):], depth + 1):
                        return True
                    idx += 1
                    continue
                if flag in NPX_VALUE_FLAGS and idx + 1 < n:
                    idx += 2
                    continue
                idx += 1
            if idx < n and _strip_package_version(tokens[idx]) in PACKAGE_MANAGERS:
                return _pm_invokes_publish(tokens[idx + 1:])
            continue

        if cmd == "eval":
            rest_tokens = tokens[idx + 1:]
            if rest_tokens and rest_tokens[0] == "--":
                rest_tokens = rest_tokens[1:]
            return is_local_publish_command(" ".join(rest_tokens), depth + 1)

        if cmd in SHELL_BINARIES:
            for inp in here_inputs:
                if is_local_publish_command(inp, depth + 1):
                    return True
            j = idx + 1
            while j < n:
                arg = tokens[j]
                if arg == "--":
                    break
                if arg in SHELL_VALUE_FLAGS:
                    j += 2
                    continue
                if arg.startswith("--"):
                    j += 1
                    continue
                if len(arg) >= 2 and arg[0] in ("-", "+") and arg[1:].isalpha():
                    flags_part = arg[1:]
                    has_o = "o" in flags_part
                    has_c = (arg[0] == "-") and ("c" in flags_part)
                    j += 1
                    if has_o and has_c:
                        o_pos = flags_part.index("o")
                        c_pos = flags_part.index("c")
                        if o_pos < c_pos:
                            if j < n:
                                j += 1
                            if j < n and tokens[j] == "--":
                                j += 1
                            if j < n and is_local_publish_command(tokens[j], depth + 1):
                                return True
                        else:
                            if j < n and is_local_publish_command(tokens[j], depth + 1):
                                return True
                        break
                    if has_o:
                        if j < n:
                            j += 1
                        continue
                    if has_c:
                        if j < n and tokens[j] == "--":
                            j += 1
                        if j < n and is_local_publish_command(tokens[j], depth + 1):
                            return True
                        break
                    continue
                if arg.startswith("-") or arg.startswith("+"):
                    j += 1
                    continue
                break
            return False

        if cmd in PACKAGE_MANAGERS:
            return _pm_invokes_publish(tokens[idx + 1:])

        return False

    return False


def is_local_publish_command(command, depth=0):
    """与えられたシェルコマンド文字列にローカル publish 実行が含まれるか判定する。"""
    if not isinstance(command, str) or not command.strip():
        return False
    if depth > MAX_DEPTH:
        return True

    stripped_cmd, unquoted_heredocs, heredoc_map = _strip_heredocs(command)
    normalized = _normalize_ansi_c_quotes(stripped_cmd)
    no_comments = _strip_shell_comments(normalized)

    for body in unquoted_heredocs:
        for sub in _extract_substitutions(body):
            if is_local_publish_command(sub, depth + 1):
                return True

    for sub in _extract_substitutions(no_comments):
        if is_local_publish_command(sub, depth + 1):
            return True

    try:
        segments = _split_segments(no_comments)
    except ValueError:
        # 解析不能なシェル構文はフェイルクローズで拒否する
        return True

    for seg in segments:
        if _segment_is_publish(seg, depth, heredoc_map):
            return True
    return False


def evaluate_payload(payload):
    """PreToolUse ペイロードを評価し、フック応答辞書を返す。"""
    if not isinstance(payload, dict):
        return {"decision": "deny", "reason": INVALID_INPUT_REASON}

    tool_call = payload.get("toolCall")
    if not isinstance(tool_call, dict):
        return {"decision": "deny", "reason": INVALID_INPUT_REASON}

    tool_name = tool_call.get("name")
    if isinstance(tool_name, str) and tool_name != "run_command":
        return {"decision": "allow"}

    args = tool_call.get("args")
    if not isinstance(args, dict):
        return {"decision": "deny", "reason": INVALID_INPUT_REASON}

    command = args.get("CommandLine")
    if command is None:
        command = args.get("commandLine")
    if not isinstance(command, str):
        return {"decision": "deny", "reason": INVALID_INPUT_REASON}

    if is_local_publish_command(command):
        return {"decision": "deny", "reason": BLOCK_REASON}
    return {"decision": "allow"}


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        result = {"decision": "deny", "reason": INVALID_INPUT_REASON}
    else:
        result = evaluate_payload(payload)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
