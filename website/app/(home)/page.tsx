import Link from 'next/link';
import {
  Activity,
  ArrowRight,
  Bell,
  Bug,
  Database,
  Gauge,
  HeartPulse,
  Layers,
  Lock,
  Radio,
  Shield,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';

const GITHUB_URL = 'https://github.com/DavideCarvalho/nestjs-telescope';

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <BackgroundTexture />
      <Hero />
      <DashboardPreview />
      <FeatureGrid />
      <WireItIn />
      <FinalCta />
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/*  Background — dot grid + emerald observatory glow, CSS only                 */
/* -------------------------------------------------------------------------- */

function BackgroundTexture() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.35] dark:opacity-[0.5]"
        style={{
          backgroundImage:
            'radial-gradient(circle at center, var(--color-fd-border) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          maskImage:
            'radial-gradient(ellipse 80% 60% at 50% 0%, black 20%, transparent 75%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 60% at 50% 0%, black 20%, transparent 75%)',
        }}
      />
      <div
        className="absolute -top-40 left-1/2 h-[36rem] w-[60rem] -translate-x-1/2 rounded-full blur-[120px]"
        style={{
          background:
            'radial-gradient(circle, rgb(16 185 129 / 0.18) 0%, rgb(16 185 129 / 0.05) 40%, transparent 70%)',
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hero                                                                        */
/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col items-center px-4 pb-10 pt-20 text-center sm:pt-28">
      <div className="tele-stagger flex flex-col items-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card/60 px-3 py-1 font-mono text-xs text-fd-muted-foreground backdrop-blur">
          <span className="relative flex h-2 w-2">
            <span className="animate-tele-blink absolute inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          Laravel Telescope, redesigned for NestJS
        </span>

        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          See what your NestJS app is{' '}
          <span className="bg-gradient-to-r from-emerald-500 to-teal-400 bg-clip-text text-transparent">
            actually doing.
          </span>
        </h1>

        <p className="mt-6 max-w-2xl text-pretty text-lg text-fd-muted-foreground">
          Watch every request, query, job, email, cache hit, and exception —
          correlated under one batch, off the response path, pluggable to the
          core, and safe in production. Alert new errors to Slack, diagnose them
          with AI, capture frontend errors, and archive before you prune. Plus a
          Horizon-style live queue console and a Pulse-style health dashboard.
          Works on Express <em>and</em> Fastify.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="group inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 font-medium text-zinc-950 shadow-[0_0_24px_-6px] shadow-emerald-500/50 transition-all hover:bg-emerald-400 hover:shadow-emerald-400/60"
          >
            Get started
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link
            href="/docs/getting-started"
            className="rounded-lg border border-fd-border bg-fd-card/40 px-5 py-2.5 font-medium backdrop-blur transition-colors hover:bg-fd-accent"
          >
            Install in 5 minutes
          </Link>
          <a
            href={GITHUB_URL}
            className="rounded-lg border border-fd-border bg-fd-card/40 px-5 py-2.5 font-medium backdrop-blur transition-colors hover:bg-fd-accent"
          >
            GitHub
          </a>
        </div>

        <p className="mt-6 font-mono text-xs text-fd-muted-foreground">
          17 packages on npm · zero added response latency · SQLite zero-config
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Dashboard preview — the centerpiece. Faithful to the real console UI,      */
/*  rendered in the product's own dark palette in both site themes.            */
/* -------------------------------------------------------------------------- */

interface EntryRow {
  type: string;
  typeColor: string;
  dot: string;
  label: string;
  status?: string;
  statusColor?: string;
  duration: string;
  bar: number;
  barColor: string;
}

const ENTRY_ROWS: readonly EntryRow[] = [
  {
    type: 'request',
    typeColor: 'text-emerald-400',
    dot: 'bg-emerald-400',
    label: 'GET /api/orders',
    status: '200',
    statusColor: 'text-emerald-400',
    duration: '42ms',
    bar: 100,
    barColor: 'bg-emerald-500/70',
  },
  {
    type: 'query',
    typeColor: 'text-sky-400',
    dot: 'bg-sky-400',
    label: 'SELECT * FROM orders WHERE user_id = ?',
    duration: '3ms',
    bar: 14,
    barColor: 'bg-sky-500/70',
  },
  {
    type: 'exception',
    typeColor: 'text-red-400',
    dot: 'bg-red-400',
    label: 'QueryFailedError: deadlock detected',
    status: '500',
    statusColor: 'text-red-400',
    duration: '118ms',
    bar: 64,
    barColor: 'bg-red-500/70',
  },
  {
    type: 'job',
    typeColor: 'text-violet-400',
    dot: 'bg-violet-400',
    label: 'queue:emails · OrderConfirmation',
    status: 'done',
    statusColor: 'text-violet-300',
    duration: '210ms',
    bar: 82,
    barColor: 'bg-violet-500/70',
  },
  {
    type: 'cache',
    typeColor: 'text-amber-400',
    dot: 'bg-amber-400',
    label: 'GET user:42:profile',
    status: 'hit',
    statusColor: 'text-amber-300',
    duration: '0.4ms',
    bar: 4,
    barColor: 'bg-amber-500/70',
  },
];

function DashboardPreview() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-24">
      <div className="relative">
        {/* glow halo under the console */}
        <div
          aria-hidden
          className="absolute -inset-x-10 -bottom-8 top-10 -z-10 rounded-[2rem] bg-emerald-500/10 blur-3xl"
        />
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/40 ring-1 ring-white/5">
          {/* window chrome */}
          <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-4 py-3">
            <span className="size-3 rounded-full bg-zinc-700" />
            <span className="size-3 rounded-full bg-zinc-700" />
            <span className="size-3 rounded-full bg-zinc-700" />
            <span className="ml-3 font-mono text-xs text-zinc-500">
              telescope · /entries
            </span>
            <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-400">
              <span className="animate-tele-blink size-1.5 rounded-full bg-emerald-400" />
              live
            </span>
          </div>

          <div className="grid gap-px bg-zinc-800/60 lg:grid-cols-[1.6fr_1fr]">
            {/* entries table */}
            <div className="bg-zinc-950 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-mono text-xs uppercase tracking-wide text-emerald-400">
                  Recent entries
                </h3>
                <span className="font-mono text-[10px] text-zinc-600">
                  correlated · batch a3f9
                </span>
              </div>
              <div className="space-y-px font-mono text-xs">
                {ENTRY_ROWS.map((row) => (
                  <div
                    key={row.label}
                    className="group flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-zinc-900"
                  >
                    <span className={`size-1.5 shrink-0 rounded-full ${row.dot}`} />
                    <span className={`w-16 shrink-0 ${row.typeColor}`}>
                      {row.type}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-zinc-300">
                      {row.label}
                    </span>
                    {row.status ? (
                      <span className={`shrink-0 ${row.statusColor}`}>
                        {row.status}
                      </span>
                    ) : null}
                    {/* timing bar */}
                    <span className="hidden h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-zinc-800 sm:block">
                      <span
                        className={`block h-full rounded-full ${row.barColor}`}
                        style={{ width: `${row.bar}%` }}
                      />
                    </span>
                    <span className="w-12 shrink-0 text-right tabular-nums text-zinc-500">
                      {row.duration}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* side rail: health + throughput sparkline */}
            <div className="flex flex-col gap-4 bg-zinc-950 p-4">
              <div>
                <h3 className="mb-3 font-mono text-xs uppercase tracking-wide text-zinc-400">
                  Telescope health
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <MockStat label="Capture cost" value="8.7 µs" accent="text-emerald-400" />
                  <MockStat label="Added latency" value="0 ms" accent="text-emerald-400" />
                  <MockStat label="Buffer" value="12 / 512" accent="text-sky-400" />
                  <MockStat label="Dropped" value="0" accent="text-emerald-400" />
                </div>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-500">
                    Throughput
                  </span>
                  <span className="font-mono text-[10px] text-emerald-400">
                    1.2k / min
                  </span>
                </div>
                <Sparkline />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function MockStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className={`mt-1 font-mono text-lg font-semibold tabular-nums ${accent}`}>
        {value}
      </p>
    </div>
  );
}

function Sparkline() {
  // A tiny inline-SVG throughput sparkline, drawn on load.
  const points =
    '0,26 12,22 24,24 36,16 48,19 60,10 72,14 84,7 96,12 108,5 120,9';
  return (
    <svg
      viewBox="0 0 120 32"
      className="h-9 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label="Throughput trend, rising over the last minute"
    >
      <defs>
        <linearGradient id="tele-spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(16 185 129 / 0.35)" />
          <stop offset="100%" stopColor="rgb(16 185 129 / 0)" />
        </linearGradient>
      </defs>
      <polygon points={`0,32 ${points} 120,32`} fill="url(#tele-spark-fill)" />
      <polyline
        className="animate-tele-draw"
        points={points}
        fill="none"
        stroke="rgb(52 211 153)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ strokeDasharray: 240 }}
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Feature grid                                                                */
/* -------------------------------------------------------------------------- */

interface Feature {
  icon: typeof Activity;
  title: string;
  body: string;
  accent: string;
}

const FEATURES: readonly Feature[] = [
  {
    icon: Layers,
    title: 'Watchers, correlated',
    body: 'Requests, DB queries, exceptions, jobs, mail, cache and schedules — all stitched under one batch per request via AsyncLocalStorage.',
    accent: 'text-emerald-400',
  },
  {
    icon: Radio,
    title: 'Live queue console',
    body: 'A Horizon-style cockpit for BullMQ and SQS: retry, remove, promote and redrive jobs while they run, with throughput per queue.',
    accent: 'text-violet-400',
  },
  {
    icon: HeartPulse,
    title: 'Pulse health dashboard',
    body: 'p50 / p99 latency, slowest routes and automatic N+1 detection — know what is hurting before your users do.',
    accent: 'text-sky-400',
  },
  {
    icon: Zap,
    title: 'Near-zero overhead',
    body: 'Capture runs off the response path at ~8.7µs per query — zero added latency. A built-in /health endpoint proves it in your app.',
    accent: 'text-amber-400',
  },
  {
    icon: Database,
    title: 'Pluggable storage',
    body: 'SQLite zero-config out of the box; MikroORM, TypeORM, Prisma and Redis adapters with self-healing schema. Archive entries to S3 before per-type retention prunes them.',
    accent: 'text-teal-400',
  },
  {
    icon: Bell,
    title: 'Error alerting',
    body: 'A new exception pages you in Slack — formatted Block Kit with route, user and a deep link — or any webhook or custom sink. Rate, slow-route and dropped-entry rules too.',
    accent: 'text-orange-400',
  },
  {
    icon: Sparkles,
    title: 'AI diagnosis',
    body: 'One click turns an exception into a triage report — probable cause, where to look, a suggested fix — from the stack, route and the SQL that just ran. Bedrock, OpenAI, or any AI-SDK model.',
    accent: 'text-fuchsia-400',
  },
  {
    icon: Bug,
    title: 'Frontend errors',
    body: 'Point your browser error handler at a public endpoint and report client_exceptions through the same pipeline — family hashing, alerts, the dashboard. A react-error-boundary in minutes.',
    accent: 'text-cyan-400',
  },
  {
    icon: Shield,
    title: 'Production-ready auth',
    body: 'Signed-cookie dashboard sessions and OTel trace linking. Ship it to prod on Express or Fastify with confidence.',
    accent: 'text-rose-400',
  },
];

function FeatureGrid() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-24">
      <div className="mb-10 text-center">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          One console for everything in flight
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-fd-muted-foreground">
          Capture, correlate, alert, diagnose. Every signal your NestJS app
          emits — backend and browser — on one mental model.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <FeatureCard key={feature.title} feature={feature} />
        ))}
      </div>
    </section>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  const Icon = feature.icon;
  return (
    <div className="group relative overflow-hidden rounded-xl border border-fd-border bg-fd-card/50 p-5 backdrop-blur transition-colors hover:border-emerald-500/40">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            'radial-gradient(120px circle at top right, rgb(16 185 129 / 0.1), transparent 70%)',
        }}
      />
      <div className="relative">
        <span className="inline-flex size-9 items-center justify-center rounded-lg border border-fd-border bg-fd-background/60">
          <Icon className={`size-4.5 ${feature.accent}`} />
        </span>
        <h3 className="mt-4 font-medium">{feature.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
          {feature.body}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Wire it in — code snippet with window chrome                               */
/* -------------------------------------------------------------------------- */

const CODE_LINES: readonly { tokens: { text: string; cls?: string }[] }[] = [
  { tokens: [{ text: '@Module', cls: 'text-violet-400' }, { text: '({' }] },
  {
    tokens: [
      { text: '  imports: [' },
    ],
  },
  {
    tokens: [
      { text: '    ' },
      { text: 'TelescopeModule', cls: 'text-emerald-400' },
      { text: '.' },
      { text: 'forRoot', cls: 'text-sky-400' },
      { text: '({}),' },
      { text: '   // captures everything', cls: 'text-zinc-600' },
    ],
  },
  {
    tokens: [
      { text: '    ' },
      { text: 'TelescopeUiModule', cls: 'text-emerald-400' },
      { text: '.' },
      { text: 'forRoot', cls: 'text-sky-400' },
      { text: '({ ' },
      { text: 'path', cls: 'text-amber-300' },
      { text: ': ' },
      { text: "'/telescope'", cls: 'text-teal-300' },
      { text: ' }),' },
    ],
  },
  { tokens: [{ text: '  ],' }] },
  { tokens: [{ text: '})' }] },
  {
    tokens: [
      { text: 'export class ', cls: 'text-violet-400' },
      { text: 'AppModule', cls: 'text-emerald-400' },
      { text: ' {}' },
    ],
  },
];

function WireItIn() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-24">
      <div className="grid items-center gap-10 lg:grid-cols-2">
        <div>
          <span className="font-mono text-xs uppercase tracking-wider text-emerald-500">
            Wire it in
          </span>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Two modules. That&apos;s the install.
          </h2>
          <p className="mt-4 text-fd-muted-foreground">
            Add <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm">TelescopeModule</code>{' '}
            to start capturing and{' '}
            <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm">TelescopeUiModule</code>{' '}
            to mount the dashboard. SQLite needs no config — it just works on
            the first boot. Swap the storage adapter whenever you outgrow it.
          </p>
          <Link
            href="/docs/getting-started"
            className="mt-6 inline-flex items-center gap-2 font-medium text-emerald-500 transition-colors hover:text-emerald-400"
          >
            Full setup guide
            <ArrowRight className="size-4" />
          </Link>
        </div>

        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-black/30 ring-1 ring-white/5">
          <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-4 py-2.5">
            <Terminal className="size-3.5 text-zinc-500" />
            <span className="font-mono text-xs text-zinc-500">app.module.ts</span>
          </div>
          <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
            <code>
              {CODE_LINES.map((line, lineIndex) => (
                <div key={lineIndex} className="whitespace-pre">
                  {line.tokens.map((token, tokenIndex) => (
                    <span
                      key={tokenIndex}
                      className={token.cls ?? 'text-zinc-300'}
                    >
                      {token.text}
                    </span>
                  ))}
                  {line.tokens.length === 0 ? ' ' : null}
                </div>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Final CTA                                                                   */
/* -------------------------------------------------------------------------- */

function FinalCta() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-28">
      <div className="relative overflow-hidden rounded-2xl border border-fd-border bg-fd-card/60 px-6 py-14 text-center backdrop-blur">
        <div
          aria-hidden
          className="absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(ellipse 60% 100% at 50% 0%, rgb(16 185 129 / 0.14), transparent 70%)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 opacity-[0.4]"
          style={{
            backgroundImage:
              'radial-gradient(circle at center, var(--color-fd-border) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
            maskImage: 'radial-gradient(ellipse 70% 80% at 50% 50%, black, transparent 80%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 70% 80% at 50% 50%, black, transparent 80%)',
          }}
        />
        <span className="inline-flex items-center gap-2 font-mono text-xs text-emerald-500">
          <Gauge className="size-4" />
          <Lock className="size-4" />
          <Activity className="size-4" />
        </span>
        <h2 className="mx-auto mt-4 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Stop guessing what your app is doing.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-fd-muted-foreground">
          Install in five minutes, capture everything, and ship the dashboard
          to production — safely.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="group inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-6 py-2.5 font-medium text-zinc-950 shadow-[0_0_24px_-6px] shadow-emerald-500/50 transition-all hover:bg-emerald-400 hover:shadow-emerald-400/60"
          >
            Get started
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <a
            href={GITHUB_URL}
            className="rounded-lg border border-fd-border bg-fd-background/40 px-6 py-2.5 font-medium transition-colors hover:bg-fd-accent"
          >
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
