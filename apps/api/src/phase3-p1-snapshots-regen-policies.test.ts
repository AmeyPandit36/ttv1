import {describe,expect,it,beforeEach} from 'vitest';
import request from 'supertest';
import {app} from './app.js';
import {SignJWT} from 'jose';
import {db,withTransaction} from './db.js';
import {versions,runs,policies} from './store.js';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'development-only-change-me-before-production');

async function makeToken(user: { id: string; name: string; role: string; departmentId?: string }) {
  return await new SignJWT({ name: user.name, role: user.role, departmentId: user.departmentId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
}

describe('Phase 3 P1-3, P1-4 & P1-5 — Snapshots, Regeneration, Policies', () => {
  beforeEach(() => {
    versions.length = 0;
    runs.length = 0;
  });

  it('P1-3: captures an immutable snapshot of all solver inputs in GenerationRun.scope', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };

    // Run generation
    const res = await request(app).post('/api/generation/run').set(authAdmin).expect(201);
    const runId = res.body.run.id;

    // Fetch the run scope directly from database to verify snapshot preservation
    const dbRun = await db.query<any>(`SELECT "scope" FROM "GenerationRun" WHERE "id"=$1`, [runId]);
    const rawScope = dbRun.rows[0].scope;
    const scope = typeof rawScope === 'string' ? JSON.parse(rawScope) : rawScope;

    expect(scope.slots).toBeDefined();
    expect(scope.resources).toBeDefined();
    expect(scope.faculty).toBeDefined();
    expect(scope.policies).toBeDefined();
    expect(scope.sessions).toBeDefined();
  });

  it('P1-4: supports regeneration, parentVersionId tracking, and locking selected entries', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };

    // 1. Generate parent version
    const parentRes = await request(app).post('/api/generation/run').set(authAdmin).expect(201);
    const parentVersion = parentRes.body.version;
    const firstAssignment = parentVersion.assignments[0];

    // 2. Run regeneration with the first assignment locked
    const regenRes = await request(app)
      .post(`/api/timetables/versions/${parentVersion.id}/regenerate`)
      .set(authAdmin)
      .send({ lockedSessionIds: [firstAssignment.sessionId] })
      .expect(201);

    const childVersion = regenRes.body.version;

    // Check parentVersionId is tracked
    expect(childVersion.parentVersionId).toBe(parentVersion.id);

    // Verify parentVersionId was successfully persisted to the database
    const dbChild = await db.query<any>(`SELECT "parentVersionId" FROM "TimetableVersion" WHERE "id"=$1`, [childVersion.id]);
    expect(dbChild.rows[0].parentVersionId).toBe(parentVersion.id);

    // Verify the locked session's assignment matches exactly in the child version
    const childAssignment = childVersion.assignments.find((a: any) => a.sessionId === firstAssignment.sessionId);
    expect(childAssignment).toBeDefined();
    expect(childAssignment.resourceId).toBe(firstAssignment.resourceId);
    expect(childAssignment.slotIds).toEqual(firstAssignment.slotIds);
  });

  it('P1-5: supports CRUD, enabling/disabling, and editing scheduling policies', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };

    // Get active policy
    const activePolicy = policies[0];
    expect(activePolicy).toBeDefined();

    // Update policy to inactive
    const updatedPolicy = {
      ...activePolicy,
      active: false,
      description: 'Disabled for P1-5 test'
    };

    const res = await request(app)
      .put(`/api/policies/${activePolicy.id}`)
      .set(authAdmin)
      .send(updatedPolicy)
      .expect(200);

    expect(res.body.active).toBe(false);
    expect(res.body.description).toBe('Disabled for P1-5 test');

    // Verify in-memory state is synchronized
    const cachedPolicy = policies.find(p => p.id === activePolicy.id);
    expect(cachedPolicy!.active).toBe(false);

    // Verify DB state is synchronized
    const dbPolicy = await db.query<any>(`SELECT "active","description" FROM "SchedulingPolicy" WHERE "id"=$1`, [activePolicy.id]);
    expect(dbPolicy.rows[0].active).toBe(false);
    expect(dbPolicy.rows[0].description).toBe('Disabled for P1-5 test');

    // Restore policy to original state
    updatedPolicy.active = true;
    updatedPolicy.description = activePolicy.description;
    await request(app).put(`/api/policies/${activePolicy.id}`).set(authAdmin).send(updatedPolicy).expect(200);
  });
});
