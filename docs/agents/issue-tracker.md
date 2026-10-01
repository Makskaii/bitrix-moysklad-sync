# Issue tracker: GitHub

Issues and specifications for this project live in the private repository [`Makskaii/bitrix-moysklad-sync`](https://github.com/Makskaii/bitrix-moysklad-sync).

Use the connected GitHub tools to create, read, update, and label issues. Specify `Makskaii/bitrix-moysklad-sync` explicitly. This project is also available as a local Git checkout; if a usable authenticated GitHub CLI is available, it may be used for the same repository.

When a skill says to publish a specification, create a GitHub issue and apply the `ready-for-agent` label. Read existing issues and comments before updating them. Pull requests are not a triage request surface for this project.

## Ticket implementation and review workflow

For every implementation ticket, use a fresh agent task and an isolated worktree/checkout based on the latest `origin/main`. Create one branch for that ticket, named `issue-<number>-<short-slug>` (or preserve an existing ticket branch when explicitly continuing that ticket). Do not implement ticket work directly on `main` or share a mutable checkout between parallel ticket workers.

When implementation is complete, ask a separate fresh reviewer agent to inspect the ticket branch against `main`. The reviewer must not edit files. The implementation agent addresses findings, then reports the final review status and verification evidence to the coordinating agent.

After review passes, commit the ticket changes on its branch, push that branch, and open a GitHub pull request targeting `main`. Include `Closes #<number>` in the PR description so GitHub closes the issue when the PR is merged. Creating a PR does not itself close the issue; do not manually close the issue before merge.

Subagents inherit the parent task's sandbox and approval mode. A local commit may succeed while pushing still needs network permission. If a push or PR action is blocked or denied, stop and report the exact action and approval result to the coordinating agent; do not route around a denial with another tool, credential, or path. Continue publication only through an authorized, policy-approved path.
