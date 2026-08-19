import {analyzeCandidates, eligibleResourcesForSession, validateTimetable} from '@chronos/domain';
import {buildSessions, faculty, resources, runs, solverInput, versions} from './store.js';

export const groundedTools = ['eligibleResources', 'currentConflicts', 'unscheduledSessions', 'generationDiagnostics'] as const;
export type GroundedTool = typeof groundedTools[number];

export function runGroundedTool(tool: string, args: Record<string, unknown>) {
  const input = solverInput();
  if (tool === 'eligibleResources') {
    const sessionId = String(args.sessionId ?? '');
    const session = input.sessions.find(item => item.id === sessionId) ?? input.sessions.find(item => item.requirementId === sessionId);
    if (!session) {
      return {tool, ok: false, error: {code: 'NOT_FOUND', message: 'Session was not found in the current teaching plan'}, resources: []};
    }
    return {
      tool,
      ok: true,
      session: {id: session.id, title: session.title, subjectCode: session.subjectCode, resourceType: session.resourceType, requiredCapabilities: session.requiredCapabilities, minCapacity: session.minCapacity, requiredResourceId: session.requiredResourceId},
      resources: eligibleResourcesForSession(input, session.id).map(resource => ({id: resource.id, name: resource.name, type: resource.type, capacity: resource.capacity, capabilities: resource.capabilities, departmentId: resource.departmentId}))
    };
  }
  if (tool === 'currentConflicts') {
    const version = versions.find(item => item.id === args.versionId) ?? versions.at(-1);
    if (!version) return {tool, ok: false, error: {code: 'NOT_FOUND', message: 'No timetable version exists yet'}, conflicts: []};
    const report = version.validation ?? validateTimetable(input, version.assignments);
    return {
      tool,
      ok: true,
      versionId: version.id,
      valid: report.valid,
      conflicts: report.conflicts,
      metrics: report.metrics
    };
  }
  if (tool === 'unscheduledSessions') {
    const version = versions.find(item => item.id === args.versionId) ?? versions.at(-1);
    const scheduled = new Set(version?.assignments.map(item => item.sessionId) ?? []);
    const sessions = buildSessions()
      .filter(session => !scheduled.has(session.id))
      .map(session => ({id: session.id, title: session.title, facultyId: session.facultyId, subjectCode: session.subjectCode, resourceType: session.resourceType}));
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
    return {
      tool,
      ok: true,
      run: {id: run.id, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, metrics: run.result?.metrics ?? {}, diagnostics: run.result?.diagnostics ?? []},
      preflight: {valid: analysis.valid, issues: analysis.issues, summary: analysis.summary},
      resources: resources.map(item => ({id: item.id, name: item.name})),
      faculty: faculty.map(item => ({id: item.id, name: item.name}))
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
