import {z} from 'zod';
import {contiguousBlocks as contiguousBlocksHelper, lowerSet, requiredCapacity} from './helpers.js';

export {requiredCapacity, lowerSet} from './helpers.js';
export {analyzeCandidates, enumerateCandidates, eligibleResourcesForSession} from './candidates.js';
export type {PreflightIssue, CandidateAnalysis, SessionCandidateReport, CandidateOption} from './candidates.js';

export const Id = z.string().min(1);
export const SessionType = z.enum(['LECTURE', 'PRACTICAL', 'TUTORIAL', 'WORKSHOP', 'SEMINAR']);
export const ResourceType = z.enum(['CLASSROOM', 'LAB', 'WORKSHOP', 'SEMINAR_HALL', 'AUDITORIUM']);
export const PolicyStrength = z.enum(['HARD', 'SOFT']);
export const TimetableStatus = z.enum(['DRAFT', 'GENERATED', 'VALIDATED', 'REVIEWED', 'APPROVED', 'PUBLISHED']);

export const SlotSchema = z.object({
  id: Id,
  dayId: Id,
  index: z.number().int().nonnegative(),
  label: z.string(),
  start: z.string(),
  end: z.string(),
  isBreak: z.boolean().default(false)
});

export const ResourceSchema = z.object({
  id: Id,
  name: z.string().min(1),
  type: ResourceType,
  capacity: z.number().int().positive(),
  departmentId: Id.optional(),
  buildingId: Id.optional(),
  active: z.boolean(),
  capabilities: z.array(z.string()),
  unavailableSlotIds: z.array(Id).default([])
});

export const FacultySchema = z.object({
  id: Id,
  name: z.string(),
  departmentId: Id,
  maxPeriodsPerWeek: z.number().int().positive().optional(),
  maxConsecutive: z.number().int().positive().optional(),
  unavailableSlotIds: z.array(Id).default([]),
  preferredSlotIds: z.array(Id).default([]),
  eligibleSubjectIds: z.array(Id).optional()
});

export const SessionSchema = z.object({
  id: Id,
  requirementId: Id,
  subjectCode: z.string(),
  title: z.string(),
  facultyId: Id,
  cohortAtomIds: z.array(Id).min(1),
  participantCount: z.number().int().positive(),
  duration: z.number().int().positive(),
  sessionType: SessionType,
  resourceType: ResourceType,
  requiredCapabilities: z.array(z.string()).default([]),
  preferredCapabilities: z.array(z.string()).default([]),
  preferredDepartmentId: Id.optional(),
  subjectId: Id.optional(),
  requiredResourceId: Id.optional(),
  minCapacity: z.number().int().positive().optional()
});

export const PolicySchema = z.object({
  id: Id,
  name: z.string(),
  description: z.string().default(''),
  type: z.enum(['RESOURCE_PREFERENCE', 'TIME_RESTRICTION', 'RESOURCE_PROHIBITION', 'MAX_DAILY_PERIODS', 'CUSTOM']),
  strength: PolicyStrength,
  weight: z.number().int().nonnegative().default(10),
  scope: z.record(z.unknown()).default({}),
  parameters: z.record(z.unknown()).default({}),
  active: z.boolean().default(true),
  version: z.number().int().positive().default(1)
});

export const SolverInputSchema = z.object({
  slots: z.array(SlotSchema),
  resources: z.array(ResourceSchema),
  faculty: z.array(FacultySchema),
  sessions: z.array(SessionSchema),
  policies: z.array(PolicySchema).default([]),
  timeLimitSeconds: z.number().positive().default(20)
});

export const AssignmentSchema = z.object({
  sessionId: Id,
  resourceId: Id,
  slotIds: z.array(Id),
  score: z.number().default(0)
});

export type Slot = z.infer<typeof SlotSchema>;
export type Resource = z.infer<typeof ResourceSchema>;
export type Faculty = z.infer<typeof FacultySchema>;
export type Session = z.infer<typeof SessionSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type SolverInput = z.infer<typeof SolverInputSchema>;
export type Assignment = z.infer<typeof AssignmentSchema>;

export interface Conflict {
  code: string;
  message: string;
  sessionIds: string[];
  slotIds?: string[];
  resourceId?: string;
  facultyId?: string;
  evidence?: Record<string, unknown>;
}

