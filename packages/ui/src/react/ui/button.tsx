import { type VariantProps, cva } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from './cn.js';

/**
 * Vendored shadcn `Button`, retuned to the Aviary tokens.
 *
 * The console's real button vocabulary is small and uniform: bordered, low-key,
 * xs/uppercase. `outline` is the default because that is what every toolbar,
 * header control and row action already looked like; `accent`/`good`/`warn`/
 * `bad` are the tinted states those controls toggle into.
 */
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded border font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        outline: 'border-line bg-transparent text-foreground hover:bg-panel-2',
        ghost:
          'border-transparent bg-transparent text-muted-foreground hover:bg-panel-2 hover:text-foreground',
        solid: 'border-transparent bg-primary text-primary-foreground hover:opacity-90',
        brand: 'tint-brand hover:brightness-125',
        good: 'tint-good hover:brightness-125',
        warn: 'tint-warn hover:brightness-125',
        bad: 'tint-bad hover:brightness-125',
      },
      size: {
        xs: 'px-2 py-0.5 text-[10px] uppercase tracking-wide',
        sm: 'px-2.5 py-1 text-xs',
        md: 'px-3 py-1.5 text-sm',
      },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});
