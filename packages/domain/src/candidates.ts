import type {Faculty, Policy, Resource, Session, Slot, SolverInput} from './index.js';
import {contiguousBlocks, requiredCapacity} from './helpers.js';

export interface PreflightIssue {
  code: string;
  message: string;
  sessionId?: string;
  requirementId?: string;
  evidence?: Record<string, unknown>;
}

export interface CandidateOption {
  resourceId: string;
  slotIds: string[];
  penalty: number;
}

export interface SessionCandidateReport {
  sessionId: string;
  requirementId: string;
  title: string;
  candidateCount: number;
  reasons: Record<string, number>;
  options: CandidateOption[];
}

export interface CandidateAnalysis {
  valid: boolean;
  issues: PreflightIssue[];
  sessions: SessionCandidateReport[];
  summary: {
    sessions: number;
    resources: number;
    slots: number;
    faculty: number;
    candidates: number;
    blockers: number;
    sessionsWithoutCandidates: number;
  };
}

function lowerSet(values: string[]): Set<string> {
  return new Set(values.map(value => value.toLocaleLowerCase()));
}

function policyApplies(session: Session, policy: Policy): boolean {
  const scope = policy.scope as Record<string, unknown>;
  if (scope.departmentId && scope.departmentId !== session.preferredDepartmentId) return false;
  if (scope.facultyId && scope.facultyId !== session.facultyId) return false;
  if (scope.sessionType && scope.sessionType !== session.sessionType) return false;
  return true;
}

function facultyEligible(faculty: Faculty | undefined, session: Session): {ok: boolean; reason?: string} {
  if (!faculty) return {ok: false, reason: 'no eligible faculty'};
  if (session.subjectId && faculty.eligibleSubjectIds && !faculty.eligibleSubjectIds.includes(session.subjectId)) {
    return {ok: false, reason: 'faculty ineligible'};
  }
  return {ok: true};
}

function resourceRejection(session: Session, resource: Resource, policies: Policy[]): string[] {
  const reasons: string[] = [];
  if (!resource.active) reasons.push('inactive');
  if (session.requiredResourceId && resource.id !== session.requiredResourceId) reasons.push('not the required resource');
  if (resource.type !== session.resourceType) reasons.push('wrong resource type');
  const needed = requiredCapacity(session);
  if (resource.capacity < needed) reasons.push('insufficient capacity');
  const have = lowerSet(resource.capabilities);
  for (const capability of session.requiredCapabilities) {
    if (!have.has(capability.toLocaleLowerCase())) reasons.push('missing required capability');
  }
  for (const policy of policies) {
    if (policy.strength !== 'HARD' || policy.type !== 'RESOURCE_PROHIBITION' || !policyApplies(session, policy)) continue;
    const ids = (policy.parameters as {resourceIds?: string[]}).resourceIds ?? [];
    if (ids.includes(resource.id)) reasons.push('prohibited by policy');
  }
  return reasons;
}

export function enumerateCandidates(input: SolverInput): SessionCandidateReport[] {
  const policies = input.policies.filter(policy => policy.active);
  const facultyById = new Map(input.faculty.map(faculty => [faculty.id, faculty]));
  const reports: SessionCandidateReport[] = [];

  for (const session of input.sessions) {
    const reasons: Record<string, number> = {};
    const bump = (reason: string) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
    const faculty = facultyById.get(session.facultyId);
    const eligibility = facultyEligible(faculty, session);
    const options: CandidateOption[] = [];
    const blocks = contiguousBlocks(input.slots, session.duration);

    if (!eligibility.ok) {
      bump(eligibility.reason ?? 'no eligible faculty');
    } else if (!blocks.length) {
      bump('no candidate time block');
    } else {
      let typedResources = 0;
      for (const resource of input.resources) {
        const rejected = resourceRejection(session, resource, policies);
        if (resource.type === session.resourceType) typedResources += 1;
        if (rejected.length) {
          for (const reason of rejected) bump(reason);
          continue;
        }
        for (const block of blocks) {
          const ids = block.map(slot => slot.id);
          if (ids.some(id => faculty?.unavailableSlotIds.includes(id))) {
            bump('faculty unavailable');
            continue;
          }
          if (ids.some(id => resource.unavailableSlotIds.includes(id))) {
            bump('resource unavailable');
            continue;
          }
          let prohibited = false;
          for (const policy of policies) {
            if (policy.strength !== 'HARD' || policy.type !== 'TIME_RESTRICTION' || !policyApplies(session, policy)) continue;
            const banned = (policy.parameters as {prohibitedSlotIds?: string[]}).prohibitedSlotIds ?? [];
            if (ids.some(id => banned.includes(id))) prohibited = true;
          }
          if (prohibited) {
            bump('prohibited by time policy');
            continue;
          }
          let penalty = 0;
          if (resource.departmentId !== session.preferredDepartmentId) penalty += 8;
          const preferred = lowerSet(session.preferredCapabilities);
          penalty += [...preferred].filter(cap => !lowerSet(resource.capabilities).has(cap)).length * 2;
          if (faculty?.preferredSlotIds.length) penalty += ids.filter(id => !faculty.preferredSlotIds.includes(id)).length * 2;
          for (const policy of policies) {
            if (policy.strength !== 'SOFT' || policy.type !== 'RESOURCE_PREFERENCE' || !policyApplies(session, policy)) continue;
            const preferredIds = (policy.parameters as {preferredResourceIds?: string[]}).preferredResourceIds ?? [];
            if (!preferredIds.includes(resource.id)) penalty += policy.weight;
          }
          options.push({resourceId: resource.id, slotIds: ids, penalty});
        }
      }
      if (!typedResources) bump('no candidate resource');
    }

    reports.push({
      sessionId: session.id,
      requirementId: session.requirementId,
      title: session.title,
      candidateCount: options.length,
      reasons,
      options
    });
  }
  return reports;
}

