import { forwardRef } from 'react';
import { cn } from './cn.js';

/**
 * Vendored shadcn `Table`, retuned to the Aviary tokens.
 *
 * Pure markup + classes — no Radix, so it is safe anywhere in the package. The
 * console's tables are dense and monospaced; the defaults here encode that so
 * the seven tables in the app stop each inventing their own row height,
 * header casing and divider colour.
 */

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  /**
   * Classes for the scroll container that wraps the `<table>`.
   *
   * Exposed because that div — not the table, and not anything the caller can
   * reach around it — is the element a sticky header positions against: it is
   * already a scroll container (an `overflow-x` other than `visible` computes
   * `overflow-y` to `auto`), so a `max-h-*` applied anywhere further out gives
   * a scrolling ancestor the sticky cells cannot see.
   */
  containerClassName?: string;
}

export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { className, containerClassName, ...props },
  ref,
) {
  return (
    <div className={cn('w-full overflow-x-auto', containerClassName)}>
      <table ref={ref} className={cn('w-full border-collapse text-xs', className)} {...props} />
    </div>
  );
});

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className, ...props }, ref) {
  return (
    <thead
      ref={ref}
      className={cn(
        'border-b border-line text-left text-[10px] uppercase tracking-wide text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
});

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...props }, ref) {
  return <tbody ref={ref} className={cn('divide-y divide-line-soft', className)} {...props} />;
});

export const TableRow = forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  function TableRow({ className, ...props }, ref) {
    return <tr ref={ref} className={cn('transition-colors', className)} {...props} />;
  },
);

export const TableHead = forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(function TableHead({ className, ...props }, ref) {
  return <th ref={ref} className={cn('px-3 py-2 font-normal', className)} {...props} />;
});

export const TableCell = forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(function TableCell({ className, ...props }, ref) {
  return <td ref={ref} className={cn('px-3 py-2 align-top', className)} {...props} />;
});
