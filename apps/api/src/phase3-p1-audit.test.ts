import {describe,expect,it,beforeEach} from 'vitest';
import request from 'supertest';
import {app} from './app.js';
import {SignJWT} from 'jose';
import {db} from './db.js';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'development-only-change-me-before-production');

async function makeToken(user: { id: string; name: string; role: string; departmentId?: string }) {
  return await new SignJWT({ name: user.name, role: user.role, departmentId: user.departmentId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
}

describe('Phase 3 P1-6 — Audit and AI Actions Log', () => {
  it('allows ADMIN to query audit events and rejects HOD/FACULTY', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };

    const hodToken = await makeToken({ id: 'hod-it', name: 'IT HOD', role: 'HOD', departmentId: 'dept-it' });
    const authHod = { Authorization: `Bearer ${hodToken}` };

    // 1. Trigger audit event by creating a department
    const deptId = `dept-audit-${Date.now()}`;
    await request(app)
      .post('/api/departments')
      .set(authAdmin)
      .send({ id: deptId, code: 'AUDIT', name: `Audit Dept ${Date.now()}` })
      .expect(201);

    // 2. Fetch audit-events (HOD should be forbidden)
    await request(app)
      .get('/api/audit-events')
      .set(authHod)
      .expect(403);

    // 3. Fetch audit-events (ADMIN should succeed and contain our CREATE action)
    const res = await request(app)
      .get('/api/audit-events')
      .set(authAdmin)
      .expect(200);

    expect(res.body.length).toBeGreaterThan(0);
    const createEvent = res.body.find((e: any) => e.action === 'CREATE' && e.entityId === deptId);
    expect(createEvent).toBeDefined();
    expect(createEvent.actorName).toBe('Demo Administrator');
    expect(createEvent.entityType).toBe('departments');
  });

  it('allows ADMIN to query AI actions and rejects FACULTY', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };

    const facToken = await makeToken({ id: 'fac-meena', name: 'Dr. Meena Rao', role: 'FACULTY' });
    const authFac = { Authorization: `Bearer ${facToken}` };

    // 1. Fetch AI actions (FACULTY should be forbidden)
    await request(app)
      .get('/api/ai-actions')
      .set(authFac)
      .expect(403);

    // 2. Fetch AI actions (ADMIN should succeed)
    const res = await request(app)
      .get('/api/ai-actions')
      .set(authAdmin)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });
});
