// @ts-nocheck
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { hash } from 'bcryptjs';
import { departments, programs, levels, divisions, batches, enrollments, faculty, resources, subjects, requirements, policies, slots, versions, runs, buildSessions } from './store.js';
import { validateTimetable } from '@chronos/domain';
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
const dataDir = fileURLToPath(new URL('../../../data', import.meta.url));
if (!isTest)
    mkdirSync(dataDir, { recursive: true });
export const db = new PGlite(isTest ? undefined : `${dataDir}/chronos`);
const migration = fileURLToPath(new URL('../../../prisma/migrations/20260819000000_initial/migration.sql', import.meta.url));
const q = (sql, p = []) => db.query(sql, p);
async function migrate() { const exists = await db.query(`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='Department') x`); if (exists.rows[0]?.x)
    return; let sql = await readFile(migration, 'utf8'); await db.exec(sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '').replaceAll(' DEFAULT gen_random_uuid()::text', '')); }
async function seed() {
    const n = await db.query(`SELECT count(*)::int n FROM "AcademicYear"`);
    if (Number(n.rows[0]?.n))
        return;
    await q(`INSERT INTO "AcademicYear"("id","name","startsOn","endsOn") VALUES ('ay-26','2026–27','2026-07-01','2027-06-30')`);
    for (const d of departments)
        await q(`INSERT INTO "Department"("id","code","name") VALUES ($1,$2,$3)`, [d.id, d.code, d.name]);
    for (const p of programs)
        await q(`INSERT INTO "Program"("id","code","name","departmentId","academicYearId") VALUES ($1,$2,$3,$4,$5)`, [p.id, p.code, p.name, p.departmentId, p.academicYearId]);
    for (const l of levels)
        await q(`INSERT INTO "AcademicLevel"("id","name","ordinal","programId") VALUES ($1,$2,$3,$4)`, [l.id, l.name, l.ordinal, l.programId]);
    for (const d of divisions)
        await q(`INSERT INTO "Division"("id","name","enrollmentCount","programLevelId") VALUES ($1,$2,$3,$4)`, [d.id, d.name, d.enrollmentCount, d.programLevelId]);
    for (const b of batches)
        await q(`INSERT INTO "Batch"("id","name","enrollmentCount","divisionId") VALUES ($1,$2,$3,$4)`, [b.id, b.name, b.enrollmentCount, b.divisionId]);
    await q(`INSERT INTO "Building"("id","code","name") VALUES ('main','MAIN','Main Building'),('tech','TECH','Technology Building')`);
    await q(`INSERT INTO "Floor"("id","name","ordinal","buildingId") VALUES ('main-2','Second Floor',2,'main'),('tech-1','First Floor',1,'tech')`);
    for (const r of resources)
        await q(`INSERT INTO "Resource"("id","code","name","type","capacity","active","departmentId","floorId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [r.id, r.id, r.name, r.type, r.capacity, r.active, r.departmentId, r.buildingId === 'main' ? 'main-2' : 'tech-1']);
    for (const name of new Set(resources.flatMap(r => r.capabilities))) {
        const id = `cap-${name.toLowerCase().replace(/\W/g, '-')}`;
        await q(`INSERT INTO "Capability"("id","key","name") VALUES ($1,$2,$3)`, [id, name.toLowerCase(), name]);
        for (const r of resources.filter(x => x.capabilities.some(c => c.toLowerCase() === name.toLowerCase())))
            await q(`INSERT INTO "ResourceCapability" VALUES ($1,$2)`, [r.id, id]);
    }
    const password = await hash('Chronos123!', 10);
    await q(`INSERT INTO "User"("id","email","passwordHash","name","role") VALUES ('user-admin','admin@chronos.local',$1,'Demo Administrator','ADMIN'),('user-student','student@chronos.local',$1,'Demo Student','STUDENT')`, [password]);
    for (const f of faculty)
        await q(`INSERT INTO "Faculty"("id","employeeCode","name","email","departmentId","maxPeriodsPerWeek","maxConsecutivePeriods") VALUES ($1,$2,$3,$4,$5,$6,$7)`, [f.id, f.id, f.name, `${f.id}@chronos.local`, f.departmentId, f.maxPeriodsPerWeek, f.maxConsecutive]);
    for (const s of subjects)
        await q(`INSERT INTO "Subject"("id","code","name","departmentId") VALUES ($1,$2,$3,$4)`, [s.id, s.code, s.name, s.departmentId]);
    await q(`INSERT INTO "ScheduleProfile"("id","name","academicYearId") VALUES ('profile-26','Standard Week','ay-26')`);
    const dayNames = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday' };
    for (const [i, day] of Object.keys(dayNames).entries()) {
        await q(`INSERT INTO "WorkingDay"("id","profileId","name","ordinal") VALUES ($1,'profile-26',$2,$3)`, [day, dayNames[day], i]);
        for (const s of slots.filter(x => x.dayId === day))
            await q(`INSERT INTO "TimeSlot"("id","workingDayId","index","label","startsAt","endsAt","isBreak") VALUES ($1,$2,$3,$4,$5,$6,$7)`, [s.id, day, s.index, s.label, s.start, s.end, s.isBreak]);
    }
    for (const f of faculty)
        for (const sid of f.unavailableSlotIds) {
            const sl = slots.find(x => x.id === sid);
            await q(`INSERT INTO "FacultyAvailability"("id","facultyId","workingDayId","timeSlotId","kind") VALUES ($1,$2,$3,$4,'UNAVAILABLE')`, [`fa-${f.id}-${sid}`, f.id, sl.dayId, sid]);
        }
    for (const r of resources)
        for (const sid of r.unavailableSlotIds) {
            const sl = slots.find(x => x.id === sid);
            await q(`INSERT INTO "ResourceAvailability"("id","resourceId","workingDayId","timeSlotId","kind") VALUES ($1,$2,$3,$4,'UNAVAILABLE')`, [`ra-${r.id}-${sid}`, r.id, sl.dayId, sid]);
        }
    for (const r of requirements) {
        await insertRequirement(r);
    }
    for (const p of policies)
        await persistPolicy(p);
    await q(`INSERT INTO "Timetable"("id","name","academicYearId","profileId") VALUES ('timetable-26','College Timetable 2026–27','ay-26','profile-26')`);
}
async function insertRequirement(e) { await q(`INSERT INTO "TeachingRequirement"("id","subjectId","facultyId","sessionType","durationPeriods","weeklyFrequency","resourceType","minCapacity","preferences") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}')`, [e.id, e.subjectId, e.facultyId, e.sessionType, e.duration, e.weeklyFrequency, e.resourceType, e.minCapacity ?? null]); for (const id of e.divisionIds ?? [])
    await q(`INSERT INTO "RequirementCohort"("id","requirementId","divisionId") VALUES ($1,$2,$3)`, [`rc-${e.id}-${id}`, e.id, id]); for (const id of e.batchIds ?? [])
    await q(`INSERT INTO "RequirementCohort"("id","requirementId","batchId") VALUES ($1,$2,$3)`, [`rc-${e.id}-${id}`, e.id, id]); for (const name of e.requiredCapabilities ?? []) {
    const cap = await db.query(`SELECT "id" FROM "Capability" WHERE lower("name")=lower($1)`, [name]);
    if (cap.rows[0])
        await q(`INSERT INTO "RequirementCapability" VALUES ($1,$2,true,5)`, [e.id, cap.rows[0].id]);
} for (let i = 1; i <= Number(e.weeklyFrequency); i++)
    await q(`INSERT INTO "SchedulableSession"("id","requirementId","occurrence","durationPeriods","fingerprint") VALUES ($1,$2,$3,$4,$5)`, [`${e.id}-${i}`, e.id, i, e.duration, `${e.id}:${i}`]); }
