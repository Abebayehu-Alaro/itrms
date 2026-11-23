# ADR 0035: CI in two tiers, the full record once per batch of related tasks

* Status: **proposed** (2026-11-23). On acceptance it **amends ADR-0034** (local Linux CI) and `workflow.md` §1, §3 and
  §5 as listed under "Changes on acceptance".

## Context
* ADR-0034 makes a complete, passing `pnpm ci:local` record the CI evidence, and `workflow.md` §3.2 asks for one for every
  merged task.
* A complete record runs six jobs: checks, stories (every story with axe and the visual baselines), infra (the dev stack
  with observability and every integration suite), gitleaks, Trivy and Semgrep. On the reference run for task 0.7 (commit
  `a070a51`, 711 s on 4 cores) checks took 146 s, stories 402 s, Semgrep 106 s and the rest under a minute; on a
  developer laptop, with image pulls, it is 30–60 minutes.
* Many tasks come in runs that touch the same code (0.17, 0.18 and 0.18a on the form engine; 0.19 and 0.20 on the
  workflow engine). A full record after each task repeats the slow jobs on code that barely changed.
* Some checks are cheap and must not wait for a batch. Task 0.7 showed it: `pnpm audit --audit-level high` failed on four
  critical and seven high advisories published in the month since `main` was last checked, in packages the task never
  touched.
* Some tasks change what every later task relies on (roles, RLS, authorization, money, dependencies, CI itself). A
  problem there must not wait for the end of a batch.

## Decision
* **Two tiers of CI evidence.**
  * **Task tier**, for every task before it goes to "in review":
    * `pnpm ci:local --jobs checks,gitleaks,trivy` on the task's last commit (a clean clone: install, slice and boundary
      checks, tool tests, format, lint, typecheck, unit tests, build, `pnpm audit --audit-level high`, and the two
      scanners). This writes a `report-partial.*` and its evidence line says PARTIAL, as ADR-0034 requires.
    * The integration suites of the packages the task changed (`pnpm --filter <package> test:int`), and the stories job
      (`--jobs stories`) when the task changes `packages/ui` or a screen.
  * **Batch tier**: a **complete** `pnpm ci:local` record (every job, none skipped, ADR-0034) on the last commit of the
    batch.
* **Batches.** A batch is a run of consecutive tasks of one phase that share code. The phase file names them: a
  `Batch:` line in the task entry, as in `**Batch:** B0-6 (0.17, 0.18, 0.18a)`. A task not named in a batch is a batch
  of one. The batches for the rest of Phase 0:

  | Batch | Tasks |
  |---|---|
  | B0-1 | 0.8 |
  | B0-2 | 0.9 |
  | B0-3 | 0.10 |
  | B0-4 | 0.11, 0.12, 0.13 |
  | B0-5 | 0.14, 0.15, 0.16 |
  | B0-6 | 0.17, 0.18, 0.18a |
  | B0-7 | 0.19, 0.20 |
  | B0-8 | 0.21, 0.22, 0.23 |
  | B0-9 | 0.24, 0.25, 0.26 |

* **Always a full record of its own**, whatever its batch says: a task that changes database roles, grants, RLS
  policies or the audit log; authentication, authorization or sessions; money, fees or payments; dependencies (a new
  package, or a version change beyond the lockfile's ranges); or CI, its tools or the security scans. B0-2 and B0-3 are
  batches of one for this reason; 0.22 (fees and payments) gets its own full record inside B0-8.
* **Approval and merge.**
  * The product owner may approve a task on its task-tier evidence. It stays approved but **not merged** until its batch
    has a complete, passing record.
  * Each task of the batch branches from the one before it. When the last one is approved, its last commit gets the
    complete record, and then every task of the batch is squash-merged to `main` in order, one conventional commit per
    task, with no other commit in between.
  * The record counts for the batch if its commit's tree equals the tree of `main` after the last of those merges
    (`git rev-parse <sha>^{tree}` equals `git rev-parse main^{tree}`). `/task-review approve` checks this before it
    records the batch's tasks as done.
  * If the complete record fails, the fix is a new commit on the batch's last task, and the record is made again. No task
    of the batch is merged until it passes.
* **Releases** (`workflow.md` §6) are tagged only on a commit of `main` that is the end of a batch, so every release has
  a complete record.

## Consequences
* A five-task batch makes one complete record instead of five. The cheap, high-value gates (the dependency audit, the
  scanners, the clean-clone build and tests) still run on every task.
* Commits of `main` inside a batch (after its first squash-merge and before its last) have no complete record of their
  own. They are merged in one sitting, so `main` is never left there, and no release is tagged on them.
* A problem that only the slow jobs see (a visual baseline, a dev-stack integration, a Semgrep rule) can be found up to a
  few tasks late. The batch's tasks are not merged until it is fixed, so `main` never holds it.
* Approved but unmerged tasks wait on a branch for days. Each later task in the batch builds on them, so a change asked for
  in review of an earlier task is a new commit on the batch's last branch, recorded against the earlier task's id.
* The compensating control of ADR-0034's exception to SEC-DV-3 becomes: a complete local record for **the last commit of
  every batch merged to `main`**, checked by `/task-review` and the task verifier before the merge. Owner and expiry are
  unchanged.
* When hosted CI is available again (ADR-0034), GitHub Actions runs on every push, and the task tier is the Actions run of
  the task's commit. Batching then only saves local time and can be dropped by superseding this ADR.

## Changes on acceptance
1. `docs/decisions/0034-local-linux-ci.md`: the status line adds "amended by ADR-0035 (two tiers, batched full record)";
   the SEC-DV-3 compensating control reads as above.
2. `docs/engineering/workflow.md`:
   * §1, the "in review" row: "PR open, task-tier CI green (ADR-0035), self-check done (§4)"; the "done" row: "…; merged
     with its batch".
   * §3.2: "On CI" means GitHub Actions for the commit, or the task tier of ADR-0035 for the task and a complete, passing
     local Linux CI record for the last commit of its batch, whose tree is the tree of `main` after the batch is merged.
   * §5: "Tasks are merged with their batch (ADR-0035), in order, one squash commit per task."
3. `docs/phases/phase-0.md`: a `**Batch:**` line in every remaining task entry (the table above).
4. `.claude/skills/task-review/SKILL.md`: step A.2 runs the task tier; step B checks the batch's complete record and the
   tree equality before it merges, and merges the batch in order.
5. `docs/decisions/README.md`: the row for 0035 says "accepted" with the date.
6. Task 0.7, "in review" when this is drafted, changes roles, the audit log and dependencies, so it keeps a full record
   of its own (ADR-0034, unchanged). The batches start with 0.8.

## Licence notes
No new tools. `tools/ci-local.mjs` already runs a subset of jobs with `--jobs`.
