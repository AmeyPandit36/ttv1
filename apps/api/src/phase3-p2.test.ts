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

describe('Phase 3 P2 — Excel Export & Persistent AI Conversations', () => {
  it('allows ADMIN to export a timetable version as an .xlsx file', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };

    // 1. Generate version
    const gen = await request(app).post('/api/generation/run').set(authAdmin).expect(201);
    const verId = gen.body.version.id;

    // 2. Export Excel
    const res = await request(app)
      .get(`/api/timetables/versions/${verId}/export.xlsx`)
      .set(authAdmin)
      .expect(200);

    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('.xlsx');
  });

  it('allows ADMIN to export a timetable version as a genuine .pdf file', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };

    // 1. Generate version
    const gen = await request(app).post('/api/generation/run').set(authAdmin).expect(201);
    const verId = gen.body.version.id;

    // 2. Export PDF
    const res = await request(app)
      .get(`/api/timetables/versions/${verId}/export.pdf`)
      .set(authAdmin)
      .expect(200);

    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('.pdf');
  });

  it('supports persistent AI conversations and history retrieval', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };

    // 1. Send first AI message
    await request(app)
      .post('/api/ai/interpret')
      .set(authAdmin)
      .send({ message: 'Prefer IT Computing Lab for Department IT.' })
      .expect(200);

    // 2. Fetch conversations
    const convs = await request(app)
      .get('/api/ai/conversations')
      .set(authAdmin)
      .expect(200);

    expect(convs.body.length).toBeGreaterThan(0);
    
    // 3. Sequential search to find our active persistent conversation
    let activeConvId = '';
    let activeMsgs: any[] = [];
    
    for (const c of convs.body) {
      const msgs = await request(app)
        .get(`/api/ai/conversations/${c.id}/messages`)
        .set(authAdmin)
        .expect(200);
      if (msgs.body.length > 0) {
        activeConvId = c.id;
        activeMsgs = msgs.body;
        break;
      }
    }

    expect(activeConvId).not.toBe('');
    expect(activeMsgs.length).toBeGreaterThan(1); // User query + AI reply
    expect(activeMsgs[0].role).toBe('user');
    expect(activeMsgs[0].content).toContain('Prefer IT Computing Lab');
    expect(activeMsgs[1].role).toBe('ai');
  });
});
