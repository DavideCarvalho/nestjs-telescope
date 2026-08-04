/**
 * Vendored shadcn primitives, generated against the Aviary tokens (see
 * `../../app/index.css` and `../../../tailwind.config.ts`).
 *
 * Primitive layer is Base UI — one package, declared explicitly in this
 * package's `package.json`. See ../../../../../AVIARY-UI.md.
 *
 * INTERNAL. This barrel is deliberately NOT re-exported from `src/react/index.ts`:
 * every module a public barrel re-exports is *resolved* by a host's bundler even
 * when nothing imports it, so exporting these would put `@base-ui-components/react`
 * into the dependency graph of every host that touches the barrel. The guard for
 * that lives in `../console-subpath.spec.ts`.
 */
export { cn } from './cn.js';
export { Badge, badgeVariants, type BadgeProps } from './badge.js';
export { Button, buttonVariants, type ButtonProps } from './button.js';
export {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './dialog.js';
export { Input } from './input.js';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select.js';
export {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type TableProps,
} from './table.js';
export { Tabs, TabsList, TabsPanel, TabsTab } from './tabs.js';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.js';
