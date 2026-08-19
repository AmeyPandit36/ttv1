import {describe,expect,it,beforeEach} from 'vitest';
import request from 'supertest';
import {app} from './app.js';
import {SignJWT} from 'jose';
import {db,withTransaction,allocateVersionNumber,persistGeneration} from './db.js';
import {versions,runs,collections} from './store.js';
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

describe('Phase 3 P0-1 — Security Scopes and Read API Scoping', () => {
  it('enforces college-wide access for ADMIN', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const auth = { Authorization: `Bearer ${adminToken}` };

    const res = await request(app).get('/api/resources').set(auth).expect(200);
    expect(res.body.length).toBeGreaterThan(1);
    const depts = res.body.map((r: any) => r.departmentId);
    expect(depts).toContain('dept-it');
    expect(depts).toContain('dept-cse');
  });

  it('restricts HOD to their own department resources and faculty only', async () => {
    const hodItToken = await makeToken({ id: 'hod-it', name: 'IT HOD', role: 'HOD', departmentId: 'dept-it' });
    const authIt = { Authorization: `Bearer ${hodItToken}` };

    const resIt = await request(app).get('/api/resources').set(authIt).expect(200);
    // Should contain room-201 and lab-it-1, but not lab-cse-1
    const idsIt = resIt.body.map((r: any) => r.id);
    expect(idsIt).toContain('room-201');
    expect(idsIt).toContain('lab-it-1');
    expect(idsIt).not.toContain('lab-cse-1');

    // HOD CSE
    const hodCseToken = await makeToken({ id: 'hod-cse', name: 'CSE HOD', role: 'HOD', departmentId: 'dept-cse' });
    const authCse = { Authorization: `Bearer ${hodCseToken}` };

    const resCse = await request(app).get('/api/resources').set(authCse).expect(200);
    const idsCse = resCse.body.map((r: any) => r.id);
    expect(idsCse).toContain('lab-cse-1');
    expect(idsCse).not.toContain('room-201');
  });

  it('restricts FACULTY to own assignments, availability, eligibility and department resource/faculty metadata', async () => {
    const facToken = await makeToken({ id: 'fac-meena', name: 'Dr. Meena Rao', role: 'FACULTY' });
    const auth = { Authorization: `Bearer ${facToken}` };

    // Get faculty collection: should ONLY return Dr. Meena Rao
    const fRes = await request(app).get('/api/faculty').set(auth).expect(200);
    expect(fRes.body.length).toBe(1);
    expect(fRes.body[0].id).toBe('fac-meena');

    // Get teaching requirements: should only return requirements assigned to fac-meena
    const reqRes = await request(app).get('/api/requirements').set(auth).expect(200);
    const facIds = reqRes.body.map((r: any) => r.facultyId);
    expect(facIds.every((id: string) => id === 'fac-meena')).toBe(true);

    // Metadata like resources should be scoped to their department (dept-it)
    const resRes = await request(app).get('/api/resources').set(auth).expect(200);
    const rIds = resRes.body.map((r: any) => r.id);
    expect(rIds).toContain('room-201');
    expect(rIds).not.toContain('lab-cse-1');
  });

  it('restricts STUDENT to own division and cohort timetable only', async () => {
    // Add student enrollment first
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    await request(app)
      .post('/api/enrollments')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ rollNumber: 'STUDENT-P3-E2E', studentName: 'P3 Student', divisionId: 'div-a', batchId: 'batch-a1' })
      .expect(201);

    const studToken = await makeToken({ id: 'student-p3', name: 'P3 Student', role: 'STUDENT' });
    const auth = { Authorization: `Bearer ${studToken}` };

    // Should only see division div-a
    const divRes = await request(app).get('/api/divisions').set(auth).expect(200);
    expect(divRes.body.length).toBe(1);
    expect(divRes.body[0].id).toBe('div-a');

    // Should see batch batch-a1
    const batRes = await request(app).get('/api/batches').set(auth).expect(200);
    expect(batRes.body.length).toBe(1);
    expect(batRes.body[0].id).toBe('batch-a1');

    // Hide faculty/resources metadata to students
    const facRes = await request(app).get('/api/faculty').set(auth).expect(200);
    expect(facRes.body).toEqual([]);
    const resRes = await request(app).get('/api/resources').set(auth).expect(200);
    expect(resRes.body).toEqual([]);
  });
});

