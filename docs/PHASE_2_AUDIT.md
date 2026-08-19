# Phase 2 audit of the Phase 1 baseline

This audit was performed against the published `main` tree
(`428f7e26b65b7f36c2212199415e95b5c887a6d2`) before Phase 2 hardening.
It describes the actual repository, not the intended product narrative.

## Baseline that was already working

- Constraint-safe CP-SAT generation with candidate pruning, occupancy, workload and consecutive limits.
- Independent TypeScript validator for completeness, eligibility, continuity, availability and collisions.
- Authenticated API, durable PGlite persistence, setup writes, CSV import/export, availability editors and AI policy confirmation.
- Existing 19 automated tests and a live generate → validate → edit workflow.

## Gaps found in the actual code

| Requirement | Baseline finding |
|---|---|
| Candidate-aware preflight | `/api/generation/preflight` only counted sessions/resources/slots and missing faculty IDs. It did not enumerate candidates or report no-block, capacity, capability or availability blockers. |
| Faculty eligibility | `FacultySubjectEligibility` existed in Prisma/SQL but was never seeded, hydrated, exposed on faculty, or enforced by the scheduler/validator. Any faculty could be assigned any subject. |
| Required resource / min capacity | `minCapacity` and `requiredResourceId` existed on the schema. Sessions did not carry them. The solver compared only `participantCount`. |
| Daily-period policies | `MAX_DAILY_PERIODS` was a documented policy type and was not implemented in CP-SAT or the validator. Soft policies only affected resource preference penalties. |
| Validator coverage | The validator missed duplicate/unknown assignments, unknown/repeated/break slots, required-resource violations, consecutive workload, and hard daily-policy violations. |
| Transactions | Generation, import confirm and moves issued sequential writes. A mid-loop failure could leave a version, entry or imported row behind. |
| Published immutability | Only the in-memory `status === 'PUBLISHED'` check existed. The database would still accept entry updates. |
| Production bootstrap | Empty databases always received the demo college and `admin@chronos.local` / `Chronos123!`. |
| Authorization | Every mutation accepted `ADMIN` or `HOD` with no department scope. HOD therefore had unsafe college-wide write access. |
| Setup/import references | Zod checked shapes, not whether `departmentId`, `facultyId`, `subjectId`, `divisionId` or `batchId` existed. |
| Grounded AI tools | The assistant could propose policies and explain one assignment. It had no live tools for eligible resources, conflicts, unscheduled sessions or generation diagnostics. |
| Generation / timetable UI | Generation showed coarse counts. Timetable cards omitted faculty/department and had no department filter. |

## Decision

Do not rebuild the platform. Harden the existing Phase 1 pipeline in place, add tests for every Phase 2 control, and keep Phase 1 hard constraints intact.
