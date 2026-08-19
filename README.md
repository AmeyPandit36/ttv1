# Campus Chronos

Intelligent, constraint-safe college timetable generation and policy management. The LLM-facing assistant interprets policies; a deterministic Google OR-Tools CP-SAT engine creates assignments; an independent TypeScript validator verifies the result.

![Architecture](https://img.shields.io/badge/solver-OR--Tools%20CP--SAT-6755d9) ![TypeScript](https://img.shields.io/badge/API-TypeScript-3178c6) ![Database](https://img.shields.io/badge/database-PostgreSQL-336791)

## Stack

- React 19, TypeScript, Vite, responsive custom administrative design
- Node 22, Express 5, Zod contracts
- PostgreSQL-compatible PGlite runtime, PostgreSQL 14+ production migration, Prisma schema
- Python 3.11, Google OR-Tools CP-SAT
- Vitest, Supertest and Python unittest

See [architecture](docs/ARCHITECTURE.md) and [API contract](docs/API.md).

## Run locally

Prerequisites: Node 22+ and Python 3.11+. The local application embeds a durable PostgreSQL-compatible PGlite database under `data/`; production can use PostgreSQL 14+.

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r scheduler/requirements.txt
CHRONOS_SEED_DEMO=1 npm run dev
```

Open `http://localhost:5173` and sign in with `admin@chronos.local` / `Chronos123!`. The API listens on `0.0.0.0:4000`; Vite serves on `0.0.0.0:5173` and proxies browser `/api` calls. The included durable embedded database is migrated and seeded automatically, so the integrated workflow runs without external infrastructure: 2026–27, IT/CSE departments, Third Year A/B, batches A1/A2, faculty availability/workloads, classroom/labs/capabilities, lectures/practicals and a department-resource policy.

To provision PostgreSQL for the persistence model:

```bash
cp .env.example .env
# create the database referenced by DATABASE_URL
npm run db:migrate
npm run db:generate
```

The checked-in `prisma/migrations/20260819000000_initial/migration.sql` creates the fresh schema. The same checked-in migration is executed by the embedded runtime (with the UUID extension default omitted because IDs are application-generated).

## Verify

```bash
npm test       # 19 domain + API/real scheduler + Python solver tests
npm run build  # domain, API and production web bundle
npm audit --omit=dev
```

## Implemented product slice

- Normalized college schema: academic hierarchy, student enrollment/cohorts, faculty, infrastructure/capabilities, time, teaching, policies, scheduling/versioning, validation/conflicts, AI and auditing.
- Requirement-to-session expansion with weekly frequency.
- Canonical atomic cohort occupancy for whole divisions, batches and combined classes.
- Pre-solve candidate filtering for continuity, active state, capacity, type, required capabilities, blackouts and hard policies.
- CP-SAT exact-one assignments; resource, faculty and cohort non-overlap; workload and consecutive limits; weighted preferences.
- Grounded no-candidate and global infeasibility diagnostics.
- Independent validator and guarded manual-move API.
- Version lifecycle and immutable published versions.
- Entity-grounded, confirmation-based policy assistant and evidence-grounded assignment explanations.
- Professional dashboard, setup lists, generation workflow, versioned/filterable timetable grid and AI conversation UI.
- Bcrypt/JWT authentication, ADMIN/HOD mutation authorization, audit writes, security headers and rate limits.
- Durable embedded PostgreSQL-compatible persistence with restart hydration.
- Validated CSV import preview/confirmation and canonical timetable CSV export.
- Faculty/resource availability editors, student enrollment, setup forms, manual move UI and lifecycle review/publish controls.
- Phase 2 hardening: candidate-aware preflight, persisted faculty eligibility, required-resource and minimum-capacity enforcement, hard/soft daily-period policies, expanded independent validator, transactional generation/import/move, published immutability, ADMIN-only college-wide writes, setup/import reference checks, and grounded AI read tools.

## Known limitations

- Local mode uses embedded PGlite rather than a network PostgreSQL service. The checked-in migration is PostgreSQL-compatible, but deployment automation for a managed PostgreSQL instance is not included.
- Availability and time-profile data are enforced and persisted, while dedicated visual calendar editors for every availability record remain basic.
- The policy assistant supports resource preference/prohibition through a deterministic fallback and an optional OpenAI-compatible structured-output provider. Additional policy plug-ins can be added without changing the tool boundary.
- CSV import and CSV timetable export are implemented; Excel and PDF renderers are not included.
- Authentication uses signed eight-hour JWTs with bcrypt password hashes. Production deployment should connect institutional OIDC, rotate `JWT_SECRET`, and add refresh/session revocation.
- Generation runs execute synchronously. Large institutions should move solving to a durable job worker with streamed progress.
- Browser-level Playwright coverage is not included; domain, real solver and HTTP integration workflows are automated.

## Recommended next work

1. Add Testcontainers coverage against network PostgreSQL and transactional optimistic concurrency.
2. Expand visual availability/time-profile and enrollment editors.
3. Move generation to a durable worker and stream progress.
4. Add more typed policy plug-ins and multi-turn provider conversations.
5. Add Excel/PDF exports and drag-and-drop interactions.
6. Integrate institutional OIDC and browser-level Playwright coverage.