async function hydrate() {
    const replace = (a, b) => a.splice(0, a.length, ...b);
    replace(departments, (await db.query(`SELECT "id","code","name","active" FROM "Department"`)).rows);
    replace(programs, (await db.query(`SELECT "id","code","name","departmentId","academicYearId" FROM "Program"`)).rows);
    replace(levels, (await db.query(`SELECT "id","name","ordinal","programId" FROM "AcademicLevel"`)).rows);
    replace(divisions, (await db.query(`SELECT "id","name","enrollmentCount","programLevelId" FROM "Division"`)).rows);
    replace(batches, (await db.query(`SELECT "id","name","enrollmentCount","divisionId" FROM "Batch"`)).rows);
    replace(enrollments, (await db.query(`SELECT e."id",s."rollNumber",s."name" "studentName",e."divisionId",e."batchId",e."validFrom" FROM "Enrollment" e JOIN "Student" s ON s."id"=e."studentId"`)).rows);
    replace(subjects, (await db.query(`SELECT "id","code","name","departmentId","programId","academicLevelId","semester","active" FROM "Subject"`)).rows);
    const fs = (await db.query(`SELECT "id","name","departmentId","maxPeriodsPerWeek","maxConsecutivePeriods" "maxConsecutive" FROM "Faculty" WHERE "active"=true`)).rows, fas = (await db.query(`SELECT "facultyId","timeSlotId","kind" FROM "FacultyAvailability" WHERE "timeSlotId" IS NOT NULL`)).rows;
    faculty.splice(0, faculty.length, ...fs.map(f => ({ ...f,maxPeriodsPerWeek:f.maxPeriodsPerWeek??undefined,maxConsecutive:f.maxConsecutive??undefined, unavailableSlotIds: fas.filter(a => a.facultyId === f.id && a.kind === 'UNAVAILABLE').map(a => a.timeSlotId), preferredSlotIds: fas.filter(a => a.facultyId === f.id && a.kind === 'PREFERRED').map(a => a.timeSlotId) })));
    const rs = (await db.query(`SELECT r."id",r."name",r."type",r."capacity",r."departmentId",f."buildingId",r."active" FROM "Resource" r LEFT JOIN "Floor" f ON f."id"=r."floorId"`)).rows, rc = (await db.query(`SELECT rc."resourceId",c."name" FROM "ResourceCapability" rc JOIN "Capability" c ON c."id"=rc."capabilityId"`)).rows, ras = (await db.query(`SELECT "resourceId","timeSlotId" FROM "ResourceAvailability" WHERE "kind"='UNAVAILABLE'`)).rows;
    resources.splice(0, resources.length, ...rs.map(r => ({ ...r, departmentId:r.departmentId??undefined,buildingId:r.buildingId??undefined, capabilities: rc.filter(c => c.resourceId === r.id).map(c => c.name), unavailableSlotIds: ras.filter(a => a.resourceId === r.id).map(a => a.timeSlotId) })));
    const req = (await db.query(`SELECT "id","subjectId","facultyId","sessionType","durationPeriods" "duration","weeklyFrequency","resourceType","minCapacity","active" FROM "TeachingRequirement" WHERE "active"=true`)).rows, co = (await db.query(`SELECT "requirementId","divisionId","batchId" FROM "RequirementCohort"`)).rows, caps = (await db.query(`SELECT x."requirementId",c."name",x."required" FROM "RequirementCapability" x JOIN "Capability" c ON c."id"=x."capabilityId"`)).rows;
    requirements.splice(0, requirements.length, ...req.map(r => ({ ...r, divisionIds: co.filter(x => x.requirementId === r.id && x.divisionId).map(x => x.divisionId), batchIds: co.filter(x => x.requirementId === r.id && x.batchId).map(x => x.batchId), requiredCapabilities: caps.filter(x => x.requirementId === r.id && x.required).map(x => x.name), preferredCapabilities: caps.filter(x => x.requirementId === r.id && !x.required).map(x => x.name) })));
    const ps = (await db.query(`SELECT "id","name","description","ruleType" "type","strength","priority" "weight","scope","parameters","active","version" FROM "SchedulingPolicy" WHERE "active"=true`)).rows;
    policies.splice(0, policies.length, ...ps);
    versions.length = 0;
    const vs = (await db.query(`SELECT "id","version","status","createdAt" FROM "TimetableVersion" ORDER BY "version"`)).rows;
    for (const v of vs) {
        const es = (await db.query(`SELECT e."sessionId",e."resourceId",s."timeSlotId",s."ordinal" FROM "TimetableEntry" e JOIN "TimetableEntrySlot" s ON s."entryId"=e."id" WHERE e."versionId"=$1 ORDER BY s."ordinal"`, [v.id])).rows, g = new Map();
        for (const e of es)
            g.set(e.sessionId, [...(g.get(e.sessionId) ?? []), e]);
        const assignments = [...g].map(([sessionId, x]) => ({ sessionId, resourceId: x[0].resourceId, slotIds: x.map(y => y.timeSlotId), score: 0 }));
        versions.push({ id: v.id, version: v.version, status: v.status, createdAt: new Date(v.createdAt).toISOString(), assignments, validation: validateTimetable({ slots, resources, faculty, sessions: buildSessions(), policies, timeLimitSeconds: 15 }, assignments) });
    }
    const gr = (await db.query(`SELECT "id","status","startedAt","completedAt","solverStatus","objectiveMetrics","diagnostics" FROM "GenerationRun" ORDER BY "startedAt"`)).rows;
    runs.splice(0, runs.length, ...gr.map(x => ({ id: String(x.id), status: String(x.solverStatus ?? x.status), startedAt: new Date(x.startedAt).toISOString(), completedAt: x.completedAt ? new Date(x.completedAt).toISOString() : undefined })));
}
export const ready = (async () => { await migrate(); await seed(); if (!isTest)
    await hydrate(); })();
