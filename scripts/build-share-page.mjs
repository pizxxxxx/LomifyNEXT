import { build } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(workspace, 'docs', 'share');
if (!output.startsWith(`${workspace}${path.sep}`) || path.relative(workspace, output) !== path.join('docs', 'share')) throw new Error('Invalid share page output');
// Publish only this directory. The desktop bundle and account modules never enter it.
await build({ configFile: false, root: path.join(workspace, 'web-share'), base: './', build: { outDir: output, emptyOutDir: true } });
