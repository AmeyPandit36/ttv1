#!/usr/bin/env python3
"""Deterministic CP-SAT timetable engine. JSON request on stdin, JSON result on stdout."""
import json, sys, time
from collections import defaultdict, Counter
try:
    from ortools.sat.python import cp_model
except ImportError:
    cp_model = None

def lower_set(values):
    return {str(x).casefold() for x in values}

def needed_capacity(session):
    return max(int(session.get('participantCount') or 0), int(session.get('minCapacity') or 0))

def blocks(slots, duration):
    by_day = defaultdict(list)
    for slot in slots:
        if not slot.get('isBreak', False):
            by_day[slot['dayId']].append(slot)
    out = []
    for day in by_day.values():
        day.sort(key=lambda item: item['index'])
        for i in range(len(day) - duration + 1):
            block = day[i:i + duration]
            if all(block[j]['index'] == block[j - 1]['index'] + 1 for j in range(1, len(block))):
                out.append(block)
    return out

def policy_applies(session, policy):
    scope = policy.get('scope') or {}
    if scope.get('departmentId') and scope.get('departmentId') != session.get('preferredDepartmentId'):
        return False
    if scope.get('facultyId') and scope.get('facultyId') != session.get('facultyId'):
        return False
    if scope.get('sessionType') and scope.get('sessionType') != session.get('sessionType'):
        return False
    return True

def faculty_reason(session, faculty):
    if not faculty:
        return 'no eligible faculty'
    subject_id = session.get('subjectId')
    eligible = faculty.get('eligibleSubjectIds')
    if subject_id and eligible is not None and subject_id not in eligible:
        return 'faculty ineligible'
    return None

def resource_reasons(session, resource, policies):
    reasons = []
    if not resource.get('active', True):
        reasons.append('inactive')
    required = session.get('requiredResourceId')
    if required and resource['id'] != required:
        reasons.append('not the required resource')
    if resource['type'] != session['resourceType']:
        reasons.append('wrong resource type')
    if resource['capacity'] < needed_capacity(session):
        reasons.append('insufficient capacity')
    have = lower_set(resource.get('capabilities', []))
    if not lower_set(session.get('requiredCapabilities', [])).issubset(have):
        reasons.append('missing required capability')
    for policy in policies:
        if policy.get('strength') == 'HARD' and policy.get('type') == 'RESOURCE_PROHIBITION' and policy_applies(session, policy):
            if resource['id'] in (policy.get('parameters') or {}).get('resourceIds', []):
                reasons.append('prohibited by policy')
    return reasons

