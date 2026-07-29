import { type VariantProps, cva } from 'class-variance-authority';
import { cn } from './cn.js';

/**
 * Vendored shadcn `Badge`, retuned to the Aviary tokens.
 *
 * Variants are semantic, not decorative: `good`/`warn`/`bad` are the status
 * hues, `brand` is "interactive / branded", `muted` is a neutral label. Entry
 * TYPE colours are a separate categorical palette (see `entry-types.ts`) and
 * deliberately do not go through here.
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium',
  {
    variants: {
      variant: {
        muted: 'tint-muted',
        brand: 'tint-brand',
        good: 'tint-good',
        warn: 'tint-warn',
        bad: 'tint-bad',
        outline: 'border-line bg-transparent text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'muted' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
