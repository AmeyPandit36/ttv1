# Phase 3 product audit

Read-only review of the repository after Phase 2 (`820fce6245f46d993cb44b23341ca3a5f8f727b9`, PR #2).
No Phase 3 features were implemented in this pass.

Source of truth: the running TypeScript API, domain package, Python solver, Prisma/SQL migrations and React client in this tree.

---

## What Phase 2 actually delivered

The product can log in, expand teaching requirements, run candidate-aware preflight, solve with CP-SAT, independently validate, persist a version, reject illegal moves, publish, and refuse published edits. Faculty eligibility, min capacity, required resources, daily-period policies, transactional writes, ADMIN-only mutations and grounded AI *read* tools are present and tested.

Phase 3 should not rebuild that pipeline. It should close production-safety and completeness gaps below.

---

## P0 — must fix before calling this production-ready

### 1. Security-scoped read APIs

**Current behaviour.** After `authenticate`, every role can `GET /api/:collection`, `GET /api/dashboard`, `GET /api/timetables/versions/:id` and export CSV. There is no department, faculty or student filter on reads. A `demo-student` token receives the full college configuration and every timetable assignment.

Mutations are correctly ADMIN-only. HOD is no longer a fake college-wide writer. Reads were left wide open.

**Needed.** Role- and scope-aware read models:

- ADMIN: college-wide
- HOD: own `departmentId` only
- FACULTY: own assignments, availability and eligibility
- STUDENT: own cohort timetable

Do not grant HOD writes until the same scope is applied to mutations.

### 2. Truthful dashboard

**Current behaviour.** `/api/dashboard` reports `academicYear: {id:'ay-26', name:'2026–27'}` as a literal, then counts in-memory arrays (`departments.length`, `buildSessions().length`, last version/run). Those arrays are real after hydrate/seed, but:

- An unseeded production database still advertises academic year 2026–27 with zero counts.
- Counts follow the in-memory replica, not a SQL aggregate, so they can drift if a write path updates only one side.
- `unresolvedConflicts` is “conflicts on the latest version”, not an independently queried open-conflict set.

**Needed.** Dashboard payloads must be derived from persisted rows (or explicitly say “no academic year configured”). Never hard-code a year name.

### 3. Concurrency-safe timetable versioning

**Current behaviour.** `nextVersionNumber()` is `SELECT max(version)+1` *then* a later `INSERT` inside `withTransaction`. Two overlapping ADMIN generates can allocate the same number; the second insert fails with `TimetableVersion_timetableId_version_key` after the solver has already run. Manual moves update the live version in place (no copy-on-write, no `parentVersionId`, no optimistic lock on `updatedAt`).

Published rows are trigger-protected. Draft/validated rows are not.

**Needed.** Allocate version numbers inside the same transaction under a row lock on `Timetable`. Copy-on-write for edits. Optimistic concurrency on move/transition (`WHERE updatedAt = $expected`).

### 4. Network PostgreSQL migration / integrity testing

**Current behaviour.** Fresh PGlite apply of both migrations creates 40 public tables and the three immutability triggers. There is no Testcontainers/PostgreSQL 14+ job, no restore test, no foreign-key failure suite against network Postgres, and `prisma migrate deploy` is undocumented against a real instance.

PGlite omitted `pgcrypto` / `gen_random_uuid()` defaults. That is fine locally and must not be assumed equivalent to managed PostgreSQL.

**Needed.** CI (or a documented one-command check) that applies the checked-in migrations to PostgreSQL 14+, asserts table/trigger presence, and exercises the published-immutability triggers and a failed-transaction rollback.

---

## P1 — required for a usable institution, not just the demo

### 5. Complete fresh-institution setup through the frontend

Academic setup UI still paints a hard-coded IT / BE / Third Year tree. Operators can create some records (faculty, resources, requirements, divisions, enrollments) but not a full empty-institution path: academic year, program, level, buildings/floors, time profile, first admin user.

Production bootstrap correctly refuses to seed demo data. Without a setup wizard, a production database is an empty API.

### 6. Time-profile / working-day / slot / break configuration

`slots` are a constant 5×6 grid compiled in `store.ts`. There is no API or screen to add a Saturday, a lunch break (`isBreak`), or a different period length. Break-slot validation exists; break-slot *editing* does not.

### 7. Policy CRUD, versioning and impact preview

Policies can be listed and created through the confirmed AI tool. There is no update, deactivate, version bump, effective-dated edit, or “what would this prohibit on the last run?” preview. `MAX_DAILY_PERIODS` is implemented in the engine but not offered as a first-class form.

### 8. Immutable generation snapshots

The solver input is rebuilt from live mutable arrays at request time. `GenerationRun` stores metrics/diagnostics JSON, not the full input snapshot. Replaying a past run against later faculty/availability edits is not possible.

### 9. Regeneration workflows

There is no “regenerate from this version”, no child version from a published timetable, and no way to lock some entries and re-solve the rest. After publish, the only legal path is a brand-new generation that is not linked via `parentVersionId`.

### 10. Audit query API / UI

`AuditEvent` and `AIAction` rows are written. Nothing lists, filters or displays them.

### 11. Browser-level tests

Coverage is domain + supertest + real OR-Tools. There is no Playwright path for login, preflight blockers, generate, move, publish, or HOD 403.

### 12. Production packaging / CI / deployment / readiness

This repository has no GitHub Actions workflow, container image, compose file, health-gated release checklist, or secret-rotation notes beyond README prose. Preview hosting still depends on `npm run dev` + `CHRONOS_SEED_DEMO=1`.

---

## P2 — operational completeness

| Gap | Actual state |
|---|---|
| Dedicated division / batch / faculty / room / department views | One grid with filters, including a Phase 2 department filter. No saved per-entity pages. |
| Combined-class participant editor | Requirements accept division *or* batch IDs. No UI to compose a combined class and show atomic occupancy. |
| Ordered fallback policy editor | Soft `RESOURCE_PREFERENCE` is a flat ID list. No ranked fallback chain. |
| Workload dashboard | Faculty `maxPeriodsPerWeek` is enforced, not visualized. |
| Version comparison | Version list exists; no diff of assignments between vN and vN+1. |
| Persistent AI conversations | Rows are inserted per call; the UI is a stateless chat that cannot reload history. |
| Excel / PDF | CSV export only. |
| Frontend UX | Dense single-file React client. Works, but setup/generate/timetable need structured pages, empty-production states, and error toasts. |

---

## P3 — scale and insight

| Gap | Actual state |
|---|---|
| Background generation jobs | `POST /api/generation/run` blocks the HTTP request and the Python process. |
| Solver / candidate benchmarks | No fixture larger than the six-session demo. |
| Validator performance | Pairwise assignment loops are O(n²). Fine at demo size. |
| Objective contribution reporting | One scalar `objective` plus a few quality metrics. No per-policy / per-penalty breakdown. |
| Large-grid virtualization | The timetable table renders every day × period cell. |

---

## Recommended Phase 3 sequence

Do not start with P3 polish.

1. **P0 security reads + truthful dashboard + locked version allocation** — otherwise “production” still leaks data and can corrupt versions.
2. **P0 PostgreSQL integrity job** — prove the checked-in migrations and triggers on the advertised production engine.
3. **P1 empty-institution setup + time-profile editing + snapshots/regeneration** — so a real college can exist without `CHRONOS_SEED_DEMO`.
4. **P1 audit API/UI, Playwright, packaging/CI**.
5. Only then P2 views/exports and P3 jobs/benchmarks.

## Out of scope reminder

This document is an audit. It must not be treated as an implementation commit. Phase 2 remains the last published functional change.
