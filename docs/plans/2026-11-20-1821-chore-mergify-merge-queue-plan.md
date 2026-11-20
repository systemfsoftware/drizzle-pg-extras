---
title: "Mergify Merge Queue - Plan"
type: chore
date: 2026-11-20
topic: mergify-merge-queue
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

## Goal Capsule

- **Objective:** An approved pull request on this repository merges to `main` without a human pressing merge, and only after its CI jobs pass both on the pull request and on the merge queue's temporary draft.
- **Means:** One Mergify queue declared in `.mergify.yml` (KTD1-KTD4), plus a one-line CI guard so the queue's draft can pass `static checks` (KTD5).
- **Authority:** The request and Mergify's published configuration docs. Check names come from `.github/workflows/ci.yml`.
- **Stop conditions:** This repository is public. No repository settings, visibility, or rulesets change. No private names, ids, paths, or hosts appear in any file, commit, or PR text.
- **Execution profile:** One PR with U1-U2. This run writes and commits the plan only; nothing is pushed.

---

## Product Contract

### Summary

Add `.mergify.yml` with a single queue named `default`. Approved, non-draft pull requests with green CI are queued automatically and squash-merged with the PR title and body as the commit message. The approving bot may also issue `queue` and `requeue` commands.

### Problem Frame

Merging is manual today. Mergify reads its configuration from the default branch only, so the file has to land on `main` before anything is queued. The CI workflow also lints the pull request title and body, which a Mergify draft pull request cannot satisfy as written (KTD5).

### Requirements

**Queue behavior**

- R1. One queue rule, `merge_method: squash`, commit title and body taken from the PR title and body.
- R2. A PR is queued automatically when it is not a draft, is approved by `kiro-systemf[bot]`, has no change request, and every CI job passes.
- R3. `merge_conditions` require the same CI jobs on the queue draft.
- R4. The CI jobs are every check in `.github/workflows/ci.yml`, matrix entries included:
  - `static checks`
  - `test (node 22, drizzle 0.x)`
  - `test (node 24, drizzle 0.x)`
  - `test (node 24, drizzle 1.0-rc)`
  - `test (timescaledb 2.32)`

**Access and scope**

- R5. `kiro-systemf[bot]` may run `queue` and `requeue`; anyone with write permission keeps that right.
- R6. Minimal: no priority rules, no batching, no other keys.
- R7. The file is validated against Mergify's schema if a copy is available offline; otherwise the PR says it was not validated.

### Scope Boundaries

- Not built: priority rules, batching, `dequeue` restrictions, labels, `shared` anchors.
- Not changed: repository settings, branch protection, rulesets, Mergify account settings.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Auto-queue through `merge_protections_settings.auto_merge_conditions: true`**, not a `pull_request_rules` entry with a `queue` action. The docs name it the current mechanism, it adds no rule list, and the queue's `queue_conditions` still gate entry. It requires Merge Protections to be enabled for the repository (Risks).
- KTD2. **`queue_conditions` carries the review and CI gates; `merge_conditions` carries the CI gates only.** Because the two lists differ, Mergify checks each PR on a draft pull request, which is what R3 asks for. Review state is not re-evaluated on the draft.
  - `queue_conditions`: `-draft`, `approved-reviews-by = kiro-systemf[bot]`, `#changes-requested-reviews-by = 0`, then one `check-success = <name>` per R4 entry.
  - `merge_conditions`: the same five `check-success` lines.
- KTD3. **`commit_message_format` with `title: pr-title` and `body: pr-body`**, not the deprecated `commit_message_template`. Mergify appends ` (#N)` to the title, matching the existing history.
- KTD4. **`commands_restrictions` for `queue` and `requeue`** replaces the default `sender-permission >= write` with `or: [sender-permission >= write, sender = kiro-systemf[bot]]`, so the write path survives.
- KTD5. **Skip the squash-message lint on queue drafts.** Mergify names the draft `merge queue: embarking main (<sha>) and #N together` on a `mergify/merge-queue/` branch. The `Lint the squash message` step in `static checks` would fail it, so `static checks` would never go green on the draft and every PR would time out of the queue. The step gains a head-ref guard. The real PR is still linted, and its `static checks` success is a queue condition, so the squash message stays covered.
- KTD6. **Bare check names**, not `@github-actions/<name>`. Only GitHub Actions publishes these checks here; qualifying them is extra surface.