export async function persistEntity(c, e) { if (c === 'departments')
    return q(`INSERT INTO "Department"("id","code","name") VALUES ($1,$2,$3)`, [e.id, e.code, e.name]); if (c === 'programs')
    return q(`INSERT INTO "Program"("id","code","name","departmentId","academicYearId") VALUES ($1,$2,$3,$4,$5)`, [e.id, e.code, e.name, e.departmentId, e.academicYearId]); if (c === 'levels')
    return q(`INSERT INTO "AcademicLevel" VALUES ($1,$2,$3,$4)`, [e.id, e.name, e.ordinal, e.programId]); if (c === 'divisions')
    return q(`INSERT INTO "Division" VALUES ($1,$2,$3,$4)`, [e.id, e.name, e.enrollmentCount, e.programLevelId]); if (c === 'batches')
    return q(`INSERT INTO "Batch" VALUES ($1,$2,$3,$4)`, [e.id, e.name, e.enrollmentCount, e.divisionId]); if (c === 'enrollments') {
    const studentId = `student-${e.rollNumber}`;
    await q(`INSERT INTO "Student"("id","rollNumber","name") VALUES ($1,$2,$3) ON CONFLICT ("rollNumber") DO UPDATE SET "name"=excluded."name"`, [studentId, e.rollNumber, e.studentName]);
    return q(`INSERT INTO "Enrollment"("id","studentId","divisionId","batchId","validFrom") VALUES ($1,$2,$3,$4,$5)`, [e.id, studentId, e.divisionId, e.batchId ?? null, e.validFrom]);
} if (c === 'subjects')
    return q(`INSERT INTO "Subject"("id","code","name","departmentId","programId","academicLevelId","semester") VALUES ($1,$2,$3,$4,$5,$6,$7)`, [e.id, e.code, e.name, e.departmentId, e.programId ?? null, e.academicLevelId ?? null, e.semester ?? null]); if (c === 'faculty') {
    await q(`INSERT INTO "Faculty"("id","employeeCode","name","email","departmentId","maxPeriodsPerWeek","maxConsecutivePeriods") VALUES ($1,$2,$3,$4,$5,$6,$7)`, [e.id, e.employeeCode, e.name, e.email, e.departmentId, e.maxPeriodsPerWeek ?? null, e.maxConsecutive ?? null]);
    return;
} if (c === 'resources') {
    await q(`INSERT INTO "Resource"("id","code","name","type","capacity","active","departmentId") VALUES ($1,$2,$3,$4,$5,true,$6)`, [e.id, e.code, e.name, e.type, e.capacity, e.departmentId ?? null]);
    for (const name of e.capabilities ?? []) {
        const key = name.toLowerCase().replace(/\W/g, '-'), id = `cap-${key}`;
        await q(`INSERT INTO "Capability"("id","key","name") VALUES ($1,$2,$3) ON CONFLICT ("key") DO NOTHING`, [id, key, name]);
        const cap = await db.query(`SELECT "id" FROM "Capability" WHERE "key"=$1`, [key]);
        await q(`INSERT INTO "ResourceCapability" VALUES ($1,$2)`, [e.id, cap.rows[0].id]);
    }
    return;
} if (c === 'requirements')
    return insertRequirement(e); throw new Error(`Persistent create unavailable for ${c}`); }
