#!/usr/bin/env bun
/**
 * Runs every test mapped by the CEP-8 manifest and reports case-level results.
 * Exits non-zero when a mapped case is missing, failing, or skipped, when a
 * coverage group is uncovered, or when the underlying test run fails.
 *
 * Usage: bun run test:cep8 [--report <path.json>]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CEP8_GROUPS,
  CEP8_PIN,
  CEP8_REQUIREMENTS,
} from '../src/__mocks__/cep8/manifest.js';
import {
  evaluateCep8,
  parseJunit,
} from '../src/__mocks__/cep8/conformance-report.js';

const files = [
  ...new Set(
    CEP8_REQUIREMENTS.flatMap((entry) => entry.cases.map((c) => c.file)),
  ),
];
const dir = mkdtempSync(join(tmpdir(), 'cep8-'));
const junitPath = join(dir, 'junit.xml');
const run = spawnSync(
  process.execPath,
  [
    'test',
    '--concurrent',
    '--timeout=60000',
    '--reporter=junit',
    `--reporter-outfile=${junitPath}`,
    ...files.map((file) => `./${file}`),
  ],
  {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
      // Funded provider qualification is a separate, explicitly enabled tier.
      NWC_INTEGRATION: 'false',
      LNBITS_INTEGRATION: 'false',
      ZAP_INTEGRATION: 'false',
    },
  },
);
let xml = '';
try {
  xml = readFileSync(junitPath, 'utf8');
} catch {
  console.error('CEP-8: the test run produced no JUnit report');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const report = evaluateCep8(CEP8_REQUIREMENTS, CEP8_GROUPS, parseJunit(xml));
const sdkRevision = spawnSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout?.trim();
console.log(
  `\nCEP-8 conformance — spec ${CEP8_PIN.repository}@${CEP8_PIN.revision.slice(0, 12)} (blob ${CEP8_PIN.blob.slice(0, 12)}), SDK ${sdkRevision || 'unknown'}, bun ${Bun.version}\n`,
);
for (const result of report.requirements) {
  const passedCases = result.cases.filter((entry) => entry.status === 'passed');
  console.log(
    `${result.status.toUpperCase().padEnd(17)} ${result.id.padEnd(13)} ${result.strength.padEnd(10)} ${result.classification.padEnd(14)} ${passedCases.length}/${result.cases.length}${result.reason ? `  (${result.reason})` : ''}`,
  );
  for (const entry of result.cases)
    if (entry.status !== 'passed')
      console.log(`    ${entry.status}: ${entry.file} › ${entry.test}`);
}
const uncovered = Object.entries(report.groups)
  .filter(([, status]) => status === 'uncovered')
  .map(([group]) => group);
const restricted = Object.entries(report.groups)
  .filter(([, status]) => status === 'not_applicable')
  .map(([group]) => group);
const counts = report.requirements.reduce<Record<string, number>>(
  (total, result) => ({
    ...total,
    [result.status]: (total[result.status] ?? 0) + 1,
  }),
  {},
);
console.log(
  `\nRequirements: ${JSON.stringify(counts)}; groups covered ${CEP8_GROUPS.length - uncovered.length - restricted.length}/${CEP8_GROUPS.length}` +
    (restricted.length ? `, restricted: ${restricted.join(', ')}` : '') +
    (uncovered.length ? `, UNCOVERED: ${uncovered.join(', ')}` : ''),
);

const reportIndex = process.argv.indexOf('--report');
if (reportIndex > 0 && process.argv[reportIndex + 1])
  writeFileSync(
    process.argv[reportIndex + 1]!,
    JSON.stringify(
      {
        pin: CEP8_PIN,
        sdkRevision,
        bun: Bun.version,
        testExitCode: run.status,
        ...report,
      },
      null,
      2,
    ),
  );

const ok = report.ok && run.status === 0;
console.log(ok ? 'CEP-8 conformance: PASS' : 'CEP-8 conformance: FAIL');
process.exit(ok ? 0 : 1);
