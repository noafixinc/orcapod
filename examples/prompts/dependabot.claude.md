Process the {{items.count}} Dependabot pull request(s) in {{repo}}.

{{items}}

- Check CI for each pull request and merge it when CI passes (`gh pr merge --merge`).
- If CI fails and the cause is a follow-up change that you can make, fix it, push, wait for CI and merge.
- Do not merge a pull request you cannot judge; comment on it with the reason instead.
- In the result summary write "merged N, needs review M" and list the numbers that need review.
