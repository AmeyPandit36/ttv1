#!/usr/bin/env python3
"""Deterministic CP-SAT timetable engine. JSON request on stdin, JSON result on stdout."""
import json, sys, time
from collections import defaultdict, Counter
try:
    from ortools.sat.python import cp_model
except ImportError:
    cp_model = None

def lower_set(values): return {str(x).casefold() for x in values}

def blocks(slots, duration):
    by_day=defaultdict(list)
    for slot in slots:
        if not slot.get('isBreak',False): by_day[slot['dayId']].append(slot)
    out=[]
    for day in by_day.values():
        day.sort(key=lambda x:x['index'])
        for i in range(len(day)-duration+1):
            block=day[i:i+duration]
            if all(block[j]['index']==block[j-1]['index']+1 for j in range(1,len(block))): out.append(block)
    return out

def solve(data):
    started=time.monotonic()
    if cp_model is None: return {'status':'ERROR','assignments':[],'diagnostics':[{'code':'DEPENDENCY_MISSING','message':'Install scheduler/requirements.txt','sessionIds':[]}],'metrics':{}}
    slots=data.get('slots',[]); resources=data.get('resources',[]); faculty={x['id']:x for x in data.get('faculty',[])}; sessions=data.get('sessions',[]); policies=[p for p in data.get('policies',[]) if p.get('active',True)]
    candidates={}; rejected={}
    for s in sessions:
        options=[]; reasons=Counter(); required=lower_set(s.get('requiredCapabilities',[]))
        for r in resources:
            rs=[]
            if not r.get('active',True): rs.append('inactive')
            if r['type'] != s['resourceType']: rs.append('wrong resource type')
            if r['capacity'] < s['participantCount']: rs.append('insufficient capacity')
            if not required.issubset(lower_set(r.get('capabilities',[]))): rs.append('missing required capability')
            for p in policies:
                if p['strength']=='HARD' and p['type']=='RESOURCE_PROHIBITION':
                    prm=p.get('parameters',{}); scope=p.get('scope',{})
                    if r['id'] in prm.get('resourceIds',[]) and (not scope.get('departmentId') or scope.get('departmentId')==s.get('preferredDepartmentId')): rs.append('prohibited by policy')
            if rs:
                reasons.update(rs); continue
            for block in blocks(slots,s['duration']):
                ids=[x['id'] for x in block]; f=faculty.get(s['facultyId'],{})
                if set(ids)&set(f.get('unavailableSlotIds',[])): reasons['faculty unavailable']+=1; continue
                if set(ids)&set(r.get('unavailableSlotIds',[])): reasons['resource unavailable']+=1; continue
                prohibited=False
                for p in policies:
                    if p['strength']=='HARD' and p['type']=='TIME_RESTRICTION':
                        prm=p.get('parameters',{}); scope=p.get('scope',{})
                        applies=(not scope.get('facultyId') or scope.get('facultyId')==s['facultyId']) and (not scope.get('sessionType') or scope.get('sessionType')==s['sessionType'])
                        if applies and set(ids)&set(prm.get('prohibitedSlotIds',[])): prohibited=True
                if prohibited: reasons['prohibited by time policy']+=1; continue
                penalty=0
                if r.get('departmentId')!=s.get('preferredDepartmentId'): penalty+=8
                preferred=lower_set(s.get('preferredCapabilities',[])); penalty+=len(preferred-lower_set(r.get('capabilities',[])))*2
                penalty+=sum(2 for x in ids if f.get('preferredSlotIds') and x not in f['preferredSlotIds'])
                for p in policies:
                    if p['strength']=='SOFT' and p['type']=='RESOURCE_PREFERENCE':
                        scope=p.get('scope',{}); prm=p.get('parameters',{})
                        if (not scope.get('departmentId') or scope.get('departmentId')==s.get('preferredDepartmentId')) and r['id'] not in prm.get('preferredResourceIds',[]): penalty+=p.get('weight',10)
                options.append({'resourceId':r['id'],'slotIds':ids,'penalty':penalty})
        candidates[s['id']]=options; rejected[s['id']]=reasons
    empty=[s for s in sessions if not candidates[s['id']]]
    workloads=Counter()
    for s in sessions: workloads[s['facultyId']]+=s['duration']
    over=[f for f in faculty.values() if f.get('maxPeriodsPerWeek') and workloads[f['id']]>f['maxPeriodsPerWeek']]
    if empty or over:
        diagnostics=[]
        for s in empty:
            evidence=dict(rejected[s['id']].most_common())
            diagnostics.append({'code':'NO_CANDIDATES','message':f"{s['title']} has no eligible time/resource assignment",'sessionIds':[s['id']],'evidence':evidence})
        for f in over: diagnostics.append({'code':'WORKLOAD_EXCEEDED','message':f"{f['name']} requires {workloads[f['id']]} periods but maximum is {f['maxPeriodsPerWeek']}",'sessionIds':[s['id'] for s in sessions if s['facultyId']==f['id']],'facultyId':f['id'],'evidence':{'required':workloads[f['id']],'maximum':f['maxPeriodsPerWeek']}})
        return {'status':'INFEASIBLE','assignments':[],'diagnostics':diagnostics,'metrics':{'sessions':len(sessions),'candidates':sum(map(len,candidates.values())),'solverDurationMs':round((time.monotonic()-started)*1000)}}
    model=cp_model.CpModel(); var={}
    for sid,opts in candidates.items():
        for i,_ in enumerate(opts): var[sid,i]=model.new_bool_var(f'x_{sid}_{i}')
        model.add_exactly_one(var[sid,i] for i in range(len(opts)))
    # Indexed occupancy produces pairwise-free linear constraints.
    resource_slot=defaultdict(list); faculty_slot=defaultdict(list); cohort_slot=defaultdict(list)
    smap={s['id']:s for s in sessions}
    for sid,opts in candidates.items():
        s=smap[sid]
        for i,o in enumerate(opts):
            for slot in o['slotIds']:
                resource_slot[o['resourceId'],slot].append(var[sid,i]); faculty_slot[s['facultyId'],slot].append(var[sid,i])
                for atom in set(s['cohortAtomIds']): cohort_slot[atom,slot].append(var[sid,i])
    for index in (resource_slot,faculty_slot,cohort_slot):
        for values in index.values(): model.add_at_most_one(values)
    # Consecutive teaching limit, evaluated on actual atomic periods per day.
    slot_by_day=defaultdict(list)
    for sl in slots:
        if not sl.get('isBreak'): slot_by_day[sl['dayId']].append(sl)
    for f in faculty.values():
        maximum=f.get('maxConsecutive')
        if not maximum: continue
        for day in slot_by_day.values():
            day.sort(key=lambda x:x['index'])
            for i in range(len(day)-maximum):
                window=day[i:i+maximum+1]
                if all(window[j]['index']==window[j-1]['index']+1 for j in range(1,len(window))):
                    terms=[]
                    for sl in window: terms.extend(faculty_slot.get((f['id'],sl['id']),[]))
                    model.add(sum(terms)<=maximum)
    model.minimize(sum(v*candidates[sid][i]['penalty'] for (sid,i),v in var.items()))
    solver=cp_model.CpSolver(); solver.parameters.max_time_in_seconds=float(data.get('timeLimitSeconds',20)); solver.parameters.num_search_workers=8
    status=solver.solve(model)
    if status not in (cp_model.OPTIMAL,cp_model.FEASIBLE):
        return {'status':'INFEASIBLE','assignments':[],'diagnostics':[{'code':'GLOBAL_CONFLICT','message':'Every session has candidates, but no collision-free combination exists. Add time/resource capacity or relax an evidenced restriction.','sessionIds':[s['id'] for s in sessions],'evidence':{'sessions':len(sessions),'candidates':sum(map(len,candidates.values()))}}],'metrics':{'sessions':len(sessions),'candidates':sum(map(len,candidates.values())),'solverDurationMs':round((time.monotonic()-started)*1000)}}
    assignments=[]
    for (sid,i),v in var.items():
        if solver.value(v):
            o=candidates[sid][i]; assignments.append({'sessionId':sid,'resourceId':o['resourceId'],'slotIds':o['slotIds'],'score':-o['penalty']})
    slot_info={x['id']:x for x in slots}; resource_info={x['id']:x for x in resources}
    def gap_count(key_values):
        occupied=defaultdict(set)
        for a in assignments:
            for key in key_values(smap[a['sessionId']]):
                for sid in a['slotIds']: occupied[(key,slot_info[sid]['dayId'])].add(slot_info[sid]['index'])
        return sum((max(v)-min(v)+1-len(v)) for v in occupied.values() if v)
    faculty_gaps=gap_count(lambda session:[session['facultyId']]); student_gaps=gap_count(lambda session:session['cohortAtomIds'])
    movements=0
    for cohort in {x for session in sessions for x in session['cohortAtomIds']}:
        daily=defaultdict(list)
        for a in assignments:
            if cohort in smap[a['sessionId']]['cohortAtomIds']:
                first=slot_info[a['slotIds'][0]];daily[first['dayId']].append((first['index'],resource_info[a['resourceId']].get('buildingId')))
        for events in daily.values():
            events.sort();movements+=sum(1 for i in range(1,len(events)) if events[i-1][1] and events[i][1] and events[i-1][1]!=events[i][1])
    used_periods=sum(len(a['slotIds']) for a in assignments);available_periods=max(1,len(resources)*len([x for x in slots if not x.get('isBreak')]))
    metrics={'sessions':len(sessions),'scheduledSessions':len(assignments),'unscheduledSessions':0,'candidates':sum(map(len,candidates.values())),'objective':solver.objective_value,'solverDurationMs':round((time.monotonic()-started)*1000),'preferredResourceAssignments':sum(1 for a in assignments if resource_info[a['resourceId']].get('departmentId')==smap[a['sessionId']].get('preferredDepartmentId')),'fallbackResourceAssignments':sum(1 for a in assignments if resource_info[a['resourceId']].get('departmentId')!=smap[a['sessionId']].get('preferredDepartmentId')),'facultyGaps':faculty_gaps,'studentGaps':student_gaps,'buildingMovements':movements,'resourceUtilizationPercent':round(100*used_periods/available_periods,2)}
    return {'status':'OPTIMAL' if status==cp_model.OPTIMAL else 'FEASIBLE','assignments':assignments,'diagnostics':[],'metrics':metrics}

def main():
    try: print(json.dumps(solve(json.load(sys.stdin))))
    except Exception as exc: print(json.dumps({'status':'ERROR','assignments':[],'diagnostics':[{'code':'SCHEDULER_ERROR','message':str(exc),'sessionIds':[]}],'metrics':{}}))
if __name__=='__main__': main()