export async function persistPolicy(p) { await q(`INSERT INTO "SchedulingPolicy"("id","name","description","ruleType","strength","priority","scope","parameters","active","version") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT ("id") DO UPDATE SET "name"=excluded."name","scope"=excluded."scope","parameters"=excluded."parameters","active"=excluded."active","version"=excluded."version"`, [p.id, p.name, p.description, p.type, p.strength, p.weight, JSON.stringify(p.scope), JSON.stringify(p.parameters), p.active, p.version]); }
export async function persistGeneration(run: any, v: any = undefined) { if (v) {
    await q(`INSERT INTO "TimetableVersion"("id","timetableId","version","status") VALUES ($1,'timetable-26',$2,$3)`, [v.id, v.version, v.status]);
    for (const a of v.assignments) {
        const id = `entry-${v.id}-${a.sessionId}`;
        await q(`INSERT INTO "TimetableEntry"("id","versionId","sessionId","resourceId") VALUES ($1,$2,$3,$4)`, [id, v.id, a.sessionId, a.resourceId]);
        for (const [i, s] of a.slotIds.entries())
            await q(`INSERT INTO "TimetableEntrySlot" VALUES ($1,$2,$3)`, [id, s, i]);
    }
    if (v.validation)
        await q(`INSERT INTO "ValidationResult"("id","versionId","valid","metrics") VALUES ($1,$2,$3,$4)`, [`validation-${v.id}`, v.id, v.validation.valid, JSON.stringify(v.validation.metrics)]);
} await q(`INSERT INTO "GenerationRun"("id","versionId","status","sessionCount","candidateCount","solverStatus","solverDurationMs","objectiveMetrics","diagnostics","startedAt","completedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [run.id, v?.id ?? null, run.status === 'INFEASIBLE' ? 'INFEASIBLE' : run.status === 'FAILED' ? 'FAILED' : 'SUCCEEDED', Number(run.result?.metrics.sessions ?? 0), Number(run.result?.metrics.candidates ?? 0), run.result?.status ?? null, Number(run.result?.metrics.solverDurationMs ?? 0), JSON.stringify(run.result?.metrics ?? {}), JSON.stringify(run.result?.diagnostics ?? []), run.startedAt, run.completedAt]); }
export async function persistMove(v, sid) { const a = v.assignments.find(x => x.sessionId === sid), id = `entry-${v.id}-${sid}`; await q(`UPDATE "TimetableEntry" SET "resourceId"=$1,"source"='MANUAL' WHERE "id"=$2`, [a.resourceId, id]); await q(`DELETE FROM "TimetableEntrySlot" WHERE "entryId"=$1`, [id]); for (const [i, s] of a.slotIds.entries())
    await q(`INSERT INTO "TimetableEntrySlot" VALUES ($1,$2,$3)`, [id, s, i]); }
export async function persistTransition(id, status) { await q(`UPDATE "TimetableVersion" SET "status"=$1::"TimetableStatus","updatedAt"=now() WHERE "id"=$2`, [status, id]); if (status === 'PUBLISHED')
    await q(`UPDATE "TimetableVersion" SET "publishedAt"=now() WHERE "id"=$1`, [id]); }
export async function audit(actorId, action, type, id, after) { await q(`INSERT INTO "AuditEvent"("id","actorId","action","entityType","entityId","after") VALUES ($1,$2,$3,$4,$5,$6)`, [crypto.randomUUID(), actorId, action, type, id, JSON.stringify(after)]); }
export async function logAIAction(userId, tool, args, result, status = 'SUCCEEDED') { const cid = crypto.randomUUID(); await q(`INSERT INTO "Conversation"("id","userId","title") VALUES ($1,$2,'Policy assistant')`, [cid, userId]); await q(`INSERT INTO "AIAction"("id","conversationId","tool","arguments","result","status") VALUES ($1,$2,$3,$4,$5,$6)`, [crypto.randomUUID(), cid, tool, JSON.stringify(args), JSON.stringify(result), status]); return cid; }
export async function persistFacultyAvailability(facultyId,unavailableSlotIds,preferredSlotIds){
 await q(`DELETE FROM "FacultyAvailability" WHERE "facultyId"=$1`,[facultyId]);
 for(const [kind,ids] of [['UNAVAILABLE',unavailableSlotIds],['PREFERRED',preferredSlotIds]])for(const sid of ids){const slot=slots.find(x=>x.id===sid);if(!slot)throw new Error(`Unknown time slot ${sid}`);await q(`INSERT INTO "FacultyAvailability"("id","facultyId","workingDayId","timeSlotId","kind") VALUES ($1,$2,$3,$4,$5)`,[`fa-${facultyId}-${kind}-${sid}`,facultyId,slot.dayId,sid,kind]);}
}
export async function persistResourceAvailability(resourceId,unavailableSlotIds){
 await q(`DELETE FROM "ResourceAvailability" WHERE "resourceId"=$1`,[resourceId]);for(const sid of unavailableSlotIds){const slot=slots.find(x=>x.id===sid);if(!slot)throw new Error(`Unknown time slot ${sid}`);await q(`INSERT INTO "ResourceAvailability"("id","resourceId","workingDayId","timeSlotId","kind") VALUES ($1,$2,$3,$4,'UNAVAILABLE')`,[`ra-${resourceId}-${sid}`,resourceId,slot.dayId,sid]);}
}
