/**
 * Cards for the entries `@dudousxd/nestjs-telescope-official` records from NestJS's first-party
 * diagnostics channels: `resilience` (`@nestjs/resilience`), `workflow` (`@nestjs/workflows`) and
 * `auth` (`@nestjs/authentication` + `@nestjs/authorization`). Their payloads are 0.x and read
 * defensively: every field is optional, and the card shows whatever scalar fields an entry carries
 * rather than a fixed list, so a field a later version adds still shows up.
 */

export const OFFICIAL_EVENT_TYPES = ['resilience', 'workflow', 'auth'] as const;

export function isOfficialEventType(type: string): boolean {
  return (OFFICIAL_EVENT_TYPES as readonly string[]).includes(type);
}

type Rec = Record<string, unknown>;

function asRecord(content: unknown): Rec {
  return typeof content === 'object' && content !== null && !Array.isArray(content)
    ? (content as Rec)
    : {};
}

function s(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Fields the header already shows, or that get their own block. */
const HEADER_KEYS = new Set(['event', 'source', 'error', 'output', 'waits', 'status']);

/** Events that read as a failure in the badge. */
const BAD_EVENTS = new Set([
  'timeout',
  'circuit-open',
  'circuit-rejected',
  'bulkhead-rejected',
  'rate-limited',
  'workflow-failed',
  'workflow-compensation-failed',
  'step-failed',
  'signal-timed-out',
  'mfa-failed',
  'refresh-token-reused',
  'magic-link-refused',
  'session-touch-failed',
  'denied',
]);

/** The subject of an official event: the policy, the workflow (and step), or who it concerns. */
function subjectOf(type: string, record: Rec): string {
  if (type === 'resilience') {
    const source = s(record.source);
    return `${s(record.policy) ?? 'unknown'}${source ? ` · ${source}` : ''}`;
  }
  if (type === 'workflow') {
    const step = s(record.step);
    return `${s(record.workflow) ?? 'unknown'}${step ? ` › ${step}` : ''}`;
  }
  if (record.source === 'authorization') {
    const policy = s(record.policy);
    const target = policy ? `${policy}.${s(record.ability) ?? '?'}` : 'no check declared';
    return `${target}${s(record.reason) ? ` (${String(record.reason)})` : ''}`;
  }
  return s(record.userId) ?? s(record.email) ?? '';
}

/** One-line label for the entries table. */
export function officialEventLabel(type: string, content: unknown): string {
  const record = asRecord(content);
  const event = s(record.event) ?? type;
  const subject = subjectOf(type, record);
  return subject ? `${event} ${subject}` : event;
}

function display(value: unknown): string {
  if (typeof value === 'number' && value > 1e12 && value < 1e14) {
    // Epoch-millisecond fields (`at`, `wakeAt`, `retryAt`, schedule `from`/`to`).
    return `${new Date(value).toISOString()} (${value})`;
  }
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  return String(value);
}

export function OfficialEventBody({
  type,
  content,
}: {
  type: string;
  content: unknown;
}): React.JSX.Element {
  const record = asRecord(content);
  const event = s(record.event) ?? type;
  const bad = BAD_EVENTS.has(event);
  const fields = Object.entries(record).filter(
    ([key, value]) =>
      !HEADER_KEYS.has(key) &&
      value !== null &&
      value !== undefined &&
      (typeof value !== 'object' ||
        (Array.isArray(value) && value.every((v) => typeof v !== 'object'))),
  );
  const error = record.error;
  const extra: [string, unknown][] = (['output', 'status', 'waits'] as const)
    .filter((key) => record[key] !== undefined)
    .map((key) => [key, record[key]]);
  return (
    <div data-testid="official-event">
      <h3 className="mb-3 flex flex-wrap items-center gap-2 font-mono text-sm text-foreground">
        <span
          className={`rounded bg-panel px-1.5 py-0.5 text-[10px] uppercase ${bad ? 'text-bad' : 'text-brand'}`}
        >
          {event}
        </span>
        <span>{subjectOf(type, record)}</span>
        {s(record.source) ? (
          <span className="text-[10px] text-muted-foreground">@nestjs/{String(record.source)}</span>
        ) : null}
      </h3>
      {fields.length > 0 ? (
        <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          {fields.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="break-all font-mono text-foreground">{display(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {error !== undefined && error !== null ? (
        <div className="mb-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            Error
          </h3>
          <pre className="overflow-auto rounded bg-panel p-3 text-xs text-bad">
            {JSON.stringify(error, null, 2)}
          </pre>
        </div>
      ) : null}
      {extra.map(([key, value]) => (
        <div key={key} className="mb-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            {key}
          </h3>
          <pre className="overflow-auto rounded bg-panel p-3 text-xs text-foreground">
            {JSON.stringify(value, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
