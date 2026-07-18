"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, LogOut, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Can } from "@/components/authz/Can";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { useNotificationUnreadCount } from "@/lib/graphql/hooks";
import { useCopilot } from "@/stores/ui";
import { UseCaseSwitcher } from "@/components/shell/UseCaseSwitcher";
import { t } from "@/lib/i18n/messages";

/** Notification bell (Tier 2b): real unread count from notification-service
 * (GET /notifications/unread-count via the bff), linking to the inbox. */
function NotificationBell() {
  const { data: unread } = useNotificationUnreadCount();
  const count = unread ?? 0;
  return (
    <Button asChild variant="ghost" size="icon" aria-label={t("notifications.bell")} title={t("notifications.bell")}>
      <Link href="/notifications" className="relative">
        <Bell className="size-4" />
        {count > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </Link>
    </Button>
  );
}

export function TopBar() {
  const router = useRouter();
  const toggleCopilot = useCopilot((s) => s.toggle);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <UseCaseSwitcher />
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ai" size="sm" onClick={toggleCopilot} className="gap-1.5">
          <Bot className="size-4" />
          {t("copilot.title")}
        </Button>
        <Can gate={FEATURE_GATES.viewNotifications}>
          <NotificationBell />
        </Can>
        <ThemeToggle />
        <Button variant="ghost" size="icon" onClick={signOut} aria-label={t("action.signOut")} title={t("action.signOut")}>
          <LogOut className="size-4" />
        </Button>
      </div>
    </header>
  );
}
