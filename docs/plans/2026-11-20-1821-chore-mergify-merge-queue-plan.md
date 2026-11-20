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

- **Objective:** An approved pull request on this repository merges to `main` without a human pressing merge, only after every CI job has passed, the same way it does in the organisation's other public repositories.
- **Means:** The organisation's thin `.mergify.yml`, copied unchanged (KTD1), and one aggregate CI job named `checks / check` that depends on every other job (KTD2).
- **Authority:** The owner's ruling to match the other open-source repositories, then the organisation's shared Mergify policy and its README, read from the organisation's `.github` repository. This plan supersedes the earlier standalone design.
- **Stop conditions:** This repository is public. No repository settings, visibility, or rulesets change. No private names, ids, paths, or hosts appear in any file, commit, or PR text.
- **Execution profile:** One PR with U1-U3. The plan is committed on its own; nothing is pushed from this run.

---

## Product Contract

### Summary

Add the shared thin `.mergify.yml` and give `ci.yml` one aggregate job, `checks / check`, that succeeds only when every other job succeeded. The organisation policy supplies the approval gate, auto-queueing, command restrictions, and queue defaults; this repository declares only its two queues, both gated on the aggregate check.

### Problem Frame

Merging is manual today, and this repository is the odd one out: the other public repositories extend one organisation policy and gate on a single check named `checks / check`. In those repositories the check comes from a shared reusable workflow, which runs everything inside a Nix dev shell and has no service containers. This repository's tests need Postgres and TimescaleDB services, so its CI stays repo-owned (decided in `docs/plans/2026-11-20-0349-chore-systemfsoftware-tooling-plan.md`, KD7). It therefore has to produce the same check name itself. Mergify's queue draft also fails this repository's squash-message lint as written (KTD3).

### Requirements

**Mergify configuration**

- R1. `.mergify.yml` is byte-identical to the file the organisation's other public repositories use: `extends: .github`, plus a `subtree` queue and a `default` queue.
- R2. Both queues require `check-success = checks / check` in `queue_conditions` and `merge_conditions`. The approval gate, change-request rule, auto-queueing, `queue` and `requeue` command restrictions, and queue defaults are inherited from the organisation policy and not redeclared.

**CI**

- R3. CI exposes a check named exactly `checks / check` on both `pull_request` and `push` events.
- R4. `checks / check` succeeds only when all four existing jobs succeed: `static checks`, `test (node ${{ matrix.node }}, drizzle 0.x)` for node 22 and 24, `test (node 24, drizzle 1.0-rc)`, and `test (timescaledb 2.32)`. It reports failure when any of them fails, is cancelled, or is skipped.
- R5. `static checks` passes on a Mergify queue draft, whose title the squash-message lint cannot accept.

**Boundaries**

- R6. The Mergify file is validated against Mergify's schema if a copy is available offline; otherwise the PR says it was not validated.

### Scope Boundaries

- Not built: a local approval gate, command restrictions, priority rules, batching, labels. The organisation policy owns them.
- Not changed: repository settings, branch protection, rulesets, Mergify account settings.
- Not adopted: calling the shared reusable CI workflow (Problem Frame).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Copy the organisation's `.mergify.yml` verbatim.** It carries a `subtree` queue although this repository has no subtrees; identical content is the convention. (session-settled: user-directed — chosen over a standalone queue file with a local approval gate and command restrictions: owner ruling "be consistent with our other open-source repos".) Governs R1, R2.
- KTD2. **A plain job `check` with `name: checks / check` and `needs` on all four jobs.** A caller job `checks` that uses the shared workflow's job `check` publishes the check name `checks / check`; a job named that string publishes the same name, and Mergify matches on the name. The job runs whatever its dependencies did and fails unless every dependency's result is `success`. It needs no checkout and no setup. Governs R3, R4.
- KTD3. **Skip the squash-message lint on queue drafts with the head-ref test the shared reusable workflow uses**: the pull request's head branch starts with `mergify/merge-queue/`. Mergify titles its draft `merge queue: embarking main (<sha>) and #N together`, which commitlint rejects, so `static checks` would never pass on a draft. The real PR is still linted and its aggregate check is a queue condition. Governs R5.
- KTD4. **Job names stay as they are.** The queue gates only on the aggregate, so the five names no longer appear in Mergify configuration and cannot drift against it.

### Risks and Dependencies

