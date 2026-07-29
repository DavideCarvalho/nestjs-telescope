import { Tabs as TabsPrimitive } from '@base-ui-components/react/tabs';
import { forwardRef } from 'react';
import { cn } from './cn.js';

/**
 * Vendored shadcn `Tabs` on Base UI, retuned to the Aviary tokens.
 *
 * NOTE the state attribute: Base UI's Tabs uses `data-active`, while Select uses
 * `data-selected` and menus use `data-highlighted`. Styling the wrong one compiles
 * clean and silently never matches. See AVIARY-UI.md.
 */

export const Tabs = TabsPrimitive.Root;
export const TabsPanel = TabsPrimitive.Panel;

export const TabsList = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn('flex flex-wrap gap-1 border-b border-line pb-2', className)}
      {...props}
    />
  );
});

export const TabsTab = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Tab>
>(function TabsTab({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Tab
      ref={ref}
      className={cn(
        'flex items-baseline gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[active]:bg-panel-2 data-[active]:text-foreground',
        className,
      )}
      {...props}
    />
  );
});
