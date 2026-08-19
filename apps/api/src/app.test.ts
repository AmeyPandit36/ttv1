import {beforeEach,describe,expect,it} from 'vitest';
import request from 'supertest';
import {app} from './app.js';
import {policies,runs,versions} from './store.js';
import {db,persistGeneration,ready} from './db.js';

const auth={Authorization:'Bearer demo-admin'};
const hod={Authorization:'Bearer demo-hod'};

describe('Chronos API integration',()=>{
 beforeEach(()=>{versions.length=0;runs.length=0});
 it('authenticates a persisted user with a hashed password',async()=>{const r=await request(app).post('/api/auth/login').send({email:'admin@chronos.local',password:'Chronos123!'}).expect(200);expect(r.body.user.role).toBe('ADMIN');expect(r.body.token.split('.')).toHaveLength(3)});
 it('reports real dashboard counts',async()=>{const r=await request(app).get('/api/dashboard').set(auth).expect(200);expect(r.body.counts.sessions).toBeGreaterThan(0);expect(r.body.counts.resources).toBeGreaterThan(0)});
 it('generates, validates, persists and guards manual editing',async()=>{const r=await request(app).post('/api/generation/run').set(auth).expect(201);expect(r.body.run.result.status).toMatch(/OPTIMAL|FEASIBLE/);expect(r.body.version.validation.valid).toBe(true);expect(r.body.version.assignments).toHaveLength(r.body.run.result.metrics.sessions);const [first,second]=r.body.version.assignments;await request(app).post(`/api/timetables/versions/${r.body.version.id}/move`).set(auth).send(first).expect(200);const invalid=await request(app).post(`/api/timetables/versions/${r.body.version.id}/move`).set(auth).send({sessionId:second.sessionId,resourceId:first.resourceId,slotIds:first.slotIds}).expect(422);expect(invalid.body.error.conflicts.length).toBeGreaterThan(0)});
 it('rejects mutation for student role',()=>request(app).post('/api/resources').set({Authorization:'Bearer demo-student'}).send({name:'Unsafe'}).expect(403));
 it('validates setup writes rather than inserting incomplete records',async()=>{const r=await request(app).post('/api/resources').set(auth).send({name:'Broken lab'}).expect(422);expect(r.body.error.code).toBe('VALIDATION_ERROR')});
 it('persists faculty availability used by candidate generation',async()=>{const r=await request(app).put('/api/faculty/fac-meena/availability').set(auth).send({unavailableSlotIds:['mon-1'],preferredSlotIds:['mon-2']}).expect(200);expect(r.body.unavailableSlotIds).toContain('mon-1')});
 it('validates and stores student enrollment',async()=>{const r=await request(app).post('/api/enrollments').set(auth).send({rollNumber:'IT-E2E-01',studentName:'Test Student',divisionId:'div-a',batchId:'batch-a1'}).expect(201);expect(r.body.rollNumber).toBe('IT-E2E-01')});
 it('previews and confirms imports before writing',async()=>{const preview=await request(app).post('/api/import/preview').set(auth).send({collection:'resources',rows:[{code:'TEST-LAB',name:'Test Lab',type:'LAB',capacity:30,departmentId:'dept-it',capabilities:['Computers']}]}).expect(200);expect(preview.body.valid).toBe(true);const result=await request(app).post(`/api/import/${preview.body.token}/confirm`).set(auth).send({}).expect(201);expect(result.body.imported).toBe(1)});
 it('does not invent AI entities',async()=>{const r=await request(app).post('/api/ai/interpret').set(auth).send({message:'Use the Quantum Lab'}).expect(200);expect(r.body.type).toBe('clarification');expect(r.body.options.length).toBeGreaterThan(0)});
 it('requires confirmation then invokes typed createPolicy',async()=>{const before=policies.length;const proposal=await request(app).post('/api/ai/interpret').set(auth).send({message:"Don't use CSE AI Lab for Information Technology"}).expect(200);expect(proposal.body.type).toBe('confirmation');const result=await request(app).post(`/api/ai/proposals/${proposal.body.proposalId}/confirm`).set(auth).expect(201);expect(result.body.tool).toBe('createPolicy');expect(policies).toHaveLength(before+1)});
});

