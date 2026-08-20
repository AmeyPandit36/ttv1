import express from 'express';import cors from 'cors';import helmet from 'helmet';import {rateLimit} from 'express-rate-limit';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {existsSync} from 'node:fs';import {randomUUID} from 'node:crypto';import PDFDocument from 'pdfkit';
import {analyzeCandidates,PolicySchema,SolverInputSchema,validateTimetable,type SolverResult} from '@chronos/domain';
import {collections,departments,faculty,resources,policies,runs,slots,solverInput,versions,buildSessions,type Entity} from './store.js';
import {ready,persistEntity,persistEntities,persistPolicy,persistGeneration,persistMove,persistTransition,audit,logAIAction,persistFacultyAvailability,persistResourceAvailability,nextVersionNumber,db,withTransaction} from './db.js';
import {interpretWithProvider} from './llm.js';
import {authenticate,authorize,currentUser,login} from './auth.js';
import {createSchemas} from './setup-schemas.js';
import {referenceIssues} from './references.js';
import {groundedTools,inferTool,runGroundedTool,isSessionForStudent} from './ai-tools.js';
import {createXlsxWorkbook} from './xlsx-export.js';

const schedulerPath=fileURLToPath(new URL('../../../scheduler/solve.py',import.meta.url));
const localPython=fileURLToPath(new URL('../../../.venv/bin/python',import.meta.url));
function runScheduler(input:unknown):Promise<SolverResult>{return new Promise((resolve,reject)=>{const child=spawn(process.env.SCHEDULER_PYTHON??(existsSync(localPython)?localPython:'python3'),[schedulerPath],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',code=>{try{resolve(JSON.parse(stdout));}catch{reject(new Error(`Scheduler exited ${code}: ${stderr||stdout}`));}});child.stdin.end(JSON.stringify(input));});}
export const app=express();app.disable('x-powered-by');app.use(helmet({crossOriginResourcePolicy:false,contentSecurityPolicy:false}));app.use(cors({origin:process.env.APP_ORIGIN?.split(',')??true,credentials:true}));app.use(express.json({limit:'1mb'}));const authLimit=rateLimit({windowMs:15*60_000,limit:30,standardHeaders:'draft-8',legacyHeaders:false});const operationLimit=rateLimit({windowMs:60_000,limit:30,standardHeaders:'draft-8',legacyHeaders:false});

function filterCollectionForHOD(collectionName: string, data: any[], departmentId: string) {
  if (!departmentId) return [];
  switch (collectionName) {
    case 'departments':
      return data.filter(x => x.id === departmentId);
    case 'programs':
    case 'faculty':
    case 'resources':
    case 'subjects':
      return data.filter(x => x.departmentId === departmentId);
    case 'levels':
      return data.filter(x => {
        const prog = collections.programs.find(p => p.id === (x as any).programId);
        return prog && (prog as any).departmentId === departmentId;
      });
    case 'divisions':
      return data.filter(x => {
        const lvl = collections.levels.find(l => l.id === (x as any).programLevelId);
        const prog = lvl ? collections.programs.find(p => p.id === (lvl as any).programId) : null;
        return prog && (prog as any).departmentId === departmentId;
      });
    case 'batches':
      return data.filter(x => {
        const div = collections.divisions.find(d => d.id === (x as any).divisionId);
        const lvl = div ? collections.levels.find(l => l.id === (div as any).programLevelId) : null;
        const prog = lvl ? collections.programs.find(p => p.id === (lvl as any).programId) : null;
        return prog && (prog as any).departmentId === departmentId;
      });
    case 'enrollments':
      return data.filter(x => {
        const div = collections.divisions.find(d => d.id === (x as any).divisionId);
        const lvl = div ? collections.levels.find(l => l.id === (div as any).programLevelId) : null;
        const prog = lvl ? collections.programs.find(p => p.id === (lvl as any).programId) : null;
        return prog && (prog as any).departmentId === departmentId;
      });
    case 'requirements':
      return data.filter(x => {
        const sub = collections.subjects.find(s => s.id === (x as any).subjectId);
        return sub && (sub as any).departmentId === departmentId;
      });
    case 'policies':
      return data.filter(x => x.scope?.departmentId === departmentId);
    default:
      return data;
  }
}

function filterCollectionForFaculty(collectionName: string, data: any[], fac: any) {
  if (!fac) return [];
  if (collectionName === 'faculty') {
    return data.filter(x => x.id === fac.id);
  }
  if (collectionName === 'requirements') {
    return data.filter(x => x.facultyId === fac.id);
  }
  return filterCollectionForHOD(collectionName, data, fac.departmentId);
}

function filterCollectionForStudent(collectionName: string, data: any[], enroll: any) {
  if (!enroll) return [];
  if (collectionName === 'enrollments') {
    return data.filter(x => x.id === enroll.id);
  }
  if (collectionName === 'divisions') {
    return data.filter(x => x.id === enroll.divisionId);
  }
  if (collectionName === 'batches') {
    return enroll.batchId ? data.filter(x => x.id === enroll.batchId) : [];
  }
  if (collectionName === 'requirements') {
    return data.filter(x => 
      ((x as any).divisionIds && (x as any).divisionIds.includes(enroll.divisionId)) ||
      ((x as any).batchIds && enroll.batchId && (x as any).batchIds.includes(enroll.batchId))
    );
  }
  if (collectionName === 'subjects') {
    const reqs = collections.requirements.filter(x => 
      ((x as any).divisionIds && ((x as any).divisionIds as string[]).includes(enroll.divisionId)) ||
      ((x as any).batchIds && enroll.batchId && ((x as any).batchIds as string[]).includes(enroll.batchId))
    );
    const subIds = reqs.map(r => (r as any).subjectId);
    return data.filter(x => subIds.includes(x.id));
  }
  if (['departments', 'programs', 'levels', 'faculty', 'resources', 'policies'].includes(collectionName)) {
    return [];
  }
  return data;
}

app.get('/api/health',async(_req,res,next)=>{try{await ready;res.json({status:'ok',service:'chronos-api',database:'ready'});}catch(e){next(e);}});
app.post('/api/auth/login',authLimit,async(req,res,next)=>{try{const result=await login(String(req.body.email??''),String(req.body.password??''));if(!result)return res.status(401).json({error:{code:'INVALID_CREDENTIALS',message:'Email or password is incorrect'}});res.json(result);}catch(e){next(e);}});
app.use('/api',async(_req,_res,next)=>{try{await ready;next();}catch(e){next(e);}});app.use('/api',authenticate);
app.get('/api/session',(req,res)=>res.json({user:currentUser(req)}));

app.get('/api/dashboard',async(req,res,next)=>{
  try {
    const user = currentUser(req);
    const ayRes = await db.query<any>(`SELECT "id","name" FROM "AcademicYear" WHERE "active"=true ORDER BY "startsOn" DESC LIMIT 1`);
    let academicYear = null;
    if (ayRes.rows.length > 0) {
      academicYear = { id: ayRes.rows[0].id, name: ayRes.rows[0].name };
    } else {
      const anyAy = await db.query<any>(`SELECT "id","name" FROM "AcademicYear" ORDER BY "startsOn" DESC LIMIT 1`);
      if (anyAy.rows.length > 0) {
        academicYear = { id: anyAy.rows[0].id, name: anyAy.rows[0].name };
      }
    }

    let counts = { departments: 0, faculty: 0, resources: 0, requirements: 0, sessions: 0 };
    let facId: string | null = null;
    let enroll: any = null;

    if (user.role === 'ADMIN') {
      const d = await db.query<{n: number}>(`SELECT count(*)::int n FROM "Department"`);
      const f = await db.query<{n: number}>(`SELECT count(*)::int n FROM "Faculty"`);
      const r = await db.query<{n: number}>(`SELECT count(*)::int n FROM "Resource"`);
      const q_req = await db.query<{n: number}>(`SELECT count(*)::int n FROM "TeachingRequirement"`);
      const s = await db.query<{n: number}>(`SELECT count(*)::int n FROM "SchedulableSession"`);
      counts = {
        departments: d.rows[0]?.n || 0,
        faculty: f.rows[0]?.n || 0,
        resources: r.rows[0]?.n || 0,
        requirements: q_req.rows[0]?.n || 0,
        sessions: s.rows[0]?.n || 0
      };
    } else if (user.role === 'HOD') {
      const depId = user.departmentId || '';
      const d = await db.query<{n: number}>(`SELECT count(*)::int n FROM "Department" WHERE "id"=$1`, [depId]);
      const f = await db.query<{n: number}>(`SELECT count(*)::int n FROM "Faculty" WHERE "departmentId"=$1`, [depId]);
      const r = await db.query<{n: number}>(`SELECT count(*)::int n FROM "Resource" WHERE "departmentId"=$1`, [depId]);
      const q_req = await db.query<{n: number}>(`SELECT count(*)::int n FROM "TeachingRequirement" tr JOIN "Subject" s ON s."id"=tr."subjectId" WHERE s."departmentId"=$1`, [depId]);
      const s = await db.query<{n: number}>(`SELECT count(*)::int n FROM "SchedulableSession" ss JOIN "TeachingRequirement" tr ON tr."id"=ss."requirementId" JOIN "Subject" s ON s."id"=tr."subjectId" WHERE s."departmentId"=$1`, [depId]);
      counts = {
        departments: d.rows[0]?.n || 0,
        faculty: f.rows[0]?.n || 0,
        resources: r.rows[0]?.n || 0,
        requirements: q_req.rows[0]?.n || 0,
        sessions: s.rows[0]?.n || 0
      };
    } else if (user.role === 'FACULTY') {
      const fRes = await db.query<any>(`SELECT "id", "departmentId" FROM "Faculty" WHERE "userId"=$1 OR "id"=$2`, [user.id, user.id]);
      if (fRes.rows.length > 0) {
        facId = fRes.rows[0].id;
        const depId = fRes.rows[0].departmentId;
        const d = await db.query<{n: number}>(`SELECT count(*)::int n FROM "Department" WHERE "id"=$1`, [depId]);
        const f = await db.query<{n: number}>(`SELECT count(*)::int n FROM "Faculty" WHERE "id"=$1`, [facId]);
        const r = await db.query<{n: number}>(`SELECT count(*)::int n FROM "Resource" WHERE "departmentId"=$1`, [depId]);
        const q_req = await db.query<{n: number}>(`SELECT count(*)::int n FROM "TeachingRequirement" WHERE "facultyId"=$1`, [facId]);
        const s = await db.query<{n: number}>(`SELECT count(*)::int n FROM "SchedulableSession" ss JOIN "TeachingRequirement" tr ON tr."id"=ss."requirementId" WHERE tr."facultyId"=$1`, [facId]);
        counts = {
          departments: d.rows[0]?.n || 0,
          faculty: f.rows[0]?.n || 0,
          resources: r.rows[0]?.n || 0,
          requirements: q_req.rows[0]?.n || 0,
          sessions: s.rows[0]?.n || 0
        };
      }
    } else if (user.role === 'STUDENT') {
      const eRes = await db.query<any>(`
        SELECT e."id", e."divisionId", e."batchId", s."name" "studentName"
        FROM "Enrollment" e 
        JOIN "Student" s ON s."id"=e."studentId" 
        WHERE s."id"=$1 OR s."rollNumber"=$2 OR s."name"=$3
      `, [user.id, user.id, user.name]);
      if (eRes.rows.length > 0) {
        enroll = { id: eRes.rows[0].id, divisionId: eRes.rows[0].divisionId, batchId: eRes.rows[0].batchId, studentName: eRes.rows[0].studentName };
        const divId = enroll.divisionId;
        const batId = enroll.batchId;
        const q_req = await db.query<{n: number}>(`
          SELECT count(distinct tr."id")::int n 
          FROM "TeachingRequirement" tr 
          JOIN "RequirementCohort" rc ON rc."requirementId"=tr."id" 
          WHERE rc."divisionId"=$1 OR rc."batchId"=$2
        `, [divId, batId || null]);
        const s = await db.query<{n: number}>(`
          SELECT count(distinct ss."id")::int n 
          FROM "SchedulableSession" ss 
          JOIN "TeachingRequirement" tr ON tr."id"=ss."requirementId"
          JOIN "RequirementCohort" rc ON rc."requirementId"=tr."id" 
          WHERE rc."divisionId"=$1 OR rc."batchId"=$2
        `, [divId, batId || null]);
        counts = {
          departments: 0,
          faculty: 0,
          resources: 0,
          requirements: q_req.rows[0]?.n || 0,
          sessions: s.rows[0]?.n || 0
        };
      }
    }

    const verRes = await db.query<any>(`SELECT "id", "version", "status", "createdAt" FROM "TimetableVersion" ORDER BY "createdAt" DESC, "version" DESC LIMIT 1`);
    let latestVersion = null;
    let unresolvedConflicts = 0;
    if (verRes.rows.length > 0) {
      const vId = verRes.rows[0].id;
      const verObj = versions.find(v => v.id === vId);
      if (verObj) {
        let assignments = verObj.assignments;
        const sessions = buildSessions();
        if (user.role === 'HOD') {
          assignments = assignments.filter(a => {
            const s = sessions.find(x => x.id === a.sessionId);
            return s && s.preferredDepartmentId === user.departmentId;
          });
        } else if (user.role === 'FACULTY' && facId) {
          assignments = assignments.filter(a => {
            const s = sessions.find(x => x.id === a.sessionId);
            return s && s.facultyId === facId;
          });
        } else if (user.role === 'STUDENT' && enroll) {
          assignments = assignments.filter(a => {
            const s = sessions.find(x => x.id === a.sessionId);
            return s && isSessionForStudent(s, enroll.divisionId, enroll.batchId);
          });
        }
        latestVersion = { ...verObj, assignments };

        let conflicts = verObj.validation?.conflicts || [];
        if (user.role === 'HOD') {
          conflicts = conflicts.filter(c => {
            const sIds = c.sessionIds || [];
            return sIds.some(sid => {
              const s = sessions.find(x => x.id === sid);
              return s && s.preferredDepartmentId === user.departmentId;
            });
          });
        } else if (user.role === 'FACULTY' && facId) {
          conflicts = conflicts.filter(c => {
            const sIds = c.sessionIds || [];
            return sIds.some(sid => {
              const s = sessions.find(x => x.id === sid);
              return s && s.facultyId === facId;
            });
          });
        } else if (user.role === 'STUDENT' && enroll) {
          conflicts = conflicts.filter(c => {
            const sIds = c.sessionIds || [];
            return sIds.some(sid => {
              const s = sessions.find(x => x.id === sid);
              return s && isSessionForStudent(s, enroll.divisionId, enroll.batchId);
            });
          });
        }
        unresolvedConflicts = conflicts.length;
      }
    }

    const runRes = await db.query<any>(`SELECT "id", "status", "startedAt", "completedAt" FROM "GenerationRun" ORDER BY "startedAt" DESC LIMIT 1`);
    let latestRun = null;
    if (runRes.rows.length > 0) {
      latestRun = {
        id: runRes.rows[0].id,
        status: runRes.rows[0].status,
        startedAt: new Date(runRes.rows[0].startedAt).toISOString(),
        completedAt: runRes.rows[0].completedAt ? new Date(runRes.rows[0].completedAt).toISOString() : undefined
      };
    }

    const setupRequired = !academicYear || counts.departments === 0 || counts.faculty === 0 || counts.resources === 0;

    res.json({
      academicYear,
      counts,
      latestVersion,
      unresolvedConflicts,
      latestRun,
      setupRequired
    });
  } catch (e) {
    next(e);
  }
});

app.get('/api/slots',(_req,res)=>res.json(slots));

app.get('/api/:collection',(req,res,next)=>{
  const name = String(req.params.collection);
  const data=collections[name];
  if(!data)return next();

  const user = currentUser(req);
  if (user.role === 'ADMIN') {
    return res.json(data);
  }
  if (user.role === 'HOD') {
    return res.json(filterCollectionForHOD(name, data, user.departmentId || ''));
  }
  if (user.role === 'FACULTY') {
    const fac = faculty.find(f => (f as any).userId === user.id || f.id === user.id);
    return res.json(filterCollectionForFaculty(name, data, fac));
  }
  if (user.role === 'STUDENT') {
    const enroll = collections.enrollments.find(e => (e as any).studentId === user.id || e.id === user.id || (e as any).studentName?.toLowerCase() === user.name?.toLowerCase());
    return res.json(filterCollectionForStudent(name, data, enroll));
  }
  res.json([]);
});

app.post('/api/:collection',authorize('ADMIN'),async(req,res,next)=>{const name=String(req.params.collection);const data=collections[name];if(!data)return next();if(!req.body||typeof req.body!=='object')return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'A JSON object is required'}});const schema=createSchemas[name];if(!schema)return res.status(405).json({error:{code:'UNSUPPORTED_CREATE',message:`Create is not available for ${name}`}});const parsed=schema.safeParse(req.body);if(!parsed.success)return res.status(422).json({error:{code:'VALIDATION_ERROR',message:'The submitted record is invalid',details:parsed.error.flatten()}});const refs=referenceIssues(name,parsed.data as Record<string,unknown>);if(refs.length)return res.status(422).json({error:{code:'INVALID_REFERENCE',message:'Referenced entities are missing or ineligible',details:refs}});const entity={...parsed.data,id:parsed.data.id||randomUUID()} as Entity;if(data.some(x=>x.id===entity.id))return res.status(409).json({error:{code:'DUPLICATE',message:`${entity.id} already exists`}});try{await persistEntity(name,entity);data.push(entity);await audit(currentUser(req).id,'CREATE',name,entity.id,entity);res.status(201).json(entity);}catch(e){next(e);}});
app.put('/api/faculty/:id/availability',authorize('ADMIN'),async(req,res,next)=>{const f=faculty.find(x=>x.id===req.params.id);if(!f)return res.status(404).json({error:{code:'NOT_FOUND',message:'Faculty not found'}});const unavailable=Array.isArray(req.body.unavailableSlotIds)?req.body.unavailableSlotIds:[],preferred=Array.isArray(req.body.preferredSlotIds)?req.body.preferredSlotIds:[];if([...unavailable,...preferred].some(id=>!slots.some(s=>s.id===id)))return res.status(422).json({error:{code:'UNKNOWN_SLOT',message:'Availability contains an unknown time slot'}});try{await persistFacultyAvailability(f.id,unavailable,preferred);f.unavailableSlotIds=unavailable;f.preferredSlotIds=preferred;await audit(currentUser(req).id,'UPDATE_AVAILABILITY','Faculty',f.id,{unavailable,preferred});res.json(f);}catch(e){next(e);}});
app.put('/api/resources/:id/availability',authorize('ADMIN'),async(req,res,next)=>{const r=resources.find(x=>x.id===req.params.id);if(!r)return res.status(404).json({error:{code:'NOT_FOUND',message:'Resource not found'}});const unavailable=Array.isArray(req.body.unavailableSlotIds)?req.body.unavailableSlotIds:[];if(unavailable.some((id:string)=>!slots.some(s=>s.id===id)))return res.status(422).json({error:{code:'UNKNOWN_SLOT',message:'Availability contains an unknown time slot'}});try{await persistResourceAvailability(r.id,unavailable);r.unavailableSlotIds=unavailable;await audit(currentUser(req).id,'UPDATE_AVAILABILITY','Resource',r.id,{unavailable});res.json(r);}catch(e){next(e);}});
app.post('/api/generation/preflight',authorize('ADMIN','HOD'),(_req,res)=>{const analysis=analyzeCandidates(solverInput());res.json({valid:analysis.valid,issues:analysis.issues,sessions:analysis.sessions.map(s=>({sessionId:s.sessionId,requirementId:s.requirementId,title:s.title,candidateCount:s.candidateCount,reasons:s.reasons})),summary:analysis.summary});});
app.post('/api/generation/run',operationLimit,authorize('ADMIN'),async(_req,res,next)=>{const run={id:randomUUID(),status:'SOLVING',startedAt:new Date().toISOString()} as (typeof runs)[number];try{const input=SolverInputSchema.parse(solverInput());(run as any).scope = input;const preflight=analyzeCandidates(input);if(!preflight.valid){run.status='INFEASIBLE';run.completedAt=new Date().toISOString();run.result={status:'INFEASIBLE',assignments:[],diagnostics:preflight.issues.map(issue=>({code:issue.code,message:issue.message,sessionIds:issue.sessionId?[issue.sessionId]:[],evidence:issue.evidence})),metrics:preflight.summary};await persistGeneration(run);runs.push(run);return res.status(422).json({run,preflight});}if(_req.query?.async==='true'||_req.body?.async===true){await persistGeneration(run);runs.push(run);res.status(202).json({run,preflight,message:'Timetable generation started in the background.'});(async()=>{try{const result=await runScheduler(input);run.status=result.status;run.completedAt=new Date().toISOString();run.result=result;if(['OPTIMAL','FEASIBLE'].includes(result.status)){const report=validateTimetable(input,result.assignments);const version={id:randomUUID(),version:0,status:(report.valid?'VALIDATED':'GENERATED') as 'VALIDATED'|'GENERATED',assignments:result.assignments,validation:report,createdAt:new Date().toISOString()};await persistGeneration(run,version);versions.push(version);await audit(currentUser(_req).id,'GENERATE','TimetableVersion',version.id,{runId:run.id,status:version.status});}else{await persistGeneration(run);}}catch(e){(run as any).status='FAILED';run.completedAt=new Date().toISOString();await persistGeneration(run);}})();return;}const result=await runScheduler(input);run.status=result.status;run.completedAt=new Date().toISOString();run.result=result;if(['OPTIMAL','FEASIBLE'].includes(result.status)){const report=validateTimetable(input,result.assignments);const version={id:randomUUID(),version:0,status:(report.valid?'VALIDATED':'GENERATED') as 'VALIDATED'|'GENERATED',assignments:result.assignments,validation:report,createdAt:new Date().toISOString()};await persistGeneration(run,version);versions.push(version);runs.push(run);await audit(currentUser(_req).id,'GENERATE','TimetableVersion',version.id,{runId:run.id,status:version.status});return res.status(201).json({run,version,preflight});}await persistGeneration(run);runs.push(run);res.status(422).json({run,preflight});}catch(error){run.status='FAILED';run.completedAt=new Date().toISOString();runs.push(run);next(error);}});

app.get('/api/generation/runs',(req,res)=>{
  const user = currentUser(req);
  if (user.role === 'ADMIN') return res.json(runs);
  if (user.role === 'HOD') {
    return res.json(runs.map(r => ({
      ...r,
      result: r.result ? {
        ...r.result,
        diagnostics: (r.result.diagnostics || []).filter((d: any) => {
          if (!d.sessionIds || d.sessionIds.length === 0) return true;
          return d.sessionIds.some((sid: string) => {
            const s = buildSessions().find(x => x.id === sid);
            return s && s.preferredDepartmentId === user.departmentId;
          });
        })
      } : undefined
    })));
  }
  return res.json([]);
});

app.get('/api/timetables/versions',(req,res)=>{
  const user = currentUser(req);
  const mapped = versions.map(v => {
    let assignments = v.assignments;
    const sessions = buildSessions();
    if (user.role === 'HOD') {
      assignments = assignments.filter(a => {
        const s = sessions.find(x => x.id === a.sessionId);
        return s && s.preferredDepartmentId === user.departmentId;
      });
    } else if (user.role === 'FACULTY') {
      const fac = faculty.find(f => (f as any).userId === user.id || f.id === user.id);
      assignments = fac ? assignments.filter(a => {
        const s = sessions.find(x => x.id === a.sessionId);
        return s && s.facultyId === fac.id;
      }) : [];
    } else if (user.role === 'STUDENT') {
      const enroll = collections.enrollments.find(e => (e as any).studentId === user.id || e.id === user.id || (e as any).studentName?.toLowerCase() === user.name?.toLowerCase());
      assignments = enroll ? assignments.filter(a => {
        const s = sessions.find(x => x.id === a.sessionId);
        return s && isSessionForStudent(s, (enroll as any).divisionId, (enroll as any).batchId);
      }) : [];
    }
    return { ...v, assignments };
  });
  res.json(mapped);
});

app.get('/api/timetables/versions/:id',async(req,res,next)=>{
  const version=versions.find(v=>v.id===req.params.id);
  if(!version)return res.status(404).json({error:{code:'NOT_FOUND',message:'Timetable version not found'}});
  
  try {
    const user = currentUser(req);
    const sessions=buildSessions();
    const scheduled=new Set(version.assignments.map(a=>a.sessionId));
    
    let versionSlots = slots;
    const timetableRes = await db.query<any>(`
      SELECT t."profileId" 
      FROM "Timetable" t 
      JOIN "TimetableVersion" tv ON tv."timetableId" = t."id" 
      WHERE tv."id" = $1
    `, [version.id]);
    const profileId = timetableRes.rows[0]?.profileId;
    if (profileId) {
      const slotsRes = await db.query<any>(`
        SELECT ts."id", wd."id" "dayId", ts."index", ts."label", ts."startsAt" "start", ts."endsAt" "end", ts."isBreak"
        FROM "TimeSlot" ts
        JOIN "WorkingDay" wd ON wd."id" = ts."workingDayId"
        WHERE wd."profileId" = $1 AND wd."enabled" = true
        ORDER BY wd."ordinal", ts."index"
      `, [profileId]);
      if (slotsRes.rows.length > 0) {
        versionSlots = slotsRes.rows.map(row => ({
          id: row.id,
          dayId: row.dayId,
          index: Number(row.index),
          label: row.label,
          start: row.start,
          end: row.end,
          isBreak: Boolean(row.isBreak)
        }));
      }
    }
  
  let assignments = version.assignments;
  let sList = sessions;
  let fac = faculty.find(f => (f as any).userId === user.id || f.id === user.id);
  let enroll = collections.enrollments.find(e => (e as any).studentId === user.id || e.id === user.id || (e as any).studentName?.toLowerCase() === user.name?.toLowerCase());
  
  if (user.role === 'HOD') {
    assignments = assignments.filter(a => {
      const s = sessions.find(x => x.id === a.sessionId);
      return s && s.preferredDepartmentId === user.departmentId;
    });
  } else if (user.role === 'FACULTY') {
    assignments = fac ? assignments.filter(a => {
      const s = sessions.find(x => x.id === a.sessionId);
      return s && s.facultyId === fac.id;
    }) : [];
  } else if (user.role === 'STUDENT') {
    assignments = enroll ? assignments.filter(a => {
      const s = sessions.find(x => x.id === a.sessionId);
      return s && isSessionForStudent(s, (enroll as any).divisionId, (enroll as any).batchId);
    }) : [];
  }
  
  let resResources = resources;
  let resFaculty = faculty;
  let resDepartments = departments;
  let resDivisions = collections.divisions;
  let resBatches = collections.batches;
  
  if (user.role === 'HOD') {
    resResources = resources.filter(r => r.departmentId === user.departmentId);
    resFaculty = faculty.filter(f => f.departmentId === user.departmentId);
    resDepartments = departments.filter(d => d.id === user.departmentId);
    resDivisions = filterCollectionForHOD('divisions', collections.divisions, user.departmentId || '');
    resBatches = filterCollectionForHOD('batches', collections.batches, user.departmentId || '');
    sList = sessions.filter(s => s.preferredDepartmentId === user.departmentId);
  } else if (user.role === 'FACULTY') {
    if (fac) {
      resResources = resources.filter(r => r.departmentId === (fac as any).departmentId);
      resFaculty = faculty.filter(f => f.id === (fac as any).id);
      resDepartments = departments.filter(d => d.id === (fac as any).departmentId);
      resDivisions = filterCollectionForHOD('divisions', collections.divisions, (fac as any).departmentId);
      resBatches = filterCollectionForHOD('batches', collections.batches, (fac as any).departmentId);
      sList = sessions.filter(s => s.facultyId === (fac as any).id);
    } else {
      resResources = []; resFaculty = []; resDepartments = []; resDivisions = []; resBatches = []; sList = [];
    }
  } else if (user.role === 'STUDENT') {
    if (enroll) {
      resResources = [];
      resFaculty = [];
      resDepartments = [];
      resDivisions = collections.divisions.filter(d => d.id === (enroll as any).divisionId);
      resBatches = (enroll as any).batchId ? collections.batches.filter(b => b.id === (enroll as any).batchId) : [];
      sList = sessions.filter(s => isSessionForStudent(s, (enroll as any).divisionId, (enroll as any).batchId));
    } else {
      resResources = []; resFaculty = []; resDepartments = []; resDivisions = []; resBatches = []; sList = [];
    }
  }
  
  const schedIds = new Set(assignments.map(a => a.sessionId));
  res.json({
    ...version,
    assignments,
    sessions: sList,
    unscheduledSessions: sList.filter(s => !schedIds.has(s.id)),
    resources: resResources,
    faculty: resFaculty,
    departments: resDepartments,
    divisions: resDivisions,
    batches: resBatches,
    slots: versionSlots
  });
  } catch(e) { next(e); }
});

app.post('/api/timetables/versions/:id/move',authorize('ADMIN'),async(req,res,next)=>{
  const version=versions.find(v=>v.id===req.params.id);
  if(!version)return res.status(404).json({error:{code:'NOT_FOUND',message:'Version not found'}});
  if(version.status==='PUBLISHED')return res.status(409).json({error:{code:'PUBLISHED_IMMUTABLE',message:'Published timetable entries are immutable'}});
  
  const dbVer = await db.query<any>(`SELECT "updatedAt" FROM "TimetableVersion" WHERE "id"=$1`, [req.params.id]);
  if (dbVer.rows.length === 0) return res.status(404).json({error:{code:'NOT_FOUND',message:'Version not found'}});
  const currentUpdatedAt = new Date(dbVer.rows[0].updatedAt).toISOString();
  const clientUpdatedAt = req.body.updatedAt || req.headers['x-updated-at'];
  if (clientUpdatedAt && new Date(clientUpdatedAt).getTime() !== new Date(currentUpdatedAt).getTime()) {
    return res.status(409).json({error:{code:'STALE_UPDATE',message:'This timetable version has been modified by another administrator. Please refresh.'}});
  }

  const {sessionId,resourceId,slotIds}=req.body;
  const moved=version.assignments.map(a=>a.sessionId===sessionId?{...a,resourceId,slotIds,score:0}:a);
  if(!moved.some(a=>a.sessionId===sessionId))return res.status(404).json({error:{code:'SESSION_NOT_FOUND',message:'Session is not present in this version'}});
  const report=validateTimetable(solverInput(),moved);
  if(!report.valid)return res.status(422).json({error:{code:'INVALID_MOVE',message:'Move rejected because it violates hard constraints',conflicts:report.conflicts}});
  version.assignments=moved;
  version.validation=report;
  version.status='VALIDATED';
  try{await persistMove(version,sessionId);await audit(currentUser(req).id,'MANUAL_MOVE','TimetableEntry',sessionId,{resourceId,slotIds});res.json(version);}catch(e){if((e as {code?:string}).code==='PUBLISHED_IMMUTABLE')return res.status(409).json({error:{code:'PUBLISHED_IMMUTABLE',message:'Published timetable entries are immutable'}});next(e);}});

app.post('/api/timetables/versions/:id/transition',authorize('ADMIN'),async(req,res,next)=>{
  const v=versions.find(x=>x.id===req.params.id);
  if(!v)return res.status(404).json({error:{code:'NOT_FOUND',message:'Version not found'}});
  
  const dbVer = await db.query<any>(`SELECT "updatedAt" FROM "TimetableVersion" WHERE "id"=$1`, [req.params.id]);
  if (dbVer.rows.length === 0) return res.status(404).json({error:{code:'NOT_FOUND',message:'Version not found'}});
  const currentUpdatedAt = new Date(dbVer.rows[0].updatedAt).toISOString();
  const clientUpdatedAt = req.body.updatedAt || req.headers['x-updated-at'];
  if (clientUpdatedAt && new Date(clientUpdatedAt).getTime() !== new Date(currentUpdatedAt).getTime()) {
    return res.status(409).json({error:{code:'STALE_UPDATE',message:'This timetable version has been modified by another administrator. Please refresh.'}});
  }

  const nextStatus=String(req.body.status);const allowed:Record<string,string[]>= {DRAFT:['GENERATED'],GENERATED:['VALIDATED'],VALIDATED:['REVIEWED'],REVIEWED:['APPROVED'],APPROVED:['PUBLISHED']};if(!allowed[v.status]?.includes(nextStatus))return res.status(409).json({error:{code:'INVALID_TRANSITION',message:`Cannot transition ${v.status} to ${nextStatus}`}});if(nextStatus==='PUBLISHED'&&!v.validation?.valid)return res.status(409).json({error:{code:'VALIDATION_REQUIRED',message:'Only independently validated versions can be published'}});v.status=nextStatus as typeof v.status;try{await persistTransition(v.id,nextStatus);await audit(currentUser(req).id,'TRANSITION','TimetableVersion',v.id,{status:nextStatus});res.json(v);}catch(e){next(e);}});

function parseCsvLine(line:string){const values:string[]=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){values.push(value.trim());value='';}else value+=c;}values.push(value.trim());return values;}
const pendingImports=new Map<string,{collection:string;rows:Entity[]}>();
app.post('/api/import/preview',authorize('ADMIN'),(req,res)=>{const collection=String(req.body.collection??''),schema=createSchemas[collection],target=collections[collection];if(!schema||!target)return res.status(400).json({error:{code:'UNSUPPORTED_IMPORT',message:'Choose a supported configuration collection'}});let source=req.body.rows;if(!source&&typeof req.body.csv==='string'){const lines=req.body.csv.trim().split(/\r?\n/),headers=parseCsvLine(lines.shift()??'');source=lines.map((line:string)=>{const values=parseCsvLine(line),row:any=Object.fromEntries(values.map((x:string,i:number)=>[headers[i],x]));for(const key of ['capabilities','requiredCapabilities','preferredCapabilities','unavailableSlotIds'])if(typeof row[key]==='string')row[key]=row[key].split(/[;,]/).map((x:string)=>x.trim()).filter(Boolean);return row;});}if(!Array.isArray(source))return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'rows or csv is required'}});const valid:Entity[]=[],errors:any[]=[];source.forEach((row:any,index:number)=>{const parsed=schema.safeParse(row);if(!parsed.success)errors.push({row:index+1,issues:parsed.error.issues.map(x=>({path:x.path.join('.'),message:x.message}))});else{const refs=referenceIssues(collection,parsed.data as Record<string,unknown>);if(refs.length)errors.push({row:index+1,issues:refs});const e={...parsed.data,id:parsed.data.id||randomUUID()} as Entity;if(target.some(x=>x.id===e.id)||valid.some(x=>x.id===e.id))errors.push({row:index+1,issues:[{path:'id',message:'Duplicate identifier'}]});else if(!refs.length) valid.push(e);}});const token=randomUUID();if(!errors.length)pendingImports.set(token,{collection,rows:valid});res.json({valid:!errors.length,token:errors.length?null:token,collection,totalRows:source.length,validRows:valid,errors});});
app.post('/api/import/:token/confirm',authorize('ADMIN'),async(req,res,next)=>{const pendingImport=pendingImports.get(String(req.params.token));if(!pendingImport)return res.status(404).json({error:{code:'IMPORT_NOT_FOUND',message:'Import preview expired or had validation errors'}});try{await persistEntities(pendingImport.collection,pendingImport.rows);for(const row of pendingImport.rows)collections[pendingImport.collection].push(row);pendingImports.delete(String(req.params.token));await audit(currentUser(req).id,'IMPORT',pendingImport.collection,null,{count:pendingImport.rows.length});res.status(201).json({imported:pendingImport.rows.length,collection:pendingImport.collection});}catch(e){next(e);}});
const pending=new Map<string,{policy:unknown;summary:string}>();
app.post('/api/ai/interpret',operationLimit,authorize('ADMIN'),async(req,res,next)=>{try{const message=String(req.body.message??'').trim();if(!message)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'message is required'}});const user = currentUser(req);let cId = req.body.conversationId;if (!cId) {cId = randomUUID();const title = message.substring(0, 40) + (message.length > 40 ? '...' : '');await db.query(`INSERT INTO "Conversation"("id","userId","title") VALUES ($1,$2,$3)`, [cId, user.id, title]);}await db.query(`INSERT INTO "ConversationMessage"("id","conversationId","role","content") VALUES ($1,$2,'user',$3)`, [randomUUID(), cId, message]);const grounded=inferTool(message);if(grounded){const sessionHint=buildSessions().find(s=>message.toLowerCase().includes(s.subjectCode.toLowerCase())||message.toLowerCase().includes(s.id.toLowerCase())||message.toLowerCase().includes(s.title.toLowerCase()));const result=runGroundedTool(grounded.tool,{...grounded.args,sessionId:sessionHint?.id},currentUser(req));await logAIAction(currentUser(req).id,grounded.tool,{message},result);const assistantText = `Grounded ${grounded.tool} result: success.`;await db.query(`INSERT INTO "ConversationMessage"("id","conversationId","role","content") VALUES ($1,$2,'ai',$3)`, [randomUUID(), cId, assistantText]);return res.json({type:'tool',tool:grounded.tool,summary:`Grounded ${grounded.tool} result from live application data.`,result});}const provider=await interpretWithProvider(message,resources,departments);let mentioned=provider?resources.filter(r=>provider.resourceIds.includes(r.id)):resources.filter(r=>message.toLowerCase().includes(r.name.toLowerCase())||message.toLowerCase().includes(r.id.toLowerCase()));const asksResource=/lab|room|classroom|workshop|resource/i.test(message);if(provider?.action==='CLARIFY'||(asksResource&&!mentioned.length)){const result={type:'clarification',message:provider?.clarification??'I could not match that resource to configured data. Which resource do you mean?',options:resources.map(r=>({id:r.id,name:r.name,type:r.type}))};await logAIAction(currentUser(req).id,'clarifyPolicy',{message},result);await db.query(`INSERT INTO "ConversationMessage"("id","conversationId","role","content") VALUES ($1,$2,'ai',$3)`, [randomUUID(), cId, result.message]);return res.json(result);}const dept=provider?.departmentId?departments.find(d=>d.id===provider.departmentId):departments.find(d=>message.toLowerCase().includes(String(d.name).toLowerCase())||message.toLowerCase().includes(String(d.code).toLowerCase()));const prohibit=provider?provider.action==='PROHIBIT_RESOURCE':/don.?t|do not|never|prohibit|prevent|cannot use/i.test(message);const prefer=provider?provider.action==='PREFER_RESOURCE':/prefer|priority|should use/i.test(message);if(mentioned.length&&(prohibit||prefer)){const policy={id:randomUUID(),name:prohibit?`Restrict ${mentioned[0].name}`:`Prefer ${mentioned[0].name}`,description:`Proposed from administrator instruction: ${message}`,type:prohibit?'RESOURCE_PROHIBITION':'RESOURCE_PREFERENCE',strength:prohibit?'HARD':'SOFT',weight:10,scope:dept?{departmentId:dept.id}:{},parameters:{[prohibit?'resourceIds':'preferredResourceIds']:mentioned.map(r=>r.id)},active:true,version:1};const id=randomUUID(),summary=`${prohibit?'Prevent':'Prefer'} ${mentioned.map(r=>r.name).join(', ')}${dept?` for ${dept.name}`:''}. This changes future scheduling behavior.`;pending.set(id,{policy,summary});const result={type:'confirmation',proposalId:id,summary,policy};await logAIAction(currentUser(req).id,'proposePolicy',{message},result,'AWAITING_CONFIRMATION');await db.query(`INSERT INTO "ConversationMessage"("id","conversationId","role","content") VALUES ($1,$2,'ai',$3)`, [randomUUID(), cId, summary]);return res.json(result);}const result={type:'clarification',message:'te a configured resource and whether to prefer or prohibit it.',options:resources.map(r=>r.name)};await logAIAction(currentUser(req).id,'clarifyPolicy',{message},result);await db.query(`INSERT INTO "ConversationMessage"("id","conversationId","role","content") VALUES ($1,$2,'ai',$3)`, [randomUUID(), cId, result.message]);res.json(result);}catch(e){next(e);}});
app.post('/api/ai/proposals/:id/confirm',authorize('ADMIN'),async(req,res,next)=>{const proposal=pending.get(String(req.params.id));if(!proposal)return res.status(404).json({error:{code:'PROPOSAL_NOT_FOUND',message:'Proposal expired or does not exist'}});const parsed=PolicySchema.safeParse(proposal.policy);if(!parsed.success)return res.status(422).json({error:{code:'INVALID_POLICY',message:'The structured policy failed validation',details:parsed.error.flatten()}});try{await persistPolicy(parsed.data);policies.push(parsed.data);pending.delete(String(req.params.id));await audit(currentUser(req).id,'AI_CREATE_POLICY','SchedulingPolicy',parsed.data.id,parsed.data);res.status(201).json({tool:'createPolicy',result:parsed.data});}catch(e){next(e);}});

