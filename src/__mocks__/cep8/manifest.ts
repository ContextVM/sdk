/**
 * Test-only CEP-8 requirement manifest. Every case names an exact test; the
 * `test:cep8` runner fails when a mapped case is missing, failing, or skipped.
 */

/** Authoritative specification revision for this manifest. */
export const CEP8_PIN = {
  repository: 'ContextVM/contextvm-docs',
  revision: '3b4f9dc9f9012a418abd9faec6a70db774754862',
  path: 'src/content/docs/reference/ceps/cep-8.md',
  blob: 'a17cf3d25c88608692a63d3ebb8d7547ecddc453',
} as const;

/** Normative keyword, or `DEFINITION` for wire formats the CEP specifies. */
export type Strength =
  'DEFINITION' | 'MUST' | 'MUST NOT' | 'SHOULD' | 'SHOULD NOT' | 'MAY';

/**
 * `protocol`: an applicable CEP-8 requirement. `recommendation`: a SHOULD the
 * SDK implements. `optional`: required only when advertised. `sdk-policy`: a
 * stronger local guarantee. `provider`: a concrete payment-adapter contract.
 */
export type Classification =
  'protocol' | 'recommendation' | 'optional' | 'sdk-policy' | 'provider';

export interface Cep8Case {
  /** Repository-relative test file. */
  file: string;
  /** Exact test name as reported by `bun test`. */
  test: string;
}

export interface Cep8Requirement {
  id: string;
  /** Specification section, or the SDK/provider contract it qualifies. */
  section: string;
  strength: Strength;
  classification: Classification;
  role: 'server' | 'client' | 'both' | 'payment-handler' | 'payment-processor';
  lifecycle: 'transparent' | 'explicit_gating' | 'both' | 'negotiation';
  /** Transport profiles exercised by the mapped cases. */
  transport: 'cleartext' | 'all-encryption-modes' | 'transport-independent';
  /** Optional profile that must be advertised before the requirement applies. */
  profile?: string;
  /** Work-plan coverage groups (C01–C12, F01–F16, P01–P08). */
  groups: string[];
  statement: string;
  /** Expected observable outcome asserted by the mapped cases. */
  oracle: string;
  /** Fixture or deterministic fault schedule, when one is used. */
  schedule?: string;
  cases: Cep8Case[];
  /** Explicit applicability exception; only for non-mandatory or unadvertised scope. */
  notApplicable?: string;
}

const tests =
  (file: string) =>
  (...names: string[]): Cep8Case[] =>
    names.map((test) => ({ file: `src/${file}`, test }));

const conformance = tests('payments/cep8-conformance.e2e.test.ts');
const faults = tests('payments/cep8-delivery-faults.e2e.test.ts');
const providers = tests('payments/cep8-provider-contracts.test.ts');
const bolt11 = tests('payments/bolt11.test.ts');
const flow = tests('transport/payments-flow.test.ts');
const gating = tests('payments/server-explicit-gating.test.ts');
const serverPayments = tests('payments/server-payments.test.ts');
const validation = tests('payments/server-payment-validation.test.ts');
const reliability = tests('payments/server-payment-reliability.test.ts');
const recovery = tests('payments/payment-recovery.test.ts');
const store = tests('payments/authorization-store.test.ts');
const grants = tests('payments/expired-payment-grants.test.ts');
const identity = tests('payments/canonical-identity.test.ts');
const client = tests('payments/client-payments.test.ts');
const clientReliability = tests('payments/client-payments-reliability.test.ts');
const clientLimits = tests('payments/client-payments-limits.test.ts');
const settlement = tests('payments/processors/settlement-recovery.test.ts');
const nwc = tests(
  'payments/processors/ln-bolt11-nwc-payment-processor.test.ts',
);
const shutdown = tests('payments/server-transport-payments.shutdown.test.ts');
const stateRecovery = tests('transport/payment-state-recovery.e2e.test.ts');
const PROFILES = ['cleartext', 'persistent', 'ephemeral'] as const;
const each = (name: (profile: string) => string): string[] =>
  PROFILES.map(name);