def solve(data):
    started = time.monotonic()
    if cp_model is None:
        return {'status': 'ERROR', 'assignments': [], 'diagnostics': [{'code': 'DEPENDENCY_MISSING', 'message': 'Install scheduler/requirements.txt', 'sessionIds': []}], 'metrics': {}}
    slots = data.get('slots', [])
    resources = data.get('resources', [])
    faculty = {item['id']: item for item in data.get('faculty', [])}
    sessions = data.get('sessions', [])
    policies = [policy for policy in data.get('policies', []) if policy.get('active', True)]
    slot_info = {item['id']: item for item in slots}
    resource_info = {item['id']: item for item in resources}
    candidates = {}
    rejected = {}

    for session in sessions:
        options = []
        reasons = Counter()
        ineligible = faculty_reason(session, faculty.get(session['facultyId']))
        if ineligible:
            reasons[ineligible] += 1
        else:
            member = faculty.get(session['facultyId'], {})
            time_blocks = blocks(slots, session['duration'])
            if not time_blocks:
                reasons['no candidate time block'] += 1
            typed = 0
            for resource in resources:
                if resource.get('type') == session['resourceType']:
                    typed += 1
                blocked = resource_reasons(session, resource, policies)
                if blocked:
                    reasons.update(blocked)
                    continue
                for block in time_blocks:
                    ids = [item['id'] for item in block]
                    if session.get('requiredSlotIds') and set(ids) != set(session['requiredSlotIds']):
                        continue
                    if set(ids) & set(member.get('unavailableSlotIds', [])) and not session.get('requiredSlotIds'):
                        reasons['faculty unavailable'] += 1
                        continue
                    if set(ids) & set(resource.get('unavailableSlotIds', [])) and not session.get('requiredSlotIds'):
                        reasons['resource unavailable'] += 1
                        continue
                    prohibited = False
                    for policy in policies:
                        if policy.get('strength') == 'HARD' and policy.get('type') == 'TIME_RESTRICTION' and policy_applies(session, policy):
                            if set(ids) & set((policy.get('parameters') or {}).get('prohibitedSlotIds', [])):
                                prohibited = True
                    if prohibited:
                        reasons['prohibited by time policy'] += 1
                        continue
                    penalty = 0
                    if resource.get('departmentId') != session.get('preferredDepartmentId'):
                        penalty += 8
                    preferred = lower_set(session.get('preferredCapabilities', []))
                    penalty += len(preferred - lower_set(resource.get('capabilities', []))) * 2
                    preferred_slots = member.get('preferredSlotIds') or []
                    if preferred_slots:
                        penalty += sum(2 for slot_id in ids if slot_id not in preferred_slots)
                    for policy in policies:
                        if policy.get('strength') == 'SOFT' and policy.get('type') == 'RESOURCE_PREFERENCE' and policy_applies(session, policy):
                            if resource['id'] not in (policy.get('parameters') or {}).get('preferredResourceIds', []):
                                penalty += policy.get('weight', 10)
                    options.append({'resourceId': resource['id'], 'slotIds': ids, 'penalty': penalty})
            if not typed and not options:
                reasons['no candidate resource'] += 1
        candidates[session['id']] = options
        rejected[session['id']] = reasons

    empty = [session for session in sessions if not candidates[session['id']]]
    workloads = Counter()
    for session in sessions:
        workloads[session['facultyId']] += session['duration']
    over = [member for member in faculty.values() if member.get('maxPeriodsPerWeek') and workloads[member['id']] > member['maxPeriodsPerWeek']]
    if empty or over:
        diagnostics = []
        for session in empty:
            diagnostics.append({
                'code': 'NO_CANDIDATES',
                'message': f"{session['title']} has no eligible time/resource assignment",
                'sessionIds': [session['id']],
                'evidence': dict(rejected[session['id']].most_common())
            })
        for member in over:
            diagnostics.append({
                'code': 'WORKLOAD_EXCEEDED',
                'message': f"{member['name']} requires {workloads[member['id']]} periods but maximum is {member['maxPeriodsPerWeek']}",
                'sessionIds': [session['id'] for session in sessions if session['facultyId'] == member['id']],
                'facultyId': member['id'],
                'evidence': {'required': workloads[member['id']], 'maximum': member['maxPeriodsPerWeek']}
            })
        return {
            'status': 'INFEASIBLE',
            'assignments': [],
            'diagnostics': diagnostics,
            'metrics': {'sessions': len(sessions), 'candidates': sum(map(len, candidates.values())), 'solverDurationMs': round((time.monotonic() - started) * 1000)}
        }

    model = cp_model.CpModel()
    var = {}
    for session_id, options in candidates.items():
        for index, _ in enumerate(options):
            var[session_id, index] = model.new_bool_var(f'x_{session_id}_{index}')
        model.add_exactly_one(var[session_id, index] for index in range(len(options)))

    resource_slot = defaultdict(list)
    faculty_slot = defaultdict(list)
    cohort_slot = defaultdict(list)
    smap = {session['id']: session for session in sessions}
    for session_id, options in candidates.items():
        session = smap[session_id]
        for index, option in enumerate(options):
            for slot_id in option['slotIds']:
                resource_slot[option['resourceId'], slot_id].append(var[session_id, index])
                faculty_slot[session['facultyId'], slot_id].append(var[session_id, index])
                for atom in set(session['cohortAtomIds']):
                    cohort_slot[atom, slot_id].append(var[session_id, index])
    for index in (resource_slot, faculty_slot, cohort_slot):
        for values in index.values():
            model.add_at_most_one(values)

    slot_by_day = defaultdict(list)
    for slot in slots:
        if not slot.get('isBreak'):
            slot_by_day[slot['dayId']].append(slot)
    for member in faculty.values():
        maximum = member.get('maxConsecutive')
        if not maximum:
            continue
        for day in slot_by_day.values():
            day.sort(key=lambda item: item['index'])
            for i in range(len(day) - maximum):
                window = day[i:i + maximum + 1]
                if all(window[j]['index'] == window[j - 1]['index'] + 1 for j in range(1, len(window))):
                    terms = []
                    for slot in window:
                        terms.extend(faculty_slot.get((member['id'], slot['id']), []))
                    model.add(sum(terms) <= maximum)

    soft_terms = []
    for policy in policies:
        if policy.get('type') != 'MAX_DAILY_PERIODS':
            continue
        params = policy.get('parameters') or {}
        maximum = int(params.get('maxPeriods') or params.get('maxDailyPeriods') or 0)
        if maximum <= 0:
            continue
        for member in faculty.values():
            for day_id, day_slots in slot_by_day.items():
                terms = []
                for session_id, options in candidates.items():
                    session = smap[session_id]
                    if session['facultyId'] != member['id'] or not policy_applies(session, policy):
                        continue
                    for index, option in enumerate(options):
                        count = sum(1 for slot_id in option['slotIds'] if slot_info[slot_id]['dayId'] == day_id)
                        if count:
                            terms.append(var[session_id, index] * count)
                if not terms:
                    continue
                if policy.get('strength') == 'HARD':
                    model.add(sum(terms) <= maximum)
                else:
                    overflow = model.new_int_var(0, 64, f"daily_{policy.get('id', 'p')}_{member['id']}_{day_id}")
                    model.add(sum(terms) - overflow <= maximum)
                    soft_terms.append(overflow * int(policy.get('weight', 10)))

    model.minimize(sum(variable * candidates[session_id][index]['penalty'] for (session_id, index), variable in var.items()) + sum(soft_terms))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(data.get('timeLimitSeconds', 20))
    solver.parameters.num_search_workers = 8
    status = solver.solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {
            'status': 'INFEASIBLE',
            'assignments': [],
            'diagnostics': [{
                'code': 'GLOBAL_CONFLICT',
                'message': 'Every session has candidates, but no collision-free combination exists. Add time/resource capacity or relax an evidenced restriction.',
                'sessionIds': [session['id'] for session in sessions],
                'evidence': {'sessions': len(sessions), 'candidates': sum(map(len, candidates.values()))}
            }],
            'metrics': {'sessions': len(sessions), 'candidates': sum(map(len, candidates.values())), 'solverDurationMs': round((time.monotonic() - started) * 1000)}
        }

    assignments = []
    for (session_id, index), variable in var.items():
        if solver.value(variable):
            option = candidates[session_id][index]
            assignments.append({'sessionId': session_id, 'resourceId': option['resourceId'], 'slotIds': option['slotIds'], 'score': -option['penalty']})

    def gap_count(key_values):
        occupied = defaultdict(set)
        for assignment in assignments:
            for key in key_values(smap[assignment['sessionId']]):
                for slot_id in assignment['slotIds']:
                    occupied[(key, slot_info[slot_id]['dayId'])].add(slot_info[slot_id]['index'])
        return sum((max(values) - min(values) + 1 - len(values)) for values in occupied.values() if values)

    faculty_gaps = gap_count(lambda session: [session['facultyId']])
    student_gaps = gap_count(lambda session: session['cohortAtomIds'])
    movements = 0
    for cohort in {atom for session in sessions for atom in session['cohortAtomIds']}:
        daily = defaultdict(list)
        for assignment in assignments:
            if cohort in smap[assignment['sessionId']]['cohortAtomIds']:
                first = slot_info[assignment['slotIds'][0]]
                daily[first['dayId']].append((first['index'], resource_info[assignment['resourceId']].get('buildingId')))
        for events in daily.values():
            events.sort()
            movements += sum(1 for i in range(1, len(events)) if events[i - 1][1] and events[i][1] and events[i - 1][1] != events[i][1])
    used_periods = sum(len(assignment['slotIds']) for assignment in assignments)
    available_periods = max(1, len(resources) * len([slot for slot in slots if not slot.get('isBreak')]))
    metrics = {
        'sessions': len(sessions),
        'scheduledSessions': len(assignments),
        'unscheduledSessions': 0,
        'candidates': sum(map(len, candidates.values())),
        'objective': solver.objective_value,
        'solverDurationMs': round((time.monotonic() - started) * 1000),
        'preferredResourceAssignments': sum(1 for assignment in assignments if resource_info[assignment['resourceId']].get('departmentId') == smap[assignment['sessionId']].get('preferredDepartmentId')),
        'fallbackResourceAssignments': sum(1 for assignment in assignments if resource_info[assignment['resourceId']].get('departmentId') != smap[assignment['sessionId']].get('preferredDepartmentId')),
        'facultyGaps': faculty_gaps,
        'studentGaps': student_gaps,
        'buildingMovements': movements,
        'resourceUtilizationPercent': round(100 * used_periods / available_periods, 2)
    }
    return {'status': 'OPTIMAL' if status == cp_model.OPTIMAL else 'FEASIBLE', 'assignments': assignments, 'diagnostics': [], 'metrics': metrics}

def main():
    try:
        print(json.dumps(solve(json.load(sys.stdin))))
    except Exception as exc:
        print(json.dumps({'status': 'ERROR', 'assignments': [], 'diagnostics': [{'code': 'SCHEDULER_ERROR', 'message': str(exc), 'sessionIds': []}], 'metrics': {}}))

if __name__ == '__main__':
    main()