export interface ValidationReport {
  valid: boolean;
  checkedAt: string;
  conflicts: Conflict[];
  metrics: {scheduledSessions: number; totalSessions: number; hardViolations: number; unscheduledSessions: number};
}

export interface SolverResult {
  status: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'INVALID_INPUT' | 'ERROR';
  assignments: Assignment[];
  diagnostics: Conflict[];
  metrics: Record<string, number | string>;
}

function policyApplies(session: Session, policy: Policy): boolean {
  const scope = policy.scope as Record<string, unknown>;
  if (scope.departmentId && scope.departmentId !== session.preferredDepartmentId) return false;
  if (scope.facultyId && scope.facultyId !== session.facultyId) return false;
  if (scope.sessionType && scope.sessionType !== session.sessionType) return false;
  return true;
}

export function resourceEligible(session: Session, resource: Resource): {ok: boolean; reasons: string[]} {
  const reasons: string[] = [];
  if (!resource.active) reasons.push('resource inactive');
  if (session.requiredResourceId && resource.id !== session.requiredResourceId) reasons.push(`requires specific resource ${session.requiredResourceId}`);
  if (resource.type !== session.resourceType) reasons.push(`requires ${session.resourceType}`);
  const needed = requiredCapacity(session);
  if (resource.capacity < needed) reasons.push(`capacity ${resource.capacity} < ${needed}`);
  const caps = lowerSet(resource.capabilities);
  for (const capability of session.requiredCapabilities) {
    if (!caps.has(capability.toLocaleLowerCase())) reasons.push(`missing capability ${capability}`);
  }
  return {ok: reasons.length === 0, reasons};
}

export function contiguousBlocks(slots: Slot[], duration: number): Slot[][] {
  return contiguousBlocksHelper(slots, duration);
}

