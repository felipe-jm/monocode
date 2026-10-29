import { useEffect, useRef, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { IS_MAC } from "../../platform/tauri/platform";
import {
  providerAccounts,
  subscribeProviderAccounts,
} from "../../features/providers/model/providerAccounts";
import {
  getAllRateLimits,
  loadRateLimits,
} from "../../features/providers/model/rateLimitsCache";
import { fetchOmpUsageReports } from "../../features/providers/model/rateLimitsFetch";
import {
  loadMonoMenuBarIcon,
  subscribeMonoMenuBarIcon,
} from "../../features/settings/model/settings";
import {
  menuBarUsageSections,
  type MenuBarOmpUsage,
} from "../model/menuBarUsage";

const REFRESH_MS = 5 * 60_000;
/** Emitted by the native menu when an account row is chosen. */
const OPEN_ACCOUNTS_EVENT = "mono-menu-open-accounts";

/**
 * Keeps the usage sections of the Mono menu bar menu current: every Claude
 * account and every omp account, refreshed every five minutes. Only the main
 * window feeds the menu, so extra windows do not repeat the requests.
 */
export function useMenuBarUsage(onOpenAccounts: () => void) {
  const openAccounts = useRef(onOpenAccounts);
  openAccounts.current = onOpenAccounts;
  const menuBarIcon = useSyncExternalStore(
    subscribeMonoMenuBarIcon,
    loadMonoMenuBarIcon,
  );

  useEffect(() => {
    if (!IS_MAC || !isTauri() || !menuBarIcon) return;
    const window = getCurrentWebviewWindow();
    if (window.label !== "main") return;
    let disposed = false;
    let running = false;
    let again = false;
    let claudeUpdatedAt: number | null = null;
    let omp: MenuBarOmpUsage | null = null;
    let sent = "";

    const refresh = async () => {
      again = true;
      if (running) return;
      running = true;
      try {
        while (again && !disposed) {
          again = false;
          const [, ompResult] = await Promise.all([
            Promise.allSettled(
              providerAccounts("claude").map((account) =>
                loadRateLimits("claude", account.id, true),
              ),
            ),
            fetchOmpUsageReports().then(
              (reports) => ({ reports }),
              (error: unknown) => ({
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          ]);
          if (disposed) return;
          const now = Date.now();
          claudeUpdatedAt = now;
          if ("error" in ompResult) {
            // A failed run keeps the last good numbers, still dated.
            if (!omp || "error" in omp) omp = { error: ompResult.error };
          } else {
            omp =
              ompResult.reports === null
                ? null
                : { reports: ompResult.reports, updatedAt: now };
          }
          const sections = menuBarUsageSections({
            claudeAccounts: providerAccounts("claude"),
            claudeUsage: getAllRateLimits(),
            claudeUpdatedAt,
            omp,
            now,
          });
          const payload = JSON.stringify(sections);
          if (payload === sent) continue;
          await invoke("mono_menu_usage_sync", { sections });
          sent = payload;
        }
      } catch (error) {
        console.error(error);
      } finally {
        running = false;
      }
    };

    void refresh();
    const timer = globalThis.setInterval(() => void refresh(), REFRESH_MS);
    const unsubscribe = subscribeProviderAccounts(() => void refresh());
    let unlisten: (() => void) | undefined;
    void window
      .listen(OPEN_ACCOUNTS_EVENT, () => openAccounts.current())
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(console.error);
    return () => {
      disposed = true;
      globalThis.clearInterval(timer);
      unsubscribe();
      unlisten?.();
      void invoke("mono_menu_usage_sync", { sections: [] }).catch(
        console.error,
      );
    };
  }, [menuBarIcon]);
}
