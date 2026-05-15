#!/usr/bin/env node
// ══════════════════════════════════════════════════════
// build.js — bundles tsia/ into a single annotator.html
// Usage: node build.js
// ══════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// Module load order — respects dependency graph (leaves first)
const MODULE_ORDER = [
  'js/constants.js',
  'js/utils.js',
  'js/state.js',
  'js/storage.js',
  'js/canvas.js',
  'js/boxes.js',
  'js/annotate-ui.js',
  'js/navigation.js',
  'js/screens.js',
  'js/projects.js',
  'js/import.js',
  'js/export.js',
  'js/interaction.js',
  'js/main.js',
];

// Read and strip import/export statements from a module
function processModule(filePath) {
  const full = path.join(ROOT, filePath);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const out = [];
  let inImport = false;

  for (const line of lines) {
    // Detect start of import statement
    if (/^\s*import\s+/.test(line)) {
      // Single-line import (has 'from' and closing quote on same line, or bare import)
      if (/from\s+['"]/.test(line) || /^import\s+['"]/.test(line)) {
        continue; // skip entire line
      }
      // Multiline import — start skipping
      inImport = true;
      continue;
    }
    // If inside multiline import, skip until we see the 'from' line
    if (inImport) {
      if (/from\s+['"]/.test(line)) {
        inImport = false;
      }
      continue;
    }
    // Strip "export " prefix from declarations
    let processed = line.replace(/^export\s+(function|const|let|var|async\s+function)/, '$1');
    // Skip "export { ... }" lines
    if (/^\s*export\s*\{/.test(processed)) continue;
    // Strip "export default"
    processed = processed.replace(/^export\s+default\s+/, '');
    out.push(processed);
  }

  return `// ── ${filePath} ──\n${out.join('\n').trim()}\n`;
}

// Read HTML template
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Read CSS
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

// Bundle all JS modules
const js = MODULE_ORDER.map(m => processModule(m)).join('\n');

// Replace <link rel="stylesheet" ...> with inline <style>
html = html.replace(
  /<link\s+rel="stylesheet"\s+href="style\.css"\s*\/?>/,
  `<style>\n${css}</style>`
);

// Replace <script type="module" src="js/main.js"></script> with inline <script>
html = html.replace(
  /<script\s+type="module"\s+src="js\/main\.js"\s*><\/script>/,
  `<script>\n${js}</script>`
);

// Write output
const out = path.join(ROOT, 'annotator.html');
fs.writeFileSync(out, html, 'utf8');

const lines = html.split('\n').length;
console.log(`Built ${out} (${lines} lines, ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
