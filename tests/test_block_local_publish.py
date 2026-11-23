#!/usr/bin/env python3
"""ローカル publish 禁止フック・設定・リリーススキル構成のユニットテスト。"""

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOOK_SCRIPT = ROOT / ".agents" / "hooks" / "block-local-publish.py"
HOOKS_JSON = ROOT / ".agents" / "hooks.json"
CLAUDE_SETTINGS = ROOT / ".claude" / "settings.json"
RELEASE_SKILL = ROOT / ".claude" / "skills" / "statusline-release" / "SKILL.md"
PACKAGE_JSON = ROOT / "package.json"


def _load_hook_module():
    spec = importlib.util.spec_from_file_location("block_local_publish", str(HOOK_SCRIPT))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = _load_hook_module()


def _make_payload(command, tool_name="run_command"):
    return {
        "hookEventName": "PreToolUse",
        "toolCall": {
            "id": "toolu_test",
            "name": tool_name,
            "args": {"CommandLine": command},
        },
    }


class TestBlockLocalPublishLogic(unittest.TestCase):
    """is_local_publish_command / evaluate_payload の判定テスト。"""

    def test_denies_direct_publish_commands(self):
        commands = [
            "npm publish",
            "npm publish --access public",
            "npm publish --dry-run",
            "npm publish --ignore-scripts",
            "bun publish",
            "bun publish --access public",
            "pnpm publish",
            "pnpm publish --no-git-checks",
            "yarn publish",
            "yarn publish --access public",
            "yarn npm publish",
            "yarn npm publish --access public",
            "yarn workspaces foreach npm publish",
        ]
        for cmd in commands:
            with self.subTest(cmd=cmd):
                res = hook.evaluate_payload(_make_payload(cmd))
                self.assertEqual(res["decision"], "deny")
                self.assertIn("publish", res["reason"])

    def test_denies_flags_before_publish_paths_and_ansi_c_quotes(self):
        commands = [
            "npm --prefix . publish",
            "npm -C /tmp/pkg publish",
            "npm --registry https://registry.npmjs.org/ publish",
            "npm --registry=https://registry.npmjs.org/ publish",
            "npm --userconfig /tmp/.npmrc publish",
            "npm --color always publish",
            "npm --fetch-retries 1 publish",
            "npm --provenance false publish",
            "npm --location project publish",
            "npm --ignore-scripts --color always publish",
            "npm --tag test publish",
            "bun --conditions foo publish",
            "pnpm --dir . publish",
            "pnpm -r publish",
            "yarn --cwd . npm publish",
            "/usr/local/bin/npm publish",
            "/opt/homebrew/bin/bun publish",
            "./node_modules/.bin/pnpm publish",
            '"npm" "publish"',
            "n'p'm pub\"lish\"",
            "$'npm' publish",
            "$'\\x6e\\x70\\x6d' $'publish'",
        ]
        for cmd in commands:
            with self.subTest(cmd=cmd):
                self.assertTrue(hook.is_local_publish_command(cmd))

    def test_denies_redirections_and_here_strings(self):
        commands = [
            "</dev/null npm publish",
            "< /dev/null npm publish",
            ">/dev/null npm publish",
            "2>&1 npm publish",
            "npm</dev/null publish",
            "npm publish 2>/dev/null",
            "echo ok\n</dev/null npm publish",
            "(</dev/null npm publish)",
            "echo ok;>/dev/null npm publish",
            "echo ok&&</dev/null npm publish",
            "echo ok\n&>/dev/null npm publish",
            'sh <<< "npm publish"',
            "zsh <<< 'bun publish --ignore-scripts'",
        ]
        for cmd in commands:
            with self.subTest(cmd=cmd):
                self.assertTrue(hook.is_local_publish_command(cmd))

    def test_denies_wrappers_and_env_assignments(self):
        commands = [
            "NODE_AUTH_TOKEN=secret npm publish",
            "env npm publish",
            "env FOO=1 BAR=2 bun publish",
            "env -u FOO npm publish",
            "env -S 'npm publish'",
            'env -iS "npm publish"',
            "sudo npm publish",
            "sudo -E bun publish",
            "sudo --user root npm publish",
            "command npm publish",
            "exec npm publish",
            "nohup pnpm publish",
            "time npm publish",
            "nice -n 0 npm publish",
            "nice -n 10 npm publish",
            "timeout 30 npm publish",
            "coproc npm publish",
            "corepack pnpm publish",
            "corepack yarn npm publish",
            "npx npm publish",
            "npx npm@latest publish",
            "bunx npm@11 publish",
            "npx --yes -c 'npm publish'",
            'npx -yc "npm publish"',
            "bunx pnpm publish",
        ]
        for cmd in commands:
            with self.subTest(cmd=cmd):
                self.assertTrue(hook.is_local_publish_command(cmd))

    def test_denies_compound_multiline_subshell_and_nested_shell(self):
        commands = [
            "bun run test && npm publish",
            "echo ok; bun publish",
            "false || pnpm publish",
            "echo ok | yarn publish",
            "echo hi\nnpm publish",
            "echo ok\n\nnpm publish",
            "echo ok;\nnpm publish",
            "(echo ok)\nnpm publish",
            "echo ok&&(npm publish)",
            "echo ok ||\nnpm publish",
            "# comment\nnpm publish",
            "bun run test # run tests\nnpm publish",
            "(npm publish)",
            "{ npm publish; }",
            "echo $(npm publish)",
            'echo "$(bun publish)"',
            "echo `pnpm publish`",
            'sh -c "npm publish"',
            "bash -lc 'bun publish --dry-run'",
            "/bin/zsh -ec 'yarn npm publish'",
            'bash -o errexit -c "npm publish"',
            "sh -euo pipefail -c 'npm publish'",
            "bash -euo pipefail -c 'npm publish --ignore-scripts'",
            "sh -eo errexit -c 'npm publish'",
            "bash -oc pipefail 'npm publish'",
            "bash -co 'npm publish' pipefail",
            'sh +e -c "npm publish"',
            'bash -c -- "npm publish"',
            'sh -c -- "npm publish"',
            'eval "npm publish"',
            "eval npm publish",
            "eval -- npm publish",
            'eval -- "npm publish"',
        ]
        for cmd in commands:
            with self.subTest(cmd=cmd):
                self.assertTrue(hook.is_local_publish_command(cmd))

    def test_denies_deep_nesting_heredoc_bypasses_and_unterminated_quotes(self):
        commands = [
            "eval eval eval eval eval eval npm publish",
            "\"npm\" publish && cat <<EOF\ndon't\nEOF",
            'sh -c "npm publish" && cat <<EOF\ndon\'t\nEOF',
            "eval \"npm publish\"; cat <<EOF\n'\nEOF",
            "cat <<EOF\n$(npm publish)\nEOF",
            "sh <<'EOF'\nnpm publish --ignore-scripts\nEOF",
            "bash <<EOF\nnpm publish --ignore-scripts\nEOF",
            "zsh <<-EOF\n\tbun publish --ignore-scripts\nEOF",
            'echo "a\n<<\'EOF\' "\nnpm publish --ignore-scripts',
            "echo 'a\n<<\\EOF '\nbun publish --ignore-scripts",
            'npm publish "unterminated',
            "echo ok && bun publish 'unterminated",
        ]
        for cmd in commands:
            with self.subTest(cmd=cmd):
                self.assertTrue(hook.is_local_publish_command(cmd))

    def test_allows_safe_commands_and_mentions_in_arguments(self):
        commands = [
            "npm pack --dry-run --ignore-scripts --json",
            "npm view @chieeeeno/claude-statusline version",
            "npm test",
            "npm run build",
            "bun run typecheck && bun run test",
            "bun install --frozen-lockfile",
            "pnpm --version",
            "yarn --version",
            'git commit -m "block local npm publish"',
            "git commit -m 'line1\nnpm publish'",
            'git log --grep="bun publish"',
            'grep "npm publish" .github/workflows/publish.yml',
            'rg "yarn npm publish" .',
            'gh pr create --title "release skill" --body "Disallow npm publish locally"',
            "echo 'Do not run npm publish or $(npm publish)'",
            "python3 tests/run_suite.py",
            "git tag -a v2.3.0 -m v2.3.0 && git push origin v2.3.0",
            "cat <<'EOF' > /tmp/statusline-release-pr.md\nローカルからの `npm publish` を禁止\nEOF",
            "cat <<EOF\ndon't run local publish\nEOF",
            'echo "line1\n<<\'EOF\' in quoted string\nline3"',
        ]
        for cmd in commands:
            with self.subTest(cmd=cmd):
                res = hook.evaluate_payload(_make_payload(cmd))
                self.assertEqual(res, {"decision": "allow"})

    def test_allows_non_run_command_tools(self):
        res = hook.evaluate_payload(_make_payload("npm publish", tool_name="read_file"))
        self.assertEqual(res, {"decision": "allow"})

    def test_supports_camelcase_command_line_key(self):
        payload = {
            "hookEventName": "PreToolUse",
            "toolCall": {
                "id": "toolu_camel",
                "name": "run_command",
                "args": {"commandLine": "npm publish"},
            },
        }
        self.assertEqual(hook.evaluate_payload(payload)["decision"], "deny")

    def test_fails_closed_on_malformed_payload(self):
        bad_payloads = [
            None,
            [],
            {},
            {"toolCall": None},
            {"toolCall": {"name": "run_command", "args": None}},
            {"toolCall": {"name": "run_command", "args": {}}},
            {"toolCall": {"name": "run_command", "args": {"CommandLine": 123}}},
        ]
        for payload in bad_payloads:
            with self.subTest(payload=payload):
                res = hook.evaluate_payload(payload)
                self.assertEqual(res["decision"], "deny")


