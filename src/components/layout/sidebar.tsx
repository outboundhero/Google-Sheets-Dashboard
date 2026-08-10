"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  Users,
  Table2,
  Settings,
  PanelLeftClose,
  PanelLeft,
  Mailbox,
  Send,
  Globe,
  LogOut,
  PackagePlus,
  PlugZap,
  Recycle,
  Gauge,
  Server,
  LayoutGrid,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";
import { InstanceSwitcher } from "./instance-switcher";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth-context";

type Role = "admin" | "viewer";
type Icon = typeof LayoutDashboard;

interface NavLeaf {
  href: string;
  label: string;
  icon: Icon;
  roles: Role[];
}
interface NavGroup {
  group: string;
  label: string;
  icon: Icon;
  defaultHref: string; // where clicking the group header navigates
  roles: Role[];
  children: NavLeaf[];
}
type NavEntry = NavLeaf | NavGroup;

function isGroup(e: NavEntry): e is NavGroup {
  return (e as NavGroup).children !== undefined;
}

const allNavItems: NavEntry[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, roles: ["admin"] },
  { href: "/clients", label: "Clients", icon: Users, roles: ["admin", "viewer"] },
  { href: "/leads", label: "All Leads", icon: Table2, roles: ["admin"] },
  {
    group: "infrastructure",
    label: "Infrastructure",
    icon: Server,
    defaultHref: "/deliverability",
    roles: ["admin", "viewer"],
    children: [
      { href: "/deliverability", label: "Deliverability", icon: Mailbox, roles: ["admin", "viewer"] },
      { href: "/deliverability/inbox-orders", label: "Inbox Orders", icon: PackagePlus, roles: ["admin"] },
      { href: "/domains", label: "Domains", icon: Globe, roles: ["admin"] },
    ],
  },
  { href: "/account-status", label: "Account Status", icon: PlugZap, roles: ["admin", "viewer"] },
  {
    group: "campaigns",
    label: "Campaigns",
    icon: Send,
    defaultHref: "/campaigns",
    roles: ["admin"],
    children: [
      { href: "/campaigns", label: "Master Grid", icon: LayoutGrid, roles: ["admin"] },
      { href: "/campaigns/summary", label: "By Client", icon: Users, roles: ["admin"] },
      { href: "/campaigns/remaining-leads", label: "Remaining Leads", icon: Gauge, roles: ["admin"] },
    ],
  },
  { href: "/mrl-pacing", label: "MRL Pacing", icon: Gauge, roles: ["admin"] },
  { href: "/replacement", label: "Replacement", icon: Recycle, roles: ["admin"] },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const { user, role, signOut } = useAuth();
  const r: Role = role || "viewer";

  // Visible entries for this role; group children filtered too (hide an empty group).
  const navItems: NavEntry[] = allNavItems
    .filter((e) => e.roles.includes(r))
    .map((e) => (isGroup(e) ? { ...e, children: e.children.filter((c) => c.roles.includes(r)) } : e))
    .filter((e) => !isGroup(e) || e.children.length > 0);

  // Flat href list for "most-specific wins" active detection.
  const allHrefs: string[] = navItems.flatMap((e) => (isGroup(e) ? e.children.map((c) => c.href) : [e.href]));
  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    if (!pathname.startsWith(href)) return false;
    const moreSpecific = allHrefs.some((h) => h !== href && h.startsWith(href + "/") && pathname.startsWith(h));
    return !moreSpecific;
  };

  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const e of allNavItems) {
      if (isGroup(e) && e.children.some((c) => pathname.startsWith(c.href))) s.add(e.group);
    }
    return s;
  });
  const toggleGroup = (g: string) =>
    setOpenGroups((prev) => {
      const n = new Set(prev);
      if (n.has(g)) n.delete(g); else n.add(g);
      return n;
    });
  const openGroup = (g: string) => setOpenGroups((prev) => new Set(prev).add(g));

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 flex h-screen flex-col border-r bg-card transition-all duration-300",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          "flex h-16 items-center border-b px-4",
          collapsed ? "justify-center" : "gap-3"
        )}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
          L
        </div>
        {!collapsed && (
          <span className="text-lg font-semibold tracking-tight">
            LeadSync
          </span>
        )}
      </div>

      {/* Instance switcher */}
      <InstanceSwitcher collapsed={collapsed} />

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-2 py-4">
        {navItems.map((item) => {
          // ── Group (e.g. Infrastructure) ──────────────────────────────────
          if (isGroup(item)) {
            const groupActive = item.children.some((c) => isActive(c.href));
            const open = openGroups.has(item.group);

            if (collapsed) {
              // Collapsed rail: icon-only link to the group's default page.
              const header = (
                <Link
                  href={item.defaultHref}
                  className={cn(
                    "flex items-center justify-center rounded-lg px-2 py-2.5 text-sm font-medium transition-colors",
                    groupActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <item.icon className="h-5 w-5 shrink-0" />
                </Link>
              );
              return (
                <Tooltip key={item.group} delayDuration={0}>
                  <TooltipTrigger asChild>{header}</TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              );
            }

            return (
              <div key={item.group}>
                <div
                  className={cn(
                    "flex items-center gap-1 rounded-lg pr-1 text-sm font-medium transition-colors",
                    groupActive && !open ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  <Link
                    href={item.defaultHref}
                    onClick={() => openGroup(item.group)}
                    className="flex flex-1 items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-accent hover:text-accent-foreground"
                  >
                    <item.icon className="h-5 w-5 shrink-0" />
                    <span>{item.label}</span>
                  </Link>
                  <button
                    type="button"
                    aria-label={open ? `Collapse ${item.label}` : `Expand ${item.label}`}
                    onClick={() => toggleGroup(item.group)}
                    className="rounded-md p-1.5 hover:bg-accent hover:text-accent-foreground"
                  >
                    <ChevronDown className={cn("h-4 w-4 transition-transform duration-300", open ? "rotate-0" : "-rotate-90")} />
                  </button>
                </div>

                {/* Animated sub-items */}
                <div className={cn("grid transition-all duration-300 ease-in-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
                  <div className="overflow-hidden">
                    <div className="mt-1 ml-3 space-y-1 border-l pl-3">
                      {item.children.map((c) => (
                        <Link
                          key={c.href}
                          href={c.href}
                          className={cn(
                            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                            isActive(c.href)
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                          )}
                        >
                          <c.icon className="h-4 w-4 shrink-0" />
                          <span>{c.label}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          // ── Leaf ─────────────────────────────────────────────────────────
          const active = isActive(item.href);
          const linkContent = (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                collapsed && "justify-center px-2"
              )}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );

          if (collapsed) {
            return (
              <Tooltip key={item.href} delayDuration={0}>
                <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            );
          }

          return linkContent;
        })}
      </nav>

      {/* User + Footer */}
      <div className="border-t">
        {/* User info */}
        {user && !collapsed && (
          <div className="flex items-center gap-2 px-4 py-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium">
              {(user.email?.[0] || "?").toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{user.email}</p>
              <p className="text-[10px] text-muted-foreground capitalize">{role}</p>
            </div>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={signOut}>
                  <LogOut className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Sign out</TooltipContent>
            </Tooltip>
          </div>
        )}
        {user && collapsed && (
          <div className="flex flex-col items-center gap-1 py-2">
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button
                  onClick={signOut}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium hover:bg-destructive/10 hover:text-destructive transition-colors"
                >
                  {(user.email?.[0] || "?").toUpperCase()}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {user.email} ({role}) — Click to sign out
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* Theme + Collapse */}
        <div
          className={cn(
            "flex items-center p-3",
            collapsed ? "justify-center" : "justify-between"
          )}
        >
          <ThemeToggle />
          {!collapsed && (
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={onToggle}>
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          )}
          {collapsed && (
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={onToggle}>
              <PanelLeft className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}
