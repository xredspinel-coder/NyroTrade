'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', '.git', 'logs']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
}

walk(root);

let failed = false;
for (const file of files) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    // CommonJS files in this project do not use top-level await, so Function
    // gives us a fast parse-only check without spawning another process.
    // eslint-disable-next-line no-new-func
    new Function(source);
  } catch (error) {
    failed = true;
    process.stderr.write(`Syntax check failed: ${path.relative(root, file)}\n`);
    process.stderr.write(`${error.stack || error.message}\n`);
  }
}

if (failed) {
  process.exit(1);
}

console.log(`Syntax OK (${files.length} files)`);
