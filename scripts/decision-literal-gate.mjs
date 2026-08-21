import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const args = new Set(process.argv.slice(2));
const CONFIGURATION_ERROR_EXIT = 2;

const valueAfter = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
};
const blocking = args.has('--blocking');
const quotedLiteral = /(['"`])(?:APPROVED|ALLOWED)\1/g;

const walk = (absolute, files) => {
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) walk(child, files);
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) files.push(child);
  }
};

const loadGate = () => {
  const root = resolve(valueAfter('--root', process.cwd()));
  const configPath = resolve(root, valueAfter('--config', 'decision-literal-allowlist.json'));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('configuration must be a JSON object.');
  }
  if (
    !Array.isArray(config.runtimePaths) ||
    config.runtimePaths.length === 0 ||
    config.runtimePaths.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new Error('runtimePaths must be a non-empty string array.');
  }
  if (
    !Array.isArray(config.allowedFiles) ||
    config.allowedFiles.some((entry) =>
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.path !== 'string' ||
      entry.path.length === 0)
  ) {
    throw new Error('allowedFiles must be an array of objects with non-empty path values.');
  }

  const allowed = new Set(config.allowedFiles.map((entry) => entry.path));
  const files = [];
  for (const runtimePath of config.runtimePaths) {
    const absolute = resolve(root, runtimePath);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      throw new Error(`declared runtime path does not exist: ${runtimePath}`);
    }
    if (stats.isDirectory()) walk(absolute, files);
    else if (stats.isFile()) files.push(absolute);
    else throw new Error(`declared runtime path is not a file or directory: ${runtimePath}`);
  }

  const violations = [];
  for (const file of files) {
    const repoPath = relative(root, file).split('\\').join('/');
    if (allowed.has(repoPath)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      quotedLiteral.lastIndex = 0;
      if (quotedLiteral.test(lines[index])) {
        violations.push(`${repoPath}:${index + 1}:${lines[index].trim()}`);
      }
    }
  }
  return violations;
};

let violations;
try {
  violations = loadGate();
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown configuration fault';
  console.error(`decision-literal-gate: configuration error: ${message}`);
  process.exit(CONFIGURATION_ERROR_EXIT);
}

if (violations.length === 0) {
  console.log('decision-literal-gate: 0 violations');
  process.exit(0);
}
console.error(`decision-literal-gate: ${violations.length} violation(s)`);
for (const violation of violations) console.error(violation);
process.exit(blocking ? 1 : 0);
