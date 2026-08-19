import { z } from 'zod';

export const Id = z.string().min(1);
export const SessionType = z.enum(['LECTURE','PRACTICAL','TUTORIAL','WORKSHOP','SEMINAR']);
export const ResourceType = z.enum(['CLASSROOM','LAB','WORKSHOP','SEMINAR_HALL','AUDITORIUM']);
export const PolicyStrength = z.enum(['HARD','SOFT']);
export const TimetableStatus = z.enum(['DRAFT','GENERATED','VALIDATED','REVIEWED','APPROVED','PUBLISHED']);

export const SlotSchema = z.object({id:Id,dayId:Id,index:z.number().int().nonnegative(),label:z.string(),start:z.string(),end:z.string(),isBreak:z.boolean().default(false)});
export const ResourceSchema = z.object({id:Id,name:z.string().min(1),type:ResourceType,capacity:z.number().int().positive(),departmentId:Id.optional(),buildingId:Id.optional(),active:z.boolean(),capabilities:z.array(z.string()),unavailableSlotIds:z.array(Id).default([])});
export const FacultySchema = z.object({id:Id,name:z.string(),departmentId:Id,maxPeriodsPerWeek:z.number().int().positive().optional(),maxConsecutive:z.number().int().positive().optional(),unavailableSlotIds:z.array(Id).default([]),preferredSlotIds:z.array(Id).default([])});
export const SessionSchema = z.object({id:Id,requirementId:Id,subjectCode:z.string(),title:z.string(),facultyId:Id,cohortAtomIds:z.array(Id).min(1),participantCount:z.number().int().positive(),duration:z.number().int().positive(),sessionType:SessionType,resourceType:ResourceType,requiredCapabilities:z.array(z.string()).default([]),preferredCapabilities:z.array(z.string()).default([]),preferredDepartmentId:Id.optional()});
export const PolicySchema = z.object({id:Id,name:z.string(),description:z.string().default(''),type:z.enum(['RESOURCE_PREFERENCE','TIME_RESTRICTION','RESOURCE_PROHIBITION','MAX_DAILY_PERIODS','CUSTOM']),strength:PolicyStrength,weight:z.number().int().nonnegative().default(10),scope:z.record(z.unknown()).default({}),parameters:z.record(z.unknown()).default({}),active:z.boolean().default(true),version:z.number().int().positive().default(1)});
export const SolverInputSchema = z.object({slots:z.array(SlotSchema),resources:z.array(ResourceSchema),faculty:z.array(FacultySchema),sessions:z.array(SessionSchema),policies:z.array(PolicySchema).default([]),timeLimitSeconds:z.number().positive().default(20)});
export const AssignmentSchema = z.object({sessionId:Id,resourceId:Id,slotIds:z.array(Id),score:z.number().default(0)});
export type Slot=z.infer<typeof SlotSchema>; export type Resource=z.infer<typeof ResourceSchema>; export type Faculty=z.infer<typeof FacultySchema>; export type Session=z.infer<typeof SessionSchema>; export type Policy=z.infer<typeof PolicySchema>; export type SolverInput=z.infer<typeof SolverInputSchema>; export type Assignment=z.infer<typeof AssignmentSchema>;

export interface Conflict { code:string; message:string; sessionIds:string[]; slotIds?:string[]; resourceId?:string; facultyId?:string; evidence?:Record<string,unknown>; }
export interface ValidationReport { valid:boolean; checkedAt:string; conflicts:Conflict[]; metrics:{scheduledSessions:number; totalSessions:number; hardViolations:number}; }
export interface SolverResult { status:'OPTIMAL'|'FEASIBLE'|'INFEASIBLE'|'INVALID_INPUT'|'ERROR'; assignments:Assignment[]; diagnostics:Conflict[]; metrics:Record<string,number|string>; }