### Risks and Dependencies

- **Bot approval may not count.** Mergify documents that `approved-reviews-by` matches only reviewers with write, maintain, or admin permission, and the request notes an App lacks write permission. If so, R2 never matches. This cannot be checked offline. The first PR's Mergify check summary shows whether the condition is satisfied. Fixing it needs a repository or Mergify setting change, which is outside this task, so it is reported rather than worked around.
- **Mergify prerequisites.** The Mergify app, Merge Queue, and Merge Protections must be enabled for the repository; squash merges must be allowed. None is visible from the repository.
- **Check-name drift.** The five names in `.mergify.yml` duplicate job names in `ci.yml`. Renaming a job leaves its condition unsatisfiable until the queue's checks timeout.
- **Bootstrap.** Mergify reads configuration from `main`, so the PR that adds the file merges by hand, not through the queue.

---

## Implementation Units

### U1. Add the Mergify configuration

- **Goal:** `.mergify.yml` implements R1-R6 as KTD1-KTD4 and KTD6 describe.
- **Requirements:** R1-R7.
- **Dependencies:** none.
- **Files:** `.mergify.yml` (new).
- **Approach:**
  - Top-level keys: `merge_protections_settings`, `queue_rules` (one rule, `default`), `commands_restrictions`.
  - Set `merge_method: squash` and `commit_message_format` on the rule.
  - Quote every condition that contains `#`, parentheses, or commas, such as `"check-success = test (node 22, drizzle 0.x)"`.
  - Copy check names from `ci.yml` job `name:` fields, expanding the node matrix to 22 and 24.
- **Test expectation:** none -- declarative config; verified by the checks below.
- **Verification:** see Verification Contract.

### U2. Keep queue drafts from failing the squash-message lint

- **Goal:** `static checks` succeeds on a Mergify queue draft (KTD5).
- **Requirements:** R3.
- **Dependencies:** none.
- **Files:** `.github/workflows/ci.yml`.
- **Approach:** Extend the `if:` of the `Lint the squash message` step with a clause excluding heads that start with `mergify/merge-queue/`. Leave every other step and trigger unchanged. Update the header comment of the workflow's lint sentence only if it becomes inaccurate.
- **Test expectation:** none -- workflow config; it can only be exercised by a real queue run (Verification Contract).
- **Verification:** The step still runs on ordinary pull requests and is skipped on a `mergify/merge-queue/` head.

---

## Verification Contract

| Check | Applies to | Command or evidence |
| --- | --- | --- |
| YAML and formatting | U1 | `pnpm format:check` (dprint covers YAML) |
| Check names match CI | U1 | Compare the five `check-success` values to the `name:` fields in `.github/workflows/ci.yml`; matrix expands to node 22 and 24 |
| Schema | U1 | Search for a local Mergify CLI or schema copy (`mergify config validate`, `mergify-configuration-schema.json`). None was found at planning time: no `mergify` binary, no copy in the repository. Validate if one exists; otherwise state in the PR that the file was not schema-validated. Do not fetch the schema online. |
| Lint skip | U2 | `pnpm format:check`; read the changed `if:` for the two cases (ordinary PR head, `mergify/merge-queue/` head) |
| Live behavior | U1, U2 | Pending, off-host: Mergify's configuration check on the PR, then the first queued PR's Mergify check summary (bot approval counts, draft CI green, squash message) |

## Definition of Done

- `.mergify.yml` contains one queue and nothing the Requirements exclude.
- All five CI check names appear in both `queue_conditions` and `merge_conditions`.
- The squash-message lint step is skipped only on `mergify/merge-queue/` heads.
- The PR text states the schema-validation result, the bot-approval risk, and that the live queue run is pending.
- No private name, id, path, or host appears in any changed file, commit, or PR text.
