/** UI-only state (zustand). Server state lives in React Query. */
import { create } from "zustand";

export type Theme = "dark" | "light";

interface UiState {
  /** Sidebar pinned open (true) or pinned collapsed to the icon rail (false). */
  sidebarOpen: boolean;
  paletteOpen: boolean;
  theme: Theme;
  setSidebarOpen(open: boolean): void;
  toggleSidebar(): void;
  setPaletteOpen(open: boolean): void;
  setTheme(theme: Theme): void;
}

function persistSidebar(open: boolean): void {
  try {
    localStorage.setItem("emcp:sidebar", open ? "1" : "0");
  } catch {
    /* SSR/no storage */
  }
}

export const useUi = create<UiState>((set, get) => ({
  sidebarOpen: true,
  paletteOpen: false,
  theme: "dark",
  setSidebarOpen: (sidebarOpen) => {
    set({ sidebarOpen });
    persistSidebar(sidebarOpen);
  },
  toggleSidebar: () => {
    const next = !get().sidebarOpen;
    set({ sidebarOpen: next });
    persistSidebar(next);
  },
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setTheme: (theme) => {
    set({ theme });
    try {
      localStorage.setItem("emcp:theme", theme);
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    } catch {
      /* SSR/no storage */
    }
  },
}));

/** Hydrate persisted UI prefs on the client (called once from the shell). */
export function hydrateUiPrefs(): void {
  try {
    const sidebar = localStorage.getItem("emcp:sidebar");
    const stored = localStorage.getItem("emcp:theme");
    // Migrate pre-0.2 values ("emcp"/"emcplight") to "dark"/"light".
    const theme: Theme | null =
      stored === "dark" || stored === "emcp"
        ? "dark"
        : stored === "light" || stored === "emcplight"
          ? "light"
          : null;
    useUi.setState({
      ...(sidebar != null ? { sidebarOpen: sidebar === "1" } : {}),
      ...(theme ? { theme } : {}),
    });
    if (theme) {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }
  } catch {
    /* first paint uses defaults */
  }
}
