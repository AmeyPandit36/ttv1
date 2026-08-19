import {describe, expect, it} from 'vitest';
import {analyzeCandidates, contiguousBlocks, resourceEligible, validateTimetable, type SolverInput} from './index.js';

const base: SolverInput = {
  slots: [
    {id: 'm1', dayId: 'm', index: 0, label: 'P1', start: '09', end: '10', isBreak: false},
    {id: 'm2', dayId: 'm', index: 1, label: 'P2', start: '10', end: '11', isBreak: false},
    {id: 'm3', dayId: 'm', index: 3, label: 'P3', start: '12', end: '13', isBreak: false},
    {id: 'brk', dayId: 'm', index: 2, label: 'Break', start: '11', end: '12', isBreak: true}
  ],
  resources: [{id: 'lab', name: 'Lab', type: 'LAB', capacity: 30, active: true, capabilities: ['Computers', 'SQL'], unavailableSlotIds: []}],
  faculty: [{id: 'f', name: 'Faculty', departmentId: 'd', maxPeriodsPerWeek: 4, maxConsecutive: 2, unavailableSlotIds: [], preferredSlotIds: [], eligibleSubjectIds: ['sub-db']}],
  sessions: [{id: 's1', requirementId: 'r', subjectCode: 'DB', title: 'DB practical', facultyId: 'f', cohortAtomIds: ['a1'], participantCount: 30, duration: 2, sessionType: 'PRACTICAL', resourceType: 'LAB', requiredCapabilities: ['sql'], preferredCapabilities: [], subjectId: 'sub-db'}],
  policies: [],
  timeLimitSeconds: 2
};

const ok = [{sessionId: 's1', resourceId: 'lab', slotIds: ['m1', 'm2'], score: 0}];

describe('hard domain rules', () => {
  it('matches capabilities case-insensitively and rejects capacity/type', () => {
    expect(resourceEligible(base.sessions[0], base.resources[0]).ok).toBe(true);
    expect(resourceEligible({...base.sessions[0], participantCount: 31}, base.resources[0]).reasons).toContain('capacity 30 < 31');
    expect(resourceEligible({...base.sessions[0], resourceType: 'CLASSROOM'}, base.resources[0]).ok).toBe(false);
  });

  it('does not span gaps or breaks', () => {
    expect(contiguousBlocks(base.slots, 2).map(block => block.map(slot => slot.id))).toEqual([['m1', 'm2']]);
  });

  it('detects whole-division vs batch via shared atomic cohort', () => {
    const input = {
      ...base,
      sessions: [base.sessions[0], {...base.sessions[0], id: 's2', facultyId: 'other', cohortAtomIds: ['a1', 'a2']}],
      faculty: [...base.faculty, {...base.faculty[0], id: 'other'}]
    };
    const report = validateTimetable(input, [
      {sessionId: 's1', resourceId: 'lab', slotIds: ['m1', 'm2'], score: 0},
      {sessionId: 's2', resourceId: 'lab2', slotIds: ['m1', 'm2'], score: 0}
    ]);
    expect(report.conflicts.some(conflict => conflict.code === 'COHORT_COLLISION')).toBe(true);
  });

  it('allows distinct batches in parallel when resources and faculty differ', () => {
    const input = {
      ...base,
      resources: [base.resources[0], {...base.resources[0], id: 'lab2'}],
      sessions: [base.sessions[0], {...base.sessions[0], id: 's2', facultyId: 'other', cohortAtomIds: ['a2']}],
      faculty: [...base.faculty, {...base.faculty[0], id: 'other'}]
    };
    expect(validateTimetable(input, [
      {sessionId: 's1', resourceId: 'lab', slotIds: ['m1', 'm2'], score: 0},
      {sessionId: 's2', resourceId: 'lab2', slotIds: ['m1', 'm2'], score: 0}
    ]).valid).toBe(true);
  });

  it('independently rechecks configured hard policies', () => {
    const input = {
      ...base,
      policies: [{id: 'p', name: 'Do not use lab', description: '', type: 'RESOURCE_PROHIBITION' as const, strength: 'HARD' as const, weight: 1, scope: {}, parameters: {resourceIds: ['lab']}, active: true, version: 1}]
    };
    expect(validateTimetable(input, ok).conflicts.some(conflict => conflict.code === 'POLICY_VIOLATION')).toBe(true);
  });
});