describe('Phase 3 P0-2 — Truthful Dashboard', () => {
  it('returns valid counts on a seeded/configured institution', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const r = await request(app).get('/api/dashboard').set({ Authorization: `Bearer ${adminToken}` }).expect(200);
    expect(r.body.academicYear).not.toBeNull();
    expect(r.body.counts.departments).toBeGreaterThan(0);
    expect(r.body.counts.faculty).toBeGreaterThan(0);
    expect(r.body.counts.resources).toBeGreaterThan(0);
    expect(r.body.setupRequired).toBe(false);
  });

  it('truthfully indicates setup required if academic year is deleted', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const auth = { Authorization: `Bearer ${adminToken}` };

    await db.exec('BEGIN');
    try {
      await db.query(`DELETE FROM "Enrollment"`);
      await db.query(`DELETE FROM "Student"`);
      await db.query(`DELETE FROM "ResourceCapability"`);
      await db.query(`DELETE FROM "ResourceAvailability"`);
      await db.query(`DELETE FROM "FacultyAvailability"`);
      await db.query(`DELETE FROM "FacultySubjectEligibility"`);
      await db.query(`DELETE FROM "TimetableEntrySlot"`);
      await db.query(`DELETE FROM "TimetableEntry"`);
      await db.query(`DELETE FROM "TimetableVersion"`);
      await db.query(`DELETE FROM "Timetable"`);
      await db.query(`DELETE FROM "TimeSlot"`);
      await db.query(`DELETE FROM "WorkingDay"`);
      await db.query(`DELETE FROM "ScheduleProfile"`);
      await db.query(`DELETE FROM "RequirementCohort"`);
      await db.query(`DELETE FROM "SchedulableSession"`);
      await db.query(`DELETE FROM "TeachingRequirement"`);
      await db.query(`DELETE FROM "Subject"`);
      await db.query(`DELETE FROM "Faculty"`);
      await db.query(`DELETE FROM "Batch"`);
      await db.query(`DELETE FROM "Division"`);
      await db.query(`DELETE FROM "AcademicLevel"`);
      await db.query(`DELETE FROM "Program"`);
      await db.query(`DELETE FROM "AcademicYear"`);

      const r = await request(app).get('/api/dashboard').set(auth).expect(200);
      expect(r.body.academicYear).toBeNull();
      expect(r.body.setupRequired).toBe(true);
    } finally {
      await db.exec('ROLLBACK');
    }
  });
});

describe('Phase 3 P0-3 — Concurrency-Safe Versioning & Optimistic Locking', () => {
  it('correctly increments version sequentially', async () => {
    const timetableId = 'timetable-26';
    
    await db.exec('BEGIN');
    try {
      const v1 = await allocateVersionNumber(timetableId);
      await db.query(`INSERT INTO "TimetableVersion"("id","timetableId","version","status") VALUES ($1,$2,$3,'DRAFT')`, [randomUUID(), timetableId, v1]);
      
      const v2 = await allocateVersionNumber(timetableId);
      await db.query(`INSERT INTO "TimetableVersion"("id","timetableId","version","status") VALUES ($1,$2,$3,'DRAFT')`, [randomUUID(), timetableId, v2]);

      expect(v2).toBe(v1 + 1);
    } finally {
      await db.exec('ROLLBACK');
    }
  });

  it('rejects stale manual moves under optimistic locking', async () => {
    const adminToken = await makeToken({ id: 'user-admin', name: 'Demo Administrator', role: 'ADMIN' });
    const auth = { Authorization: `Bearer ${adminToken}` };

    // Generate a run
    const gen = await request(app).post('/api/generation/run').set(auth).expect(201);
    const ver = gen.body.version;

    // A correct move with matching updatedAt (or none specified) passes
    const firstAss = ver.assignments[0];
    await request(app)
      .post(`/api/timetables/versions/${ver.id}/move`)
      .set(auth)
      .send({ ...firstAss, updatedAt: ver.updatedAt })
      .expect(200);

    // A move with a STALE/outdated updatedAt should be rejected with 409 STALE_UPDATE
    const staleTime = new Date(Date.now() - 100000).toISOString();
    const res = await request(app)
      .post(`/api/timetables/versions/${ver.id}/move`)
      .set(auth)
      .send({ ...firstAss, updatedAt: staleTime })
      .expect(409);
    
    expect(res.body.error.code).toBe('STALE_UPDATE');
  });
});