export const CEP8_REQUIREMENTS: readonly Cep8Requirement[] = [
  {
    id: 'CEP8-R01',
    section: 'New Tags Introduced / cap Tag',
    strength: 'DEFINITION',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['C01'],
    statement:
      'Pricing uses typed capability identifiers with integer or inclusive-range prices and a unit label.',
    oracle:
      'Announcements and list responses carry tool:/prompt:/resource: cap tags with "<n>" or "<min>-<max>" prices.',
    cases: [
      ...tests('payments/cap-tags.test.ts')(
        'builds CEP-8 cap tags for tools, prompts, and resources',
        'uses range price format when maxAmount is provided',
        'skips unsupported methods and unnamed capabilities',
      ),
      ...tests('transport/nostr-server-transport.test.ts')(
        'should include server PMI and cap tags in announcement and tools list events when payments are configured',
      ),
    ],
  },
  {
    id: 'CEP8-R02',
    section: 'cap Tag / Notes',
    strength: 'MAY',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['C01'],
    statement:
      'The cap price is a reference; the requested amount may be any value inside the advertised inclusive range.',
    oracle:
      'Quotes at both endpoints are accepted; out-of-range quotes fail before processor work; dynamic quotes reach the offer.',
    cases: [
      ...validation(
        'inclusive quote endpoints are valid; fixed quotes cannot change their advertised amount',
        'rejects malformed/out-of-range quotes and changed units before processor work',
      ),
      ...flow(
        'explicit gating: resolvePrice quotes a dynamic amount that reaches createPaymentRequired',
      ),
      ...tests('payments/resolve-price.test.ts')(
        'uses resolvePrice quote amount + merges meta into payment_required._meta (quote wins)',
      ),
    ],
  },
  {
    id: 'CEP8-R03',
    section: 'Scope and Non-goals / currency conversion',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'server',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['C10'],
    statement:
      'Conversion is implementation-defined; the SDK never converts units implicitly.',
    oracle:
      'Processors or quotes in another unit are refused before an invoice is created.',
    cases: validation(
      'rejects incompatible native processor units before invoice creation',
      'rejects malformed/out-of-range quotes and changed units before processor work',
    ),
  },
  {
    id: 'CEP8-R04',
    section: 'PMI Format and Registry',
    strength: 'MUST',
    classification: 'protocol',
    role: 'both',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['C02'],
    statement:
      'PMIs the SDK defines follow the W3C pattern [a-z0-9-]+. Application-chosen PMIs remain the application’s responsibility.',
    oracle: 'Built-in PMI constants match the pattern.',
    cases: conformance(
      '[C02] built-in and test-rail PMIs satisfy the CEP-8 PMI pattern',
    ),
  },
  {
    id: 'CEP8-R05',
    section: 'PMI boundaries (what PMI defines)',
    strength: 'MUST',
    classification: 'protocol',
    role: 'payment-handler',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['C02', 'C09'],
    statement:
      'A payment handler interprets pay_req according to the exact PMI; unsupported PMIs are not handled.',
    oracle:
      'Offers for an unsupported PMI never reach a handler; identical payloads under different PMIs stay independent.',
    cases: [
      ...client('ignores payment_required notifications for unsupported PMI'),
      ...clientReliability(
        'different PMIs with the same opaque request remain independent',
      ),
    ],
  },
  {
    id: 'CEP8-R06',
    section: 'PMI boundaries / _meta',
    strength: 'MUST',
    classification: 'protocol',
    role: 'client',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['C09'],
    statement: 'Unknown _meta fields are ignored.',
    oracle:
      'Unknown metadata is preserved and does not change validation or payment decisions.',
    cases: clientLimits(
      'unknown metadata is preserved without influencing validation',
    ),
  },
  {
    id: 'CEP8-R07',
    section: 'Opaque PMI acceptance',
    strength: 'MAY',
    classification: 'sdk-policy',
    role: 'both',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['C02'],
    statement:
      'The SDK matches PMIs exactly as opaque identifiers on ingress, including W3C URL-based methods.',
    oracle:
      'Non-kebab PMIs match exactly in offers, handlers, and limits without normalization.',
    cases: [
      ...tests('payments/payment-option-schema.test.ts')(
        'PMIs match exactly across client and server boundaries (bitcoin-lightning-bolt11, length=24)',
        'PMIs match exactly across client and server boundaries (https://wallet.example/method, length=29)',
      ),
      ...clientLimits(
        'accepts a non-kebab PMI in transparent offers, handlers, and amount limits',
      ),
    ],
  },
  {
    id: 'CEP8-R08',
    section: 'Transparent lifecycle / Payment processing and completion',
    strength: 'SHOULD',
    classification: 'recommendation',
    role: 'server',
    lifecycle: 'transparent',
    transport: 'cleartext',
    groups: ['C02'],
    statement:
      'With client PMIs, send at most one payment_required using a PMI from the intersection.',
    oracle:
      'Client preference selects the processor; disjoint sets are refused before invoice creation or wallet work.',
    cases: [
      ...flow(
        'PMI selection: client preference wins when intersection exists',
        'PMI selection: disjoint sets refuse before invoice creation or wallet work',
      ),
      ...validation(
        'honors advertised PMI preference, refuses disjoint sets, and permits absent PMIs',
        'disjoint PMI sets never reach invoice creation',
      ),
    ],
  },
  {
    id: 'CEP8-R09',
    section: 'Transparent lifecycle / Payment processing and completion',
    strength: 'MAY',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'transparent',
    transport: 'cleartext',
    groups: ['C02'],
    statement:
      'Without client PMIs the server may send several offers; the SDK sends one using server order.',
    oracle: 'The first configured processor issues the single offer.',
    cases: flow(
      'PMI selection: when client advertises none, uses server order',
    ),
  },
  {
    id: 'CEP8-R10',
    section: 'PMI Discovery / Stateless operation',
    strength: 'SHOULD',
    classification: 'recommendation',
    role: 'client',
    lifecycle: 'both',
    transport: 'cleartext',
    groups: ['C03'],
    statement: 'Stateless clients include pmi tags on paid requests.',
    oracle: 'Non-initialize paid requests carry the client PMI tags.',
    cases: flow(
      'client publishes PMI tags on non-initialize paid requests (stateless paid call)',
    ),
  },
  {
    id: 'CEP8-R11',
    section: 'payment_interaction Tag / Notes',
    strength: 'MUST NOT',
    classification: 'protocol',
    role: 'client',
    lifecycle: 'negotiation',
    transport: 'cleartext',
    groups: ['C03'],
    statement:
      'Clients do not rely on multiple payment_interaction tags; at most one is sent per message.',
    oracle: 'No client event carries more than one payment_interaction tag.',
    cases: conformance(
      '[C03] clients send at most one payment_interaction tag per event',
    ),
  },
  {
    id: 'CEP8-R12',
    section: 'Session-level semantics',
    strength: 'DEFINITION',
    classification: 'protocol',
    role: 'both',
    lifecycle: 'negotiation',
    transport: 'cleartext',
    groups: ['C03'],
    statement:
      'Transparent is the default; explicit gating applies only when requested and accepted.',
    oracle:
      'Clients without the tag stay transparent on an explicit-capable server; each client gets its requested lifecycle.',
    cases: [
      ...flow(
        'explicit-capable server falls back to transparent for a transparent client',
        'optional default (omitted paymentInteraction): server mirrors the lifecycle each client requests',
      ),
      ...gating(
        'forwards request directly if client is using legacy transparent mode',
      ),
    ],
  },
  {
    id: 'CEP8-R13',
    section: 'Effective mode disclosure and lifecycle negotiation',
    strength: 'MUST',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'negotiation',
    transport: 'cleartext',
    groups: ['C03'],
    statement:
      'When explicit gating is requested, the first direct response discloses the effective mode.',
    oracle:
      'The first direct response carries payment_interaction=explicit_gating.',
    cases: flow(
      'explicit gating: server discloses payment_interaction=explicit_gating on first direct response',
    ),
  },
  {
    id: 'CEP8-R14',
    section:
      'Effective mode disclosure / JSON-RPC error when explicit_gating is unsupported',
    strength: 'MUST NOT',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'negotiation',
    transport: 'cleartext',
    groups: ['C03'],
    statement:
      'A server that does not accept explicit gating never silently falls back; it answers -32602 with requested/supported data.',
    oracle: 'A transparent-only server rejects the request with -32602.',
    cases: flow(
      'explicit gating: transparent-only server rejects initialize with -32602',
    ),
  },
  {
    id: 'CEP8-R15',
    section: 'Mid-session payment-interaction update',
    strength: 'MUST',
    classification: 'protocol',
    role: 'both',
    lifecycle: 'negotiation',
    transport: 'cleartext',
    groups: ['C03'],
    statement:
      'A later payment_interaction tag upserts the mode; a transition to explicit gating is re-disclosed.',
    oracle:
      'Upserts change the effective mode and re-emit the tag; reconnect renegotiates.',
    cases: [
      ...flow(
        'mid-session payment_interaction tag upserts effective mode (transparent -> explicit_gating)',
        'explicit_gating session downgrades to transparent on reconnect (same pubkey)',
      ),
      ...tests('transport/capability-negotiator.test.ts')(
        'setPaymentInteraction to a different mode re-emits the tag (mid-session upsert)',
      ),
    ],
  },
  {
    id: 'CEP8-R16',
    section: 'Mid-session payment-interaction update / authorization migration',
    strength: 'MUST NOT',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'both',
    transport: 'cleartext',
    groups: ['C03', 'C12'],
    statement:
      'A mode change does not migrate paid authorizations across lifecycles.',
    oracle: 'A grant from one lifecycle is not consumed by the other.',
    cases: flow(
      'mode change does not migrate paid authorizations across lifecycles',
    ),
  },
  {
    id: 'CEP8-R17',
    section: 'Effective mode disclosure and lifecycle negotiation',
    strength: 'SHOULD NOT',
    classification: 'recommendation',
    role: 'client',
    lifecycle: 'negotiation',
    transport: 'transport-independent',
    groups: ['C03'],
    statement:
      'A client that required explicit gating does not auto-pay transparent offers when it was not accepted.',
    oracle:
      'The transparent offer is declined with payment_negotiation_failed.',
    cases: client(
      'declines transparent payment_required when client requested explicit_gating but server did not accept it',
    ),
  },
  {
    id: 'CEP8-R18',
    section: 'Payment Required fields',
    strength: 'DEFINITION',
    classification: 'protocol',
    role: 'both',
    lifecycle: 'transparent',
    transport: 'transport-independent',
    groups: ['C09'],
    statement:
      'payment_required carries numeric amount, opaque pay_req, pmi, optional description, ttl seconds, and _meta.',
    oracle:
      'Malformed amounts, PMIs, payloads, TTLs, and metadata are rejected before policy or wallet work.',
    cases: clientLimits(
      'rejects malformed transparent offer {"amount":-1,"pmi":"fake","pay_req":"invoice"}',
      'rejects malformed transparent offer {"amount":"5","pmi":"fake","pay_req":"invoice"}',
      'rejects malformed transparent offer {"amount":5,"pmi":"fake","pay_req":"   "}',
      'rejects malformed transparent offer {"amount":5,"pmi":"fake","pay_req":"invoice","ttl":0}',
      'rejects malformed transparent offer {"amount":5,"pmi":"fake","pay_req":"invoice","_meta":[]}',
    ),
  },
  {
    id: 'CEP8-R19',
    section: 'Transparent lifecycle / Payment processing and completion',
    strength: 'MUST',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'transparent',
    transport: 'all-encryption-modes',
    groups: ['C04'],
    statement:
      'The server processes a priced request only after payment is verified.',
    oracle:
      'Lifecycle order is offer, approval, wallet submission, receiver settlement, grant, claim, dispatch; failures never forward.',
    schedule:
      'Settlement ledger: verification resolves only after wallet submission.',
    cases: [
      ...conformance(
        ...each(
          (p) =>
            `[C04] transparent: receiver settlement precedes the single paid dispatch over ${p}`,
        ),
      ),
      ...flow(
        'gates tools/call until payment is accepted (fake delays)',
        'fail-closed: verifyPayment rejecting prevents forwarding',
        'fail-closed: createPaymentRequired throwing prevents forwarding',
      ),
    ],
  },
  {
    id: 'CEP8-R20',
    section: 'Transparent acknowledgments and result',
    strength: 'SHOULD',
    classification: 'recommendation',
    role: 'server',
    lifecycle: 'transparent',
    transport: 'cleartext',
    groups: ['C04'],
    statement:
      'The server acknowledges verified payment and may notify rejected payment.',
    oracle:
      'payment_accepted follows verification and precedes forwarding; policy rejection emits payment_rejected.',
    cases: [
      ...flow(
        'emits payment_accepted correlated to request id after verify and before forward',
      ),
      ...tests('payments/resolve-price.test.ts')(
        'emits payment_rejected when resolvePrice returns reject: true',
      ),
      ...serverPayments(
        'forwards the request anyway: the result is the point, not the SHOULD notification',
      ),
    ],
  },
  {
    id: 'CEP8-R21',
    section: 'Explicit gating lifecycle',
    strength: 'MUST NOT',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'explicit_gating',
    transport: 'all-encryption-modes',
    groups: ['C05'],
    statement:
      'A payment-gated invocation is never forwarded unless a matching paid authorization is available.',
    oracle:
      'The first call is gated; after settlement one retry claims and dispatches exactly once.',
    cases: [
      ...conformance(
        ...each(
          (p) =>
            `[C05] explicit gating: one approval, one claim, one dispatch over ${p}`,
        ),
      ),
      ...gating(
        'exercises async verifyPayment → grant → claim → forward on retry',
      ),
    ],
  },
  {
    id: 'CEP8-R22',
    section: 'Payment required error',
    strength: 'MUST',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'explicit_gating',
    transport: 'cleartext',
    groups: ['C05', 'C09'],
    statement:
      'Payment Required uses code -32042 with one or more payment options; instructions are included.',
    oracle: 'A -32042 error with a non-empty payment_options list.',
    cases: [
      ...gating('emits -32042 Payment Required on first request'),
      ...flow(
        'explicit gating: gates tools/call via -32042 error and auto-retries',
      ),
      ...client('handles explicit gating -32042 error and retries request'),
    ],
  },
  {
    id: 'CEP8-R23',
    section: 'Payment pending error',
    strength: 'SHOULD',
    classification: 'recommendation',
    role: 'both',
    lifecycle: 'explicit_gating',
    transport: 'cleartext',
    groups: ['C05', 'C09'],
    statement:
      'While verification is pending, matching invocations receive -32043 with a retry hint.',
    oracle:
      '-32043 while pending; the client retries after a bounded, floored backoff.',
    cases: [
      ...gating('emits -32043 Payment Pending if already pending'),
      ...flow(
        'explicit gating: -32043 pending race resolves after verify completes',
      ),
      ...client(
        'handles explicit gating -32043 Payment Pending error and retries after backoff',
        'floors -32043 retry delay so retry_after: 0 cannot re-send within the same second',
      ),
    ],
  },
  {
    id: 'CEP8-R24',
    section: 'Explicit gating authorization identity',
    strength: 'MUST',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'explicit_gating',
    transport: 'transport-independent',
    groups: ['C07'],
    statement:
      'Identity is client pubkey plus SHA-256(JCS({method, params})) excluding only params._meta; ids and envelope fields are excluded.',
    oracle:
      'Published vectors match; JSON-RPC ids and progress tokens do not change identity; semantic changes do.',
    schedule: 'src/payments/fixtures/canonical-invocations.json',
    cases: [
      ...identity(
        'published JCS vector: transport metadata excluded',
        'excludes params._meta from the identity (progressToken/stream do not affect hash)',
        'is deterministic regardless of object key order',
        'differs for different param values',
      ),
      ...gating(
        'grant matches across different JSON-RPC ids (id is not part of identity)',
        'grant matches across different params._meta.progressToken (_meta excluded from identity)',
      ),
      ...flow(
        'explicit gating: identical calls match across different progressTokens (_meta excluded from identity)',
      ),
    ],
  },
  {
    id: 'CEP8-R25',
    section: 'Explicit gating authorization identity / forwarding',
    strength: 'MUST',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['C07'],
    statement:
      'A consumed authorization forwards the invocation’s full original params, including _meta.',
    oracle:
      'The forwarded message is the retry itself with its own _meta; pricing cannot mutate it.',
    cases: [
      ...conformance(
        '[C07] a claimed authorization forwards the retry original params, including _meta',
      ),
      ...validation(
        'pricing cannot change the dispatched semantic arguments or metadata',
      ),
    ],
  },
  {
    id: 'CEP8-R26',
    section:
      'Correlation, Authorization Identity, and Idempotency / Explicit gating',
    strength: 'MUST',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'explicit_gating',
    transport: 'transport-independent',
    groups: ['C08'],
    statement:
      'One matching authorization is claimed atomically; concurrent double consumption is prevented; other clients or invocations cannot consume it.',
    oracle:
      'Exactly one concurrent consumer; cross-client and cross-params retries stay gated.',
    cases: [
      ...gating(
        'concurrent requests after a grant: exactly one consumes it, the other is gated',
        'grant for one client does not authorize a different client',
        'grant for one param set does not authorize a different param set',
      ),
      ...store(
        'one grant consumer wins; replaying its event never consumes a later grant',
      ),
    ],
  },
  {
    id: 'CEP8-R27',
    section:
      'Correlation, Authorization Identity, and Idempotency / Transparent',
    strength: 'MUST',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'transparent',
    transport: 'cleartext',
    groups: ['C06'],
    statement:
      'Transparent payment notifications reference the original request event id with an e tag.',
    oracle:
      'payment_required and payment_accepted carry ["e", <request event id>].',
    cases: conformance(
      '[C06] transparent payment notifications reference the original request event',
    ),
  },
  {
    id: 'CEP8-R28',
    section:
      'Correlation, Authorization Identity, and Idempotency / Transparent',
    strength: 'MUST NOT',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'transparent',
    transport: 'all-encryption-modes',
    groups: ['C06', 'F01'],
    statement:
      'Duplicate request events with the same id are retries and are never charged twice.',
    oracle:
      'One invoice, one wallet submission, and one dispatch under duplication.',
    schedule: 'Relay duplicates every client-to-server delivery.',
    cases: [
      ...flow('idempotency: duplicate request event id does not double-charge'),
      ...serverPayments(
        'redelivery after success neither re-invoices nor double-forwards',
      ),
      ...faults(
        ...each(
          (p) =>
            `[F01] duplicated request deliveries create one invoice and one dispatch over ${p}`,
        ),
      ),
    ],
  },
  {
    id: 'CEP8-R29',
    section: 'Overview / waiver',
    strength: 'MAY',
    classification: 'protocol',
    role: 'server',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['C10'],
    statement:
      'Servers may waive or reject priced invocations by policy; waiver needs no processor.',
    oracle:
      'Waivers forward without offers; rejections answer without invoices; neither needs a processor.',
    cases: [
      ...reliability(
        'transparent: waiver and rejection work without configured processors',
        'explicit_gating: waiver and rejection work without configured processors',
      ),
      ...tests('payments/resolve-price.test.ts')(
        'forwards immediately without payment notifications when resolvePrice waives payment',
      ),
      ...gating(
        'non-priced capability passes through ungated in explicit gating mode',
      ),
    ],
  },
  {
    id: 'CEP8-R30',
    section: 'Backward Compatibility',
    strength: 'DEFINITION',
    classification: 'protocol',
    role: 'both',
    lifecycle: 'both',
    transport: 'cleartext',
    groups: ['C11'],
    statement:
      'Payment participation is optional; out-of-band payment, gateway, and proxy paths keep working.',
    oracle:
      'Clients without handlers stay alive for out-of-band payment; gateway and proxy surface -32042.',
    cases: [
      ...client(
        'keeps the request alive and does not error when no handler matches',
      ),
      ...tests('gateway/gateway-payments.test.ts')(
        'explicit_gating surfaces -32042 through the gateway for a priced tool',
      ),
      ...tests('proxy/proxy-payments.test.ts')(
        'explicit_gating surfaces -32042 to the host for a priced tool',
      ),
    ],
  },
  {
    id: 'CEP8-R31',
    section: 'Package compatibility',
    strength: 'MUST',
    classification: 'sdk-policy',
    role: 'both',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['C11'],
    statement:
      'Published exports, the Node 18 floor, and browser entrypoints remain compatible.',
    oracle:
      'verify-exports, verify:payment-runtime, and verify:browser succeed.',
    cases: [],
    notApplicable:
      'Qualified by the CI package steps (verify-exports, verify:payment-runtime, verify:browser), not by bun test cases.',
  },
  {
    id: 'CEP8-R32',
    section: 'Explicit gating authorization identity / expiry',
    strength: 'MAY',
    classification: 'sdk-policy',
    role: 'server',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['C12'],
    statement:
      'Invoice expiry, verification lease, grant lifetime, replay retention, and result delivery are separate guarantees.',
    oracle:
      'Pending leases expire independently of replay records; expired grants require explicit resolution; replays keep invoice identity.',
    cases: [
      ...store(
        'pending leases expire independently of retained replay records',
      ),
      ...grants(
        'explicit resolution retains the grant through expiry plus the configured horizon',
      ),
      ...gating(
        'expired paid grant requires recovery instead of another payment',
      ),
      ...flow(
        'verification timeout preserves invoice identity for event replay',
      ),
    ],
  },
  {
    id: 'CEP8-R33',
    section: 'Optional direct payment (bearer-asset optimization)',
    strength: 'MAY',
    classification: 'optional',
    role: 'both',
    lifecycle: 'transparent',
    transport: 'transport-independent',
    profile: 'direct_payment',
    groups: [],
    statement:
      'direct_payment, -direct PMIs, and change tags apply only when a bearer profile is advertised.',
    oracle: 'Not advertised by this composition.',
    cases: [],
    notApplicable:
      'No direct-payment PMI is advertised; bearer payments are added by the Cashu profile in a later change.',
  },
  {
    id: 'SDK-F01',
    section: 'SDK reliability: duplicate delivery',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'both',
    lifecycle: 'both',
    transport: 'all-encryption-modes',
    groups: ['F01'],
    statement:
      'Duplicate offers, acknowledgements, results, and wraps cause no duplicate monetary operation.',
    oracle:
      'One wallet submission and one dispatch under duplicated server deliveries.',
    schedule: 'Relay duplicates every server-to-client delivery.',
    cases: [
      ...faults(
        ...each(
          (p) =>
            `[F01] duplicated offers, acknowledgements, and results cause one wallet submission over ${p}`,
        ),
      ),
      ...client(
        'dedupes concurrent payment_required notifications with the same pay_req',
      ),
      ...tests('transport/nostr-transport-deduplication.test.ts')(
        'server: decrypts only once for duplicate gift-wrap deliveries',
      ),
    ],
  },
  {
    id: 'SDK-F02',
    section: 'SDK reliability: delayed and reordered callbacks',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'both',
    lifecycle: 'both',
    transport: 'cleartext',
    groups: ['F02'],
    statement:
      'Stale generations cannot mutate current state or start new effects.',
    oracle:
      'Late verifiers, slow pricing, reused request ids, and late acknowledgements cause no replacement effect.',
    schedule: 'Relay holds payment_accepted until after the result.',
    cases: [
      ...reliability(
        'late verifier resolve cannot trigger a replacement invoice or duplicate grant',
        'late verifier reject cannot trigger a replacement invoice or duplicate grant',
        'slow pricing cannot create an invoice after its reservation is replaced',
      ),
      ...clientReliability(
        'request-id reuse does not allow the previous generation to pay or fail the replacement',
      ),
      ...faults(
        '[F02] a late acceptance after the result neither fails nor repeats the request',
      ),
    ],
  },
  {
    id: 'SDK-F03',
    section: 'SDK reliability: lost request or offer',
    strength: 'MUST',
    classification: 'sdk-policy',
    role: 'both',
    lifecycle: 'transparent',
    transport: 'cleartext',
    groups: ['F03'],
    statement:
      'Definite publication failure and uncertain admission remain distinguishable; replay resumes safely.',
    oracle:
      'Rejected publication reaches no server; a lost acknowledgement is admitted once and never re-invoiced on replay.',
    schedule:
      'Relay rejects, or accepts then loses the acknowledgement for, the paid request.',
    cases: [
      ...faults(
        '[F03] a request rejected before relay acceptance is a definite failure',
        '[F03] a lost acceptance acknowledgement leaves admission uncertain; replay never re-invoices',
      ),
      ...clientReliability(
        'a failed initial send releases request state before late payment offers',
      ),
    ],
  },
  {
    id: 'SDK-F04',
    section: 'SDK reliability: lost wallet response',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'client',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['F04'],
    statement:
      'A wallet outcome lost after possible submission retains the operation and is never paid again.',
    oracle: 'Unknown outcomes block repayment on any request id.',
    cases: [
      ...clientReliability(
        'an uncertain wallet result cannot be paid again on another request id',
      ),
      ...client(
        'synthesizes JSON-RPC error when the payment handler throws, instead of hanging the request',
      ),
    ],
  },
  {
    id: 'SDK-F05',
    section: 'SDK reliability: settlement notifications',
    strength: 'MUST',
    classification: 'sdk-policy',
    role: 'payment-processor',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['F05'],
    statement:
      'Early, lost, or duplicate notifications resolve through authenticated lookup of the original payment.',
    oracle:
      'Settlement is recognized once through lookup; late settlement keeps the generation.',
    cases: [
      ...settlement(
        'early/missed notifications recover through lookup, missing hash=false',
        'early/missed notifications recover through lookup, missing hash=true',
        'broken notifications do not strand settlement; cancelling one shared waiter preserves the other',
      ),
      ...recovery(
        'late settlement recovers the same generation, one grant, no invoice creation',
      ),
    ],
  },
  {
    id: 'SDK-F06',
    section: 'SDK reliability: lost acceptance or result',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'server',
    lifecycle: 'both',
    transport: 'all-encryption-modes',
    groups: ['F06'],
    statement:
      'A paid result lost at an ordinary or oversized publication boundary is recovered without another payment or execution.',
    oracle:
      'The retained result is republished once; invoice and execution counts stay at one.',
    schedule:
      'Relay drops the result delivery; publication fails at ordinary/start/chunk/end/ack boundaries.',
    cases: [
      ...faults(
        '[F06] a lost paid result is recovered from the retained record without repayment',
      ),
      ...recovery(
        'paid result persists before send, retry after recreation publishes once without re-execution',
      ),
      ...stateRecovery(
        'injected payment store: two transports, failure=ordinary, recreation/replay over cleartext',
        'injected payment store: two transports, failure=chunk, recreation/replay over persistent encryption',
        'injected payment store: two transports, failure=end, recreation/replay over ephemeral encryption',
      ),
    ],
  },
  {
    id: 'SDK-F07',
    section: 'SDK reliability: invalid receiver payloads',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'payment-handler',
    lifecycle: 'transparent',
    transport: 'transport-independent',
    groups: ['F07'],
    statement:
      'Invalid, expired, wrong-network, wrong-amount, or amountless invoices are refused before wallet submission.',
    oracle:
      'Decoder rejects published invalid vectors; mismatches are declined with no wallet request.',
    schedule:
      'BOLT #11 specification vectors plus independently encoded invoices.',
    cases: [
      ...bolt11(
        '[F07] refuses wrong-amount, amountless, and wrong-network invoices',
        'rejects the published invalid vector: checksum',
        'rejects the published invalid vector: multiplier',
        'rejects the published invalid vector: subMillisatoshi',
        'rejects the published invalid vector: missingPaymentHash',
        'decodes network, amount, timestamp, and expiry from published vectors',
      ),
      ...providers(
        '[P02] an offer whose invoice exceeds its advertised amount is declined end to end',
      ),
    ],
  },
  {
    id: 'SDK-F08',
    section: 'SDK reliability: provider failure',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'server',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['F08'],
    statement:
      'Provider outages and malformed replies fail boundedly, never settle falsely, and expose sanitized diagnostics.',
    oracle:
      'Failures never forward; observer errors are isolated; secrets never escape.',
    cases: [
      ...recovery(
        'concurrent reconcilers query once and backend errors never request payment',
        'observer/journal throws and rejections are isolated and secret fields never escape',
      ),
      ...validation('rejects mismatched or malformed processor output'),
    ],
  },
  {
    id: 'SDK-F09',
    section: 'SDK reliability: stalls and expiry boundaries',
    strength: 'MUST',
    classification: 'sdk-policy',
    role: 'both',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['F09'],
    statement:
      'Stalled creation or verification completes boundedly or retains uncertainty; expiry is correct before, at, and after the boundary.',
    oracle:
      'Slow creation becomes uncertain; expiry is exclusive at timestamp + expiry.',
    cases: [
      ...reliability(
        'slow invoice creation becomes uncertain without creating a replacement invoice',
      ),
      ...bolt11(
        '[F09] expiry boundary: valid before, expired at and after timestamp + expiry',
      ),
      ...store('an expired invoice-creation lease cannot mint another invoice'),
      ...gating(
        'retains an uncertain invoice for reconciliation when verifyPayment times out',
      ),
      ...clientReliability(
        'expiry during an eligibility check prevents a wallet action',
      ),
    ],
  },
  {
    id: 'SDK-F10',
    section: 'SDK reliability: reconnect and deduplication pressure',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'server',
    lifecycle: 'transparent',
    transport: 'all-encryption-modes',
    groups: ['F10'],
    statement:
      'Paid requests replayed after reconnect or loss of transport deduplication are never charged or executed again. The transport-wide reconnect policy (#105) is outside this guarantee.',
    oracle:
      'Replays reach payment admission as duplicates; invoice and dispatch counts stay at one.',
    schedule:
      'Relay reconnect replay, then transport recreation with full-history replay.',
    cases: [
      ...faults(
        ...each(
          (p) =>
            `[F10] relay history replay after completion never charges or executes again over ${p}`,
        ),
      ),
      ...reliability(
        'transparent replay beyond the invoice TTL and middleware recreation never invoices or executes twice',
      ),
      ...tests('transport/payment-client-eviction.e2e.test.ts')(
        'many paying clients complete after session eviction and peer disconnects without re-execution',
      ),
    ],
  },
  {
    id: 'SDK-F11',
    section: 'SDK reliability: malformed ingress',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'client',
    lifecycle: 'both',
    transport: 'cleartext',
    groups: ['F11'],
    statement:
      'Forged, malformed, or oversized payment messages at real ingress cause no wallet action, crossed request, or unhandled rejection.',
    oracle:
      'Non-server offers are ignored; malformed offers fail the request before approval; size budgets precede element validation.',
    schedule:
      'Forged events injected through the relay; 1,000-element payment_options.',
    cases: [
      ...faults(
        '[F11] payment offers from a non-server key are ignored at ingress',
        '[F11] a malformed server offer fails the request before approval or wallet work',
        '[F11] oversized explicit payment options are refused at ingress before approval',
      ),
      ...tests('payments/client-payment-validation.test.ts')(
        '[F11] the payment_options size budget applies before any element is inspected',
      ),
      ...client(
        'drops uncorrelated payment_required notifications on Nostr transports',
      ),
      ...clientLimits(
        'ambiguous uncorrelated notifications never choose between concurrent requests',
      ),
    ],
  },
  {
    id: 'SDK-F12',
    section: 'SDK reliability: client and identifier isolation',
    strength: 'MUST',
    classification: 'sdk-policy',
    role: 'both',
    lifecycle: 'both',
    transport: 'cleartext',
    groups: ['F12'],
    statement:
      'Identical invocations from different clients, and numeric/string ids, stay isolated.',
    oracle:
      'Each client pays and executes once; ids with equal text stay distinct.',
    cases: [
      ...faults(
        '[F12] concurrent clients with identical invocations and JSON-RPC ids stay isolated',
      ),
      ...client(
        'keeps numeric and string request ids with the same text form distinct',
      ),
      ...clientReliability(
        'attempt history is isolated between stable transport peers',
      ),
    ],
  },
  {
    id: 'SDK-F13',
    section: 'SDK reliability: capacity',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'server',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['F13'],
    statement:
      'Capacity zero or one never partially admits or evicts unresolved monetary state.',
    oracle:
      'Refusal precedes invoice creation; paid grants survive capacity pressure.',
    cases: [
      ...store(
        'capacity zero refuses both lifecycles before an attempt is reserved',
        'a paid grant remains claimable when retained-record capacity is one',
        'live and expired paid grants are retained under record capacity pressure',
      ),
      ...gating(
        'refuses with -32000 without minting an invoice at pending capacity',
      ),
      ...serverPayments('maxPendingPayments 0 refuses all priced requests'),
    ],
  },
  {
    id: 'SDK-F14',
    section: 'SDK reliability: store errors',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'server',
    lifecycle: 'both',
    transport: 'all-encryption-modes',
    groups: ['F14'],
    statement:
      'Store errors and lost commit acknowledgements never fall back to empty memory or repeat effects.',
    oracle:
      'Admission failures mint nothing; lost result acknowledgements recover from the same record.',
    cases: [
      ...reliability(
        'transparent: backend admission failure cannot mint an invoice or dispatch',
        'explicit_gating: backend admission failure cannot mint an invoice or dispatch',
      ),
      ...stateRecovery(
        'injected payment store: two transports, failure=result_ack, recreation/replay over cleartext',
        'injected payment store: two transports, failure=publication_ack, recreation/replay over persistent encryption',
      ),
      ...recovery(
        'a fresh default store cannot recover results retained by another store',
      ),
    ],
  },
  {
    id: 'SDK-F15',
    section: 'SDK reliability: cancellation and close',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'both',
    lifecycle: 'both',
    transport: 'cleartext',
    groups: ['F15'],
    statement:
      'No new effects start after termination; submitted effects stay uncertain; owned resources are released.',
    oracle:
      'Close fences approval and wallet work; server verification ends at the TTL without dispatch.',
    schedule: 'Relay holds the offer until the client has closed.',
    cases: [
      ...faults(
        '[F15] closing the client during payment prevents wallet work and server dispatch',
      ),
      ...clientReliability(
        'inbound cancellation prevents a delayed policy from starting the wallet',
        'close fences approval even when the underlying transport never fires onclose',
      ),
      ...shutdown(
        'transparent: close() aborts the verify signal and a late settle neither forwards nor publishes payment_accepted',
        'explicit gating: close() aborts the verify signal and a late settle retains an uncertain attempt instead of granting',
      ),
    ],
  },
  {
    id: 'SDK-F16',
    section: 'SDK reliability: expired grants and fallback',
    strength: 'MUST NOT',
    classification: 'sdk-policy',
    role: 'both',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['F16'],
    statement:
      'Expired paid grants need explicit resolution; nothing renews, reruns, refunds, or pays again automatically.',
    oracle:
      'Unresolved grants block new invoices and execution; unknown options block other payments.',
    cases: [
      ...grants(
        'unresolved paid grants remain blocked beyond retention and replay deadlines',
        'resolution cannot revoke a live grant or restore a consumed execution right',
        'middleware cannot issue another invoice or execute until operator resolution and collection',
        'concurrent resolution and retry cannot consume an expired paid right',
      ),
      ...clientReliability(
        'an unknown option takes precedence over another pending payment attempt',
      ),
    ],
  },
  {
    id: 'PROVIDER-P01',
    section: 'Provider contract: issued payload',
    strength: 'MUST',
    classification: 'provider',
    role: 'payment-processor',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['P01'],
    statement:
      'NWC, LNbits, and zap processors advertise only invoices encoding the admitted amount that have not expired.',
    oracle:
      'Wrong-amount, amountless, and expired issued invoices are refused before advertisement.',
    cases: providers(
      '[P01] NWC processor never advertises an invoice for another amount',
      '[P01] LNbits processor never advertises an invoice for another amount',
      '[P01] zap (remote LNURL service) processor never advertises an invoice for another amount',
    ),
  },
  {
    id: 'PROVIDER-P02',
    section: 'Provider contract: wallet validation',
    strength: 'MUST',
    classification: 'provider',
    role: 'payment-handler',
    lifecycle: 'transparent',
    transport: 'transport-independent',
    groups: ['P02'],
    statement: 'Wallet handlers validate the actual invoice before spending.',
    oracle:
      'Mismatches are declined via canHandle and handle with zero wallet requests.',
    cases: providers(
      '[P02] LNbits handler declines mismatched invoices with no wallet request',
      '[P02] NWC handler declines mismatched invoices with no NIP-47 request',
    ),
  },
  {
    id: 'PROVIDER-P03',
    section: 'Provider contract: receiver evidence',
    strength: 'MUST',
    classification: 'provider',
    role: 'payment-processor',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['P03'],
    statement:
      'Only authenticated receiver evidence bound to the issued invoice establishes settlement.',
    oracle:
      'Receipts for another invoice, hash, or an outgoing payment never settle.',
    cases: [
      ...providers(
        '[P03] NWC lookups for another invoice, hash, or an outgoing payment never settle',
      ),
      ...nwc('notification mode confirms a receipt using authenticated lookup'),
      ...tests('payments/processors/zap-cancellation.test.ts')(
        'zap verification authenticates receipts and releases only owned subscriptions, abort=false',
      ),
    ],
  },
  {
    id: 'PROVIDER-P04',
    section: 'Provider contract: notification and lookup races',
    strength: 'MUST',
    classification: 'provider',
    role: 'payment-processor',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['P04'],
    statement:
      'Notification and lookup races settle once and release every waiter.',
    oracle:
      'Concurrent verification is shared; subscriptions are created once.',
    cases: nwc(
      'dedupes concurrent verifyPayment for the same invoice',
      'concurrent verifies subscribe for notifications exactly once',
      'prefers lookup by payment_hash when wallet provided it on make_invoice',
    ),
  },
  {
    id: 'PROVIDER-P05',
    section: 'Provider contract: deadlines, cancellation, ownership',
    strength: 'MUST',
    classification: 'provider',
    role: 'both',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['P05'],
    statement:
      'Provider I/O honours cancellation and deadlines and releases only adapter-owned resources.',
    oracle: 'Aborts reach HTTP and relay work; shared pools stay open.',
    cases: [
      ...settlement(
        'LNbits create receives abort and cannot continue after cancellation',
        'LNbits status receives abort and cannot continue after cancellation',
        'LNbits wallet receives abort and cannot continue after cancellation',
        'late subscription setup is released after disposal',
      ),
      ...tests('payments/nip47/nwc-client.test.ts')(
        'close cancels a stalled connection without closing a shared caller pool',
      ),
      ...tests('payments/processors/zap-cancellation.test.ts')(
        'zap verification authenticates receipts and releases only owned subscriptions, abort=true',
      ),
    ],
  },
  {
    id: 'PROVIDER-P06',
    section: 'Provider contract: ambiguous acknowledgements',
    strength: 'MUST NOT',
    classification: 'provider',
    role: 'client',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['P06'],
    statement:
      'Ambiguous acknowledgements never trigger a replacement monetary operation.',
    oracle: 'Known or uncertain invoices are never approved or paid again.',
    cases: clientReliability(
      'an uncertain wallet result cannot be paid again on another request id',
      'changed amount for a known invoice never triggers another approval',
      'deduplicates concurrent and sequential explicit approvals',
    ),
  },
  {
    id: 'PROVIDER-P07',
    section: 'Provider contract: mixed-method selection',
    strength: 'MUST',
    classification: 'provider',
    role: 'client',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['P07'],
    statement:
      'Mixed-method offers preserve approval bounds and attempt limits.',
    oracle:
      'Per-PMI amount limits and attempt allowances hold across replacement and multi-option offers.',
    cases: [
      ...clientLimits(
        'multi-option offers reserve a conservative maximum per PMI and exclude unlisted rails',
        'replacement invoices share a cumulative per-PMI amount limit',
        'replacement invoices share an attempt allowance',
      ),
      ...clientReliability(
        'different offers cannot run approval callbacks concurrently for one invocation',
      ),
    ],
  },
  {
    id: 'PROVIDER-P08',
    section: 'Provider contract: controlled provider evidence',
    strength: 'MUST',
    classification: 'provider',
    role: 'both',
    lifecycle: 'both',
    transport: 'transport-independent',
    groups: ['P08'],
    statement: 'Controlled provider runs corroborate the fixture contract.',
    oracle: 'Funded NWC, LNbits, and zap integration runs succeed.',
    cases: [],
    notApplicable:
      'Extended qualification tier: funded integration tests are disabled in required CI and run separately.',
  },
];

/** Coverage groups every report must account for. */
export const CEP8_GROUPS: readonly string[] = [
  ...Array.from({ length: 12 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 16 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`),
];
