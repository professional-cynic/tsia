#!/usr/bin/env node
// Bumps the version in package.json, src-tauri/Cargo.toml, and
// src-tauri/tauri.conf.json to the value passed as argv[2].
// Run via `npm run bump 0.3.1` (script defined in package.json).

import { readFileSync, writeFileSync } from 'node:fs';

const v = process.argv[2];
if (!v || !/^\d+\.\d+\.\d+$/.test(v)) {
  console.error('Usage: npm run bump <X.Y.Z>');
  process.exit(1);
}

// package.json — JSON, so parse/edit/serialise to preserve formatting
// of other fields (mostly).
const pkgPath = 'package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = v;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// src-tauri/Cargo.toml — line-based edit. We avoid pulling in a TOML
// parser for one field; the regex anchors on the [package] section's
// version line, not any dependency's.
const cargoPath = 'src-tauri/Cargo.toml';
const cargo = readFileSync(cargoPath, 'utf8');
const VERSION_RE = /^(version\s*=\s*)"[^"]+"/m;
if (!VERSION_RE.test(cargo)) {
  console.error(`Could not find version line in ${cargoPath}`);
  process.exit(1);
}
const cargoUpdated = cargo.replace(VERSION_RE, `$1"${v}"`);
writeFileSync(cargoPath, cargoUpdated);

// src-tauri/tauri.conf.json — JSON.
const confPath = 'src-tauri/tauri.conf.json';
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
conf.version = v;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

console.log(`Bumped to ${v} in package.json, Cargo.toml, tauri.conf.json`);
