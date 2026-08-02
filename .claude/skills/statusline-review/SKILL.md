---
name: statusline-review
description: Run the full PR review loop for this repository - dispatch the quality and security reviewers in parallel over the PR diff, post inline comments and a summary to the PR, fix the blocking findings, and re-review until nothing blocking remains or three rounds have passed. Use when a feature is implemented and ready for review, and always before publishing to npm. Creates a draft PR from main if none exists.
---

# statusline-review

Reviews this repository's PR diff with two independent specialists, posts the results to the PR,
fixes what blocks release, and repeats until clean or until three rounds have passed.

Announce at the start: 「statusline-review スキルでコードレビューを実行します」

The design rationale for every rule below is in `docs/01-review-skill-design.md`. Read it if a
decision here seems arbitrary — but follow this file for the procedure.

## Before anything else

Read these two documents. Do not skip them; the review is only as good as the criteria behind it.

| ファイル | 何のために読むか |
| --- | --- |
| `docs/01-review-skill-design.md` | PR コメントテンプレート（「PR コメントテンプレート」章）。**投稿はこの書式に厳密に従う** |
| `docs/02-code-review-criteria.md` | 重大度の定義（第 3 章）。統合と打ち切り判定に使う |

The templates live in `docs/01`, not here. Copying them into this file would create a second
copy that drifts. Read them each run.

## Step 1: Preconditions

```bash
gh auth status
git remote -v
```

**Stop if `gh` is unauthenticated or no remote is configured.** Say why and stop. Do not run
`gh repo create` — creating a public repository is not a side effect a review should have.

## Step 2: Resolve the PR

```bash
gh pr view --json number,baseRefName,headRefName,isDraft 2>/dev/null
```

If a PR exists for the current branch, use it.

If none exists:
1. Confirm you are not on `main`. If you are, create a branch: `git checkout -b feat/<説明的な名前>`
2. Commit any uncommitted work with a Japanese message
3. `git push -u origin <branch>`
4. `gh pr create --draft --base main --title <日本語のタイトル> --body <概要>`

## Step 3: Scope the diff

```bash
BASE=$(gh pr view --json baseRefName -q .baseRefName)
git diff "origin/$BASE...HEAD" --name-only
```

Three dots, not two — this takes the diff from the merge base, so progress on the base branch
does not leak in as noise.

**Stop if the diff is empty.** There is nothing to review.

## Step 4: The review loop

Run this at most **three times**. Track the round number; you will need it for every comment.

### 4a. Dispatch both reviewers in parallel

Send both Task calls **in a single message** so they run concurrently.

- `quality-reviewer` — 品質観点（`docs/02` 第 4 章）
- `security-reviewer` — セキュリティ観点（`docs/02` 第 5 章）

Give each the same input: the base ref, the head ref, and the list of changed files. Tell them the
round number. Do not pass along your own opinion of the code — you wrote it, and seeding them with
your reasoning defeats the point of reviewing in a separate context.

### 4b. Merge the findings

- Deduplicate by `file:line`. If both agents report the same location, keep the security framing —
  it carries the attack path
- Sort by severity: Critical → Blocker → High → Should fix → Medium → Consider → Low
- Discard anything an agent marked 未検証 unless it is a security finding of High or above, and
  carry the 未検証 label through to the comment if you keep it

### 4c. Post to the PR

One `gh api` call creates the review with both the inline comments and the summary, so you can
never end up with inline comments and no summary:

```bash
gh api "repos/{owner}/{repo}/pulls/<number>/reviews" --method POST --input review.json
```

```json
{
  "body": "<docs/01 の総評テンプレートに沿った Markdown>",
  "event": "COMMENT",
  "comments": [
    { "path": "statusline.py", "line": 42, "side": "RIGHT", "body": "<インラインテンプレート>" }
  ]
}
```

Use `"event": "COMMENT"` always. You cannot approve your own PR, so LGTM is expressed in the
summary body, not by an `APPROVE` event.

**The `line` must be a line present in the diff**, or the API rejects the whole request. For a
finding on an unchanged line, drop it from `comments[]` and write it into the summary body with
its `file:line` instead. Losing the whole review because one comment was out of range is worse
than one finding being less conveniently placed.

Fill the templates with **real measured values**. The `34 件` and `0.46 秒` in `docs/01` are
worked examples, not text to copy.

### 4d. Decide

Count findings that are **Blocker** or **Security: High or above**.

- **Zero** → post the LGTM summary from `docs/01` and stop. Done.
- **Non-zero, and this was round 3** → post the 打ち切り summary. **Do not post LGTM.** Stop.
- **Non-zero, rounds 1–2** → continue to 4e.

### 4e. Fix, then go around again

**You apply the fixes, not the reviewers.** They have no editing tools by design — a reviewer who
patches their own finding has ratified it without anyone checking.

1. Fix only the Blocker and Security High+ findings. Leave everything else reported and untouched;
   widening the fix set is how this loop stops terminating
2. `npm test`
3. **If the tests fail, revert this round's fixes and stop.** Report what happened. Never push a
   broken tree
4. Commit in Japanese, describing what was fixed and why
5. `git push`
6. Increment the round and return to 4a

## Rules that hold throughout

- **Never touch the real `~/.claude/settings.json`.** Every CLI check runs under `HOME=$(mktemp -d)`
- **If the same finding survives two consecutive rounds, say so in the summary.** Reporting a
  fix that did not work as though it were new progress is the one failure mode that makes this
  whole loop worse than no review at all
- **Never post LGTM while a Blocker or Security High+ remains**, whatever the round
- **Do not widen the fix set** to Should fix / Medium / Consider. Those are reported, not fixed

## When you are done

Tell the user in one short paragraph: the outcome (LGTM / 打ち切り / 停止), how many rounds it
took, what was fixed, and the PR URL. If you stopped early, say exactly why.
