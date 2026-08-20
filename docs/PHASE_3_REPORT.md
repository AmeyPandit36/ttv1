# Phase 3 production maturity report

This report summarizes the implementation details, source-level verification, and current environment-dependent checks for the **Phase 3 Production Maturity Implementation** of Campus Chronos.

---

## 1. Requirement-by-requirement verification matrix

| Requirement | Audit item | Current status | Implementation file / component | Proving regression test or verification path |
| :--- | :--- | :--- | :--- | :--- |
| **P0-1** | Security-scoped READ APIs | **Complete** | `apps/api/src/app.ts` scoped collection/dashboard/timetable/export reads; `apps/api/src/ai-tools.ts` grounded read filters | `apps/api/src/phase3-p0.test.ts` |
| **P0-2** | Truthful dashboard | **Complete** | `GET /api/dashboard` uses persisted SQL counts and explicit setup-required state | `apps/api/src/phase3-p0.test.ts` |
| **P0-3** | Safer version allocation and stale update checks | **Implemented with limits** | `apps/api/src/db.ts` `allocateVersionNumber()` locks parent `Timetable`; `apps/api/src/app.ts` rejects stale move/transition requests when clients send `updatedAt` | `apps/api/src/phase3-p0.test.ts` |
| **P0-4** | PostgreSQL integrity testing | **Source complete; environment-dependent execution** | `scripts/verify-postgres.js`; `.github/workflows/ci.yml` PostgreSQL service step | Run `DATABASE_URL=... npm run verify:postgres` against PostgreSQL 14+ |
| **P1-1** | Empty-institution setup | **Complete** | `persistEntity()` writes `academicYears`, `buildings`, `floors`, hierarchy/setup entities | `apps/api/src/phase3-p1-setup-profile.test.ts` |
| **P1-2** | Time profile system | **Complete** | Dynamic `ScheduleProfile`, `WorkingDay`, `TimeSlot` hydration plus profile APIs | `apps/api/src/phase3-p1-setup-profile.test.ts` |
| **P1-3** | Immutable generation snapshots | **Complete** | `GenerationRun.scope` stores solver input snapshots | `apps/api/src/phase3-p1-snapshots-regen-policies.test.ts` |
| **P1-4** | Regeneration workflow | **Complete** | `POST /api/timetables/versions/:id/regenerate`; solver honors required locked slots/resources | `apps/api/src/phase3-p1-snapshots-regen-policies.test.ts` |
| **P1-5** | Policy management | **Complete** | `PUT /api/policies/:id`; full policy upsert persistence | `apps/api/src/phase3-p1-snapshots-regen-policies.test.ts` |
| **P1-6** | Audit API + UI paths | **Complete** | `GET /api/audit-events`; `GET /api/ai-actions`; admin-only access | `apps/api/src/phase3-p1-audit.test.ts` |
| **P1-7** | Browser testing | **Source complete; browser-runtime dependent** | `playwright.config.ts`; `apps/web/tests/e2e.spec.ts` | Run `npx playwright test` where Playwright browsers are installed |
| **P1-8** | CI and production packaging | **Source complete; remote execution pending runner/permissions** | `.github/workflows/ci.yml`, `Dockerfile`, `docker-compose.yml`, `docs/PRODUCTION.md` | Workflow installs dependencies, builds domain, runs Node/Python tests, verifies PostgreSQL, builds production bundles, and audits production dependencies |
| **P2-1** | Dedicated timetable views | **Complete** | `apps/web/src/main.tsx` global/department/faculty/room/cohort filters | Web production build |
| **P2-2** | Combined-class participant editor | **Complete** | `apps/web/src/main.tsx` create modal division/batch composer | Web production build |
| **P2-3** | Ordered fallback policy editor | **Complete** | `apps/web/src/main.tsx` policy form maps fallback lists to structured parameters | Web production build |
| **P2-4** | Faculty workload dashboard | **Complete** | `apps/web/src/main.tsx` demand/capacity dashboard | Web production build |
| **P2-5** | Timetable version comparison/diff | **Complete** | `apps/web/src/main.tsx` comparison panel | Web production build |
| **P2-6** | Persistent AI conversations | **Complete** | Conversation/message persistence and history endpoints | `apps/api/src/phase3-p2.test.ts` |
| **P2-7** | Excel and PDF export | **Complete** | `.xlsx` export uses `apps/api/src/xlsx-export.ts`; `.pdf` export uses PDFKit | `apps/api/src/phase3-p2.test.ts` verifies binary ZIP/XLSX and PDF responses |
| **P3-1** | Asynchronous generation jobs | **Implemented as in-process async mode** | `POST /api/generation/run?async=true` returns 202 and continues in-process | `apps/api/src/phase3-p3.test.ts` |
| **P3-2** | Solver/candidate benchmarks | **Complete** | Large-scale benchmark fixture in `scheduler/tests/test_solver.py` | Python unittest suite |
| **P3-3** | Optimized validator | **Complete** | `packages/domain/src/index.ts` hash-map occupancy validation | `packages/domain/src/index.test.ts` |
| **P3-4** | Objective contribution reporting | **Complete** | `scheduler/solve.py` objective breakdown metrics | Python unittest suite |
| **P3-5** | Large-grid virtualization | **Complete** | `apps/web/src/styles.css` uses `content-visibility: auto` | Web production build |

