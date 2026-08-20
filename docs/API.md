# API summary

All protected routes require `Authorization: Bearer <token>`. Development identities are created by demo seed data. College-wide mutations are ADMIN-only; non-admin reads are scoped by role where data exposure matters.

Default local credentials are `admin@chronos.local` / `Chronos123!`. Production should set a strong `JWT_SECRET` and institutional auth integration before external use.

## Core endpoints

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness and database readiness |
| POST | `/api/auth/login` | Verify bcrypt credentials and issue an eight-hour HS256 JWT |
| GET | `/api/session` | Current identity and role |
| GET | `/api/dashboard` | SQL-backed counts, latest run/version, setup-required state; role-scoped |
| GET | `/api/:collection` | Configured entities; supports `academicYears`, `buildings`, `floors`, departments, hierarchy, faculty, resources, requirements, policies, enrollments and related setup collections; role-scoped |
| POST | `/api/:collection` | ADMIN setup write with schema/reference validation |
| PUT | `/api/faculty/:id/availability` | Persist hard blackouts and preferred periods |
| PUT | `/api/resources/:id/availability` | Persist resource blackouts |
| GET | `/api/time-profiles` | List schedule profiles with working days/slots |
| POST | `/api/time-profiles` | ADMIN create schedule profile |
| POST | `/api/time-profiles/:id/activate` | ADMIN activate schedule profile and rehydrate cached slot data |

## Scheduling endpoints

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/generation/preflight` | Candidate-aware blockers and summaries before solve |
| POST | `/api/generation/run` | Build sessions, generate candidates, solve, validate and version synchronously |
| POST | `/api/generation/run?async=true` | Start an in-process asynchronous solve and return `202 Accepted` |
| GET | `/api/generation/runs` | Traceable generation runs; role-scoped diagnostics |
| GET | `/api/timetables/versions` | Version list with role-scoped assignments |
| GET | `/api/timetables/versions/:id` | Assignment data and joined view metadata; role-scoped |
| POST | `/api/timetables/versions/:id/regenerate` | ADMIN regenerate from an existing version while locking selected sessions |
| POST | `/api/timetables/versions/:id/move` | ADMIN validate and apply a manual move; rejects published versions and stale timestamps when supplied |
| POST | `/api/timetables/versions/:id/transition` | ADMIN guarded lifecycle transition |
| GET | `/api/timetables/versions/:id/export.csv` | Role-scoped CSV timetable export |
| GET | `/api/timetables/versions/:id/export.xlsx` | Role-scoped binary XLSX timetable export |
| GET | `/api/timetables/versions/:id/export.pdf` | Role-scoped binary PDF timetable export |

Generation infeasibility returns structured `diagnostics[]` with actual rejection evidence when a session has no candidates.

## Policy, audit and AI endpoints

| Method | Route | Purpose |
|---|---|---|
| PUT | `/api/policies/:id` | ADMIN full policy update/deactivate/persist |
| GET | `/api/audit-events` | ADMIN query audit events with optional filters |
| GET | `/api/ai-actions` | ADMIN query grounded AI/tool actions with optional filters |
| POST | `/api/ai/interpret` | Entity-grounded policy proposal, clarification, or grounded read-tool response; persists conversation messages |
| POST | `/api/ai/proposals/:id/confirm` | Confirm and persist typed policy proposal |
| POST | `/api/ai/explain` | Explain an assignment from actual assignment/resource/policy evidence |
| POST | `/api/ai/tools` | Grounded read tools: `eligibleResources`, `currentConflicts`, `unscheduledSessions`, `generationDiagnostics` |
| GET | `/api/ai/tools/:tool` | Same grounded tools via query arguments |
| GET | `/api/ai/conversations` | List the current user's persisted AI conversations |
| GET | `/api/ai/conversations/:id/messages` | List messages for one of the current user's conversations |

When `LLM_API_KEY`, `LLM_MODEL`, and optional `LLM_BASE_URL` are configured, policy interpretation can use an OpenAI-compatible strict JSON-schema response. Entity IDs are checked again server-side. Without provider configuration, the deterministic safe interpreter remains available.

## Import endpoints

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/import/preview` | Parse CSV/JSON, validate schema/references/duplicates without writes |
| POST | `/api/import/:token/confirm` | Commit exactly the previously validated import |

## Scheduler JSON interface

Input: `slots`, `resources`, `faculty`, expanded `sessions`, active `policies`, and `timeLimitSeconds`.

Output: `status`, `assignments[]`, `diagnostics[]`, and `metrics` including session count, candidate count, objective, objective breakdowns, solver duration and preferred-resource assignments. The Python process has no credentials and no database access.

Errors use `{ error: { code, message, ...details } }`. Authentication and high-impact generation/AI endpoints are rate-limited; Helmet security headers and configurable CORS are enabled.
