import {describe,expect,it,beforeEach} from 'vitest';
import request from 'supertest';
import {app} from './app.js';
import {SignJWT} from 'jose';
import {db,withTransaction,allocateVersionNumber,persistEntity,ready} from './db.js';
import {versions,runs,collections,slots} from './store.js';
import {randomUUID} from 'node:crypto';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'development-only-change-me-before-production');

async function makeToken(user: { id: string; name: string; role: string; departmentId?: string }) {
  return await new SignJWT({ name: user.name, role: user.role, departmentId: user.departmentId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
}

describe('Phase 3 P1-1 & P1-2 — Empty-Institution Setup & Time Profiles', () => {
  beforeEach(() => {
    versions.length = 0;
    runs.length = 0;
  });

  it('allows ADMIN to create Academic Years, Buildings, and Floors, while rejecting HODs', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };

    const hodToken = await makeToken({ id: 'hod-it', name: 'IT HOD', role: 'HOD', departmentId: 'dept-it' });
    const authHod = { Authorization: `Bearer ${hodToken}` };

    // 1. Create Academic Year (ADMIN should succeed, HOD should fail with 403)
    const ayId = 'ay-27';
    await request(app)
      .post('/api/academicYears')
      .set(authHod)
      .send({ id: ayId, name: '2027–28', startsOn: '2027-07-01', endsOn: '2028-06-30' })
      .expect(403);

    const ayRes = await request(app)
      .post('/api/academicYears')
      .set(authAdmin)
      .send({ id: ayId, name: '2027–28', startsOn: '2027-07-01', endsOn: '2028-06-30' })
      .expect(201);
    expect(ayRes.body.name).toBe('2027–28');

    // 2. Create Building (ADMIN should succeed, HOD should fail)
    const bId = 'bld-science';
    await request(app)
      .post('/api/buildings')
      .set(authHod)
      .send({ id: bId, code: 'SCI', name: 'Science Block' })
      .expect(403);

    const bRes = await request(app)
      .post('/api/buildings')
      .set(authAdmin)
      .send({ id: bId, code: 'SCI', name: 'Science Block' })
      .expect(201);
    expect(bRes.body.name).toBe('Science Block');

    // 3. Create Floor
    const flId = 'floor-sci-1';
    await request(app)
      .post('/api/floors')
      .set(authHod)
      .send({ id: flId, name: 'Ground Floor', ordinal: 1, buildingId: bId })
      .expect(403);

    const flRes = await request(app)
      .post('/api/floors')
      .set(authAdmin)
      .send({ id: flId, name: 'Ground Floor', ordinal: 1, buildingId: bId })
      .expect(201);
    expect(flRes.body.name).toBe('Ground Floor');
  });

  it('supports creating, listing, and activating custom Schedule Profiles', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };

    const profileData = {
      name: 'Standard Mon-Sat Profile',
      academicYearId: 'ay-26',
      workingDays: [
        {
          name: 'Monday',
          enabled: true,
          slots: [
            { label: 'Monday P1', startsAt: '09:00', endsAt: '10:00', isBreak: false },
            { label: 'Monday Lunch Break', startsAt: '12:00', endsAt: '13:00', isBreak: true }
          ]
        },
        {
          name: 'Saturday',
          enabled: true,
          slots: [
            { label: 'Saturday P1', startsAt: '09:00', endsAt: '10:00', isBreak: false }
          ]
        }
      ]
    };

    // 1. Create Profile
    const createRes = await request(app)
      .post('/api/time-profiles')
      .set(authAdmin)
      .send(profileData)
      .expect(201);
    
    expect(createRes.body.name).toBe('Standard Mon-Sat Profile');
    const profileId = createRes.body.id;

    // 2. List Profiles
    const listRes = await request(app)
      .get('/api/time-profiles')
      .set(authAdmin)
      .expect(200);
    
    const createdProfile = listRes.body.find((p: any) => p.id === profileId);
    expect(createdProfile).toBeDefined();
    expect(createdProfile.workingDays.length).toBe(2);
    expect(createdProfile.workingDays[0].slots.length).toBe(2);

    // 3. Activate Custom Profile
    await request(app)
      .post(`/api/time-profiles/${profileId}/activate`)
      .set(authAdmin)
      .send({})
      .expect(200);

    // After activation, slots memory cache MUST be updated to only contain Monday and Saturday custom slots!
    expect(slots.length).toBe(3); // 2 Monday slots + 1 Saturday slot
    const satSlot = slots.find((s: any) => s.label.includes('Saturday'));
    expect(satSlot).toBeDefined();

    // Verify break slot is loaded and has isBreak = true
    const breakSlot = slots.find((s: any) => s.label.includes('Lunch Break'));
    expect(breakSlot).toBeDefined();
    expect(breakSlot!.isBreak).toBe(true);

    // Restore standard seed profile for subsequent tests
    const defaultProfileRes = await db.query<any>(`SELECT "id" FROM "ScheduleProfile" WHERE "name"='Standard Week' LIMIT 1`);
    if (defaultProfileRes.rows.length > 0) {
      await request(app)
        .post(`/api/time-profiles/${defaultProfileRes.rows[0].id}/activate`)
        .set(authAdmin)
        .send({})
        .expect(200);
    }
  });
});
