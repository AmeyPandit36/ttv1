import {batches, collections, departments, divisions, faculty, levels, programs, resources, slots, subjects} from './store.js';

export interface ReferenceIssue {
  path: string;
  message: string;
}

function exists(rows: {id: string}[], id: string | undefined): boolean {
  return Boolean(id && rows.some(row => row.id === id));
}

export function referenceIssues(collection: string, entity: Record<string, unknown>): ReferenceIssue[] {
  const issues: ReferenceIssue[] = [];
  const need = (path: string, ok: boolean, message: string) => {
    if (!ok) issues.push({path, message});
  };

  if (collection === 'programs') {
    need('departmentId', exists(departments, String(entity.departmentId)), 'Unknown department');
    need('academicYearId', entity.academicYearId === 'ay-26' || Boolean(entity.academicYearId), 'Unknown academic year');
  }
  if (collection === 'levels') need('programId', exists(programs, String(entity.programId)), 'Unknown program');
  if (collection === 'divisions') need('programLevelId', exists(levels, String(entity.programLevelId)), 'Unknown academic level');
  if (collection === 'batches') need('divisionId', exists(divisions, String(entity.divisionId)), 'Unknown division');
  if (collection === 'faculty') {
    need('departmentId', exists(departments, String(entity.departmentId)), 'Unknown department');
    for (const subjectId of (entity.eligibleSubjectIds as string[] | undefined) ?? []) {
      need('eligibleSubjectIds', exists(subjects, subjectId), `Unknown eligible subject ${subjectId}`);
    }
    for (const slotId of [...((entity.unavailableSlotIds as string[] | undefined) ?? []), ...((entity.preferredSlotIds as string[] | undefined) ?? [])]) {
      need('unavailableSlotIds', slots.some(slot => slot.id === slotId), `Unknown time slot ${slotId}`);
    }
  }
  if (collection === 'enrollments') {
    need('divisionId', exists(divisions, String(entity.divisionId)), 'Unknown division');
    if (entity.batchId) need('batchId', exists(batches, String(entity.batchId)), 'Unknown batch');
  }
  if (collection === 'subjects') need('departmentId', exists(departments, String(entity.departmentId)), 'Unknown department');
  if (collection === 'resources') {
    if (entity.departmentId) need('departmentId', exists(departments, String(entity.departmentId)), 'Unknown department');
    for (const slotId of (entity.unavailableSlotIds as string[] | undefined) ?? []) {
      need('unavailableSlotIds', slots.some(slot => slot.id === slotId), `Unknown time slot ${slotId}`);
    }
  }
  if (collection === 'requirements') {
    need('subjectId', exists(subjects, String(entity.subjectId)), 'Unknown subject');
    need('facultyId', exists(faculty, String(entity.facultyId)), 'Unknown faculty');
    const teacher = faculty.find(item => item.id === entity.facultyId);
    if (teacher && entity.subjectId && teacher.eligibleSubjectIds && !teacher.eligibleSubjectIds.includes(String(entity.subjectId))) {
      issues.push({path: 'facultyId', message: 'Faculty is not eligible for the selected subject'});
    }
    for (const divisionId of (entity.divisionIds as string[] | undefined) ?? []) {
      need('divisionIds', exists(divisions, divisionId), `Unknown division ${divisionId}`);
    }
    for (const batchId of (entity.batchIds as string[] | undefined) ?? []) {
      need('batchIds', exists(batches, batchId), `Unknown batch ${batchId}`);
    }
    if (entity.requiredResourceId) {
      need('requiredResourceId', exists(resources, String(entity.requiredResourceId)), 'Unknown required resource');
    }
  }
  if (collection === 'policies' && entity.scope && typeof entity.scope === 'object') {
    const scope = entity.scope as Record<string, unknown>;
    if (scope.departmentId) need('scope.departmentId', exists(departments, String(scope.departmentId)), 'Unknown department scope');
  }
  return issues;
}

export function collectionExists(name: string): boolean {
  return Boolean(collections[name]);
}
