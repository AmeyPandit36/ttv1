# Campus Chronos architecture

## Decisions

Campus Chronos is a typed modular monorepo with four boundaries:

1. **React administration client** (`apps/web`) presents setup, generation, timetable and policy-assistant workflows. It talks only to `/api`; Vite proxies that relative path in development so preview and production origins remain safe.
2. **Express application API** (`apps/api`) owns authorization, input orchestration, lifecycle transitions, AI tools and audit boundaries. Scheduling requests are immutable snapshots.
3. **Domain package** (`packages/domain`) owns shared schemas, cohort semantics, eligibility rules, and an independent post-solve validator. It has no dependency on OR-Tools.
4. **Python CP-SAT engine** (`scheduler`) receives and returns typed JSON. It does not access the database and knows nothing about chat. This makes generation deterministic and replayable.
5. **PostgreSQL persistence model** (`prisma`) is normalized and migration-owned. Candidate combinations are deliberately not persisted; generation snapshots, counts, metrics and diagnostics are persisted instead.

The implementation does not use an AI framework. An OpenAI-compatible provider adapter can be placed before the existing controlled tool layer; tools remain the security boundary.

## Scheduling data flow

`TeachingRequirement → Session Builder → Candidate Generator → CP-SAT → Independent Validator → TimetableVersion`

A requirement with frequency *n* expands to *n* independently assignable sessions. Candidate generation forms same-day, consecutive atomic slot blocks, then rejects inactive/incompatible/undersized/unavailable resources and faculty blackouts. Only remaining `(session, block, resource)` candidates become Boolean variables.

### Cohort occupancy

Occupancy uses canonical **atomic cohort IDs**, never display strings. A batch session occupies its batch atom. A whole-division session expands to every batch atom in that division. A combined class stores the union of atoms from every participant. Consequently A1 and A2 can run in parallel, but Division A conflicts with either; combined classes conflict only with participating cohorts. A division with no batches receives a stable division atom.

### Solver model

For candidate `c` of session `s`, `x[s,c] ∈ {0,1}` and `Σc x[s,c] = 1`. Indexed at-most-one constraints enforce resource, faculty and atomic-cohort occupancy for every slot. Faculty workload is checked before solve; consecutive workload is constrained across uninterrupted windows. Hard policies filter candidates or add constraints. The objective minimizes weighted penalties for fallback resources, missing preferred capabilities, undesirable faculty periods and soft policy mismatches. Hard constraints never receive penalty variables.

This realizes feasibility and quality in one CP-SAT model while preserving their semantic separation: an objective can never buy a hard violation.

### Independent validation

The TypeScript validator does not inspect solver internals. From persisted assignments and the same immutable input snapshot it recomputes completeness, resource eligibility/capacity/type/capability, continuity, faculty/resource availability, collisions for resource/faculty/atomic cohort, and weekly workloads. Manual moves call this validator before mutation. Published versions reject edits.

## Service boundaries

- Academic: years, departments, programs, levels, divisions, batches, enrollments.
- Faculty: identity, eligibility, workload, availability, preferences.
- Infrastructure: buildings, floors, zones, resources, capabilities, availability.
- Teaching: subjects, requirements, requirement participants and capability needs.
- Time: profiles, days and atomic slots (breaks are non-teaching slots).
- Policy: versioned, scoped typed rules; hard or weighted soft strength.
- Scheduling: snapshots, runs, sessions, versions, entries, validation and conflicts.
- AI: conversations, messages, proposed actions, confirmations and tool logs.

The API persists through a PostgreSQL-compatible repository. Local mode runs durable PGlite with the checked-in SQL migration; production uses PostgreSQL. Repository methods preserve the same domain and scheduler interfaces.

## AI tool contract and safety

The assistant cannot issue SQL or assignments. Its workflow is:

`message → entity lookup → typed proposal → schema validation → confirmation → authorized tool`

Current tools are `interpretPolicy`, `createPolicy` (confirmation required), and evidence-grounded `explainAssignment`. Unknown resource names return configured choices rather than inventing entities. Tool endpoints share ADMIN/HOD authorization. Prompt text is treated as data, never as authorization. A future provider receives only allowed entity summaries and JSON schemas; server-side tool validation remains mandatory.

## Lifecycle and concurrency

Allowed progression is `DRAFT → GENERATED → VALIDATED → REVIEWED → APPROVED → PUBLISHED`. A published version is immutable; edits require a child version. In production, transitions and manual moves must use database transactions with optimistic version checks. Generation runs capture status, session/candidate counts, duration, solver result, objective metrics and diagnostics.

## Risks and mitigations

- **Combinatorial growth:** prune candidates and index occupancy rather than pairwise session constraints; scope runs and set time limits.
- **Stale input during generation:** snapshot IDs/versions and hash sessions; never read mutable tables from the solver.
- **Misleading infeasibility:** report candidate rejection counters separately from global collision infeasibility; never let an LLM invent causes.
- **Policy explosion:** allow only registered rule types with typed parameter validators and version policies.
- **Manual edit races:** transactional copy-on-write versions and optimistic locking.
- **Enrollment ambiguity:** explicit requirement participants and atomic cohort expansion; validate that combined capacity does not double-count overlapping participants.
- **LLM prompt injection:** minimum tool set, role checks, schema checks, confirmation, no unrestricted retrieval or database tools.

## Testing strategy

Pure domain unit tests cover capabilities, capacity, continuity and cohort overlap. Scheduler tests run real OR-Tools for feasibility, grounded diagnostics, combined occupancy and workload. API integration tests execute the Python process, independent validation, authorization and AI confirmation/entity safety. Production should add Testcontainers PostgreSQL repository tests and Playwright browser workflows.