class TestBlockLocalPublishCLI(unittest.TestCase):
    """hooks.json と同一条件（cwd=.agents/）でスクリプトを実行する E2E テスト。"""

    def _run_hook(self, stdin_text):
        return subprocess.run(
            [sys.executable, "./hooks/block-local-publish.py"],
            cwd=str(ROOT / ".agents"),
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_e2e_denies_npm_publish_with_exit_zero(self):
        proc = self._run_hook(json.dumps(_make_payload("npm publish")))
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(data["decision"], "deny")
        self.assertIn("publish.yml", data["reason"])

    def test_e2e_allows_bun_test_with_exit_zero(self):
        proc = self._run_hook(json.dumps(_make_payload("bun run test")))
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(data, {"decision": "allow"})

    def test_e2e_fails_closed_on_invalid_json_with_exit_zero(self):
        proc = self._run_hook("{not-json")
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(data["decision"], "deny")


class TestReleaseGuardConfigs(unittest.TestCase):
    """リポジトリ内の禁止設定・スキル定義・prepublishOnly の整合性テスト。"""

    def test_claude_settings_denies_all_local_publish_commands(self):
        cfg = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
        deny = cfg["permissions"]["deny"]
        expected = [
            "Bash(npm publish)",
            "Bash(npm publish *)",
            "Bash(bun publish)",
            "Bash(bun publish *)",
            "Bash(pnpm publish)",
            "Bash(pnpm publish *)",
            "Bash(yarn publish)",
            "Bash(yarn publish *)",
            "Bash(yarn npm publish)",
            "Bash(yarn npm publish *)",
        ]
        for rule in expected:
            self.assertIn(rule, deny)

    def test_agents_hooks_json_registers_block_local_publish(self):
        cfg = json.loads(HOOKS_JSON.read_text(encoding="utf-8"))
        entries = cfg["block-local-publish"]["PreToolUse"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["matcher"], "run_command")
        handlers = entries[0]["hooks"]
        self.assertEqual(len(handlers), 1)
        self.assertIn("block-local-publish.py", handlers[0]["command"])
        self.assertTrue(HOOK_SCRIPT.is_file())

    def test_release_skill_has_valid_frontmatter(self):
        text = RELEASE_SKILL.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"))
        parts = text.split("---\n", 2)
        self.assertEqual(len(parts), 3)
        frontmatter = parts[1]
        self.assertIn("name: statusline-release", frontmatter)
        self.assertIn("description:", frontmatter)

    def test_package_json_prepublish_only_blocks_local_publish(self):
        pkg = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
        script = pkg["scripts"].get("prepublishOnly")
        self.assertIsInstance(script, str)
        proc = subprocess.run(
            ["/bin/sh", "-c", script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("publish.yml", proc.stderr)


if __name__ == "__main__":
    unittest.main()
