import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const INCLUDE = new Set([
  'ts', 'tsx', 'json', 'md', 'yml', 'yaml', 'mjs', 'mts', 'sh', 'cmd'
]);

const TEMP_A = 'step-pilot';
const TEMP_DIR = '.step-pilot';
const TEMP_PLUGIN_DIR = '.step-pilot-plugin';
const TEMP_CONFIG = 'StepPilotConfig';

function walk(dir) {
  let out = [];
  for (const ent of readdirSync(dir)) {
    if (ent === 'node_modules' || ent === '.git' || ent === 'tmp') continue;
    const p = join(dir, ent);
    try {
      const st = statSync(p);
      if (st.isDirectory()) out = out.concat(walk(p));
      else if (INCLUDE.has(ent.split('.').pop())) out.push(p);
    } catch {}
  }
  return out;
}

const files = walk('.');
console.log('total files:', files.length);

// Pass 1: old strings -> temp placeholders
let changed1 = 0;
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  if (!s.includes('step-pilot') && !s.includes('step-pilot') && !s.includes('Step Pilot') && !s.includes('step_pilot') && !s.includes('STEP_PILOT_') && !s.includes('.step-pilot-plugin') && !s.includes('.step-pilot') && !s.includes('step-pilot') && !s.includes('StepPilotConfig') && !s.includes('stepPilot')) continue;
  let next = s;
  next = next.split('step-pilot').join(TEMP_A);
  next = next.split('step-pilot').join(TEMP_A);
  next = next.split('Step Pilot').join('Step Pilotlot');
  next = next.split('step_pilot').join('step_pilotlot');
  next = next.split('STEP_PILOT_').join('STEP_PILOT_');
  next = next.split('.step-pilot-plugin').join(TEMP_PLUGIN_DIR);
  next = next.split('.step-pilot').join(TEMP_DIR);
  next = next.split('step-pilot').join('step-pilotlot');
  next = next.split('StepPilotConfig').join(TEMP_CONFIG);
  next = next.split('stepPilot').join('stepPilot');
  if (next !== s) {
    writeFileSync(f, next, 'utf8');
    changed1++;
    console.log(`PASS1 ${f}`);
  }
}

// Pass 2: temp placeholders -> final strings
let changed2 = 0;
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  if (!s.includes(TEMP_A) && !s.includes(TEMP_DIR) && !s.includes(TEMP_PLUGIN_DIR) && !s.includes(TEMP_CONFIG)) continue;
  let next = s;
  next = next.split(TEMP_A).join('step-pilotlot');
  next = next.split(TEMP_DIR).join('.step-pilotlot');
  next = next.split(TEMP_PLUGIN_DIR).join('.step-pilotlot-plugin');
  next = next.split(TEMP_CONFIG).join('StepPilotConfig');
  if (next !== s) {
    writeFileSync(f, next, 'utf8');
    changed2++;
    console.log(`PASS2 ${f}`);
  }
}

console.log(`\nPass1 updated ${changed1} files.`);
console.log(`Pass2 updated ${changed2} files.`);