---

## 2. Current technical changes

### Database and persistence

No new Prisma migrations were required for Phase 3 cleanup. Existing schema tables are now used more completely, including `AcademicYear`, `Building`, `Floor`, `ScheduleProfile`, `WorkingDay`, `TimeSlot`, `GenerationRun.scope`, conversations, audit events, and AI actions.

### API endpoints added or expanded

- `GET /api/dashboard` — SQL-backed, role-scoped dashboard counts.
- `GET /api/:collection` — role-scoped setup/configuration reads; exposes `academicYears`, `buildings`, and `floors`.
- `GET /api/timetables/versions` and `GET /api/timetables/versions/:id` — role-scoped assignments and related entities.
- `GET /api/time-profiles`, `POST /api/time-profiles`, `POST /api/time-profiles/:id/activate` — configurable schedule profile workflow.
- `POST /api/timetables/versions/:id/regenerate` — linked regeneration with locked assignment support.
- `PUT /api/policies/:id` — persisted policy updates.
- `GET /api/audit-events`, `GET /api/ai-actions` — admin audit/AI activity queries.
- `GET /api/timetables/versions/:id/export.xlsx` — binary XLSX export using an in-repository minimal OpenXML writer. The vulnerable `xlsx` dependency was removed.
- `GET /api/timetables/versions/:id/export.pdf` — binary PDF export using PDFKit.
- `GET /api/ai/conversations`, `GET /api/ai/conversations/:id/messages` — persistent conversation history.

### Scripts and CI

- `npm test` now runs `npm run build:domain` before workspace tests, so a fresh `npm ci` does not require a manual prior `@chronos/domain` build.
- `npm run test:node` builds domain and runs domain/API tests.
- `npm run test:python` runs scheduler tests through `scripts/run-python-tests.js`, preferring `.venv` but allowing `PYTHON=/path/to/python`.
- `npm run verify:postgres` runs the PostgreSQL verification script when `DATABASE_URL` points to a real PostgreSQL service.
- `.github/workflows/ci.yml` defines dependency installation, Python solver dependency setup, domain build, Node tests, Python tests, PostgreSQL verification, production build, and production dependency audit.

---

## 3. Current verification results

Local verification performed during the cleanup milestone:

- **Node/domain/API tests:** 50/50 passed (`14` domain + `36` API).
- **Python CP-SAT solver tests:** 10/10 passed.
- **Total automated local tests:** 60/60 passed.
- **Production build:** domain, API, and web bundles compile successfully.
- **Production dependency audit:** `npm audit --omit=dev` reports 0 vulnerabilities after removing the vulnerable `xlsx` package.

Environment-dependent checks:

- **PostgreSQL verification:** source and CI workflow are present; local sandbox execution still requires an available PostgreSQL service and `DATABASE_URL`.
- **Playwright:** test source/configuration are present; execution requires installed browser binaries.

---

## 4. Remaining limitations and Phase 4 recommendations

1. **Durable async queue:** current async generation is in-process and fire-and-forget. Move this to a durable worker/queue before relying on it for long production solves.
2. **Copy-on-write edits:** manual moves still update draft/validated versions in place. Add child edit versions and stricter SQL `WHERE updatedAt = expected` updates as a separate concurrency-hardening effort.
3. **Environment verification:** run `npm run verify:postgres` against real PostgreSQL and `npx playwright test` in an environment with installed browser binaries.
4. **Operational auth:** integrate institutional OIDC/session revocation and documented secret rotation procedures.
