"use client";

import { Loader2, UserPlus, Trash2, Users2, Shield, KeyRound, ArrowUpDown } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useSheets } from "@/lib/hooks/use-sheets";
import { useAllLeads } from "@/lib/hooks/use-leads";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/shared/page-header";
import { RefreshButton } from "@/components/shared/refresh-button";
import { AddSheetDialog } from "@/components/settings/add-sheet-dialog";
import { TrackedSheetsList } from "@/components/settings/tracked-sheets-list";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

interface Profile {
  id: string;
  email: string;
  role: string;
  created_at: string;
}

export default function SettingsPage() {
  const { sheets, mutate } = useSheets();
  const { isSyncing, syncProgress, refresh } = useAllLeads();
  const { role: currentRole } = useAuth();

  // User Management state
  const [users, setUsers] = useState<Profile[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePassword, setInvitePassword] = useState("");
  const [inviting, setInviting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingRoleId, setTogglingRoleId] = useState<string | null>(null);
  const [resetPwUser, setResetPwUser] = useState<Profile | null>(null);
  const [newPassword, setNewPassword] = useState("");

  // Client-tag allocation state
  const [allocInfo, setAllocInfo] = useState<{ group1Count: number; group2Count: number; syncedAt: string } | null>(null);
  const [allocSyncing, setAllocSyncing] = useState(false);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const res = await fetch("/api/auth/users");
      const data = await res.json();
      if (Array.isArray(data)) setUsers(data);
    } catch { /* ignore */ }
    setUsersLoading(false);
  }, []);

  useEffect(() => {
    if (currentRole === "admin") loadUsers();
  }, [currentRole, loadUsers]);

  useEffect(() => {
    fetch("/api/client-tag-allocations")
      .then((r) => r.json())
      .then((d) => {
        if (d && typeof d.group1Count === "number") {
          setAllocInfo({ group1Count: d.group1Count, group2Count: d.group2Count, syncedAt: d.syncedAt });
        }
      })
      .catch(() => { /* ignore */ });
  }, []);

  const handleSyncAllocations = async () => {
    setAllocSyncing(true);
    try {
      const res = await fetch("/api/client-tag-allocations", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setAllocInfo({ group1Count: data.group1Count, group2Count: data.group2Count, syncedAt: data.syncedAt });
        toast.success(`Synced: ${data.group1Count} in Group 1, ${data.group2Count} in Group 2`);
      } else {
        toast.error(data.error || "Allocation sync failed");
      }
    } catch {
      toast.error("Allocation sync failed");
    }
    setAllocSyncing(false);
  };

  const handleInvite = async () => {
    if (!inviteEmail || !invitePassword) return;
    setInviting(true);
    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, password: invitePassword }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Viewer invited: ${inviteEmail}`);
        setShowInvite(false);
        setInviteEmail("");
        setInvitePassword("");
        loadUsers();
      } else {
        toast.error(data.error || "Failed to invite");
      }
    } catch {
      toast.error("Failed to invite");
    }
    setInviting(false);
  };

  const handleDeleteUser = async (userId: string, email: string) => {
    if (!confirm(`Remove ${email}? They will lose access immediately.`)) return;
    setDeletingId(userId);
    try {
      const res = await fetch("/api/auth/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        toast.success(`Removed ${email}`);
        loadUsers();
      } else {
        toast.error("Failed to remove user");
      }
    } catch {
      toast.error("Failed to remove user");
    }
    setDeletingId(null);
  };

  const handleToggleRole = async (userId: string, currentRole: string) => {
    const newRole = currentRole === "admin" ? "viewer" : "admin";
    if (!confirm(`Change role to ${newRole}? User will need to sign out and back in for the change to take effect.`)) return;
    setTogglingRoleId(userId);
    try {
      const res = await fetch("/api/auth/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role: newRole }),
      });
      if (res.ok) {
        toast.success(`Role changed to ${newRole}`);
        loadUsers();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to change role");
      }
    } catch {
      toast.error("Failed to change role");
    }
    setTogglingRoleId(null);
  };

  const handleResetPassword = async () => {
    if (!resetPwUser || !newPassword) return;
    try {
      const res = await fetch("/api/auth/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: resetPwUser.id, password: newPassword }),
      });
      if (res.ok) {
        toast.success(`Password reset for ${resetPwUser.email}`);
        setResetPwUser(null);
        setNewPassword("");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to reset password");
      }
    } catch {
      toast.error("Failed to reset password");
    }
  };

  const handleRefreshAll = async () => {
    try {
      await refresh();
      await fetch("/api/cache", { method: "DELETE" });
      toast.success("All sheets synced successfully.");
    } catch {
      toast.error("Sync failed");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manage tracked sheets, users, and preferences"
      />

      {/* Two-column layout: Sheets on left, other cards on right */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
        {/* Tracked Sheets — left column */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base font-semibold">
              Tracked Sheets ({sheets.length})
            </CardTitle>
            <AddSheetDialog onSuccess={() => mutate()} />
          </CardHeader>
          <CardContent>
            <TrackedSheetsList sheets={sheets} onRemoved={() => mutate()} />
          </CardContent>
        </Card>

        {/* Right column — stacked cards */}
        <div className="space-y-4">
          {/* Data Management */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">Data Management</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Sync all sheets and refresh data
                  </p>
                </div>
                <RefreshButton onRefresh={handleRefreshAll} isRefreshing={isSyncing} syncProgress={syncProgress} />
              </div>
            </CardContent>
          </Card>

          {/* Client Group Allocations */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">Client Group Allocations</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Which client tags belong to which Bison group
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={handleSyncAllocations} disabled={allocSyncing}>
                  {allocSyncing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Sync
                </Button>
              </div>
              {allocInfo ? (
                <div className="text-xs text-muted-foreground">
                  Group 1: <span className="font-medium text-foreground">{allocInfo.group1Count}</span> tags ·{" "}
                  Group 2: <span className="font-medium text-foreground">{allocInfo.group2Count}</span> tags
                  <br />
                  Last synced: {new Date(allocInfo.syncedAt).toLocaleString()}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Not synced yet — click Sync.</p>
              )}
            </CardContent>
          </Card>

          {/* Service Account Info */}
          <Card>
            <CardContent className="p-4 space-y-2">
              <p className="text-sm font-semibold">Service Account</p>
              <p className="text-xs text-muted-foreground">
                Share your sheets with this email:
              </p>
              <code className="block rounded-md bg-muted p-2.5 text-xs font-mono break-all">
                n8n-1-291@outreachify-486520.iam.gserviceaccount.com
              </code>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* User Management (Admin only) */}
      {currentRole === "admin" && (
        <>
          <Separator />
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
              <div className="flex items-center gap-2">
                <Users2 className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base font-semibold">
                  User Management
                </CardTitle>
              </div>
              <Button size="sm" onClick={() => setShowInvite(true)}>
                <UserPlus className="mr-2 h-4 w-4" />
                Invite Viewer
              </Button>
            </CardHeader>
            <CardContent>
              {usersLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : users.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No users found</p>
              ) : (
                <div className="space-y-2">
                  {users.map((u) => (
                    <div key={u.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium shrink-0">
                        {(u.email[0] || "?").toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{u.email}</p>
                        <p className="text-[10px] text-muted-foreground">
                          Added {new Date(u.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        onClick={() => handleToggleRole(u.id, u.role)}
                        disabled={togglingRoleId === u.id}
                        className="shrink-0"
                        title={`Click to change to ${u.role === "admin" ? "viewer" : "admin"}`}
                      >
                        <Badge variant="outline" className={`cursor-pointer transition-colors ${u.role === "admin" ? "text-emerald-500 border-emerald-500/30 hover:bg-emerald-500/10" : "text-muted-foreground hover:bg-muted"}`}>
                          {togglingRoleId === u.id ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Shield className="mr-1 h-3 w-3" />
                          )}
                          {u.role}
                        </Badge>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => { setResetPwUser(u); setNewPassword(""); }}
                        title="Reset password"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        disabled={deletingId === u.id}
                        onClick={() => handleDeleteUser(u.id, u.email)}
                        title="Remove user"
                      >
                        {deletingId === u.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Reset Password Dialog */}
          <Dialog open={!!resetPwUser} onOpenChange={(open) => { if (!open) setResetPwUser(null); }}>
            <DialogContent className="sm:!max-w-md">
              <DialogHeader>
                <DialogTitle>Reset Password</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
                <p className="text-sm text-muted-foreground">
                  Set a new password for <span className="font-medium text-foreground">{resetPwUser?.email}</span>
                </p>
                <div className="space-y-2">
                  <label className="text-sm font-medium">New Password</label>
                  <input
                    type="text"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password"
                    className="flex h-10 w-full rounded-lg border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setResetPwUser(null)}>Cancel</Button>
                  <Button onClick={handleResetPassword} disabled={!newPassword}>
                    Reset Password
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Invite Dialog */}
          <Dialog open={showInvite} onOpenChange={setShowInvite}>
            <DialogContent className="sm:!max-w-md">
              <DialogHeader>
                <DialogTitle>Invite Viewer</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
                <p className="text-sm text-muted-foreground">
                  Viewers can only access the Clients page (read-only).
                </p>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Email</label>
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="viewer@company.com"
                    className="flex h-10 w-full rounded-lg border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Temporary Password</label>
                  <input
                    type="text"
                    value={invitePassword}
                    onChange={(e) => setInvitePassword(e.target.value)}
                    placeholder="Set a password for the viewer"
                    className="flex h-10 w-full rounded-lg border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setShowInvite(false)}>Cancel</Button>
                  <Button onClick={handleInvite} disabled={inviting || !inviteEmail || !invitePassword}>
                    {inviting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Invite
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