- **Squash message source.** The organisation file sets no `commit_message_format`, so the squash commit follows the repository's GitHub setting. Read through the API at planning time, this repository squashes with the commit or PR title and the commit messages, while the reference repository uses the PR title and the PR body. Until the owner aligns the setting, the squash commit need not match the title and body that CI lints. Changing repository settings is out of scope, so this is recorded as an open question and not worked around.
- **Aggregate drift.** A job added to `ci.yml` later and left out of the aggregate's `needs` is not gated. The job carries a comment saying every job must be listed.
- **Head-ref test can be spoofed.** A fork pull request can name its branch `mergify/merge-queue/...` and skip the squash-message lint. The shared reusable workflow has the same test, and the organisation's title protection still checks the title; the body stays unchecked. Accepted as the house convention.
- **Prerequisites not visible from the repository.** The Mergify app must be active here with Merge Queue and Merge Protections, and the organisation's `.github` repository must stay readable. The other repositories show the setup works. Mergify reads configuration from `main`, so this PR merges by hand. The organisation policy requires the repository owner's approval for a PR that touches CI or Mergify configuration, which this one does.

### Open Questions

**Deferred**

- Should the owner set the repository's squash defaults to PR title and PR body to match the other repositories? Merging works either way. Until it is set, the squash commit text can differ from the linted PR title and body.

---

## Implementation Units

### U1. Add the shared Mergify configuration

- **Goal:** `.mergify.yml` is the organisation's thin file (R1, R2; KTD1).
- **Requirements:** R1, R2, R6.
- **Dependencies:** U3, so the check it names exists when the file lands.
- **Files:** `.mergify.yml` (new).
- **Approach:** Take the file from one of the organisation's public repositories (effect-daemon, effect-readiness, npm-package, discern, effect-microvm, rx-effect, hex-schema and effect-e2e held one identical copy at planning time) and add it unchanged. Do not reformat it; if the formatter rewrites it, exclude the file from formatting rather than edit it.
- **Test expectation:** none -- declarative config; verified by comparison with the sibling copy.
- **Verification:** The file is identical to the sibling copy (checksum match). Schema check per the Verification Contract.

### U2. Keep queue drafts from failing the squash-message lint

- **Goal:** `static checks` succeeds on a Mergify queue draft (KTD3; R5).
- **Requirements:** R5.
- **Dependencies:** none.
- **Files:** `.github/workflows/ci.yml`.
- **Approach:** Extend the `if:` of the `Lint the squash message` step so it also requires the head branch not to start with `mergify/merge-queue/`. Leave every other step unchanged.
- **Test expectation:** none -- workflow config; exercised only by a real queue run (Verification Contract).
- **Verification:** The step still runs on an ordinary pull request and is skipped on a `mergify/merge-queue/` head.

### U3. Add the aggregate `checks / check` job

- **Goal:** One check, `checks / check`, that is green only when every other job is green (KTD2; R3, R4).
- **Requirements:** R3, R4.
- **Dependencies:** none.
- **Files:** `.github/workflows/ci.yml`.
- **Approach:**
  - Add a job `check` with `name: checks / check` and `needs` listing `static-checks`, `test`, `test-rc`, and `timescale`.
  - Give it a run condition that holds when a dependency failed, so a red dependency produces a red aggregate and not a missing one.
  - One step fails unless every dependency's result is `success`.
  - Add the comment about listing every job (Risks), and update the workflow's header comment to mention the aggregate.
- **Test expectation:** none -- workflow config; exercised only by CI runs (Verification Contract).
- **Verification:** On a pull request, `checks / check` appears in the check list and turns green only after the four jobs finish green.

---

## Verification Contract

| Check | Applies to | Command or evidence |
| --- | --- | --- |
| Formatting | U2, U3 | `pnpm format:check` |
| Config identical to the organisation's | U1 | Compare `.mergify.yml` with a sibling repository's copy at implementation time; checksums match |
| Schema | U1 | Look for a local Mergify CLI or schema copy (`mergify config validate`). None was found at planning time: no `mergify` binary, no copy in the repository. The file cannot be validated offline in any case, since it extends another repository's file. Validate if possible; otherwise say in the PR that it was not validated. |
| Aggregate wiring | U3 | Read the job: `needs` lists all four jobs, it runs after a failed dependency, and it fails on any result other than `success` |
| Live behavior | U1-U3 | Pending, off-host: Mergify's configuration check on the PR, a green `checks / check` on the PR, then the first queued PR's Mergify summary (draft CI green, lint skipped, squash message) |

## Definition of Done

- `.mergify.yml` matches the organisation's file exactly and declares no local approval or command rules.
- `ci.yml` publishes `checks / check`, which depends on all four jobs and fails when any of them does not succeed.
- The squash-message lint is skipped only when the head branch starts with `mergify/merge-queue/`.
- The PR text states the schema-validation result, the squash-defaults open question, the owner-approval requirement, and that the live queue run is pending.
- No private name, id, path, or host appears in any changed file, commit, or PR text.
