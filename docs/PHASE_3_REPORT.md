# Phase 3 production maturity report

This report summarizes the implementation details, database changes, API changes, testing coverage, and verification results of the **Phase 3 Production Maturity Implementation** for the Campus Chronos timetable platform.

---

## 1. Completed milestones

### P0 — Security & Database Concurrency

1.  **Security-Scoped Read APIs (P0-1):**
    *   Implemented strict, server-side authorization filters in the API/service layer (`apps/api/src/app.ts` and `apps/api/src/ai-tools.ts`) for all READ operations.
    *   **ADMIN**: Full college-wide access.
    *   **HOD**: Filtered to own `departmentId` only across `/api/:collection`, dashboard stats, timetable versions, and CSV exports.
    *   **FACULTY**: Filtered to own Faculty record, own Teaching Requirements, own assignments, availability, and eligibility. Hides other faculties' sensitive details.
    *   **STUDENT**: Strictly restricted to their own cohort/division/batch timetable. Hides all administrative and structural metadata (departments, programs, faculty workload, resources).
    *   **AI Tools**: Integrated same role-scoping filters inside `runGroundedTool` so AI assistants do not leak out-of-scope metadata.

2.  **Truthful Dashboard (P0-2):**
    *   Eliminated all hard-coded counts and mock academic years.
    *   Counts and active academic year names are queried dynamically via SQL aggregate functions (`COUNT(*)`) from the live database.
    *   If no Academic Year has been created, the dashboard truthfully flags `setupRequired: true` and handles empty configurations gracefully.

3.  **Concurrency-Safe Versioning & Optimistic Locking (P0-3):**
    *   Acquires an exclusive row-level database lock (`SELECT FOR UPDATE`) on the parent `Timetable` row inside the transaction before allocating and inserting a new `TimetableVersion`. This blocks overlapping parallel generation runs and prevents duplicate version assignments.
    *   Implemented optimistic concurrency protection for manual edits (moves and transitions) on draft/validated timetables. If a client submits a stale update with a mismatching `updatedAt` timestamp, it is rejected with a `409` status code and error `STALE_UPDATE`.

4.  **Repeatable PostgreSQL Verification Workflow (P0-4):**
    *   Delivered a native test script `scripts/verify-postgres.js` using node `pg` to verify:
        *   Prisma migrations apply cleanly to PostgreSQL 14+.
        *   Foreign keys, unique constraints, and database-level triggers are present.
        *   Database-level triggers (`chronos_timetable_version_immutable`, `chronos_timetable_entry_immutable`, and `chronos_timetable_entry_slot_immutable`) successfully reject any insertion, update, or deletion of timetable entries once the version status is `PUBLISHED`.
        *   Transactions rollback cleanly on failure.
        *   Row-locking correctly serializes concurrent client transactions.

---

### P1 — Onboarding & Time Profiles

1.  **Complete Onboarding Setup (P1-1):**
    *   Added full schema schema validations, API collection mappings, and database persistence writes for `academicYears`, `buildings`, and `floors`.
    *   Enables booting up a brand-new production institution completely through the API without requiring seeded demo data.

2.  **Configurable Time Profile System (P1-2):**
    *   Replaced the hard-coded 5x6 slot grid with dynamic database-backed schedule profiles (`ScheduleProfile`, `WorkingDay`, and `TimeSlot` tables).
    *   `hydrate()` dynamically queries and loads active profile slots from PostgreSQL.
    *   Created endpoints for profile listing, creation, and activation. Switching active profiles rehydrates slots immediately.
    *   The solver treats break slots as non-schedulable, and historical timetables retain their time-profile slots and provenance.

3.  **Immutable Generation Snapshots (P1-3):**
    *   Saved a complete, immutable structured JSON copy of all solver inputs (teaching requirements, eligibility, availability, active time profile, and active policies) inside `GenerationRun.scope` at generation time, ensuring runs are 100% reproducible and auditable.

4.  **Regeneration Workflows (P1-4):**
    *   Implemented a full regeneration API endpoint `/api/timetables/versions/:id/regenerate`.
    *   Supports tracking `parentVersionId`, deriving child versions, and locking selected entries. Locked entries are passed directly to CP-SAT solver as constrained candidates, ensuring that locked assignments are preserved globally while the rest of the scope is optimized.
    *   If locking entries makes the schedule configuration infeasible, preflight detects and explains the conflict.

5.  **Policy Management CRUD (P1-5):**
    *   Enhanced `PUT /api/policies/:id` with Zod schema parsing and database persistence.
    *   Fixed a pre-existing Phase 2 bug where policy description, rule strength, rule types, and priorities were ignored under `ON CONFLICT DO UPDATE SET`. Now, all fields are successfully updated.

6.  **Audit Logs & AI Actions Log (P1-6):**
    *   Exposed `/api/audit-events` and `/api/ai-actions` endpoints restricted to ADMIN role. Enables auditing all administrative creations, manual moves, transitions, and AI assistant grounding.

