import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const required = ['display_name', 'js', 'author', 'version'];
for (const key of required) if (!manifest[key]) throw new Error(`manifest.json missing ${key}`);
for (const file of [manifest.js, manifest.css]) {
    if (!file) continue;
    if (!fs.existsSync(path.join(root, file))) throw new Error(`manifest file not found: ${file}`);
}
const sourceFiles = [];
function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
        else if (entry.isFile() && full.endsWith('.js')) sourceFiles.push(full);
    }
}
walk(root);
console.log(`FF5 extension build check passed (${sourceFiles.length} JavaScript modules; plain ES modules, no bundle).`);

