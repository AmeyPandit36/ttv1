import {analyzeCandidates, eligibleResourcesForSession, validateTimetable} from '@chronos/domain';
import {buildSessions, faculty, resources, runs, solverInput, versions, collections} from './store.js';

export const groundedTools = ['eligibleResources', 'currentConflicts', 'unscheduledSessions', 'generationDiagnostics'] as const;
export type GroundedTool = typeof groundedTools[number];

export function isSessionForStudent(session: any, studentDivisionId: string, studentBatchId?: string) {
  if (studentBatchId && session.cohortAtomIds.includes(studentBatchId)) {
    return true;
  }
  if (session.cohortAtomIds.includes(`division:${studentDivisionId}`)) {
    return true;
  }
  return false;
}

export function runGroundedTool(tool: string, args: Record<string, unknown>, user?: any) {
  const input = solverInput();
  
  let fac: any = null;
  let enroll: any = null;
  if (user) {
    if (user.role === 'FACULTY') {
      fac = faculty.find(f => (f as any).userId === user.id || f.id === user.id);
    } else if (user.role === 'STUDENT') {
      enroll = collections.enrollments.find(e => (e as any).studentId === user.id || e.id === user.id || (e as any).studentName?.toLowerCase() === user.name?.toLowerCase());
    }
  }

  if (tool === 'eligibleResources') {
    const sessionId = String(args.sessionId ?? '');
    const session = input.sessions.find(item => item.id === sessionId) ?? input.sessions.find(item => item.requirementId === sessionId);
    if (!session) {
      return {tool, ok: false, error: {code: 'NOT_FOUND', message: 'Session was not found in the current teaching plan'}, resources: []};
    }
    
    if (user) {
      if (user.role === 'HOD' && session.preferredDepartmentId !== user.departmentId) {
        return {tool, ok: false, error: {code: 'FORBIDDEN', message: 'Unauthorized access to session'}, resources: []};
      }
      if (user.role === 'FACULTY' && (!fac || session.facultyId !== fac.id)) {
        return {tool, ok: false, error: {code: 'FORBIDDEN', message: 'Unauthorized access to session'}, resources: []};
      }
      if (user.role === 'STUDENT' && (!enroll || !isSessionForStudent(session, (enroll as any).divisionId, (enroll as any).batchId))) {
        return {tool, ok: false, error: {code: 'FORBIDDEN', message: 'Unauthorized access to session'}, resources: []};
      }
    }

    return {
      tool,
      ok: true,
      session: {id: session.id, title: session.title, subjectCode: session.subjectCode, resourceType: session.resourceType, requiredCapabilities: session.requiredCapabilities, minCapacity: session.minCapacity, requiredResourceId: session.requiredResourceId},
      resources: eligibleResourcesForSession(input, session.id)
        .filter(resource => {
          if (user && user.role === 'HOD' && resource.departmentId !== user.departmentId) return false;
          if (user && user.role === 'FACULTY' && fac && resource.departmentId !== fac.departmentId) return false;
          return true;
        })
        .map(resource => ({id: resource.id, name: resource.name, type: resource.type, capacity: resource.capacity, capabilities: resource.capabilities, departmentId: resource.departmentId}))
    };
  }
  if (tool === 'currentConflicts') {
    const version = versions.find(item => item.id === args.versionId) ?? versions.at(-1);
    if (!version) return {tool, ok: false, error: {code: 'NOT_FOUND', message: 'No timetable version exists yet'}, conflicts: []};
    const report = version.validation ?? validateTimetable(input, version.assignments);
    
    let conflicts = report.conflicts || [];
    if (user) {
      if (user.role === 'HOD') {
        conflicts = conflicts.filter(c => {
          const sIds = c.sessionIds || [];
          return sIds.some(sid => {
            const s = input.sessions.find(x => x.id === sid);
            return s && s.preferredDepartmentId === user.departmentId;
          });
        });
      } else if (user.role === 'FACULTY' && fac) {
        conflicts = conflicts.filter(c => {
          const sIds = c.sessionIds || [];
          return sIds.some(sid => {
            const s = input.sessions.find(x => x.id === sid);
            return s && s.facultyId === fac.id;
          });
        });
      } else if (user.role === 'STUDENT' && enroll) {
        conflicts = conflicts.filter(c => {
          const sIds = c.sessionIds || [];
          return sIds.some(sid => {
            const s = input.sessions.find(x => x.id === sid);
            return s && isSessionForStudent(s, (enroll as any).divisionId, (enroll as any).batchId);
          });
        });
      }
    }

    return {
      tool,
      ok: true,
      versionId: version.id,
      valid: conflicts.length === 0,
      conflicts,
      metrics: report.metrics
    };
  }
  if (tool === 'unscheduledSessions') {
    const version = versions.find(item => item.id === args.versionId) ?? versions.at(-1);
    const scheduled = new Set(version?.assignments.map(item => item.sessionId) ?? []);
    let sessions = buildSessions()
      .filter(session => !scheduled.has(session.id))
      .map(session => ({id: session.id, title: session.title, facultyId: session.facultyId, subjectCode: session.subjectCode, resourceType: session.resourceType, preferredDepartmentId: session.preferredDepartmentId, cohortAtomIds: session.cohortAtomIds}));
    
    if (user) {
      if (user.role === 'HOD') {
        sessions = sessions.filter(s => s.preferredDepartmentId === user.departmentId);
      } else if (user.role === 'FACULTY' && fac) {
        sessions = sessions.filter(s => s.facultyId === fac.id);
      } else if (user.role === 'STUDENT' && enroll) {
        sessions = sessions.filter(s => isSessionForStudent(s, (enroll as any).divisionId, (enroll as any).batchId));
      }
    }

    return {
      tool,
      ok: true,
      versionId: version?.id ?? null,
      unscheduled: sessions,
      scheduledCount: scheduled.size,
      totalSessions: buildSessions().length
    };
  }
  if (tool === 'generationDiagnostics') {
    const run = runs.find(item => item.id === args.runId) ?? runs.at(-1);
    if (!run) return {tool, ok: false, error: {code: 'NOT_FOUND', message: 'No generation run exists yet'}, diagnostics: []};
    const analysis = analyzeCandidates(input);
    
    let filteredAnalysisIssues = analysis.issues;
    let filteredResources = resources;
    let filteredFaculty = faculty;

    if (user) {
      if (user.role === 'HOD') {
        filteredAnalysisIssues = analysis.issues.filter(issue => {
          if (!issue.sessionId) return true;
          const s = input.sessions.find(x => x.id === issue.sessionId);
          return s && s.preferredDepartmentId === user.departmentId;
        });
        filteredResources = resources.filter(r => r.departmentId === user.departmentId);
        filteredFaculty = faculty.filter(f => f.departmentId === user.departmentId);
      }
    }

    return {
      tool,
      ok: true,
      run: {id: run.id, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, metrics: run.result?.metrics ?? {}, diagnostics: run.result?.diagnostics ?? []},
      preflight: {valid: filteredAnalysisIssues.length === 0, issues: filteredAnalysisIssues, summary: analysis.summary},
      resources: filteredResources.map(item => ({id: item.id, name: item.name})),
      faculty: filteredFaculty.map(item => ({id: item.id, name: item.name}))
    };
  }
  return {tool, ok: false, error: {code: 'UNKNOWN_TOOL', message: `Unsupported tool ${tool}`}};
}

export function inferTool(message: string): {tool: GroundedTool; args: Record<string, unknown>} | null {
  const text = message.toLowerCase();
  if (/eligible resource|which room|which lab|candidate resource/.test(text)) return {tool: 'eligibleResources', args: {}};
  if (/conflict|collision|violation/.test(text)) return {tool: 'currentConflicts', args: {}};
  if (/unscheduled|not scheduled|missing session/.test(text)) return {tool: 'unscheduledSessions', args: {}};
  if (/diagnostic|preflight|infeasible|why (did|can.t|cannot) (it )?generat/.test(text)) return {tool: 'generationDiagnostics', args: {}};
  return null;
}
