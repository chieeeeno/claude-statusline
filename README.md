# @chieeeeno/claude-statusline

A fast, dependency-free status line for [Claude Code](https://claude.com/claude-code).

```
📁 my-repo  ⧉ feature-branch
⑂ feature/add-search  🧠 Opus 5 (1M)  ⚡ xhigh  📖 Explanatory  🤔 on
ctx ▓░░░░░░░░░ 10% 98k/1M │ 🔥 5h ▓▓▓▓▓▓▓░░░ 67% ↺2:03 │ 📅 7d ▓▓░░░░░░░░ 22% ↺5d │ 💰 $2.69 · 12m
```

## Why another status line?

- **No Node at render time.** The status line is rendered by Python (~40ms). Node is used only
  to write the settings entry during setup. Node-based status lines pay 100ms+ of startup on
  every redraw, against a 300ms debounce window.
- **Rate limit windows.** Shows your 5-hour and 7-day usage together with the time left until
  each window resets — so you can see whether to keep going or wrap up.
- **Zero dependencies.** Python standard library only.

## Install

```bash
npm install -g @chieeeeno/claude-statusline
claude-statusline --install
```

That writes a `statusLine` entry into `~/.claude/settings.json` (backing up the existing file
first). Claude Code picks it up without a restart.

To update:

```bash
npm update -g @chieeeeno/claude-statusline
```

No need to re-run `--install` — the settings entry points at the package directory, so the new
version takes effect immediately.

## What it shows

| Line | Content |
|---|---|
| 1 | Repository name (from the `origin` remote) and git worktree name |
| 2 | Branch, model, reasoning effort, output style, thinking, fast mode |
| 3 | Context usage, 5-hour window, 7-day window, cost / elapsed time / lines changed |

Usage bars turn green → yellow → orange → red at 50% / 75% / 90%.

Segments disappear entirely when their data is unavailable — no `--` placeholders. Rate limit
windows are only reported for Claude.ai subscribers (Pro/Max), so they will not appear on
usage-based API plans.

## Commands

```
claude-statusline --install [--runcat]  Write the statusLine entry into ~/.claude/settings.json
claude-statusline --uninstall           Remove the statusLine entry
claude-statusline --print               Render a payload read from stdin (for debugging)
claude-statusline --version             Print the version
```

Preview it without changing any settings:

```bash
echo '{"model":{"display_name":"Opus 5"},"context_window":{"used_percentage":25,"total_input_tokens":50000,"context_window_size":200000}}' \
  | claude-statusline --print
```

`--uninstall` leaves a `statusLine` alone if it points at a different program, so it will not
clobber another tool's setting.

### RunCat Neo integration

With `--install --runcat`, the status line also writes `~/.claude/runcat-usage.json` in the
format [RunCat Neo](https://apps.apple.com/app/runcat) reads, so your model, context, and rate
limit usage show up in the macOS menu bar. Off by default — nothing is written unless you ask
for it.

## Requirements

- macOS or Linux (Windows is not supported)
- Python 3.8+ (uses the standard library only)
- Node 18+ (setup only)
- git (for the branch segment; everything else still renders without it)

## Development

```bash
npm test   # python3 -m unittest discover -s tests -v
```

## License

MIT
