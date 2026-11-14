import type { Cep8Case, Cep8Requirement } from './manifest.js';

/** One executed test as reported by `bun test --reporter=junit`. */
export interface TestOutcome {
  file: string;
  test: string;
  status: 'passed' | 'failed' | 'skipped';
}

export type CaseStatus = 'passed' | 'failed' | 'skipped' | 'missing';
export type RequirementStatus =
  CaseStatus | 'not_applicable' | 'unmapped' | 'invalid_exception';

export interface RequirementResult {
  id: string;
  strength: Cep8Requirement['strength'];
  classification: Cep8Requirement['classification'];
  groups: string[];
  status: RequirementStatus;
  cases: Array<Cep8Case & { status: CaseStatus }>;
  reason?: string;
}

export interface Cep8Report {
  ok: boolean;
  requirements: RequirementResult[];
  groups: Record<string, 'covered' | 'not_applicable' | 'uncovered'>;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};
const unescapeXml = (value: string): string =>
  value.replace(/&(#x?[0-9a-f]+|\w+);/gi, (entity, code: string) =>
    code.startsWith('#')
      ? String.fromCodePoint(
          parseInt(
            code.slice(code[1] === 'x' ? 2 : 1),
            code[1] === 'x' ? 16 : 10,
          ),
        )
      : (ENTITIES[code] ?? entity),
  );

/** Extracts test outcomes from Bun's JUnit report. */
export function parseJunit(xml: string): TestOutcome[] {
  const outcomes: TestOutcome[] = [];
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const [, attributes = '', , body = ''] of xml.matchAll(pattern)) {
    const attribute = (name: string): string =>
      unescapeXml(
        new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? '',
      );
    outcomes.push({
      file: attribute('file'),
      test: attribute('name'),
      status: /<(failure|error)\b/.test(body)
        ? 'failed'
        : /<skipped\b/.test(body)
          ? 'skipped'
          : 'passed',
    });
  }
  return outcomes;
}

const SEVERITY: CaseStatus[] = ['failed', 'missing', 'skipped', 'passed'];

/**
 * Maps outcomes onto the manifest. Every mapped case must pass; mandatory
 * protocol requirements cannot be excepted unless tied to an optional profile.
 */
export function evaluateCep8(
  requirements: readonly Cep8Requirement[],
  groups: readonly string[],
  outcomes: readonly TestOutcome[],
): Cep8Report {
  const caseStatus = (entry: Cep8Case): CaseStatus => {
    const matches = outcomes.filter(
      (outcome) => outcome.file === entry.file && outcome.test === entry.test,
    );
    if (matches.length === 0) return 'missing';
    if (matches.some((outcome) => outcome.status === 'failed')) return 'failed';
    return matches.some((outcome) => outcome.status === 'skipped')
      ? 'skipped'
      : 'passed';
  };
  const results = requirements.map((requirement): RequirementResult => {
    const cases = requirement.cases.map((entry) => ({
      ...entry,
      status: caseStatus(entry),
    }));
    const base = {
      id: requirement.id,
      strength: requirement.strength,
      classification: requirement.classification,
      groups: requirement.groups,
      cases,
    };
    if (requirement.notApplicable !== undefined) {
      const mandatory =
        requirement.classification === 'protocol' &&
        ['MUST', 'MUST NOT', 'DEFINITION'].includes(requirement.strength) &&
        requirement.profile === undefined;
      return {
        ...base,
        status:
          mandatory || cases.length > 0
            ? 'invalid_exception'
            : 'not_applicable',
        reason: requirement.notApplicable,
      };
    }
    if (cases.length === 0) return { ...base, status: 'unmapped' };
    return {
      ...base,
      status:
        SEVERITY.find((status) =>
          cases.some((entry) => entry.status === status),
        ) ?? 'missing',
    };
  });
  const coverage = Object.fromEntries(
    groups.map((group) => {
      const owners = results.filter((result) => result.groups.includes(group));
      const status =
        owners.length > 0 &&
        owners.every((result) => result.status === 'not_applicable')
          ? 'not_applicable'
          : owners.some((result) => result.status === 'passed') &&
              owners.every((result) =>
                ['passed', 'not_applicable'].includes(result.status),
              )
            ? 'covered'
            : 'uncovered';
      return [group, status];
    }),
  ) as Cep8Report['groups'];
  return {
    ok:
      results.every((result) =>
        ['passed', 'not_applicable'].includes(result.status),
      ) && Object.values(coverage).every((status) => status !== 'uncovered'),
    requirements: results,
    groups: coverage,
  };
}
