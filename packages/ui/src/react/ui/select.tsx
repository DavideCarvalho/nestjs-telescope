import { Select as SelectPrimitive } from '@base-ui-components/react/select';
import { forwardRef } from 'react';
import { cn } from './cn.js';

/**
 * Vendored shadcn `Select` on Base UI, retuned to the Aviary tokens.
 *
 * A native `<select>` draws its popup with the OS, so it cannot be themed and was
 * the one control that broke the console's look in both light and dark. Base UI
 * gives a themable listbox with the keyboard and typeahead behaviour intact.
 */

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export const SelectTrigger = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex items-center justify-between gap-1.5 rounded border border-line bg-panel px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="text-muted-foreground" aria-hidden="true">
        ▾
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export const SelectContent = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Popup> & {
    /** Forwarded to `Select.Positioner` — the side the popup opens on. */
    side?: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Positioner>['side'];
    align?: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Positioner>['align'];
  }
>(function SelectContent({ className, children, side = 'bottom', align = 'start', ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner side={side} align={align} sideOffset={4} className="z-50">
        <SelectPrimitive.Popup
          ref={ref}
          className={cn(
            'min-w-[6rem] overflow-hidden rounded border border-line bg-popover p-1 text-popover-foreground shadow-lg font-mono',
            className,
          )}
          {...props}
        >
          {children}
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center rounded-sm px-2 py-1 text-xs text-foreground outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-panel data-[selected]:text-brand',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
});

export const SelectGroupLabel = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.GroupLabel>
>(function SelectGroupLabel({ className, ...props }, ref) {
  return (
    <SelectPrimitive.GroupLabel
      ref={ref}
      className={cn(
        'px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
});