describe('phase 2 validator expansions', () => {
  it('detects duplicate and unknown assignments', () => {
    const report = validateTimetable(base, [...ok, ...ok, {sessionId: 'ghost', resourceId: 'lab', slotIds: ['m1'], score: 0}]);
    expect(report.conflicts.some(conflict => conflict.code === 'DUPLICATE_ASSIGNMENT')).toBe(true);
    expect(report.conflicts.some(conflict => conflict.code === 'UNKNOWN_ASSIGNMENT')).toBe(true);
  });

  it('detects unknown, repeated and break slots', () => {
    expect(validateTimetable(base, [{sessionId: 's1', resourceId: 'lab', slotIds: ['nope', 'm2'], score: 0}]).conflicts.some(c => c.code === 'UNKNOWN_SLOT')).toBe(true);
    expect(validateTimetable(base, [{sessionId: 's1', resourceId: 'lab', slotIds: ['m1', 'm1'], score: 0}]).conflicts.some(c => c.code === 'REPEATED_SLOT')).toBe(true);
    expect(validateTimetable(base, [{sessionId: 's1', resourceId: 'lab', slotIds: ['m1', 'brk'], score: 0}]).conflicts.some(c => c.code === 'BREAK_SLOT')).toBe(true);
  });

  it('enforces required resource and explicit minimum capacity', () => {
    const required = validateTimetable({...base, sessions: [{...base.sessions[0], requiredResourceId: 'other-lab'}]}, ok);
    expect(required.conflicts.some(conflict => conflict.code === 'REQUIRED_RESOURCE')).toBe(true);
    const capacity = validateTimetable({...base, sessions: [{...base.sessions[0], minCapacity: 40}]}, ok);
    expect(capacity.conflicts.some(conflict => conflict.code === 'CAPACITY_VIOLATION')).toBe(true);
  });

  it('enforces faculty eligibility', () => {
    const report = validateTimetable({...base, sessions: [{...base.sessions[0], subjectId: 'sub-ml'}]}, ok);
    expect(report.conflicts.some(conflict => conflict.code === 'FACULTY_INELIGIBLE')).toBe(true);
  });

  it('detects consecutive workload and hard daily-period policies', () => {
    const consecutive = validateTimetable({...base, faculty: [{...base.faculty[0], maxConsecutive: 1}]}, ok);
    expect(consecutive.conflicts.some(conflict => conflict.code === 'CONSECUTIVE_WORKLOAD')).toBe(true);
    const daily = validateTimetable({
      ...base,
      policies: [{id: 'daily', name: 'Max one', description: '', type: 'MAX_DAILY_PERIODS', strength: 'HARD', weight: 1, scope: {}, parameters: {maxPeriods: 1}, active: true, version: 1}]
    }, ok);
    expect(daily.conflicts.some(conflict => conflict.code === 'DAILY_POLICY_VIOLATION')).toBe(true);
  });

  it('still reports resource, faculty and availability collisions', () => {
    const input = {
      ...base,
      resources: [base.resources[0], {...base.resources[0], id: 'lab2', unavailableSlotIds: ['m1']}],
      faculty: [...base.faculty, {...base.faculty[0], id: 'other'}],
      sessions: [base.sessions[0], {...base.sessions[0], id: 's2', facultyId: 'other', cohortAtomIds: ['b1']}]
    };
    const collisions = validateTimetable(input, [
      {sessionId: 's1', resourceId: 'lab', slotIds: ['m1', 'm2'], score: 0},
      {sessionId: 's2', resourceId: 'lab', slotIds: ['m1', 'm2'], score: 0}
    ]);
    expect(collisions.conflicts.some(conflict => conflict.code === 'RESOURCE_COLLISION')).toBe(true);
    const unavailable = validateTimetable({
      ...base,
      sessions: [{...base.sessions[0], id: 's2', facultyId: 'other'}],
      faculty: [...base.faculty, {...base.faculty[0], id: 'other'}],
      resources: [{...base.resources[0], unavailableSlotIds: ['m1']}]
    }, [{sessionId: 's2', resourceId: 'lab', slotIds: ['m1', 'm2'], score: 0}]);
    expect(unavailable.conflicts.some(conflict => conflict.code === 'RESOURCE_UNAVAILABLE')).toBe(true);
  });
});

describe('candidate-aware preflight', () => {
  it('flags missing faculty eligibility before solve', () => {
    const report = analyzeCandidates({...base, sessions: [{...base.sessions[0], subjectId: 'sub-unknown'}]});
    expect(report.valid).toBe(false);
    expect(report.issues.some(issue => issue.code === 'NO_ELIGIBLE_FACULTY')).toBe(true);
  });

  it('flags insufficient capacity and missing capability', () => {
    expect(analyzeCandidates({...base, sessions: [{...base.sessions[0], minCapacity: 80}]}).issues.some(issue => issue.code === 'INSUFFICIENT_CAPACITY')).toBe(true);
    expect(analyzeCandidates({...base, sessions: [{...base.sessions[0], requiredCapabilities: ['GPU']}]}).issues.some(issue => issue.code === 'MISSING_REQUIRED_CAPABILITY')).toBe(true);
  });

  it('accepts the seeded feasible fixture', () => {
    expect(analyzeCandidates(base).valid).toBe(true);
    expect(analyzeCandidates(base).summary.candidates).toBeGreaterThan(0);
  });
});
