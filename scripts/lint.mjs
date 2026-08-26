import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const files = [];
function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
        else if (entry.isFile() && full.endsWith('.js')) files.push(full);
    }
}
walk(root);
for (const file of files) execFileSync(node, ['--check', file], { stdio: 'inherit' });
const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
if (/messageFormatter\s*\.addHook|<script\s+src=|express\s*\(/i.test(source)) throw new Error('Forbidden staging/server integration detected');
console.log(`FF5 lint check passed (${files.length} files).`);

