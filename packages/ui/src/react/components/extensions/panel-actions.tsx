import { useQueryClient } from '@tanstack/react-query';
import { type JSX, type ReactNode, createContext, useContext, useState } from 'react';
import type { ColumnAction, ExtensionActionInfo } from '../../../client/types.js';
import { useOptionalTelescopeClient } from '../../telescope-context.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/dialog.js';
import { useMeta } from '../../use-telescope-queries.js';
import type { PanelRow } from './table-features.js';

/** What a row button asks the dashboard for: run this action on this row, after a confirmation. */
interface PanelActions {
  /** The declared action this button runs, or `undefined` when the server does not list it. */
  info(action: ColumnAction): ExtensionActionInfo | undefined;
  request(action: ColumnAction, row: PanelRow): void;
}

const PanelActionsContext = createContext<PanelActions | null>(null);

/** Fills `{key}` placeholders from the row. Plain text: never parsed as HTML or a URL. */
export function fillFromRow(template: string, row: PanelRow): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => String(row[key] ?? ''));
}

/** Whether the row matches the action's `showWhen` (every listed field holds one of its values). */
export function actionShownFor(action: ColumnAction, row: PanelRow): boolean {
  if (!action.showWhen) return true;
  return Object.entries(action.showWhen).every(([key, values]) =>
    values.some((value) => value === row[key]),
  );
}

interface Pending {
  ext: string;
  name: string;
  label: string;
  question: string;
  destructive: boolean;
  input: Record<string, unknown>;
}

/**
 * Lets the tables of one extension's dashboard run that extension's actions. Buttons appear only
 * when the server has mutations on and lists the action; each run is confirmed in a dialog, then
 * every panel of the dashboard refetches so the change shows.
 */
export function PanelActionsProvider({
  ext,
  children,
}: {
  ext: string;
  children: ReactNode;
}): React.JSX.Element {
  const client = useOptionalTelescopeClient();
  const queryClient = useQueryClient();
  const meta = useMeta();
  const [pending, setPending] = useState<Pending | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const declared: ExtensionActionInfo[] = (meta.data?.actions ?? []).filter((a) => a.ext === ext);
  const enabled = meta.data?.mutations === true && client?.extAction !== undefined;
  const value: PanelActions | null = enabled
    ? {
        info: (action) => declared.find((a) => a.name === action.name),
        request(action, row) {
          const info = declared.find((a) => a.name === action.name);
          if (!info) return;
          const label = action.label ?? info.label ?? info.name;
          const confirm = action.confirm ?? info.confirm ?? `${label}?`;
          const input: Record<string, unknown> = {};
          for (const [key, template] of Object.entries(action.input ?? {})) {
            input[key] = fillFromRow(template, row);
          }
          setOutcome(null);
          setPending({
            ext,
            name: info.name,
            label,
            question: fillFromRow(confirm, row),
            destructive: action.destructive ?? info.destructive ?? false,
            input,
          });
        },
      }
    : null;

  async function run(): Promise<void> {
    if (!pending || !client?.extAction) return;
    setRunning(true);
    try {
      await client.extAction(pending.ext, pending.name, pending.input);
      setOutcome({ ok: true, text: `${pending.label}: done.` });
      await queryClient.invalidateQueries({ queryKey: ['telescope', 'ext-data', pending.ext] });
    } catch (error) {
      setOutcome({
        ok: false,
        text: `${pending.label} failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setRunning(false);
      setPending(null);
    }
  }

  return (
    <PanelActionsContext.Provider value={value}>
      {outcome && (
        <output
          className={`mb-3 block rounded border px-3 py-1.5 text-xs ${outcome.ok ? 'tint-good' : 'tint-bad'}`}
        >
          {outcome.text}
        </output>
      )}
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !running) setPending(null);
        }}
      >
        <DialogContent aria-label="Confirm action" className="space-y-3 p-4">
          <DialogTitle>{pending?.label}</DialogTitle>
          <DialogDescription>{pending?.question}</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={running} onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant={pending?.destructive ? 'bad' : 'solid'}
              disabled={running}
              onClick={() => void run()}
            >
              {pending?.label}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PanelActionsContext.Provider>
  );
}

/** A table cell's action button; nothing outside a {@link PanelActionsProvider} with mutations on. */
export function RowActionButton({
  action,
  row,
}: {
  action: ColumnAction;
  row: PanelRow;
}): React.JSX.Element | null {
  const actions = useContext(PanelActionsContext);
  const info = actions?.info(action);
  if (actions === null || info === undefined || !actionShownFor(action, row)) return null;
  return (
    <Button
      size="xs"
      variant={(action.destructive ?? info.destructive) ? 'bad' : 'outline'}
      className="ml-2"
      onClick={() => actions.request(action, row)}
    >
      {action.label ?? info.label ?? info.name}
    </Button>
  );
}
