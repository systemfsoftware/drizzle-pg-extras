---
title: "Mergify queue drafts cancel their own CI under cancel-in-progress"
category: integration-issues
module: ci_merge_queue
date: "2026-11-21"
problem_type: integration_issue
component: infrastructure
severity: high
symptoms:
  - "Mergify dequeued queued pull requests with CHECKS_FAILED although every job on the queue branch had already passed"
  - "`checks / check` failed with `RESULTS: cancelled cancelled cancelled cancelled`"
  - "the same queue branch produced a green run minutes after the dequeue"
root_cause: concurrency
resolution_type: config_change
related_components:
  - development_workflow
tags:
  - mergify
  - merge-queue
  - github-actions
  - concurrency
  - cancel-in-progress
  - aggregate-check
---

# Mergify queue drafts cancel their own CI under cancel-in-progress

## Problem

A pull request queued in the Mergify merge queue is checked on a queue branch through a draft pull request. That draft was dequeued twice with `CHECKS_FAILED` even though every job on the branch passed, because the workflow's own concurrency rule cancelled the runs Mergify was waiting on. Fixed by exempting queue-draft heads from cancellation (opened in #8, unmerged as of this writing); the queue first worked end to end after that.

## Symptoms

- Mergify's dequeue reason is `CHECKS_FAILED`, with `checks / check` named as the failed check.
- The aggregate job's log shows `RESULTS: cancelled cancelled cancelled cancelled` and exits 1 — not a test failure, a cancellation batch.
- Several workflow runs appear on the queue branch within seconds of each other; all but the newest end cancelled.

## What Didn't Work

- Treating it as flaky CI and requeueing: every requeue re-enters the same event sequence, so the failure reproduces.
- Making the aggregate lenient about cancelled dependencies: rejected — it would also forgive genuine cancellations that should block a merge (see Why This Works).

## Solution

In the workflow's `concurrency` block, `cancel-in-progress` applies only when the event is a `pull_request` **and** the head branch does not start with the queue-branch prefix:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' && !startsWith(github.head_ref, 'mergify/merge-queue/') }}
```

## Why This Works

Chain from trigger to symptom, every link observed during the incident:

1. Mergify checks a queued pull request on a queue branch exposed as a draft pull request. Opening and annotating that draft fires several `pull_request` events within seconds — the incident produced four runs on one branch in 42 seconds.
2. All of a draft's `pull_request` runs share one concurrency group keyed by the draft's pull-request number, and `cancel-in-progress` was unconditional on `pull_request` events, so each new event cancelled the run in flight.
3. The `checks / check` aggregate job runs `if: always()` and fails on any dependency result other than `success`, so a cancelled batch reports failure instead of vanishing — by design, so a red job can never look like a missing one.
4. Mergify reads the newest reported outcome per check name. At dequeue time that outcome was the cancelled aggregate, so the queue concluded `CHECKS_FAILED` and removed the pull request. The last event's run completed green afterwards, too late to matter.

The invariant: **a run whose consumer is an automation decision must be allowed to finish**. Cancellation is a cost optimization for human-in-the-loop pushes, where a newer push makes an older run's result uninteresting. A merge-queue draft has exactly one interesting result per check; cancelling it does not save a stale run, it destroys the only signal. The same exemption appears in the organisation's shared reusable CI, so a repo-owned workflow that gates a queue on an aggregate must reproduce it.

The lenient-aggregate alternative — skipping or forgiving `cancelled` results — would invert the aggregate's contract: the aggregate exists so that a job that did not succeed blocks the merge, whatever the reason. Exempting the trigger (do not cancel) keeps that contract intact; weakening the check (ignore cancellation) breaks it.

## Prevention

- When a workflow gates a merge queue on a required check, read the concurrency block together with the queue: every extra `pull_request` event on a queue draft must not cancel a run still in flight. Exempt queue-branch heads from `cancel-in-progress`.
- No local test seam exercises Actions concurrency; the live queue run is the only full proof. Cheapest signal that the defect is back: the aggregate failing with a `RESULTS` value of repeated non-`success` words rather than a job failure.
- Renaming the queue-branch prefix in the Mergify configuration without updating this exemption reintroduces the defect; the two names must change together.

Related: #2 introduced the aggregate check, #5 was the pull request the queue could not merge, #8 carries the fix.
