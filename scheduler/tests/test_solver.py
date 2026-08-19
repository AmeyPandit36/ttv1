import unittest
from scheduler.solve import solve

def fixture():
    return {
        'slots': [{'id': f'm{i}', 'dayId': 'm', 'index': i - 1, 'label': f'P{i}', 'start': '09', 'end': '10', 'isBreak': False} for i in range(1, 5)],
        'resources': [{'id': 'lab', 'name': 'Lab', 'type': 'LAB', 'capacity': 35, 'active': True, 'capabilities': ['Computers', 'SQL'], 'unavailableSlotIds': []}],
        'faculty': [{'id': 'f', 'name': 'Faculty', 'departmentId': 'd', 'maxPeriodsPerWeek': 8, 'maxConsecutive': 3, 'unavailableSlotIds': [], 'preferredSlotIds': [], 'eligibleSubjectIds': ['sub-db']}],
        'sessions': [{
            'id': 's', 'requirementId': 'r', 'subjectCode': 'DB', 'title': 'DB practical', 'facultyId': 'f',
            'cohortAtomIds': ['a1'], 'participantCount': 30, 'duration': 2, 'sessionType': 'PRACTICAL',
            'resourceType': 'LAB', 'requiredCapabilities': ['sql'], 'preferredCapabilities': [],
            'preferredDepartmentId': 'd', 'subjectId': 'sub-db'
        }],
        'policies': [],
        'timeLimitSeconds': 2
    }

