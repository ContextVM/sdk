import { describe, expect, test } from 'bun:test';
import {
  evaluateCep8,
  parseJunit,
  type TestOutcome,
} from './conformance-report.js';
import {
  CEP8_GROUPS,
  CEP8_REQUIREMENTS,
  type Cep8Requirement,
} from './manifest.js';

const requirement = (
  overrides: Partial<Cep8Requirement> = {},
): Cep8Requirement => ({
  id: 'R',
  section: 's',
  strength: 'MUST',
  classification: 'protocol',
  role: 'server',
  lifecycle: 'both',
  transport: 'transport-independent',
  groups: ['G'],
  statement: 's',
  oracle: 'o',
  cases: [{ file: 'src/a.test.ts', test: 'a' }],
  ...overrides,
});
const passed: TestOutcome = {
  file: 'src/a.test.ts',
  test: 'a',
  status: 'passed',
};

describe('CEP-8 conformance report', () => {
  test('parses Bun JUnit cases, escaped names, failures, and skips', () => {
    const outcomes = parseJunit(`<testsuites>
      <testcase name="a &amp; &quot;b&quot; &lt;c&gt;" file="src/a.test.ts" />
      <testcase name="failed" file="src/a.test.ts"><failure type="AssertionError" /></testcase>
      <testcase name="skipped" file="src/a.test.ts"><skipped /></testcase>
    </testsuites>`);
    expect(outcomes).toEqual([
      { file: 'src/a.test.ts', test: 'a & "b" <c>', status: 'passed' },
      { file: 'src/a.test.ts', test: 'failed', status: 'failed' },
      { file: 'src/a.test.ts', test: 'skipped', status: 'skipped' },
    ]);
  });

  test('fails on missing, failing, or skipped mapped cases', () => {
    for (const [outcomes, status] of [
      [[], 'missing'],
      [[{ ...passed, status: 'failed' }], 'failed'],
      [[{ ...passed, status: 'skipped' }], 'skipped'],
    ] as const) {
      const report = evaluateCep8([requirement()], ['G'], outcomes);
      expect(report.ok).toBe(false);
      expect(report.requirements[0]!.status).toBe(status);
      expect(report.groups.G).toBe('uncovered');
    }
    expect(evaluateCep8([requirement()], ['G'], [passed]).ok).toBe(true);
  });

  test('refuses exceptions for mandatory protocol requirements and unmapped requirements', () => {
    const excepted = evaluateCep8(
      [requirement({ cases: [], notApplicable: 'not tested' })],
      ['G'],
      [],
    );
    expect(excepted.requirements[0]!.status).toBe('invalid_exception');
    const optional = evaluateCep8(
      [
        requirement({
          cases: [],
          notApplicable: 'not advertised',
          profile: 'x',
        }),
      ],
      ['G'],
      [],
    );
    expect(optional.ok).toBe(true);
    expect(optional.groups.G).toBe('not_applicable');
    expect(
      evaluateCep8([requirement({ cases: [] })], ['G'], []).requirements[0]!
        .status,
    ).toBe('unmapped');
    expect(evaluateCep8([], ['G'], []).groups.G).toBe('uncovered');
  });

  test('the manifest maps every work-plan group and uses unique requirement ids', () => {
    const ids = CEP8_REQUIREMENTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const mapped = new Set(CEP8_REQUIREMENTS.flatMap((entry) => entry.groups));
    for (const group of CEP8_GROUPS) expect(mapped.has(group)).toBe(true);
    for (const entry of CEP8_REQUIREMENTS)
      expect(entry.cases.length > 0 || entry.notApplicable !== undefined).toBe(
        true,
      );
  });
});
