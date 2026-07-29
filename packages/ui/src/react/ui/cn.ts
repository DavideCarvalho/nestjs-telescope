import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The shadcn class helper: `clsx` for conditional/array/object class values,
 * `tailwind-merge` to make a later conflicting utility win instead of both
 * landing in the class list and losing to source order in the stylesheet.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