app.get('/api/timetables/versions/:id/export.csv',(req,res)=>{
  const v=versions.find(x=>x.id===req.params.id);
  if(!v)return res.status(404).json({error:{code:'NOT_FOUND',message:'Version not found'}});
  
  const user = currentUser(req);
  const sessions=buildSessions();
  let assignments = v.assignments;
  
  if (user.role === 'HOD') {
    assignments = assignments.filter(a => {
      const s = sessions.find(x => x.id === a.sessionId);
      return s && s.preferredDepartmentId === user.departmentId;
    });
  } else if (user.role === 'FACULTY') {
    const fac = faculty.find(f => (f as any).userId === user.id || f.id === user.id);
    assignments = fac ? assignments.filter(a => {
      const s = sessions.find(x => x.id === a.sessionId);
      return s && s.facultyId === fac.id;
    }) : [];
  } else if (user.role === 'STUDENT') {
    const enroll = collections.enrollments.find(e => (e as any).studentId === user.id || e.id === user.id || (e as any).studentName?.toLowerCase() === user.name?.toLowerCase());
    assignments = enroll ? assignments.filter(a => {
      const s = sessions.find(x => x.id === a.sessionId);
      return s && isSessionForStudent(s, (enroll as any).divisionId, (enroll as any).batchId);
    }) : [];
  }
  
  const esc=(x:unknown)=>`"${String(x??'').replaceAll('\"','\"\"')}"`;
  const rows=[['Subject','Session','Faculty','Resource','Day','Start','End','Cohorts']];
  for(const a of assignments){
    const session=sessions.find(x=>x.id===a.sessionId)!;
    const resource=resources.find(x=>x.id===a.resourceId)!;
    const atomic=a.slotIds.map(id=>slots.find(x=>x.id===id)!).filter(Boolean);
    rows.push([session.subjectCode,session.title,faculty.find(x=>x.id===session.facultyId)?.name??session.facultyId,resource.name,atomic[0]?.label.split(' ')[0]??'',atomic[0]?.start??'',atomic.at(-1)?.end??'',session.cohortAtomIds.join('+')]);
  }
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename=chronos-version-${v.version}.csv`);
  res.send(rows.map(row=>row.map(esc).join(',')).join('\n'));
});

app.post('/api/ai/explain',(req,res)=>{const {versionId,sessionId}=req.body;const v=versions.find(x=>x.id===versionId);const a=v?.assignments.find(x=>x.sessionId===sessionId);const s=buildSessions().find(x=>x.id===sessionId);const r=resources.find(x=>x.id===a?.resourceId);if(!v||!a||!s||!r)return res.status(404).json({error:{code:'NOT_FOUND',message:'Assignment evidence was not found'}});const own=r.departmentId===s.preferredDepartmentId;res.json({explanation:`${s.title} was assigned to ${r.name}. It satisfies type ${s.resourceType}, capacity ${s.participantCount} (room: ${r.capacity}), and all required capabilities. ${own?'It is a preferred department resource.':'It is an eligible fallback; the department resource could not improve the globally feasible objective.'}`,evidence:{assignment:a,requiredCapabilities:s.requiredCapabilities,resourceCapabilities:r.capabilities,capacity:{required:s.participantCount,actual:r.capacity},policyIds:policies.filter(p=>p.active).map(p=>p.id)}});});

app.post('/api/ai/tools',authorize('ADMIN','HOD'),async(req,res,next)=>{try{const tool=String(req.body.tool??'');if(!groundedTools.includes(tool as typeof groundedTools[number]))return res.status(400).json({error:{code:'UNKNOWN_TOOL',message:'Supported tools are eligibleResources, currentConflicts, unscheduledSessions and generationDiagnostics'}});const result=runGroundedTool(tool,req.body??{},currentUser(req));await logAIAction(currentUser(req).id,tool,req.body??{},result);res.json(result);}catch(e){next(e);}});
app.get('/api/ai/tools/:tool',authorize('ADMIN','HOD'),(req,res)=>{const result=runGroundedTool(String(req.params.tool),req.query as Record<string,unknown>,currentUser(req));if(!result.ok&&(result as {error?:{code?:string}}).error?.code==='UNKNOWN_TOOL')return res.status(400).json({error:(result as {error:unknown}).error});res.json(result);});

app.get('/api/timetables/versions/:id/export.xlsx', async (req, res, next) => {
  try {
    const v = versions.find(x => x.id === req.params.id);
    if (!v) return res.status(404).json({error:{code:'NOT_FOUND',message:'Version not found'}});
    
    const user = currentUser(req);
    const sessions = buildSessions();
    let assignments = v.assignments;
    
    if (user.role === 'HOD') {
      assignments = assignments.filter(a => {
        const s = sessions.find(x => x.id === a.sessionId);
        return s && s.preferredDepartmentId === user.departmentId;
      });
    } else if (user.role === 'FACULTY') {
      const fac = faculty.find(f => (f as any).userId === user.id || f.id === user.id);
      assignments = fac ? assignments.filter(a => {
        const s = sessions.find(x => x.id === a.sessionId);
        return s && s.facultyId === fac.id;
      }) : [];
    } else if (user.role === 'STUDENT') {
      const enroll = collections.enrollments.find(e => (e as any).studentId === user.id || e.id === user.id || (e as any).studentName?.toLowerCase() === user.name?.toLowerCase());
      assignments = enroll ? assignments.filter(a => {
        const s = sessions.find(x => x.id === a.sessionId);
        return s && isSessionForStudent(s, (enroll as any).divisionId, (enroll as any).batchId);
      }) : [];
    }

    const columns = ['Subject Code', 'Session Title', 'Faculty', 'Resource', 'Day', 'Start Time', 'End Time', 'Cohorts'];
    const dataRows = assignments.map(a => {
      const s = sessions.find(x => x.id === a.sessionId)!;
      const r = resources.find(x => x.id === a.resourceId)!;
      const atomic = a.slotIds.map(id => slots.find(x => x.id === id)!).filter(Boolean);
      return {
        'Subject Code': s.subjectCode,
        'Session Title': s.title,
        'Faculty': faculty.find(x => x.id === s.facultyId)?.name || s.facultyId,
        'Resource': r.name,
        'Day': atomic[0]?.label.split(' ')[0] || '',
        'Start Time': atomic[0]?.start || '',
        'End Time': atomic.at(-1)?.end || '',
        'Cohorts': s.cohortAtomIds.join(', ')
      };
    });

    const buf = createXlsxWorkbook(dataRows, `Version ${v.version}`, columns);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=chronos-version-${v.version}.xlsx`);
    res.send(buf);
  } catch (e) { next(e); }
});

