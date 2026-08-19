import {describe,expect,it,beforeEach} from 'vitest';
import request from 'supertest';
import {app} from './app.js';
import {SignJWT} from 'jose';
import {runs} from './store.js';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'development-only-change-me-before-production');

async function makeToken(user: { id: string; name: string; role: string; departmentId?: string }) {
  return await new SignJWT({ name: user.name, role: user.role, departmentId: user.departmentId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
}

describe('Phase 3 P3 — Asynchronous Generation Jobs', () => {
  it('triggers a background/asynchronous generation run returning 202 Accepted immediately', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };

    // Trigger asynchronous run
    const res = await request(app)
      .post('/api/generation/run?async=true')
      .set(authAdmin)
      .expect(202);

    expect(res.body.run.status).toBe('SOLVING');
    expect(res.body.message).toContain('background');

    // Clean up local in-memory runs list to prevent bloat if needed
    runs.length = 0;
  });
});
