"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth-context";

type Role = "admin" | "viewer";

const allNavItems: { href: string; label: string; icon: typeof LayoutDashboard; roles: Role[] }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, roles: ["admin"] },
  { href: "/clients", label: "Clients", icon: Users, roles: ["admin", "viewer"] },
  { href: "/leads", label: "All Leads", icon: Table2, roles: ["admin"] },
  { href: "/deliverability", label: "Deliverability", icon: Mailbox, roles: ["admin", "viewer"] },
  { href: "/deliverability/inbox-orders", label: "Inbox Orders", icon: PackagePlus, roles: ["admin"] },
  { href: "/campaigns", label: "Campaigns", icon: Send, roles: ["admin"] },
  { href: "/domains", label: "Domains", icon: Globe, roles: ["admin"] },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const { user, role, signOut } = useAuth();

  const navItems = allNavItems.filter((item) => item.roles.includes(role || "viewer"));

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

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-2 py-4">
        {navItems.map((item) => {
          const isActive = (() => {
            if (item.href === "/") return pathname === "/";
            if (!pathname.startsWith(item.href)) return false;
            const moreSpecific = navItems.some(
              (other) =>
                other.href !== item.href &&
                other.href.startsWith(item.href + "/") &&
                pathname.startsWith(other.href)
            );
            return !moreSpecific;
          })();

          const linkContent = (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
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