function primaryIssue(session: Session, report: SessionCandidateReport): PreflightIssue {
  const reasons = report.reasons;
  const pick = (code: string, key: string, message: string): PreflightIssue => ({
    code,
    message,
    sessionId: session.id,
    requirementId: session.requirementId,
    evidence: reasons
  });
  if (reasons['no eligible faculty']) return pick('NO_ELIGIBLE_FACULTY', 'no eligible faculty', `${session.title} has no assigned eligible faculty`);
  if (reasons['faculty ineligible']) return pick('NO_ELIGIBLE_FACULTY', 'faculty ineligible', `${session.title} is assigned to a faculty member who is not eligible for the subject`);
  if (reasons['no candidate time block']) return pick('NO_CANDIDATE_TIME_BLOCK', 'no candidate time block', `${session.title} has no contiguous ${session.duration}-period block`);
  if (reasons['no candidate resource'] && !reasons['insufficient capacity'] && !reasons['missing required capability']) {
    return pick('NO_CANDIDATE_RESOURCE', 'no candidate resource', `${session.title} has no resource of type ${session.resourceType}`);
  }
  if (reasons['insufficient capacity'] && !report.candidateCount) return pick('INSUFFICIENT_CAPACITY', 'insufficient capacity', `${session.title} needs capacity ${requiredCapacity(session)} and no eligible room meets it`);
  if (reasons['missing required capability'] && !report.candidateCount) return pick('MISSING_REQUIRED_CAPABILITY', 'missing required capability', `${session.title} requires capabilities that no eligible resource provides`);
  if (reasons['faculty unavailable'] && !report.candidateCount) return pick('FACULTY_UNAVAILABLE', 'faculty unavailable', `${session.title} has no remaining block where the faculty member is available`);
  if (reasons['resource unavailable'] && !report.candidateCount) return pick('RESOURCE_UNAVAILABLE', 'resource unavailable', `${session.title} has no remaining block where an eligible resource is available`);
  if (reasons['not the required resource'] && !report.candidateCount) return pick('NO_CANDIDATE_RESOURCE', 'not the required resource', `${session.title} must use a specific resource that is not eligible`);
  return pick('NO_CANDIDATES', 'none', `${session.title} has no eligible time/resource assignment`);
}

export function analyzeCandidates(input: SolverInput): CandidateAnalysis {
  const issues: PreflightIssue[] = [];
  if (!input.slots.filter(slot => !slot.isBreak).length) {
    issues.push({code: 'NO_TIME_PROFILE', message: 'No enabled teaching time slots exist'});
  }
  if (!input.resources.length) {
    issues.push({code: 'NO_RESOURCES', message: 'No active resources exist'});
  }
  if (!input.sessions.length) {
    issues.push({code: 'NO_SESSIONS', message: 'No teaching requirements expand into sessions'});
  }

  const sessions = enumerateCandidates(input);
  for (const session of input.sessions) {
    const report = sessions.find(item => item.sessionId === session.id);
    if (report && report.candidateCount === 0) issues.push(primaryIssue(session, report));
  }

  const candidates = sessions.reduce((sum, session) => sum + session.candidateCount, 0);
  const blockers = issues.length;
  return {
    valid: blockers === 0,
    issues,
    sessions,
    summary: {
      sessions: input.sessions.length,
      resources: input.resources.length,
      slots: input.slots.length,
      faculty: input.faculty.length,
      candidates,
      blockers,
      sessionsWithoutCandidates: sessions.filter(session => session.candidateCount === 0).length
    }
  };
}

export function eligibleResourcesForSession(input: SolverInput, sessionId: string): Resource[] {
  const session = input.sessions.find(item => item.id === sessionId);
  if (!session) return [];
  const policies = input.policies.filter(policy => policy.active);
  return input.resources.filter(resource => resourceRejection(session, resource, policies).length === 0);
}

export function slotsOnDay(slots: Slot[], dayId: string): Slot[] {
  return slots.filter(slot => slot.dayId === dayId && !slot.isBreak).sort((a, b) => a.index - b.index);
}
