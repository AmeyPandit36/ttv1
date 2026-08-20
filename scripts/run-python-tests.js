import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const candidates = [
  process.env.PYTHON,
  process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python',
  'python3',
  'python'
].filter(Boolean);

const python = candidates.find(candidate => {
  if (!candidate) return false;
  return candidate.includes('/') || candidate.includes('\\') ? existsSync(candidate) : true;
});

if (!python) {
  console.error('Unable to locate Python. Create .venv or set PYTHON=/path/to/python.');
  process.exit(1);
}

const result = spawnSync(python, ['-m', 'unittest', 'discover', 'scheduler/tests'], {
  stdio: 'inherit'
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
