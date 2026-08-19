import {z} from 'zod';
const id=z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/).optional();const text=z.string().trim().min(1).max(160);
export const createSchemas:Record<string,z.ZodTypeAny>={
 departments:z.object({id,code:text.max(16),name:text,active:z.boolean().default(true)}),
 programs:z.object({id,code:text.max(24),name:text,departmentId:text,academicYearId:text.default('ay-26')}),
 levels:z.object({id,name:text,ordinal:z.coerce.number().int().min(1).max(10),programId:text}),
 divisions:z.object({id,name:text.max(40),enrollmentCount:z.coerce.number().int().min(1).max(1000),programLevelId:text}),
 batches:z.object({id,name:text.max(40),enrollmentCount:z.coerce.number().int().min(1).max(1000),divisionId:text}),
 faculty:z.object({id,employeeCode:text.max(30),name:text,email:z.string().email(),departmentId:text,maxPeriodsPerWeek:z.coerce.number().int().min(1).max(100).optional(),maxConsecutive:z.coerce.number().int().min(1).max(12).optional(),unavailableSlotIds:z.array(text).default([]),preferredSlotIds:z.array(text).default([]),eligibleSubjectIds:z.array(text).default([]),active:z.boolean().default(true)}),
 enrollments:z.object({id,rollNumber:text.max(40),studentName:text,divisionId:text,batchId:text.optional(),validFrom:z.string().default('2026-07-01')}),
 subjects:z.object({id,code:text.max(30),name:text,departmentId:text,programId:text.optional(),academicLevelId:text.optional(),semester:z.coerce.number().int().min(1).max(12).optional(),active:z.boolean().default(true)}),
 resources:z.object({id,code:text.max(30),name:text,type:z.enum(['CLASSROOM','LAB','WORKSHOP','SEMINAR_HALL','AUDITORIUM']),capacity:z.coerce.number().int().min(1).max(10000),departmentId:text.optional(),capabilities:z.array(text).default([]),unavailableSlotIds:z.array(text).default([]),active:z.boolean().default(true)}),
 requirements:z.object({id,subjectId:text,facultyId:text,divisionIds:z.array(text).default([]),batchIds:z.array(text).default([]),sessionType:z.enum(['LECTURE','PRACTICAL','TUTORIAL','WORKSHOP','SEMINAR']),duration:z.coerce.number().int().min(1).max(6),weeklyFrequency:z.coerce.number().int().min(1).max(20),resourceType:z.enum(['CLASSROOM','LAB','WORKSHOP','SEMINAR_HALL','AUDITORIUM']),minCapacity:z.coerce.number().int().positive().optional(),requiredCapabilities:z.array(text).default([]),preferredCapabilities:z.array(text).default([])}).refine(x=>x.divisionIds.length+x.batchIds.length>0,'At least one division or batch is required')
};
