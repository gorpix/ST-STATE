import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const modules = [];
function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory() && !['node_modules', 'dist', '.git'].includes(entry.name)) walk(full);
        else if (entry.isFile() && full.endsWith('.js') && !full.includes(`${path.sep}test${path.sep}`) && !full.includes(`${path.sep}scripts${path.sep}`)) modules.push(full);
    }
}
walk(root);
for (const file of modules) await import(pathToFileURL(file));
console.log(`ST-STATE module typecheck/import check passed (${modules.length} modules).`);