const lower=(xs:string[])=>new Set(xs.map(x=>x.toLocaleLowerCase()));
export function resourceEligible(session:Session, resource:Resource): {ok:boolean; reasons:string[]} {
  const reasons:string[]=[];
  if(!resource.active) reasons.push('resource inactive');
  if(resource.type!==session.resourceType) reasons.push(`requires ${session.resourceType}`);
  if(resource.capacity<session.participantCount) reasons.push(`capacity ${resource.capacity} < ${session.participantCount}`);
  const caps=lower(resource.capabilities); for(const c of session.requiredCapabilities) if(!caps.has(c.toLocaleLowerCase())) reasons.push(`missing capability ${c}`);
  return {ok:reasons.length===0,reasons};
}
export function contiguousBlocks(slots:Slot[], duration:number): Slot[][] {
  const result:Slot[][]=[]; const days=new Map<string,Slot[]>(); for(const s of slots.filter(s=>!s.isBreak)) days.set(s.dayId,[...(days.get(s.dayId)??[]),s]);
  for(const daySlots of days.values()) { const ordered=[...daySlots].sort((a,b)=>a.index-b.index); for(let i=0;i<=ordered.length-duration;i++){ const block=ordered.slice(i,i+duration); if(block.every((s,j)=>j===0||s.index===block[j-1].index+1)) result.push(block); } }
  return result;
}
export function validateTimetable(input:SolverInput, assignments:Assignment[]): ValidationReport {
  const conflicts:Conflict[]=[]; const bySession=new Map(assignments.map(a=>[a.sessionId,a])); const slotMap=new Map(input.slots.map(s=>[s.id,s])); const resMap=new Map(input.resources.map(r=>[r.id,r])); const facMap=new Map(input.faculty.map(f=>[f.id,f]));
  for(const s of input.sessions){ const a=bySession.get(s.id); if(!a){conflicts.push({code:'MISSING_SESSION',message:`${s.title} is not scheduled`,sessionIds:[s.id]});continue;} const r=resMap.get(a.resourceId); if(!r){conflicts.push({code:'UNKNOWN_RESOURCE',message:`Unknown resource ${a.resourceId}`,sessionIds:[s.id]});continue;} const eligible=resourceEligible(s,r); for(const reason of eligible.reasons) conflicts.push({code:'RESOURCE_INELIGIBLE',message:`${s.title}: ${reason}`,sessionIds:[s.id],resourceId:r.id}); if(a.slotIds.length!==s.duration) conflicts.push({code:'INVALID_DURATION',message:`${s.title} requires ${s.duration} continuous periods`,sessionIds:[s.id],slotIds:a.slotIds}); const actual=a.slotIds.map(x=>slotMap.get(x)).filter(Boolean) as Slot[]; if(actual.length===s.duration && actual.some((x,i)=>i>0&&(x.dayId!==actual[0].dayId||x.index!==actual[i-1].index+1))) conflicts.push({code:'NON_CONTIGUOUS',message:`${s.title} spans a break or non-contiguous period`,sessionIds:[s.id],slotIds:a.slotIds}); const f=facMap.get(s.facultyId); for(const id of a.slotIds){if(f?.unavailableSlotIds.includes(id)) conflicts.push({code:'FACULTY_UNAVAILABLE',message:`${f.name} is unavailable`,sessionIds:[s.id],slotIds:[id],facultyId:f.id});if(r.unavailableSlotIds.includes(id)) conflicts.push({code:'RESOURCE_UNAVAILABLE',message:`${r.name} is unavailable`,sessionIds:[s.id],slotIds:[id],resourceId:r.id});}}
  for(let i=0;i<assignments.length;i++) for(let j=i+1;j<assignments.length;j++){const a=assignments[i],b=assignments[j],overlap=a.slotIds.filter(x=>b.slotIds.includes(x));if(!overlap.length)continue;const sa=input.sessions.find(s=>s.id===a.sessionId),sb=input.sessions.find(s=>s.id===b.sessionId);if(!sa||!sb)continue;if(a.resourceId===b.resourceId) conflicts.push({code:'RESOURCE_COLLISION',message:'Resource is double-booked',sessionIds:[sa.id,sb.id],slotIds:overlap,resourceId:a.resourceId});if(sa.facultyId===sb.facultyId) conflicts.push({code:'FACULTY_COLLISION',message:'Faculty is double-booked',sessionIds:[sa.id,sb.id],slotIds:overlap,facultyId:sa.facultyId});if(sa.cohortAtomIds.some(x=>sb.cohortAtomIds.includes(x))) conflicts.push({code:'COHORT_COLLISION',message:'Participating student cohort is double-booked',sessionIds:[sa.id,sb.id],slotIds:overlap});}
  for(const f of input.faculty){const periods=assignments.filter(a=>input.sessions.find(s=>s.id===a.sessionId)?.facultyId===f.id).reduce((n,a)=>n+a.slotIds.length,0);if(f.maxPeriodsPerWeek&&periods>f.maxPeriodsPerWeek) conflicts.push({code:'WORKLOAD_EXCEEDED',message:`${f.name}: ${periods} periods exceeds maximum ${f.maxPeriodsPerWeek}`,sessionIds:assignments.filter(a=>input.sessions.find(s=>s.id===a.sessionId)?.facultyId===f.id).map(a=>a.sessionId),facultyId:f.id});}
  return {valid:conflicts.length===0,checkedAt:new Date().toISOString(),conflicts,metrics:{scheduledSessions:assignments.length,totalSessions:input.sessions.length,hardViolations:conflicts.length}};
}