class SolverTests(unittest.TestCase):
    def test_schedules_continuous_eligible_block(self):
        result = solve(fixture())
        self.assertIn(result['status'], ['OPTIMAL', 'FEASIBLE'])
        self.assertEqual(len(result['assignments'][0]['slotIds']), 2)

    def test_infeasible_has_grounded_diagnostic(self):
        data = fixture()
        data['resources'][0]['capacity'] = 20
        result = solve(data)
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertIn('insufficient capacity', result['diagnostics'][0]['evidence'])

    def test_combined_class_blocks_participant(self):
        data = fixture()
        data['resources'].append({**data['resources'][0], 'id': 'lab2'})
        data['faculty'].append({**data['faculty'][0], 'id': 'f2'})
        data['sessions'] = [
            {**data['sessions'][0], 'id': 'combined', 'cohortAtomIds': ['a1', 'b1'], 'facultyId': 'f2'},
            {**data['sessions'][0], 'id': 'batch', 'cohortAtomIds': ['a1']}
        ]
        result = solve(data)
        assignments = result['assignments']
        self.assertFalse(set(assignments[0]['slotIds']) & set(assignments[1]['slotIds']))

    def test_hard_workload(self):
        data = fixture()
        data['faculty'][0]['maxPeriodsPerWeek'] = 1
        result = solve(data)
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertEqual(result['diagnostics'][0]['code'], 'WORKLOAD_EXCEEDED')

    def test_faculty_eligibility(self):
        data = fixture()
        data['sessions'][0]['subjectId'] = 'sub-other'
        result = solve(data)
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertIn('faculty ineligible', result['diagnostics'][0]['evidence'])

    def test_required_resource(self):
        data = fixture()
        data['resources'].append({**data['resources'][0], 'id': 'lab2', 'capacity': 80})
        data['sessions'][0]['requiredResourceId'] = 'lab'
        result = solve(data)
        self.assertIn(result['status'], ['OPTIMAL', 'FEASIBLE'])
        self.assertEqual(result['assignments'][0]['resourceId'], 'lab')

    def test_minimum_capacity(self):
        data = fixture()
        data['sessions'][0]['minCapacity'] = 80
        result = solve(data)
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertIn('insufficient capacity', result['diagnostics'][0]['evidence'])

    def test_hard_daily_policy(self):
        data = fixture()
        data['policies'] = [{
            'id': 'daily', 'name': 'Max one', 'type': 'MAX_DAILY_PERIODS', 'strength': 'HARD',
            'weight': 20, 'scope': {}, 'parameters': {'maxPeriods': 1}, 'active': True
        }]
        result = solve(data)
        self.assertEqual(result['status'], 'INFEASIBLE')

    def test_soft_preference_influences_objective(self):
        data = fixture()
        data['resources'] = [
            {**data['resources'][0], 'id': 'fallback', 'departmentId': 'other'},
            {**data['resources'][0], 'id': 'preferred', 'departmentId': 'd'}
        ]
        data['policies'] = [{
            'id': 'pref', 'name': 'Prefer preferred', 'type': 'RESOURCE_PREFERENCE', 'strength': 'SOFT',
            'weight': 25, 'scope': {}, 'parameters': {'preferredResourceIds': ['preferred']}, 'active': True
        }]
        result = solve(data)
        self.assertIn(result['status'], ['OPTIMAL', 'FEASIBLE'])
        self.assertEqual(result['assignments'][0]['resourceId'], 'preferred')

    def test_large_scale_benchmark(self):
        """P3: Large scale college benchmark test."""
        import random
        slots = []
        days = ['mon', 'tue', 'wed', 'thu', 'fri']
        for day in days:
            for idx in range(6):
                slots.append({
                    'id': f'{day}-{idx+1}',
                    'dayId': day,
                    'index': idx,
                    'label': f'{day.capitalize()} P{idx+1}',
                    'start': f'{9+idx:02d}:00',
                    'end': f'{10+idx:02d}:00',
                    'isBreak': idx == 3 # Period 4 is lunch break
                })

        resources = []
        for i in range(1, 11):
            resources.append({
                'id': f'room-{i}',
                'name': f'Classroom {100+i}',
                'type': 'CLASSROOM',
                'capacity': 60 if i % 2 == 0 else 40,
                'active': True,
                'capabilities': ['Projector'] if i % 3 == 0 else [],
                'unavailableSlotIds': []
            })

        faculty_list = []
        for i in range(1, 16):
            faculty_list.append({
                'id': f'fac-{i}',
                'name': f'Professor {i}',
                'departmentId': f'dept-{i % 3}',
                'maxPeriodsPerWeek': 18,
                'maxConsecutive': 3,
                'unavailableSlotIds': ['mon-1'] if i % 5 == 0 else [],
                'preferredSlotIds': [],
                'eligibleSubjectIds': [f'sub-{i}', f'sub-{i+1}']
            })

        sessions = []
        for i in range(1, 31):
            fac_id = f'fac-{(i % 15) + 1}'
            sessions.append({
                'id': f'session-{i}',
                'requirementId': f'req-{i}',
                'subjectCode': f'CS{100+i}',
                'title': f'Course {i} Lecture',
                'facultyId': fac_id,
                'cohortAtomIds': [f'cohort-{(i % 5) + 1}'],
                'participantCount': 30,
                'duration': 1,
                'sessionType': 'LECTURE',
                'resourceType': 'CLASSROOM',
                'requiredCapabilities': [],
                'preferredCapabilities': [],
                'preferredDepartmentId': f'dept-{(i % 3)}',
                'subjectId': f'sub-{(i % 15) + 1}'
            })

        data = {
            'slots': slots,
            'resources': resources,
            'faculty': faculty_list,
            'sessions': sessions,
            'policies': [{
                'id': 'pref-it',
                'name': 'Prefer department rooms',
                'type': 'RESOURCE_PREFERENCE',
                'strength': 'SOFT',
                'weight': 8,
                'scope': {},
                'parameters': {'preferredResourceIds': ['room-1', 'room-2']},
                'active': True
            }],
            'timeLimitSeconds': 5
        }

        import json
        result = solve(data)
        if result['status'] == 'INFEASIBLE':
            print("INFEASIBLE DIAGS:", json.dumps(result['diagnostics'], indent=2))
        self.assertIn(result['status'], ['OPTIMAL', 'FEASIBLE'])
        self.assertEqual(len(result['assignments']), len(sessions))
        self.assertGreater(result['metrics']['resourceUtilizationPercent'], 0)

if __name__ == '__main__':
    unittest.main()