describe('Phase 2 hardening',()=>{
 beforeEach(()=>{versions.length=0;runs.length=0});

 it('returns candidate-aware preflight without blockers on the seeded plan',async()=>{
  const r=await request(app).post('/api/generation/preflight').set(auth).expect(200);
  expect(r.body.valid).toBe(true);
  expect(r.body.summary.candidates).toBeGreaterThan(0);
  expect(r.body.issues).toEqual([]);
 });

 it('does not give HOD college-wide mutation access',async()=>{
  await request(app).post('/api/resources').set(hod).send({code:'HOD-X',name:'HOD Room',type:'CLASSROOM',capacity:20,departmentId:'dept-it'}).expect(403);
  await request(app).post('/api/generation/run').set(hod).expect(403);
 });

 it('rejects setup and import rows with unknown references',async()=>{
  const created=await request(app).post('/api/faculty').set(auth).send({employeeCode:'X1',name:'Ineligible',email:'x1@chronos.local',departmentId:'missing-dept',eligibleSubjectIds:['sub-db']}).expect(422);
  expect(created.body.error.code).toBe('INVALID_REFERENCE');
  const preview=await request(app).post('/api/import/preview').set(auth).send({collection:'resources',rows:[{code:'BAD-DEPT',name:'Bad',type:'LAB',capacity:20,departmentId:'no-such-dept'}]}).expect(200);
  expect(preview.body.valid).toBe(false);
  expect(preview.body.errors[0].issues[0].path).toBe('departmentId');
 });

 it('rejects teaching requirements when faculty is not eligible for the subject',async()=>{
  const r=await request(app).post('/api/requirements').set(auth).send({subjectId:'sub-ml',facultyId:'fac-meena',divisionIds:['div-a'],sessionType:'LECTURE',duration:1,weeklyFrequency:1,resourceType:'CLASSROOM'}).expect(422);
  expect(r.body.error.code).toBe('INVALID_REFERENCE');
 });

 it('rolls back a failed generation persist so no partial version remains',async()=>{
  await ready;
  const before=await db.query<{n:number}>(`SELECT count(*)::int n FROM "TimetableVersion"`);
  await expect(persistGeneration(
    {id:'run-rollback',status:'SUCCEEDED',startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),result:{status:'OPTIMAL',metrics:{sessions:1,candidates:1,solverDurationMs:1},diagnostics:[]}},
    {id:'ver-rollback',version:99,status:'VALIDATED',assignments:[{sessionId:'does-not-exist',resourceId:'room-201',slotIds:['mon-1']}],validation:{valid:true,metrics:{}}}
  )).rejects.toBeTruthy();
  const after=await db.query<{n:number}>(`SELECT count(*)::int n FROM "TimetableVersion"`);
  expect(after.rows[0].n).toBe(before.rows[0].n);
 });

 it('protects published timetable entries from modification',async()=>{
  const generated=await request(app).post('/api/generation/run').set(auth).expect(201);
  const id=generated.body.version.id;
  await request(app).post(`/api/timetables/versions/${id}/transition`).set(auth).send({status:'REVIEWED'}).expect(200);
  await request(app).post(`/api/timetables/versions/${id}/transition`).set(auth).send({status:'APPROVED'}).expect(200);
  await request(app).post(`/api/timetables/versions/${id}/transition`).set(auth).send({status:'PUBLISHED'}).expect(200);
  const move=await request(app).post(`/api/timetables/versions/${id}/move`).set(auth).send(generated.body.version.assignments[0]).expect(409);
  expect(move.body.error.code).toBe('PUBLISHED_IMMUTABLE');
 });

 it('exposes grounded AI tools from live application data',async()=>{
  const generated=await request(app).post('/api/generation/run').set(auth).expect(201);
  const sessionId=generated.body.version.assignments[0].sessionId;
  const eligible=await request(app).post('/api/ai/tools').set(auth).send({tool:'eligibleResources',sessionId}).expect(200);
  expect(eligible.body.ok).toBe(true);
  expect(eligible.body.resources.length).toBeGreaterThan(0);
  const conflicts=await request(app).post('/api/ai/tools').set(auth).send({tool:'currentConflicts',versionId:generated.body.version.id}).expect(200);
  expect(conflicts.body.valid).toBe(true);
  const unscheduled=await request(app).post('/api/ai/tools').set(auth).send({tool:'unscheduledSessions',versionId:generated.body.version.id}).expect(200);
  expect(unscheduled.body.unscheduled).toEqual([]);
  const diagnostics=await request(app).post('/api/ai/interpret').set(auth).send({message:'Show generation diagnostics'}).expect(200);
  expect(diagnostics.body.type).toBe('tool');
  expect(diagnostics.body.tool).toBe('generationDiagnostics');
 });
});
