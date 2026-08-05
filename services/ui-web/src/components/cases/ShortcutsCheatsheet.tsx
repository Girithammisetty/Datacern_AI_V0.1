"use client";
/**
 * The Case Workbench keyboard cheatsheet (opened with `?`). A plain Radix
 * dialog — no confirm/cancel semantics, just a reference — so it never implies
 * an action. Every row is a t() string; the keys themselves are literal.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n/messages";
import type { MessageKey } from "@/lib/i18n/messages";

const ROWS: { keys: string[]; descKey: MessageKey }[] = [
  { keys: ["j", "k"], descKey: "cases.shortcuts.jk" },
  { keys: ["Enter"], descKey: "cases.shortcuts.enter" },
  { keys: ["r"], descKey: "cases.shortcuts.resolve" },
  { keys: ["e"], descKey: "cases.shortcuts.escalate" },
  { keys: ["a"], descKey: "cases.shortcuts.assign" },
  { keys: ["/"], descKey: "cases.shortcuts.search" },
  { keys: ["?"], descKey: "cases.shortcuts.help" },
];

export function ShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-5 shadow-lg focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">{t("cases.shortcuts.title")}</Dialog.Title>
          <Dialog.Description asChild>
            <p className="mt-1 text-sm text-muted-foreground">{t("cases.shortcuts.subtitle")}</p>
          </Dialog.Description>
          <dl className="mt-4 space-y-2">
            {ROWS.map((r) => (
              <div key={r.descKey} className="flex items-center justify-between gap-4">
                <dd className="text-sm">{t(r.descKey)}</dd>
                <dt className="flex shrink-0 items-center gap-1">
                  {r.keys.map((k) => (
                    <kbd
                      key={k}
                      className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                    >
                      {k}
                    </kbd>
                  ))}
                </dt>
              </div>
            ))}
          </dl>
          <div className="mt-5 flex justify-end">
            <Dialog.Close asChild>
              <Button variant="outline" size="sm">
                {t("cases.shortcuts.close")}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
