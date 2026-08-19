# Production readiness & deployment guide

This document provides instructions for deploying, validating, and maintaining the **Campus Chronos** college timetable platform in a production-grade environment.

---

## 1. Environment requirements

*   **Node.js**: v18.0.0 or higher (Active LTS recommended)
*   **Python**: v3.11.x (with `ortools` and standard scheduler requirements)
*   **Database**: PostgreSQL v14.0 or higher
*   **Memory**: Minimum 2 GB RAM (for running CP-SAT optimization)

---

## 2. Secrets configuration

All production credentials and keys must be injected via secure system environment variables. Never hard-code credentials in source code.

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db?schema=public` |
| `JWT_SECRET` | HS256 key used to sign session tokens | `9a7f34c2b8c9d0e1...` (Use 256+ bit strong random key) |
| `NODE_ENV` | Mode of operation (`production` or `development`) | `production` |
| `APP_ORIGIN` | Allowed CORS origins (comma-separated list) | `https://chronos.yourcollege.edu` |
| `PORT` | HTTP port for the API server | `4000` |

---

## 3. Database migrations

We use **Prisma** to apply database migrations to Managed PostgreSQL.

### Applying migrations:
```bash
# Install Node dependencies
npm install

# Run migration deployment (runs checked-in SQL files sequentially)
npx prisma migrate deploy
```

Our migrations include critical database-level hardening triggers (`chronos_timetable_version_immutable`, `chronos_timetable_entry_immutable`, and `chronos_timetable_entry_slot_immutable`) that block any insertions, updates, or deletions of timetable entries once their corresponding `TimetableVersion` is marked as `PUBLISHED`.

---

## 4. Environment & health validation

The API server provides a dedicated health check endpoint at `/api/health`.

### Verification command:
```bash
curl -f http://localhost:4000/api/health
```

### Healthy response (Status 200):
```json
{
  "status": "ok",
  "service": "chronos-api",
  "database": "ready"
}
```

---

## 5. Secret rotation guidance

To maintain high operational security, rotate your `JWT_SECRET` periodically (e.g., every 90 days) or immediately upon suspicion of compromise.

### Rotation procedure:
1.  **Generate a new 512-bit secure secret key**:
    ```bash
    openssl rand -base64 48
    ```
2.  **Deploy the new key as a secondary key or update the environment**:
    *   Update the `JWT_SECRET` environment variable in your production environment config (e.g., AWS ECS, Kubernetes Secrets, or Heroku Config).
3.  **Perform a rolling restart of the API container instances**:
    *   This forces all servers to pick up the new secret.
    *   *Note*: Rotating the JWT secret will invalidate existing active client sessions, requiring users to log in again. Schedule rotation during off-peak hours (e.g., midnight) to prevent operational disruption.
