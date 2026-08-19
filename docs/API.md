# API summary

All mutation routes require `Authorization: Bearer <token>`. The development identities are `demo-admin`, `demo-hod`, `demo-faculty`, and `demo-student`; only ADMIN/HOD can mutate.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness |
| GET | `/api/session` | Current identity and role |
| GET | `/api/dashboard` | Derived, non-fabricated counts and latest run/version |
| GET | `/api/{departments,programs,levels,divisions,batches,subjects,faculty,resources,requirements,policies}` | Configured domain entities |
| POST | `/api/:collection` | Authorized setup write (demo repository) |
| POST | `/api/generation/preflight` | Blocking input validation and snapshot counts |
| POST | `/api/generation/run` | Build sessions, generate candidates, solve, validate and version |
| GET | `/api/generation/runs` | Traceable generation runs |
| GET | `/api/timetables/versions` | Version list |
| GET | `/api/timetables/versions/:id` | Assignment data and joined view metadata |
| POST | `/api/timetables/versions/:id/move` | Validate and apply a manual move |
| POST | `/api/timetables/versions/:id/transition` | Guarded lifecycle transition |
| POST | `/api/ai/interpret` | Entity-grounded policy proposal or clarification |
| POST | `/api/ai/proposals/:id/confirm` | Confirm and invoke typed `createPolicy` tool |
| POST | `/api/ai/explain` | Explain an assignment from actual assignment/resource/policy evidence |

Errors have `{ error: { code, message, ...details } }`. Generation infeasibility has a run result with structured `diagnostics[]`, including actual rejection evidence when a session has no candidates.

## Scheduler JSON interface

Input: `slots`, `resources`, `faculty`, expanded `sessions`, active `policies`, `timeLimitSeconds`.

Output: `status`, `assignments[]`, `diagnostics[]`, and `metrics` (session count, candidate count, objective, solver duration and preferred-resource assignments). The process has no credentials and no database access.

## Additional operational endpoints

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Verify bcrypt credentials and issue an eight-hour HS256 JWT |
| PUT | `/api/faculty/:id/availability` | Persist hard blackouts and preferred periods |
| PUT | `/api/resources/:id/availability` | Persist resource blackouts |
| POST | `/api/import/preview` | Parse CSV/JSON, validate schema and duplicates without writes |
| POST | `/api/import/:token/confirm` | Commit exactly the previously validated import |
| GET | `/api/timetables/versions/:id/export.csv` | Export the canonical timetable data |

Local credentials are `admin@chronos.local` / `Chronos123!`. Production refuses to start without `JWT_SECRET`. Authentication and high-impact generation/AI endpoints are rate-limited; Helmet security headers and configurable CORS are enabled.

When `LLM_API_KEY`, `LLM_MODEL`, and optional `LLM_BASE_URL` are configured, policy interpretation uses an OpenAI-compatible strict JSON-schema response. Entity IDs are checked again server-side. Without provider configuration, the safe deterministic interpreter remains available.
