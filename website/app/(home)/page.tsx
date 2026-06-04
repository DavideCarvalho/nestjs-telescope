import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <p className="mb-4 text-sm font-medium uppercase tracking-wider text-fd-muted-foreground">
        Laravel Telescope, redesigned for NestJS
      </p>
      <h1 className="mb-6 max-w-3xl text-4xl font-bold sm:text-5xl">
        See what your NestJS app is actually doing.
      </h1>
      <p className="mb-10 max-w-2xl text-lg text-fd-muted-foreground">
        Watch every request, query, job, email, cache hit, and exception —
        correlated under one batch, off the response path, pluggable to the core,
        and safe in production. Plus a Horizon-style live queue console and a
        Pulse-style health dashboard. Works on Express <em>and</em> Fastify.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/docs"
          className="rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
        >
          Get started
        </Link>
        <Link
          href="/docs/getting-started"
          className="rounded-lg border border-fd-border px-5 py-2.5 font-medium transition-colors hover:bg-fd-accent"
        >
          Install in 5 minutes
        </Link>
        <a
          href="https://github.com/DavideCarvalho/nestjs-telescope"
          className="rounded-lg border border-fd-border px-5 py-2.5 font-medium transition-colors hover:bg-fd-accent"
        >
          GitHub
        </a>
      </div>
    </main>
  );
}
