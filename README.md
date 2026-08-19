# Campus Chronos

Intelligent, constraint-safe college timetable generation and policy management. The LLM-facing assistant interprets policies; a deterministic Google OR-Tools CP-SAT engine creates assignments; an independent TypeScript validator verifies the result.

![Architecture](https://img.shields.io/badge/solver-OR--Tools%20CP--SAT-6755d9) ![TypeScript](https://img.shields.io/badge/API-TypeScript-3178c6) ![Database](https://img.shields.io/badge/database-PostgreSQL-336791)

## Stack

- React 19, TypeScript, Vite, responsive custom administrative design
- Node 22, Express 5, Zod contracts
- PostgreSQL 14+, Prisma schema and SQL migration
- Python 3.11, Google OR-Tools CP-SAT
- Vitest, Supertest and Python unittest

See [architecture](docs/ARCHITECTURE.md) and [API contract](docs/API.md).

## Run locally

Prerequisites: Node 22+, Python 3.11+, and (for persistent production mode) PostgreSQL 14+.

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r scheduler/requirements.txt
npm run dev
```

Open `http://localhost:5173`. The API listens on `0.0.0.0:4000`; Vite serves on `0.0.0.0:5173` and proxies browser `/api` calls. The included realistic in-memory demo repository means the integrated workflow runs without infrastructure: 2026–27, IT/CSE departments, Third Year A/B, batches A1/A2, faculty availability/workloads, classroom/labs/capabilities, lectures/practicals and a department-resource policy.

To provision PostgreSQL for the persistence model:

```bash
cp .env.example .env
# create the database referenced by DATABASE_URL
npm run db:migrate
npm run db:generate
```

The checked-in `prisma/migrations/20260819000000_initial/migration.sql` creates the fresh schema. The present demo API repository is intentionally infrastructure-free; wiring it to generated Prisma repositories is listed under limitations.

## Verify

```bash
npm test       # domain + API/real scheduler + Python solver tests
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
- Role boundary for ADMIN, HOD, FACULTY and STUDENT development identities.

## Known limitations

This repository is a production-oriented vertical slice, not the entire multi-year product backlog in the master brief:

- The running demo uses an in-memory repository; process restarts reset data. The complete PostgreSQL schema/migration exists, but API repositories and transactional persistence are not yet wired to Prisma.
- Setup screens currently provide connected list views; the “Add” buttons are visual while typed create endpoints exist. Full forms, update/delete, availability editors and enrollment import are pending.
- Manual move validation exists in the API, but drag-and-drop UI is pending.
- The policy assistant currently uses a deterministic safe interpreter for resource preference/prohibition. The controlled tool boundary is ready, but an external provider adapter, broader typed rule catalog and durable conversations are pending.
- Authentication uses explicit development bearer identities, not password/OIDC sessions. Production deployment must add OIDC/password hashing, CSRF/rate limiting, persistent audit writes and department-row scoping.
- CSV/Excel import, PDF/Excel export, background job queue/progress streaming, copy-on-write version UI, Testcontainers repository tests and Playwright tests are not yet included.
- Infeasible global collision diagnostics are grounded at aggregate level; minimal unsatisfiable cores and relaxation ranking are a recommended enhancement.

## Recommended next work

1. Implement Prisma repositories and transactions, then PostgreSQL/Testcontainers integration tests.
2. Add typed CRUD forms and availability/time-profile editors with optimistic concurrency.
3. Move generation to a durable worker and persist immutable input snapshots/fingerprints.
4. Add policy-rule plugins and a provider-agnostic LLM adapter with tool-call transcripts.
5. Add drag/drop version cloning, scope views, import previews and exports.
6. Add OIDC/RBAC department filters, security headers, rate limits and end-to-end Playwright coverage.
