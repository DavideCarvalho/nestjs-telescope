import { Dialog as DialogPrimitive } from '@base-ui-components/react/dialog';
import { forwardRef } from 'react';
import { cn } from './cn.js';

/**
 * Vendored shadcn `Dialog` on Base UI, retuned to the Aviary tokens.
 *
 * Used uniformly for both modal shapes in this console — the command palette and
 * the queue job drawer — so overlay behaviour (focus trap, scroll lock, Esc,
 * outside-press) is one implementation rather than two hand-rolled ones.
 *
 * Base UI keeps the popup in normal flow with an ordinary `z-index` rather than
 * the browser top layer, so anything that must outrank a modal (a toast, say)
 * still can. See AVIARY-UI.md — this is why it is not a native `<dialog>`.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogBackdrop = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Backdrop>
>(function DialogBackdrop({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Backdrop
      ref={ref}
      className={cn('fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]', className)}
      {...props}
    />
  );
});

/**
 * The popup surface. `placement` covers the two layouts the console needs: a
 * centred command palette and a right-hand drawer.
 */
export const DialogContent = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Popup> & {
    placement?: 'center' | 'top' | 'right';
  }
>(function DialogContent({ className, placement = 'center', children, ...props }, ref) {
  const placementClass =
    placement === 'right'
      ? 'inset-y-0 right-0 w-full max-w-xl border-l'
      : placement === 'top'
        ? 'left-1/2 top-[12vh] w-[min(36rem,92vw)] -translate-x-1/2 rounded-lg border'
        : 'left-1/2 top-1/2 w-[min(36rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border';

  return (
    <DialogPrimitive.Portal>
      <DialogBackdrop />
      <DialogPrimitive.Popup
        ref={ref}
        className={cn(
          'fixed z-50 border-line bg-panel-2 text-foreground shadow-2xl focus:outline-none font-mono',
          placementClass,
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
});

export const DialogTitle = forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-sm font-semibold text-foreground', className)}
      {...props}
    />
  );
});

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  );
});
