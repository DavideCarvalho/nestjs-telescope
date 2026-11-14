import type { ReactNode } from 'react';
import { EmptyState } from '../aviary-kit/blocks/empty-state';
import { PageHeader } from '../aviary-kit/blocks/page-header';
import { cn } from '../aviary-kit/lib/utils';
import { PageBody } from '../aviary-kit/shell/app-shell';
import { Skeleton } from '../aviary-kit/ui/skeleton';

/**
 * One telescope page: the kit's page body (padding, max width) with its header — title, a one-line
 * description and the page's own controls (window picker, …) on the right.
 */
export function TelescopePage({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <PageBody {...(className ? { className } : {})}>
      <PageHeader title={title} description={description} actions={actions} />
      {children}
    </PageBody>
  );
}

/** Stand-in for a list or a table while it loads: rows shaped like the content, in a card. */
export function RowsSkeleton({
  rows = 8,
  className,
}: {
  rows?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className={cn('aviary-surface rounded-lg border border-border px-4 py-2', className)}
    >
      {Array.from({ length: rows }, (_, i) => `row-${i}`).map((key, i) => (
        <div
          key={key}
          className="flex items-center gap-4 border-b border-line-soft py-2.5 last:border-0"
        >
          <Skeleton className="h-3 w-16 shrink-0" />
          <Skeleton className="h-3 w-14 shrink-0" />
          <Skeleton className="h-3" style={{ width: `${40 + ((i * 17) % 40)}%` }} />
          <Skeleton className="ml-auto h-3 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Stand-in for a chart or a detail block while it loads. */
export function BlockSkeleton({ height = 220 }: { height?: number }): React.JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className="aviary-surface flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <Skeleton className="h-3 w-32" />
      <Skeleton className="w-full" style={{ height: height - 40 }} />
    </div>
  );
}

/** "Nothing here" for a whole page region. */
export function PageEmpty({
  title,
  description,
  icon,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="aviary-surface rounded-lg border border-border">
      <EmptyState title={title} description={description} icon={icon} action={action} />
    </div>
  );
}

/** A region's load failure, with its message. */
export function LoadError({ error, label }: { error: unknown; label: string }): React.JSX.Element {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="rounded-lg border border-bad/25 bg-bad/5 p-4 text-sm text-bad">
      {label} could not be loaded: <span className="mono text-[11px] text-fg-2">{message}</span>
    </div>
  );
}
