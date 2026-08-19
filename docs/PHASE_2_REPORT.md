# Phase 2 report

Phase 2 hardens the existing Campus Chronos Phase 1 pipeline. It does not replace the solver, validator or persistence model.

## Findings

The published Phase 1 baseline already generated feasible timetables, validated collisions and persisted authenticated workflows. It did not enumerate candidates before solve, did not persist or enforce faculty-subject eligibility, did not apply required-resource / minimum-capacity / daily-period policies, did not wrap writes in transactions, auto-seeded production credentials, and treated HOD as a college-wide writer.

## Implementation changes

1. **Candidate-aware preflight** — `analyzeCandidates()` enumerates feasible (resource, block) options and returns blockers: no time block, no eligible faculty, no candidate resource, insufficient capacity, missing capability, faculty/resource unavailability.
2. **Faculty eligibility** — eligibility is seeded, hydrated, accepted on faculty create, required on teaching requirements, and enforced in the solver and independent validator.
3. **Required resource and minimum capacity** — sessions carry `requiredResourceId` and `minCapacity`; both are hard filters in candidate generation, CP-SAT input and the validator.
4. **Daily-period policies** — `MAX_DAILY_PERIODS` is a CP-SAT hard constraint or a weighted overflow penalty. The validator independently flags hard daily violations.
5. **Expanded validator** — duplicate/unknown assignments, unknown/repeated/break slots, required-resource, consecutive workload, hard daily policy, plus the original collision/capacity/capability/availability/continuity checks.
6. **Transactions** — generation persist, multi-row import confirm and manual moves run in `BEGIN/COMMIT` with rollback on failure.
7. **Published protection** — API rejects edits; `persistMove` re-checks database status; PostgreSQL triggers reject entry/slot mutation of `PUBLISHED` versions.
8. **Production-safe bootstrap** — demo college and `admin@chronos.local` are created only when `CHRONOS_SEED_DEMO=1` or during tests. `npm run db:seed` is the explicit seed entry point.
9. **Authorization** — college-wide mutations are ADMIN-only. HOD may read and use preflight/grounded tools until department scoping exists.
10. **Reference validation** — setup and import reject unknown department/faculty/subject/division/batch/resource references and ineligible faculty-subject pairs.
11. **Grounded AI tools** — `eligibleResources`, `currentConflicts`, `unscheduledSessions`, `generationDiagnostics` read live application data. The LLM still cannot write assignments.
12. **Generation UI** — blockers, scheduled/unscheduled counts, quality metrics and validation status.
13. **Timetable UI** — faculty/department on cards and an authoritative department filter.

## Files changed

- `packages/domain/src/{index,candidates,helpers,index.test}.ts`
- `scheduler/solve.py`, `scheduler/tests/test_solver.py`
- `apps/api/src/{app,app.test,db,store,setup-schemas,references,ai-tools}.ts`
- `apps/web/src/{main.tsx,styles.css}`
- `prisma/migrations/20260819100000_phase2_hardening/migration.sql`, `prisma/seed.ts`
- `package.json`, `.env.example`, `README.md`, `docs/API.md`, `docs/PHASE_2_AUDIT.md`, `docs/PHASE_2_REPORT.md`

## Tests

| Suite | Result |
|---|---|
| Domain / validator / preflight | 14 passed |
| API / integration / Phase 2 | 17 passed |
| Real OR-Tools scheduler | 9 passed |
| **Total** | **40 passed** |

Covered: faculty eligibility, required resource, minimum capacity, hard daily policy, soft preference objective, validator violations, transactional rollback, published protection, grounded AI tools, candidate-aware preflight, HOD write denial, reference validation. Existing Phase 1 generate → validate → reject-collision tests still pass.

## Builds

- `@chronos/domain` TypeScript build passed
- `@chronos/api` TypeScript build passed
- `@chronos/web` `tsc -b && vite build` passed (1565 modules)
- `npm audit --omit=dev` — 0 vulnerabilities

## Fresh database migration

Applied `20260819000000_initial` then `20260819100000_phase2_hardening` on an empty PostgreSQL-compatible PGlite instance:

- 40 public tables created
- immutability triggers present: `chronos_timetable_version_immutable`, `chronos_timetable_entry_immutable`, `chronos_timetable_entry_slot_immutable`

## Live end-to-end workflow

Against a seeded API (`CHRONOS_SEED_DEMO=1`):

1. JWT login as `admin@chronos.local` — success
2. Candidate-aware preflight — `valid=true`, 156 candidates, 0 blockers
3. Generation — `OPTIMAL`, 6 independently valid assignments
4. Manual move of a legal assignment — 200
5. Collision move — 422
6. Lifecycle `VALIDATED → REVIEWED → APPROVED → PUBLISHED` — 200
7. Move after publish — 409 `PUBLISHED_IMMUTABLE`
8. Grounded `generationDiagnostics` tool — live OPTIMAL run
9. HOD `POST /api/resources` — 403 `FORBIDDEN`

## Remaining limitations

- HOD department-scoped writes are intentionally not implemented.
- Local mode still uses embedded PGlite; network PostgreSQL is schema-compatible but not integration-tested here.
- Generation remains synchronous.
- There is no Playwright/browser suite.
- Soft daily-period overflow is optimized in CP-SAT; the independent validator only fails **hard** daily policies.
- Concurrent generation still needs transactional version-number allocation under a real PostgreSQL lock (see Phase 3 audit).