export function validateTimetable(input: SolverInput, assignments: Assignment[]): ValidationReport {
  const conflicts: Conflict[] = [];
  const slotMap = new Map(input.slots.map(slot => [slot.id, slot]));
  const resMap = new Map(input.resources.map(resource => [resource.id, resource]));
  const facMap = new Map(input.faculty.map(faculty => [faculty.id, faculty]));
  const sessionMap = new Map(input.sessions.map(session => [session.id, session]));
  const seenSessions = new Set<string>();

  for (const assignment of assignments) {
    if (seenSessions.has(assignment.sessionId)) {
      conflicts.push({code: 'DUPLICATE_ASSIGNMENT', message: `Session ${assignment.sessionId} is assigned more than once`, sessionIds: [assignment.sessionId]});
    }
    seenSessions.add(assignment.sessionId);

    if (!sessionMap.has(assignment.sessionId)) {
      conflicts.push({code: 'UNKNOWN_ASSIGNMENT', message: `Assignment refers to unknown session ${assignment.sessionId}`, sessionIds: [assignment.sessionId], resourceId: assignment.resourceId});
      continue;
    }

    if (new Set(assignment.slotIds).size !== assignment.slotIds.length) {
      conflicts.push({code: 'REPEATED_SLOT', message: `Session ${assignment.sessionId} repeats a time slot`, sessionIds: [assignment.sessionId], slotIds: assignment.slotIds});
    }

    for (const slotId of assignment.slotIds) {
      const slot = slotMap.get(slotId);
      if (!slot) {
        conflicts.push({code: 'UNKNOWN_SLOT', message: `Unknown time slot ${slotId}`, sessionIds: [assignment.sessionId], slotIds: [slotId]});
        continue;
      }
      if (slot.isBreak) {
        conflicts.push({code: 'BREAK_SLOT', message: `Session uses break slot ${slot.label}`, sessionIds: [assignment.sessionId], slotIds: [slotId]});
      }
    }
  }

  for (const session of input.sessions) {
    const assignment = assignments.find(item => item.sessionId === session.id);
    if (!assignment) {
      conflicts.push({code: 'MISSING_SESSION', message: `${session.title} is not scheduled`, sessionIds: [session.id]});
      continue;
    }
    const resource = resMap.get(assignment.resourceId);
    if (!resource) {
      conflicts.push({code: 'UNKNOWN_RESOURCE', message: `Unknown resource ${assignment.resourceId}`, sessionIds: [session.id]});
      continue;
    }
    const faculty = facMap.get(session.facultyId);
    if (session.subjectId && faculty?.eligibleSubjectIds && !faculty.eligibleSubjectIds.includes(session.subjectId)) {
      conflicts.push({code: 'FACULTY_INELIGIBLE', message: `${faculty.name} is not eligible to teach ${session.subjectCode}`, sessionIds: [session.id], facultyId: faculty.id, evidence: {subjectId: session.subjectId}});
    }
    const eligible = resourceEligible(session, resource);
    for (const reason of eligible.reasons) {
      const code = reason.startsWith('requires specific') ? 'REQUIRED_RESOURCE'
        : reason.startsWith('capacity') ? 'CAPACITY_VIOLATION'
        : reason.startsWith('missing capability') ? 'CAPABILITY_VIOLATION'
        : 'RESOURCE_INELIGIBLE';
      conflicts.push({code, message: `${session.title}: ${reason}`, sessionIds: [session.id], resourceId: resource.id});
    }
    if (assignment.slotIds.length !== session.duration) {
      conflicts.push({code: 'INVALID_DURATION', message: `${session.title} requires ${session.duration} continuous periods`, sessionIds: [session.id], slotIds: assignment.slotIds});
    }
    const actual = assignment.slotIds.map(id => slotMap.get(id)).filter(Boolean) as Slot[];
    if (actual.length === session.duration && actual.some((slot, index) => index > 0 && (slot.dayId !== actual[0].dayId || slot.index !== actual[index - 1].index + 1))) {
      conflicts.push({code: 'NON_CONTIGUOUS', message: `${session.title} spans a break or non-contiguous period`, sessionIds: [session.id], slotIds: assignment.slotIds});
    }
    for (const slotId of assignment.slotIds) {
      if (faculty?.unavailableSlotIds.includes(slotId)) {
        conflicts.push({code: 'FACULTY_UNAVAILABLE', message: `${faculty.name} is unavailable`, sessionIds: [session.id], slotIds: [slotId], facultyId: faculty.id});
      }
      if (resource.unavailableSlotIds.includes(slotId)) {
        conflicts.push({code: 'RESOURCE_UNAVAILABLE', message: `${resource.name} is unavailable`, sessionIds: [session.id], slotIds: [slotId], resourceId: resource.id});
      }
    }
    for (const policy of input.policies.filter(item => item.active && item.strength === 'HARD')) {
      if (!policyApplies(session, policy)) continue;
      const params = policy.parameters as Record<string, unknown>;
      if (policy.type === 'RESOURCE_PROHIBITION' && Array.isArray(params.resourceIds) && params.resourceIds.includes(resource.id)) {
        conflicts.push({code: 'POLICY_VIOLATION', message: `${session.title} uses ${resource.name}, prohibited by policy ${policy.name}`, sessionIds: [session.id], resourceId: resource.id, evidence: {policyId: policy.id}});
      }
      if (policy.type === 'TIME_RESTRICTION' && Array.isArray(params.prohibitedSlotIds) && assignment.slotIds.some(id => (params.prohibitedSlotIds as unknown[]).includes(id))) {
        conflicts.push({code: 'POLICY_VIOLATION', message: `${session.title} occupies a period prohibited by policy ${policy.name}`, sessionIds: [session.id], slotIds: assignment.slotIds, evidence: {policyId: policy.id}});
      }
    }
  }

  for (let i = 0; i < assignments.length; i++) {
    for (let j = i + 1; j < assignments.length; j++) {
      const left = assignments[i];
      const right = assignments[j];
      const overlap = left.slotIds.filter(id => right.slotIds.includes(id));
      if (!overlap.length) continue;
      const first = sessionMap.get(left.sessionId);
      const second = sessionMap.get(right.sessionId);
      if (!first || !second) continue;
      if (left.resourceId === right.resourceId) {
        conflicts.push({code: 'RESOURCE_COLLISION', message: 'Resource is double-booked', sessionIds: [first.id, second.id], slotIds: overlap, resourceId: left.resourceId});
      }
      if (first.facultyId === second.facultyId) {
        conflicts.push({code: 'FACULTY_COLLISION', message: 'Faculty is double-booked', sessionIds: [first.id, second.id], slotIds: overlap, facultyId: first.facultyId});
      }
      if (first.cohortAtomIds.some(atom => second.cohortAtomIds.includes(atom))) {
        conflicts.push({code: 'COHORT_COLLISION', message: 'Participating student cohort is double-booked', sessionIds: [first.id, second.id], slotIds: overlap});
      }
    }
  }

  for (const faculty of input.faculty) {
    const own = assignments.filter(assignment => sessionMap.get(assignment.sessionId)?.facultyId === faculty.id);
    const periods = own.reduce((sum, assignment) => sum + assignment.slotIds.length, 0);
    if (faculty.maxPeriodsPerWeek && periods > faculty.maxPeriodsPerWeek) {
      conflicts.push({code: 'WORKLOAD_EXCEEDED', message: `${faculty.name}: ${periods} periods exceeds maximum ${faculty.maxPeriodsPerWeek}`, sessionIds: own.map(assignment => assignment.sessionId), facultyId: faculty.id});
    }
    if (faculty.maxConsecutive) {
      const byDay = new Map<string, number[]>();
      for (const assignment of own) {
        for (const slotId of assignment.slotIds) {
          const slot = slotMap.get(slotId);
          if (!slot || slot.isBreak) continue;
          byDay.set(slot.dayId, [...(byDay.get(slot.dayId) ?? []), slot.index]);
        }
      }
      for (const [dayId, indexes] of byDay) {
        const ordered = [...new Set(indexes)].sort((a, b) => a - b);
        let run = 1;
        for (let i = 1; i < ordered.length; i++) {
          run = ordered[i] === ordered[i - 1] + 1 ? run + 1 : 1;
          if (run > faculty.maxConsecutive) {
            conflicts.push({
              code: 'CONSECUTIVE_WORKLOAD',
              message: `${faculty.name} exceeds ${faculty.maxConsecutive} consecutive periods`,
              sessionIds: own.map(assignment => assignment.sessionId),
              facultyId: faculty.id,
              evidence: {dayId, run}
            });
            break;
          }
        }
      }
    }
  }

  for (const policy of input.policies.filter(item => item.active && item.strength === 'HARD' && item.type === 'MAX_DAILY_PERIODS')) {
    const maxPeriods = Number((policy.parameters as {maxPeriods?: number; maxDailyPeriods?: number}).maxPeriods
      ?? (policy.parameters as {maxDailyPeriods?: number}).maxDailyPeriods
      ?? 0);
    if (!maxPeriods) continue;
    const byKey = new Map<string, {facultyId: string; dayId: string; count: number; sessionIds: string[]}>();
    for (const assignment of assignments) {
      const session = sessionMap.get(assignment.sessionId);
      if (!session || !policyApplies(session, policy)) continue;
      for (const slotId of assignment.slotIds) {
        const slot = slotMap.get(slotId);
        if (!slot || slot.isBreak) continue;
        const key = `${session.facultyId}:${slot.dayId}`;
        const current = byKey.get(key) ?? {facultyId: session.facultyId, dayId: slot.dayId, count: 0, sessionIds: []};
        current.count += 1;
        if (!current.sessionIds.includes(session.id)) current.sessionIds.push(session.id);
        byKey.set(key, current);
      }
    }
    for (const item of byKey.values()) {
      if (item.count > maxPeriods) {
        conflicts.push({
          code: 'DAILY_POLICY_VIOLATION',
          message: `Hard daily-period policy ${policy.name} exceeded (${item.count} > ${maxPeriods})`,
          sessionIds: item.sessionIds,
          facultyId: item.facultyId,
          evidence: {policyId: policy.id, dayId: item.dayId, count: item.count, maxPeriods}
        });
      }
    }
  }

  const scheduled = assignments.filter(assignment => sessionMap.has(assignment.sessionId)).length;
  return {
    valid: conflicts.length === 0,
    checkedAt: new Date().toISOString(),
    conflicts,
    metrics: {
      scheduledSessions: scheduled,
      totalSessions: input.sessions.length,
      hardViolations: conflicts.length,
      unscheduledSessions: Math.max(0, input.sessions.length - scheduled)
    }
  };
}