app.get('/api/timetables/versions/:id/export.pdf', async (req, res, next) => {
  try {
    const v = versions.find(x => x.id === req.params.id);
    if (!v) return res.status(404).json({error:{code:'NOT_FOUND',message:'Version not found'}});
    
    const user = currentUser(req);
    const sessions = buildSessions();
    let assignments = v.assignments;
    
    if (user.role === 'HOD') {
      assignments = assignments.filter(a => {
        const s = sessions.find(x => x.id === a.sessionId);
        return s && s.preferredDepartmentId === user.departmentId;
      });
    } else if (user.role === 'FACULTY') {
      const fac = faculty.find(f => (f as any).userId === user.id || f.id === user.id);
      assignments = fac ? assignments.filter(a => {
        const s = sessions.find(x => x.id === a.sessionId);
        return s && s.facultyId === fac.id;
      }) : [];
    } else if (user.role === 'STUDENT') {
      const enroll = collections.enrollments.find(e => (e as any).studentId === user.id || e.id === user.id || (e as any).studentName?.toLowerCase() === user.name?.toLowerCase());
      assignments = enroll ? assignments.filter(a => {
        const s = sessions.find(x => x.id === a.sessionId);
        return s && isSessionForStudent(s, (enroll as any).divisionId, (enroll as any).batchId);
      }) : [];
    }

    const doc = new PDFDocument({ layout: 'landscape', size: 'A4', margin: 30 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=chronos-version-${v.version}.pdf`);
    doc.pipe(res);

    doc.font('Helvetica-Bold').fontSize(18).text(`Campus Chronos Timetable - Version ${v.version}`, { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Status: ${v.status}  |  Generated on: ${new Date(v.createdAt).toLocaleDateString()}`, { align: 'center' });
    doc.moveDown(2);

    doc.font('Helvetica-Bold').fontSize(10);
    const headers = ['Subject', 'Session Title', 'Faculty', 'Resource', 'Day', 'Period'];
    const colWidths = [80, 150, 110, 110, 80, 80];
    let startX = 30;
    let startY = doc.y;

    headers.forEach((h, idx) => {
      doc.text(h, startX, startY);
      startX += colWidths[idx];
    });
    
    doc.moveTo(30, startY + 15).lineTo(30 + colWidths.reduce((a, b) => a + b, 0), startY + 15).stroke();
    doc.moveDown(1.5);

    doc.font('Helvetica').fontSize(9);
    assignments.forEach(a => {
      const s = sessions.find(x => x.id === a.sessionId)!;
      const r = resources.find(x => x.id === a.resourceId)!;
      const atomic = a.slotIds.map(id => slots.find(x => x.id === id)!).filter(Boolean);
      
      const rowY = doc.y;
      if (rowY > 520) {
        doc.addPage();
        doc.font('Helvetica-Bold').fontSize(10);
        let headerX = 30;
        headers.forEach((h, idx) => {
          doc.text(h, headerX, 30);
          headerX += colWidths[idx];
        });
        doc.moveTo(30, 45).lineTo(30 + colWidths.reduce((a, b) => a + b, 0), 45).stroke();
        doc.font('Helvetica').fontSize(9);
        doc.y = 55;
      }

      let curX = 30;
      doc.text(s.subjectCode, curX, doc.y); curX += colWidths[0];
      doc.text(s.title.substring(0, 30), curX, doc.y); curX += colWidths[1];
      
      const teacherName = faculty.find(x => x.id === s.facultyId)?.name || s.facultyId;
      doc.text(teacherName.substring(0, 20), curX, doc.y); curX += colWidths[2];
      doc.text(r.name.substring(0, 20), curX, doc.y); curX += colWidths[3];
      doc.text(atomic[0]?.label.split(' ')[0] || '', curX, doc.y); curX += colWidths[4];
      doc.text(atomic[0]?.label.split(' ')[1] || '', curX, doc.y);
      
      doc.moveDown(1.2);
    });

    doc.end();
  } catch (e) { next(e); }
});

app.get('/api/ai/conversations', async (req, res, next) => {
  try {
    const user = currentUser(req);
    const result = await db.query<any>(`SELECT "id", "title", "createdAt" FROM "Conversation" WHERE "userId" = $1 ORDER BY "createdAt" DESC`, [user.id]);
    res.json(result.rows);
  } catch (e) { next(e); }
});

app.get('/api/ai/conversations/:id/messages', async (req, res, next) => {
  try {
    const user = currentUser(req);
    const convCheck = await db.query(`SELECT 1 FROM "Conversation" WHERE "id" = $1 AND "userId" = $2`, [req.params.id, user.id]);
    if (convCheck.rows.length === 0) return res.status(403).json({error:{code:'FORBIDDEN',message:'Unauthorized access to conversation'}});
    
    const result = await db.query<any>(`SELECT "id", "role", "content", "createdAt" FROM "ConversationMessage" WHERE "conversationId" = $1 ORDER BY "createdAt" ASC`, [req.params.id]);
    res.json(result.rows);
  } catch (e) { next(e); }
});

app.get('/api/time-profiles', async (req, res, next) => {
  try {
    const profilesRes = await db.query<any>(`SELECT "id", "name", "academicYearId", "active" FROM "ScheduleProfile"`);
    const profiles = [];
    for (const p of profilesRes.rows) {
      const daysRes = await db.query<any>(`SELECT "id", "name", "ordinal", "enabled" FROM "WorkingDay" WHERE "profileId" = $1 ORDER BY "ordinal"`, [p.id]);
      const days = [];
      for (const d of daysRes.rows) {
        const slotsRes = await db.query<any>(`SELECT "id", "index", "label", "startsAt" "start", "endsAt" "end", "isBreak" FROM "TimeSlot" WHERE "workingDayId" = $1 ORDER BY "index"`, [d.id]);
        days.push({ ...d, slots: slotsRes.rows.map((s: any) => ({ ...s, isBreak: Boolean(s.isBreak) })) });
      }
      profiles.push({ ...p, workingDays: days, active: Boolean(p.active) });
    }
    res.json(profiles);
  } catch (e) { next(e); }
});

app.post('/api/time-profiles', authorize('ADMIN'), async (req, res, next) => {
  try {
    const { name, academicYearId, workingDays } = req.body;
    const profileId = randomUUID();
    await withTransaction(async () => {
      await db.query(`INSERT INTO "ScheduleProfile"("id", "name", "academicYearId", "active") VALUES ($1, $2, $3, false)`, [profileId, name, academicYearId]);
      for (const [dIdx, d] of workingDays.entries()) {
        const dayId = `${profileId}-${d.name.toLowerCase().substring(0, 3)}`;
        await db.query(`INSERT INTO "WorkingDay"("id", "profileId", "name", "ordinal", "enabled") VALUES ($1, $2, $3, $4, $5)`, [dayId, profileId, d.name, dIdx, d.enabled ?? true]);
        for (const [sIdx, s] of d.slots.entries()) {
          const slotId = `${dayId}-${sIdx + 1}`;
          await db.query(`INSERT INTO "TimeSlot"("id", "workingDayId", "index", "label", "startsAt", "endsAt", "isBreak") VALUES ($1, $2, $3, $4, $5, $6, $7)`, [slotId, dayId, sIdx, s.label, s.startsAt, s.endsAt, s.isBreak ?? false]);
        }
      }
    });
    res.status(201).json({ id: profileId, name, academicYearId });
  } catch (e) { next(e); }
});

app.post('/api/time-profiles/:id/activate', authorize('ADMIN'), async (req, res, next) => {
  try {
    const profileId = req.params.id;
    await withTransaction(async () => {
      await db.query(`UPDATE "ScheduleProfile" SET "active"=false`);
      await db.query(`UPDATE "ScheduleProfile" SET "active"=true WHERE "id"=$1`, [profileId]);
    });
    const { hydrate } = await import('./db.js');
    await hydrate();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/timetables/versions/:id/regenerate', authorize('ADMIN'), async (req, res, next) => {
  try {
    const parentId = req.params.id;
    const parentVersion = versions.find(v => v.id === parentId);
    if (!parentVersion) return res.status(404).json({error:{code:'NOT_FOUND',message:'Parent version not found'}});

    const { lockedSessionIds } = req.body;
    const lockedIds = new Set<string>(lockedSessionIds || []);

    const input = solverInput();
    const modifiedSessions = input.sessions.map(s => {
      if (lockedIds.has(s.id)) {
        const parentAssignment = parentVersion.assignments.find(a => a.sessionId === s.id);
        if (parentAssignment) {
          return {
            ...s,
            requiredResourceId: parentAssignment.resourceId,
            requiredSlotIds: parentAssignment.slotIds
          };
        }
      }
      return s;
    });

    const modifiedInput = { ...input, sessions: modifiedSessions };

    const run = { id: randomUUID(), status: 'SOLVING', startedAt: new Date().toISOString() } as any;
    run.scope = modifiedInput;

    const preflight = analyzeCandidates(modifiedInput);
    if (!preflight.valid) {
      run.status = 'INFEASIBLE';
      run.completedAt = new Date().toISOString();
      run.result = {
        status: 'INFEASIBLE',
        assignments: [],
        diagnostics: preflight.issues.map(issue => ({
          code: issue.code,
          message: `Locked constraints caused preflight infeasibility: ${issue.message}`,
          sessionIds: issue.sessionId ? [issue.sessionId] : [],
          evidence: issue.evidence
        })),
        metrics: preflight.summary
      };
      await persistGeneration(run);
      runs.push(run);
      return res.status(422).json({ error: { code: 'REGEN_INFEASIBLE', message: 'Locked sessions made the timetable configuration infeasible.', preflight, run } });
    }

    const result = await runScheduler(modifiedInput);
    run.status = result.status;
    run.completedAt = new Date().toISOString();
    run.result = result;

    if (['OPTIMAL', 'FEASIBLE'].includes(result.status)) {
      const report = validateTimetable(modifiedInput, result.assignments);
      const version = {
        id: randomUUID(),
        version: 0,
        status: (report.valid ? 'VALIDATED' : 'GENERATED') as any,
        assignments: result.assignments,
        validation: report,
        createdAt: new Date().toISOString(),
        parentVersionId: parentId
      };
      await persistGeneration(run, version);
      await db.query(`UPDATE "TimetableVersion" SET "parentVersionId"=$1 WHERE "id"=$2`, [parentId, version.id]);
      
      versions.push(version);
      runs.push(run);
      return res.status(201).json({ run, version, preflight });
    }

    await persistGeneration(run);
    runs.push(run);
    res.status(422).json({ error: { code: 'REGEN_FAILED', message: 'Could not find a feasible schedule with those locked entries.', run } });

  } catch (e) { next(e); }
});

app.put('/api/policies/:id', authorize('ADMIN'), async (req, res, next) => {
  try {
    const policyId = req.params.id;
    const existing = policies.find(p => p.id === policyId);
    if (!existing) return res.status(404).json({error:{code:'NOT_FOUND',message:'Policy not found'}});
    
    const parsed = PolicySchema.safeParse({ ...req.body, id: policyId });
    if (!parsed.success) {
      return res.status(422).json({error:{code:'VALIDATION_ERROR',message:'Invalid policy fields',details:parsed.error.flatten()}});
    }
    
    const updated = parsed.data;
    await persistPolicy(updated);
    
    const idx = policies.findIndex(p => p.id === policyId);
    policies[idx] = updated;
    
    await audit(currentUser(req).id, 'UPDATE_POLICY', 'SchedulingPolicy', policyId, updated);
    res.json(updated);
  } catch (e) { next(e); }
});

app.get('/api/audit-events', authorize('ADMIN'), async (req, res, next) => {
  try {
    const { action, entityType, actorId } = req.query;
    let query = `
      SELECT ae."id", ae."actorId", u."name" "actorName", ae."action", ae."entityType", ae."entityId", ae."after", ae."createdAt"
      FROM "AuditEvent" ae
      LEFT JOIN "User" u ON u."id" = ae."actorId"
      WHERE 1=1
    `;
    const params = [];
    let pIdx = 1;
    if (action) {
      query += ` AND ae."action" = $${pIdx++}`;
      params.push(action);
    }
    if (entityType) {
      query += ` AND ae."entityType" = $${pIdx++}`;
      params.push(entityType);
    }
    if (actorId) {
      query += ` AND ae."actorId" = $${pIdx++}`;
      params.push(actorId);
    }
    query += ` ORDER BY ae."createdAt" DESC LIMIT 100`;
    
    const result = await db.query<any>(query, params);
    res.json(result.rows.map(row => ({
      ...row,
      after: typeof row.after === 'string' ? JSON.parse(row.after) : row.after
    })));
  } catch (e) { next(e); }
});

app.get('/api/ai-actions', authorize('ADMIN'), async (req, res, next) => {
  try {
    const { tool, status } = req.query;
    let query = `
      SELECT aa."id", aa."tool", aa."arguments", aa."result", aa."status", aa."createdAt", c."userId", u."name" "userName"
      FROM "AIAction" aa
      JOIN "Conversation" c ON c."id" = aa."conversationId"
      LEFT JOIN "User" u ON u."id" = c."userId"
      WHERE 1=1
    `;
    const params = [];
    let pIdx = 1;
    if (tool) {
      query += ` AND aa."tool" = $${pIdx++}`;
      params.push(tool);
    }
    if (status) {
      query += ` AND aa."status" = $${pIdx++}`;
      params.push(status);
    }
    query += ` ORDER BY aa."createdAt" DESC LIMIT 100`;
    
    const result = await db.query<any>(query, params);
    res.json(result.rows.map(row => ({
      ...row,
      arguments: typeof row.arguments === 'string' ? JSON.parse(row.arguments) : row.arguments,
      result: typeof row.result === 'string' ? JSON.parse(row.result) : row.result
    })));
  } catch (e) { next(e); }
});

app.use((_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'Route not found'}}));
app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{console.error(error);res.status(500).json({error:{code:'INTERNAL_ERROR',message:error instanceof Error?error.message:'Unexpected server error'}});});
