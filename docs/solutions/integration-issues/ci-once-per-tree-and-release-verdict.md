---
title: "CI runs the full gate once per tree, and a release reuses main's verdict"
category: integration-issues
module: ci_pipeline
date: "2026-11-21"
problem_type: integration_issue
component: infrastructure
severity: medium
symptoms:
  - "a pull request branch ran the full gate twice for one commit, once on push and once on pull_request"
  - "editing a pull request title re-ran the whole matrix on an unchanged tree"
  - "the release PR dispatched the whole matrix for a diff that only moves versions and consumes intents"
  - "a required check could report success from a run whose aggregate never executed"
root_cause: trigger_topology
resolution_type: config_change
related_components:
  - development_workflow
tags:
  - github-actions
  - merge-queue
  - required-check
  - skipped-status
  - cache
  - release
---

# CI runs the full gate once per tree, and a release reuses main's verdict

## Problem

The workflow listened for `push` and `pull_request` on every branch, so one commit on a pull request produced two full runs, and a title edit produced a third. The release caller dispatched that same whole matrix on the release branch, whose only difference from main is version surfaces, while the merge-queue draft re-proved the merged tree anyway. Each run restored and re-saved the pnpm store, including pull requests, whose saved caches are scoped to the pull request's merge ref and cannot be read back by main or by a sibling pull request.

The boundary is the event-to-tree mapping. A commit on a branch is one tree; a pull request's head and its queue draft are two trees; a version bump is a third tree that only the version surfaces distinguish. Every trigger that does not introduce a new tree is a duplicate run.

## Mechanism

1. **Two events, one commit.** `push` on a feature branch and `pull_request` on the same commit both start the gate. They publish the same check context against the same SHA, so the second run replaces the first's result without adding evidence. Restricting `push` to the default branch removes one of the two; `pull_request` remains the single run on a branch's tree.
2. **The queue draft is the binding tree.** Mergify turns a queued pull request into a draft pull request whose tree is the pull request merged into the base. Its `pull_request` run is a new tree and must run the whole gate; the ruleset's required check is injected on that draft, so the draft's aggregate, not the head's, decides the merge.
3. **A message edit is not a tree change.** Linting the squash message inside the gate tied a title or body edit to another whole matrix. Moving that lint to its own check on the head keeps the message gated while the gate stays tied to code changes.
4. **Skipped is a satisfying conclusion.** GitHub counts a job whose conclusion is `skipped` as satisfying a required status check. So a gate that skips a dependency, or an aggregate that tolerates a non-`success` result, can report green for work that never ran. The aggregate must run unconditionally and fail on every result other than `success`; a verdict that is reused must be the aggregate's own `success`, not merely the containing run's `success`.
5. **Cache scope is the writer's ref.** A cache saved by a pull-request run belongs to that pull request's merge ref and is unreadable from the default branch or from other pull requests. Pull-request writes are therefore pure cost. Only a push to the default branch writes; every other run restores read-only.
6. **A token-created release PR runs nothing by itself.** The release PR is opened with the workflow token, so its own `pull_request` workflows wait for a human approval. The release caller must dispatch a workflow on that branch to give the required check a verdict. Dispatching the whole matrix there rebuilds what main already proved; the release branch differs only by version surfaces, and the queue draft runs the whole gate on the merged tree before anything lands.

## Architectural Invariants

**One gate per tree.** A trigger earns a full run only when it introduces a tree the existing runs do not cover.

```text
trees(commit on branch)   = head tree              -> pull_request run
trees(queue draft)        = head merged into base  -> pull_request run (binding)
trees(commit on default)  = landed tree            -> push run
trees(version-only diff)  = base tree + versions   -> reused verdict
```

**A gating result must be a conclusion, never an absence.**

```text
gate(results):
  for each dependency result:
    require result == success     # skipped, cancelled, failed all block
```

**Reuse a verdict only across a provably narrower diff, and re-check the verdict itself.**

```text
reuse(base, head):
  require diff(base, head) is a version surface
  require check(base, "checks / check").conclusion == success
  require check(base, "checks / check").status == completed
```

The narrow-diff guard is what keeps a reused verdict sound: a release PR that grows a non-version change fails the gate instead of inheriting main's green. Reading the aggregate's own conclusion is what keeps a skipped or cancelled gate from passing as a successful one.

**Caches are written only where their readers can restore them.** The default branch is the only writer; every other run uses a restore-only form.

Anti-pattern to grep for: a required check whose job carries `if:`, `paths-ignore`, or a matrix leg that can conclude `skipped`, and a cache save step not guarded by the default branch.

## Prevention

- Adding a trigger starts with the question "which new tree does this run cover?" Two events over the same commit are a defect, not redundancy.
- Never put an `if:` or a path filter on a job named as a required check; make it run and fail instead.
- When a gate reuses another run's verdict, assert the aggregate's own conclusion and status, and assert the diff is inside what that verdict measured.
- Any new cache writer is guarded by the default branch at the writer, not at each caller; readers use restore-only.
- The live proof is a pull request run (one run, one tree), a queued draft (the binding run), and a release dispatch that reports green from main's aggregate without rebuilding the matrix.
