import { deepClone, sanitizePlainText } from './util.js';

export class DiagnosticLog {
    constructor({ maxEntries = 100, now = () => Date.now() } = {}) {
        this.maxEntries = maxEntries;
        this.now = now;
        this.entries = [];
    }

    add(level, code, message, details = undefined) {
        const entry = {
            at: this.now(),
            level: String(level || 'info'),
            code: String(code || 'ST-STATE'),
            message: sanitizePlainText(message, { maxLength: 1000, preserveNewlines: false }),
        };
        if (details !== undefined) entry.details = deepClone(details);
        this.entries = [...this.entries, entry].slice(-this.maxEntries);
        return entry;
    }

    info(code, message, details) { return this.add('info', code, message, details); }
    warn(code, message, details) { return this.add('warning', code, message, details); }
    error(code, message, details) { return this.add('error', code, message, details); }

    list() { return deepClone(this.entries); }
    latest() { return this.entries.at(-1) ? deepClone(this.entries.at(-1)) : null; }
    clear() { this.entries = []; }
}


