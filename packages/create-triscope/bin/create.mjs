#!/usr/bin/env node
// `npm init triscope <dir>` — scaffold a new triscope project.
//
// Copies packages/create-triscope/template/ to <dir>, doing literal
// `__PROJECT_NAME__` substitution in package.json and the example skill.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATE = resolve(__dirname, '../template');

export function copyDir(src, dst, subs) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const sPath = join(src, entry);
    const dPath = join(dst, entry);
    const stat = statSync(sPath);
    if (stat.isDirectory()) {
      copyDir(sPath, dPath, subs);
    } else {
      let content = readFileSync(sPath);
      // Apply substitutions only to text files
      if (/\.(json|md|html|ts|js|mjs|cjs|css)$/.test(entry)) {
        let text = content.toString('utf8');
        for (const [k, v] of Object.entries(subs)) {
          text = text.split(k).join(v);
        }
        content = Buffer.from(text, 'utf8');
      }
      writeFileSync(dPath, content);
    }
  }
}

export function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npm init triscope <project-dir>');
    process.exit(2);
  }
  const target = resolve(process.cwd(), arg);
  if (existsSync(target) && readdirSync(target).length > 0) {
    console.error(`Refusing to scaffold into non-empty directory: ${target}`);
    process.exit(2);
  }
  const projectName = basename(target).replace(/[^A-Za-z0-9._-]/g, '-');
  const subs = { __PROJECT_NAME__: projectName };
  copyDir(TEMPLATE, target, subs);
  console.log(`Scaffolded ${projectName} at ${target}`);
  console.log('');
  console.log('Next steps:');
  console.log(`  cd ${arg}`);
  console.log('  npm install');
  console.log('  npm run dev        # open the lab in Chrome/Edge with WebGPU');
  console.log('  # then from another shell:');
  console.log('  npx triscope state .perf.fps');
  console.log('  npx triscope list');
}

// Only auto-run when invoked as a script (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
