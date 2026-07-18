import type { QueryClient } from "@tanstack/react-query";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { queryOptions } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { whoami } from "~/server/fns.ts";
import { Toaster } from "~/components/ui/sonner";
import { TooltipProvider } from "~/components/ui/tooltip";
import { hydrateUiPrefs, useUi } from "~/store/ui.ts";
import appCss from "~/styles/app.css?url";

export type Auth = Awaited<ReturnType<typeof whoami>>;

export const whoamiQuery = queryOptions({
  queryKey: ["whoami"],
  queryFn: () => whoami(),
  staleTime: 15_000,
});

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "emcp — the CRM your agents can work" },
      {
        name: "description",
        content:
          "Open-source, agent-native CRM. Your AI agents work the pipeline through MCP; you approve what matters.",
      },
      { name: "theme-color", content: "#131316" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "emcp" },
      { property: "og:title", content: "emcp — the CRM your agents can work" },
      {
        property: "og:description",
        content:
          "Open-source, agent-native CRM. Your AI agents work the pipeline through MCP; you approve what matters.",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
    scripts: [
      {
        // Anti-flash: apply persisted theme before first paint. Dark is the
        // default; legacy values from 0.1 ("emcp"/"emcplight") are migrated.
        children: `(function(){try{var t=localStorage.getItem("emcp:theme");if(t==="emcp")t="dark";if(t==="emcplight")t="light";if(t!=="light"&&t!=="dark")t="dark";document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){}})();`,
      },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFound,
});

function RootComponent() {
  const theme = useUi((state) => state.theme);

  useEffect(() => {
    hydrateUiPrefs();
  }, []);

  return (
    <RootDocument>
      <TooltipProvider>
        <Outlet />
        <Toaster
          theme={theme}
          position="bottom-right"
          closeButton
          duration={3200}
        />
      </TooltipProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3">
      <p className="font-mono text-5xl font-bold text-foreground/20">404</p>
      <p className="text-sm text-muted-foreground">
        This page doesn&apos;t exist.
      </p>
      <Link
        to="/"
        className="mt-2 inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/85"
      >
        Back home
      </Link>
    </div>
  );
}
