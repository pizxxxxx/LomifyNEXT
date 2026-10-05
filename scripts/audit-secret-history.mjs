import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

// Print locations only. Never print a matching line or credential value.
const git = (args, input, binary = false) => {
  const result = spawnSync('git', args, { input, encoding: binary ? undefined : 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Git audit failed (${args[0]})`);
  return result.stdout;
};
const entries = git(['rev-list', '--objects', '--all']).trim().split('\n').map((line) => {
  const space = line.indexOf(' ');
  return { oid: line.slice(0, space), path: line.slice(space + 1) };
}).filter((entry) => /\.(?:rs|ts|js|mjs|svelte|json|toml|md|txt|ya?ml|env|example)$/i.test(entry.path) || /(?:^|\/)\.env(?:\.|$)/.test(entry.path));
const objects = git(['cat-file', '--batch'], entries.map((entry) => entry.oid).join('\n') + '\n', true);
const patterns = [
  /\b(?:access[_-]?token|refresh[_-]?token|yandexToken|session[_-]?key|shared[_-]?secret|client[_-]?secret|sessionId)["']?\s*[:=]\s*["']([a-z0-9._~+/=-]{20,})["']/gi,
  /\btoken["']?\s*[:=]\s*["']([a-z0-9._~+/=-]{32,})["']/gi,
  /(?:VITE_)?LASTFM_SHARED_SECRET\s*=\s*["']?([a-z0-9]{20,})/gi,
  /(?:OAuth|Bearer)\s+(y0__[a-z0-9_-]{15,}|eyJ[a-z0-9_.-]{30,})/gi,
  /\b(y0__[a-z0-9_-]{24,})\b/gi
];
let offset = 0;
let scanned = 0;
const findings = [];
for (const entry of entries) {
  const newline = objects.indexOf(10, offset);
  const header = objects.subarray(offset, newline).toString('utf8').split(' ');
  const length = Number(header[2]);
  offset = newline + 1;
  const data = objects.subarray(offset, offset + length);
  offset += length + 1;
  if (header[1] !== 'blob' || data.includes(0)) continue;
  scanned++;
  const text = data.toString('utf8');
  text.split('\n').forEach((line, i) => {
    if (patterns.some((pattern) => { pattern.lastIndex = 0; return pattern.test(line); })) {
      findings.push({ path: entry.path, line: i + 1, blob: entry.oid.slice(0, 12) });
    }
  });
}
let workingFiles = 0;
const current = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0');
for (const path of new Set(current)) {
  if (!path || /(?:^|\/)(?:node_modules|target|build|build_output|dist|\.svelte-kit)\//.test(path) || !/\.(?:rs|ts|js|mjs|svelte|json|toml|md|txt|ya?ml|env|example)$/i.test(path)) continue;
  if (!fs.existsSync(path)) continue;
  const data = fs.readFileSync(path);
  if (data.includes(0)) continue;
  workingFiles++;
  data.toString('utf8').split('\n').forEach((line, index) => {
    if (patterns.some((pattern) => { pattern.lastIndex = 0; return pattern.test(line); })) findings.push({ path, line: index + 1, workingTree: true });
  });
}
console.log(JSON.stringify({ scannedHistoricalTextBlobs: scanned, scannedWorkingTextFiles: workingFiles, potentialSecrets: findings }, null, 2));
