/**
 * Application chrome. Sidebar behavior: pinned open/collapsed (persisted),
 * hover/focus on the collapsed rail previews the expanded panel as an overlay
 * flyout without shifting content, ⌘/Ctrl+B toggles the pin, mobile gets a
 * sheet. Topbar: sidebar trigger, palette search, theme toggle, account menu.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Activity as ActivityIcon,
  Bot,
  Building2,
  CheckSquare,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  CircleDollarSign,
  Home,
  KeyRound,
  Layers,
  LogOut,
  Moon,
  Package,
  Radar,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  Zap,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useIsAdmin } from "~/lib/use-is-admin.ts";
import { whoamiQuery, type Auth } from "~/routes/__root.tsx";
import { logout, changePassword } from "~/server/fns.ts";
import { useUi } from "~/store/ui.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { Avatar, ButtonSpinner, Modal } from "./ui.tsx";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Kbd } from "~/components/ui/kbd";
import { Separator } from "~/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "~/components/ui/sidebar";

const NAV = [
  { to: "/app", label: "Home", icon: Home, exact: true },
  { to: "/app/leads", label: "Leads", icon: Radar },
  { to: "/app/companies", label: "Companies", icon: Building2 },
  { to: "/app/people", label: "People", icon: Users },
  { to: "/app/lists", label: "Lists", icon: Layers },
  { to: "/app/deals", label: "Deals", icon: CircleDollarSign },
  { to: "/app/offerings", label: "Offerings", icon: Package },
  { to: "/app/tasks", label: "Tasks", icon: CheckSquare },
  { to: "/app/activity", label: "Activity", icon: ActivityIcon },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const auth = useQuery(whoamiQuery).data as Auth;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // When the sidebar is pinned collapsed, hovering or focusing the icon rail
  // previews the full sidebar as an overlay flyout. The provider flips `open`
  // on so the panel uses its real expanded styling; CSS pins the layout gap
  // to the rail width so page content never shifts.
  const [preview, setPreview] = useState(false);

  const pending = auth?.pendingApprovals ?? 0;
  const isAdmin = useIsAdmin();
  const previewing = !sidebarOpen && preview;

  return (
    <SidebarProvider
      open={sidebarOpen || preview}
      onOpenChange={setSidebarOpen}
      data-hover-preview={previewing ? "true" : undefined}
    >
      <Sidebar
        collapsible="icon"
        onMouseEnter={() => setPreview(true)}
        onMouseLeave={() => setPreview(false)}
        onFocusCapture={() => setPreview(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setPreview(false);
        }}
      >
        <SidebarHeader>
          <div className="flex h-9 items-center gap-2 px-1.5">
            <Zap
              className="size-4.5 shrink-0 text-primary"
              fill="currentColor"
            />
            <span className="min-w-0 flex-1 truncate font-mono text-sm font-bold tracking-tight group-data-[collapsible=icon]:hidden">
              emcp<span className="text-muted-foreground/60">/crm</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              title={
                sidebarOpen
                  ? "Collapse sidebar (Ctrl+B)"
                  : "Pin sidebar open (Ctrl+B)"
              }
              aria-label={sidebarOpen ? "Collapse sidebar" : "Pin sidebar open"}
              aria-pressed={sidebarOpen}
              className="shrink-0 group-data-[collapsible=icon]:hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              {sidebarOpen ? (
                <ChevronsLeft className="size-4" />
              ) : (
                <ChevronsRight className="size-4" />
              )}
            </Button>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              {NAV.map((item) => (
                <NavItem key={item.to} {...item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup className="mt-auto">
            <SidebarMenu>
              <NavItem
                to="/app/agents"
                label="Agents"
                icon={Bot}
                pathname={pathname}
              />
              <NavItem
                to="/app/approvals"
                label="Approvals"
                icon={ShieldCheck}
                pathname={pathname}
                badge={pending > 0 ? pending : undefined}
              />
              {isAdmin ? (
                <NavItem
                  to="/app/admin"
                  label="Admin"
                  icon={Settings}
                  pathname={pathname}
                />
              ) : null}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <AccountMenu auth={auth} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-6 backdrop-blur-sm">
          <SidebarTrigger className="-ml-0.5 text-muted-foreground" />
          <Separator
            orientation="vertical"
            className="mr-1 data-vertical:h-5"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-0 flex-1 cursor-text justify-start text-muted-foreground/70 hover:border-ring/40 hover:bg-transparent hover:text-muted-foreground/70"
            onClick={() => setPaletteOpen(true)}
          >
            <Search className="size-3.5" />
            <span className="flex-1 truncate text-left text-xs">
              Search leads, companies, people, deals…
            </span>
            <Kbd>⌘K</Kbd>
          </Button>
          <Link
            to="/app/agents"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Bot className="size-3.5" />
            Agents
          </Link>
          <ThemeToggle />
        </header>
        <main className="min-w-0 w-full flex-1 px-6 py-5">{children}</main>
      </SidebarInset>
      <CommandPalette />
    </SidebarProvider>
  );
}

function NavItem(props: {
  to: string;
  label: string;
  icon: typeof Home;
  pathname: string;
  exact?: boolean;
  badge?: number;
}) {
  const active = props.exact
    ? props.pathname === props.to
    : props.pathname.startsWith(props.to);
  const Icon = props.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={props.label}
        render={<Link to={props.to} />}
      >
        <Icon />
        <span>{props.label}</span>
      </SidebarMenuButton>
      {props.badge ? <SidebarMenuBadge>{props.badge}</SidebarMenuBadge> : null}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-sidebar-primary opacity-0 transition-opacity peer-data-active/menu-button:opacity-100 group-data-[collapsible=icon]:hidden"
      />
    </SidebarMenuItem>
  );
}

function ThemeToggle() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      aria-label="Toggle theme"
      className="text-muted-foreground"
    >
      {theme === "dark" ? (
        <Sun className="size-4" />
      ) : (
        <Moon className="size-4" />
      )}
    </Button>
  );
}

function AccountMenu({ auth }: { auth: Auth }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pwOpen, setPwOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  if (!auth) return null;

  async function doLogout() {
    await logout();
    queryClient.clear();
    navigate({ to: "/login" });
  }

  async function doChangePassword() {
    setBusy(true);
    try {
      const res = await changePassword({ data: { current, next } });
      if (res.ok) {
        toast.success("Password changed");
        setPwOpen(false);
        setCurrent("");
        setNext("");
      } else {
        toast.error(res.error ?? "Failed", { duration: 6000 });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
                />
              }
            >
              <Avatar name={auth.user.name} />
              <div className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-medium">
                  {auth.user.name}
                </span>
                <span className="truncate text-xs text-muted-foreground capitalize">
                  {auth.role}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto text-muted-foreground group-data-[collapsible=icon]:hidden" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              sideOffset={8}
              className="w-56"
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground">
                    {auth.user.name}
                  </span>
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {auth.user.email}
                  </span>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setPwOpen(true)}>
                <KeyRound /> Change password
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => void doLogout()}
              >
                <LogOut /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <Modal
        open={pwOpen}
        onClose={() => setPwOpen(false)}
        title="Change password"
      >
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              Current password
            </span>
            <Input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              New password (min 10 chars)
            </span>
            <Input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setPwOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || !current || next.length < 10}
              onClick={() => void doChangePassword()}
            >
              {busy ? <ButtonSpinner /> : null}
              Update
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
