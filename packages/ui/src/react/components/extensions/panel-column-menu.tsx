import { type JSX, useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/button.js';
import type { PanelColumn } from './table-features.js';

/**
 * The "Columns" menu on a table panel: one toggle per column that declared
 * `hideable`, driven by v9's `columnVisibilityFeature`.
 *
 * Built from the vendored `Button` inside a plain positioned `div` rather than a
 * vendored menu primitive, because there isn't one — `src/react/ui/` vendors
 * Table, Button, Input, Select, Dialog, Tabs, Tooltip and Badge, and a menu is a
 * large Base UI surface to vendor for a list of checkboxes. Every *control* here
 * is still the vendored Button; only the container is bare markup.
 *
 * Renders nothing at all when no column opted in, which is what keeps every
 * dashboard that predates this feature rendering exactly as it did.
 */
export function PanelColumnMenu({ columns }: { columns: PanelColumn[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const hideable = columns.filter((column) => column.getCanHide());

  // Click-away and Escape. Without these the menu is a trap: it sits over the
  // panel below it and the only way to dismiss it is to find the trigger again.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent): void {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (hideable.length === 0) return null;

  const hiddenCount = hideable.filter((column) => !column.getIsVisible()).length;

  return (
    <div className="relative" ref={root}>
      <Button
        variant="ghost"
        size="xs"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className="px-1.5 text-muted-foreground"
      >
        Columns{hiddenCount > 0 ? ` (${hideable.length - hiddenCount}/${hideable.length})` : ''}
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-[10rem] rounded border border-line bg-popover p-1 shadow-lg"
        >
          {hideable.map((column) => (
            <Button
              key={column.id}
              role="menuitemcheckbox"
              aria-checked={column.getIsVisible()}
              variant="ghost"
              size="xs"
              onClick={() => column.toggleVisibility()}
              className="w-full justify-start gap-2 normal-case tracking-normal"
            >
              <span aria-hidden="true" className={column.getIsVisible() ? '' : 'opacity-30'}>
                {column.getIsVisible() ? '☑' : '☐'}
              </span>
              {typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
