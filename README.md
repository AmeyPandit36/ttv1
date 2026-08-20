# Campus Chronos

Intelligent, constraint-safe college timetable generation and policy management. The assistant interprets grounded scheduling policies; a deterministic Google OR-Tools CP-SAT engine creates assignments; an independent TypeScript validator verifies the result.

![Architecture](https://img.shields.io/badge/solver-OR--Tools%20CP--SAT-6755d9) ![TypeScript](https://img.shields.io/badge/API-TypeScript-3178c6) ![Database](https://img.shields.io/badge/database-PostgreSQL-336791)

## Stack

- React 19, TypeScript, Vite, responsive administrative UI
- Node 22, Express 5, Zod contracts
- PostgreSQL-compatible PGlite local runtime, PostgreSQL 14+ production migration, Prisma schema
- Python 3.11, Google OR-Tools CP-SAT
- Vitest, Supertest, Python unittest, and Playwright E2E source/configuration
- PDFKit plus an in-repository minimal XLSX writer for binary timetable exports

See [architecture](docs/ARCHITECTURE.md), [API contract](docs/API.md), [Phase 3 report](docs/PHASE_3_REPORT.md), and [production guide](docs/PRODUCTION.md).

## Run locally

Prerequisites: Node 22+ and Python 3.11+. The local application embeds a durable PostgreSQL-compatible PGlite database under `data/`; production can use PostgreSQL 14+.

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r scheduler/requirements.txt
CHRONOS_SEED_DEMO=1 npm run dev
```

Open `http://localhost:5173` and sign in with `admin@chronos.local` / `Chronos123!`. The API listens on `0.0.0.0:4000`; Vite serves on `0.0.0.0:5173` and proxies browser `/api` calls. With `CHRONOS_SEED_DEMO=1`, the embedded database is migrated and seeded automatically with academic year 2026–27, IT/CSE departments, divisions, batches, faculty, resources, availability/workload data, teaching requirements, and sample policies.

To provision PostgreSQL for the production persistence model:

```bash
cp .env.example .env
# create the database referenced by DATABASE_URL
npm run db:migrate
npm run db:generate
```

The checked-in `prisma/migrations/20260819000000_initial/migration.sql` creates the fresh schema. The embedded runtime applies equivalent SQL locally, with UUID defaults handled by application-generated IDs.

## Verify

Install Node and Python dependencies first:

```bash
npm ci
python3 -m venv .venv
.venv/bin/pip install -r scheduler/requirements.txt
```

Then run:

```bash
npm test              # builds @chronos/domain, then runs domain/API/Python tests
npm run build         # domain, API, and production web bundle
npm audit --omit=dev  # production dependency audit
```

Optional environment-dependent checks:

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/db npm run verify:postgres
npx playwright test
```

`verify:postgres` requires a real PostgreSQL 14+ database. Playwright requires installed browser binaries (`npx playwright install` or a CI image/cache that already contains them).

## Implemented product slice

- Normalized college schema: academic hierarchy, student enrollment/cohorts, faculty, infrastructure/capabilities, time, teaching, policies, scheduling/versioning, validation/conflicts, AI, and auditing.
- Requirement-to-session expansion with weekly frequency.
- Canonical atomic cohort occupancy for whole divisions, batches, and combined classes.
- Pre-solve candidate filtering for continuity, active state, capacity, type, required capabilities, blackouts, and hard policies.
- CP-SAT exact-one assignments; resource, faculty, and cohort non-overlap; workload and consecutive limits; weighted preferences; objective contribution metrics.
- Grounded no-candidate and global infeasibility diagnostics.
- Optimized independent validator and guarded manual-move API.
- Version lifecycle, parent/child regeneration links, immutable published versions, and optimistic stale-update checks when clients supply version timestamps.
- Role-scoped read APIs for dashboard data, collections, timetable versions, exports, and grounded AI read tools.
- Truthful SQL-backed dashboard with explicit setup-required state for empty institutions.
- Empty-institution setup support for academic years, buildings, floors, hierarchy entities, faculty, resources, requirements, and enrollments.
- Configurable time profiles, working days, slots, breaks, and active-profile hydration.
- Policy create/update/deactivate persistence and policy assistant proposal confirmation.
- Immutable generation snapshots persisted in `GenerationRun.scope`.
- Regeneration from existing versions with selected locked assignments.
- Admin audit and AI-action query APIs plus UI access paths.
- Persistent AI conversations with message history.
- Dedicated timetable filters/views, faculty workload dashboard, combined-class participant editor, fallback-policy editor, and version diff panel.
- CSV import preview/confirmation, CSV export, binary XLSX export, and binary PDF export.
- In-process asynchronous generation mode via `POST /api/generation/run?async=true`; the default generation endpoint remains synchronous.
- Dockerfile, docker-compose, production guide, and GitHub Actions CI workflow source.
- Bcrypt/JWT authentication, ADMIN/HOD authorization boundaries, audit writes, security headers, and rate limits.

## Known limitations

- Local mode uses embedded PGlite rather than a network PostgreSQL service. A PostgreSQL verification script and CI workflow are present, but real PostgreSQL execution depends on an available PostgreSQL service/runner.
- Browser E2E coverage is present in source (`playwright.config.ts`, `apps/web/tests/e2e.spec.ts`), but execution requires installed Playwright browser binaries. Sandboxes without those binaries cannot run it.
- The async generation path is in-process and fire-and-forget, not a durable external queue/worker with resumable progress.
- Manual moves update draft/validated versions in place. They reject stale updates when clients provide `updatedAt`, but full copy-on-write edit versions are still future work.
- Availability and time-profile data are enforced and persisted, while visual calendar editors remain basic.
- Authentication uses signed eight-hour JWTs with bcrypt password hashes. Production deployment should connect institutional OIDC, rotate `JWT_SECRET`, and add refresh/session revocation.

## Recommended next work

1. Run and monitor the PostgreSQL verification workflow on a real CI runner/service.
2. Run Playwright E2E in an environment with cached/installed browsers.
3. Move async generation to a durable worker/queue with streamed progress.
4. Implement copy-on-write edit versions and stricter SQL-level optimistic updates.
5. Expand visual availability/time-profile and enrollment editors.
6. Add more typed policy plug-ins, institutional OIDC, and drag-and-drop timetable interactions.
