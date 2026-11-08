Process the {{items.count}} Dependabot pull request(s) in {{repo}}.

{{items}}

- Before judging any pull request, check how long each new version has been published (release-age wait). Collect every `<pkg>@<ver>` from the PR body and from the lockfile diff of `gh pr diff <number>` (transitive dependencies included). Read the publish time with `npm view <pkg> time --json | jq -r '.["<ver>"]'` (for github-actions: `gh api repos/<owner>/<repo>/commits/<sha> --jq .commit.committer.date`). The minimum age is 3 days for a security update (the PR body references a GHSA) and 7 days otherwise. If any version is younger, do not install or verify it: hold the pull request, and write the time at which the minimum is reached in a PR comment and in the result. Also write the earliest such time over all held pull requests as `"retryAt"` (ISO 8601 with a timezone, e.g. `2026-11-14T00:00:00+09:00`) in `result.json`, so that they are processed again then. Passing CI or a small diff is not a reason to shorten the wait.
- For a pull request that passed the wait, verify it in a worktree, run `pnpm audit` after `pnpm install`, and hold it if the new version has an advisory.
- Check CI for each pull request and merge it when CI passes (`gh pr merge --merge`).
- If CI fails and the cause is a follow-up change that you can make, fix it, push, wait for CI and merge.
- Do not merge a pull request you cannot judge; comment on it with the reason instead.
- In the result summary write "merged N, needs review M" and list the numbers that need review.