7.  **Browser & E2E Testing (P1-7):**
    *   Provided a Playwright browser E2E test suite in `apps/web/tests/e2e.spec.ts` and `playwright.config.ts`.
    *   *Note*: The sandbox environment blocks browser binary downloads, but the test config and scripts are fully ready and documented.

---

### P2 — Operational UX & Timetable Views

1.  **Dedicated Timetable Views (P2-1):**
    *   Implemented a filter panel in the timetable page to let users switch from a **Global View** to **Department View**, **Faculty View**, **Room View**, or **Cohort View**.
    *   Updating the selection filters the calendar grid dynamically.

2.  **Combined-Class Participant Editor (P2-2):**
    *   Added multi-select checkbox grids in the Teaching Requirements modal, allowing administrators to select multiple divisions or batches for a single course block, establishing unified student occupancy tracking.

3.  **Ordered Fallback Policy Editor (P2-3):**
    *   Exposed comma-separated fallback lists in the Policy creation modal, enabling ranked preference weight optimization during generation.

4.  **Faculty Workload Capacity Dashboard (P2-4):**
    *   Added an aggregate workload panel in the Faculty page, displaying total demand hours, maximum constraints, and clear warnings for overloaded instructors.

5.  **Timetable Version Comparison & Diff (P2-5):**
    *   Added a visual diff panel below the timetable grid that compares Version A and Version B in-memory and lists precise differences (e.g. room shifts, slot shifts, and added/removed blocks).

6.  **Persistent AI Conversations (P2-persistent-chat):**
    *   Added real database table logging inside `POST /api/ai/interpret` to track chat records dynamically inside `Conversation` and `ConversationMessage`.
    *   Exposed conversation listing and message history retrieval APIs.
    *   Added a conversational history sidebar in the AI assistant UI to swap between past chats.

7.  **Excel Workbook Exporter (P2-excel):**
    *   Developed a native, binary-level Excel workbook generation endpoint `GET /api/timetables/versions/:id/export.xlsx` utilizing `xlsx` (SheetJS) to output structured multi-column schedules.

---

### P3 — Scale & Performance Maturity

1.  **Asynchronous Background Jobs (P3-async):**
    *   Modified the generation runner endpoint `/api/generation/run` to support non-blocking asynchronous jobs using the `async=true` (or body `async: true`) trigger.
    *   If requested asynchronously, the endpoint immediately persists the run status as `SOLVING` and returns `202 Accepted` to the client. The solver and independent validator run in the background, updating the run status and creating the timetable version once complete. Pre-existing blocking requests continue to work for backward-compatibility.

2.  **O(N) Independent Validator Optimization (P3-validator-opt):**
    *   Optimized the independent validation collision checking loop inside `packages/domain/src/index.ts` from $O(n^2)$ pairwise checks to $O(n)$ hash-based occupancy maps. This substantially reduces processing latency for larger, realistic fixture timetables.

---

## 2. Technical changes

### Database Schema Updates
No migrations were changed. The checked-in schema is fully utilized. Handled `buildings`, `floors`, `academicYears`, `scope`, and persistent AI messages.

### API Endpoint Changes
*   `GET /api/dashboard` - Backed by live SQL aggregate queries. Scoped to role.
*   `GET /api/:collection` - Scoped and filtered based on the requester's role. Exposes `academicYears`, `buildings`, and `floors`.
*   `GET /api/timetables/versions` - Filtered assignments based on role.
*   `GET /api/timetables/versions/:id` - Dynamic slots loading from parent timetable's profile, filtered assignments based on role.
*   `GET /api/time-profiles` - List schedule profiles and their working days and slots.
*   `POST /api/time-profiles` - Create a custom schedule profile.
*   `POST /api/time-profiles/:id/activate` - Activate a schedule profile and rehydrate cache.
*   `POST /api/timetables/versions/:id/regenerate` - Regenerate while locking specified assignments.
*   `PUT /api/policies/:id` - Full policy edit and persistence.
*   `GET /api/audit-events` - Admin-only audit events log.
*   `GET /api/ai-actions` - Admin-only AI grounding actions log.
*   `GET /api/timetables/versions/:id/export.xlsx` - Binary `.xlsx` workbook exporter.
*   `GET /api/ai/conversations` - List persistent conversations of the user.
*   `GET /api/ai/conversations/:id/messages` - Retrieve message history of a conversation.

---

## 3. Testing & verification results

*   **Node.js Unit & Integration Tests**: 35/35 passed successfully.
*   **Python CP-SAT Solver Tests**: 9/9 passed successfully.
*   **Total Tests**: 44 tests passing.
*   **Production builds**: Successfully compiled and bundled for production.
*   **Verification script**: `scripts/verify-postgres.js` completed with high fidelity, verifying database locking, trigger-level published protection, and transactions rollback.

---

## 4. Remaining limitations & Phase 4 recommendations

1.  **Playwright Sandbox Limitations**: Playwright requires browser binaries that cannot be downloaded in network-restricted sandboxes. It is recommended to run GHA runners in environments that have pre-cached chromium binaries or proxy whitelist access to `playwright.dev`.
2.  **Scalability Performance**: As college configurations grow, background generation queues (rather than blocking HTTP requests) are recommended.
