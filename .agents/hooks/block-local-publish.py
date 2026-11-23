#!/usr/bin/env python3
"""Antigravity CLI (agy) PreToolUse フック: ローカルからのパッケージ公開コマンドを拒否する。

.agents/hooks.json から run_command 実行前に呼び出される。
stdin で PreToolUse ペイロード（JSON）を受け取り、ローカル publish コマンドを
検出した場合は decision: "deny"、それ以外は decision: "allow" を stdout に返して
常に終了コード 0 で終了する（異常入力時はフェイルクローズで deny を返す）。
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
SEPARATORS = frozenset((";", "&&", "||", "|", "&", "(", ")", "\n"))
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
    )
)
ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
SHORT_C_FLAG_RE = re.compile(r"^-[A-Za-z]*c[A-Za-z]*$")

# パッケージマネージャのサブコマンド前に値を取る主なグローバルオプション
PM_VALUE_FLAGS = frozenset(
    (
        "-C",
        "--prefix",
        "--cwd",
        "--dir",
        "--registry",
        "--userconfig",
        "--globalconfig",
        "--cache",
        "--filter",
        "-F",
        "--workspace",
        "-w",
        "--config",
        "-c",
        "--env-file",
        "--loglevel",
        "--tag",
        "--otp",
        "--access",
    )
)

SUDO_VALUE_FLAGS = frozenset(("-u", "-g", "-C", "-p", "-r", "-t", "-U", "-h", "-T"))
ENV_VALUE_FLAGS = frozenset(("-u", "--unset", "-C", "--chdir", "-P", "-S", "--split-string"))
TIMEOUT_VALUE_FLAGS = frozenset(("-k", "--kill-after", "-s", "--signal"))
NPX_VALUE_FLAGS = frozenset(("-p", "--package", "-c", "--call", "--userconfig"))

# shlex が未閉鎖クォート等で失敗したときの保守的フォールバック正規表現
FALLBACK_PUBLISH_RE = re.compile(
    r"(?:^|[;&|(\n`])\s*"
    r"(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*"
    r"(?:(?:env|sudo|command|builtin|exec|nohup|time|corepack|npx|bunx)\s+)*"
    r"(?:[^\s/;&|]+/)?"
    r"(?:(?:npm|bun|pnpm)\b[^\n;&|]*\bpublish\b|yarn\b[^\n;&|]*\b(?:npm\s+)?publish\b)"
)

MAX_DEPTH = 5


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


def _split_segments(command):
    """シェルコマンドを単純コマンド単位のトークン列に分解する。"""
    lex = shlex.shlex(command, posix=True, punctuation_chars=";&|()\n")
    # 空白と区切り演算子のみで分割する（URL の : 等でトークンが割れないようにする）
    lex.whitespace_split = True
    # 改行を空白ではなくコマンド区切りトークンとして扱う
    lex.whitespace = " \t\r"
    tokens = list(lex)

    segments = []
    current = []
    for tok in tokens:
        if tok in SEPARATORS:
            if current:
                segments.append(current)
                current = []
        else:
            current.append(tok)
    if current:
        segments.append(current)
    return segments


def _pm_invokes_publish(pm_name, args):
    """npm / bun / pnpm / yarn の引数リストが publish サブコマンドを起動するか判定する。"""
    positionals = []
    i = 0
    n = len(args)
    while i < n:
        tok = args[i]
        if tok == "--":
            break
        if tok.startswith("-"):
            if tok in PM_VALUE_FLAGS and i + 1 < n:
                i += 2
                continue
            i += 1
            continue
        positionals.append(tok)
        if len(positionals) >= 2:
            break
        i += 1

    if not positionals:
        return False
    if positionals[0] == "publish":
        return True
    if pm_name == "yarn" and positionals[0] == "npm" and len(positionals) >= 2:
        return positionals[1] == "publish"
    return False


def _segment_is_publish(tokens, depth):
    """単一コマンドのトークン列がローカル publish を実行するか判定する。"""
    if depth > MAX_DEPTH:
        return False

    idx = 0
    n = len(tokens)

    while idx < n:
        tok = tokens[idx]
        if tok in LEADING_KEYWORDS or ENV_ASSIGN_RE.match(tok):
            idx += 1
            continue

        cmd = os.path.basename(tok)

        if cmd in ("command", "builtin", "nohup", "time", "nice"):
            idx += 1
            while idx < n and tokens[idx].startswith("-"):
                if tokens[idx] == "--":
                    idx += 1
                    break
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
                if flag in ("-c", "--call") and idx + 1 < n:
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
            continue

        if cmd == "eval":
            rest = " ".join(tokens[idx + 1:])
            return is_local_publish_command(rest, depth + 1)

        if cmd in SHELL_BINARIES:
            j = idx + 1
            while j < n:
                arg = tokens[j]
                if arg == "--":
                    break
                if arg == "-c" or SHORT_C_FLAG_RE.match(arg):
                    if j + 1 < n and is_local_publish_command(tokens[j + 1], depth + 1):
                        return True
                    break
                if not arg.startswith("-"):
                    break
                j += 1
            return False

        if cmd in PACKAGE_MANAGERS:
            return _pm_invokes_publish(cmd, tokens[idx + 1:])

        return False

    return False


def is_local_publish_command(command, depth=0):
    """与えられたシェルコマンド文字列にローカル publish 実行が含まれるか判定する。"""
    if not isinstance(command, str) or not command.strip():
        return False
    if depth > MAX_DEPTH:
        return False

    for sub in _extract_substitutions(command):
        if is_local_publish_command(sub, depth + 1):
            return True

    try:
        segments = _split_segments(command)
    except ValueError:
        return bool(FALLBACK_PUBLISH_RE.search(command))

    for seg in segments:
        if _segment_is_publish(seg, depth):
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
