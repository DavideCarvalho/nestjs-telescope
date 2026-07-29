import { Tooltip as TooltipPrimitive } from '@base-ui-components/react/tooltip';
import { forwardRef } from 'react';
import { cn } from './cn.js';

/** Vendored shadcn `Tooltip` on Base UI, retuned to the Aviary tokens. */

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Popup> & {
    side?: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Positioner>['side'];
    sideOffset?: number;
  }
>(function TooltipContent({ className, side = 'top', sideOffset = 6, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} className="z-50">
        <TooltipPrimitive.Popup
          ref={ref}
          className={cn(
            'max-w-xs rounded border border-line bg-popover px-2 py-1 text-[11px] leading-snug text-popover-foreground shadow-lg font-mono',
            className,
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
});
