"use client";

import { RefreshCw, Loader2, UserPlus, Trash2, Users2, Shield } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useSheets } from "@/lib/hooks/use-sheets";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/shared/page-header";
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
  const { role: currentRole } = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  // User Management state
  const [users, setUsers] = useState<Profile[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePassword, setInvitePassword] = useState("");
  const [inviting, setInviting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const handleRefreshAll = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/cache", { method: "DELETE" });
      toast.success("Cache cleared. Data will refresh on next load.");
    } catch {
      toast.error("Failed to clear cache");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Settings"
        description="Manage tracked sheets and preferences"
      />

      {/* Tracked Sheets */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="text-base font-semibold">
            Tracked Sheets ({sheets.length})
          </CardTitle>
          <AddSheetDialog onSuccess={() => mutate()} />
        </CardHeader>
        <CardContent>
          <TrackedSheetsList sheets={sheets} onRemoved={() => mutate()} />
        </CardContent>
      </Card>

      <Separator />

      {/* Data Management */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Data Management
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Refresh All Data</p>
              <p className="text-xs text-muted-foreground">
                Clear the server cache and fetch fresh data from all sheets
              </p>
            </div>
            <Button
              variant="outline"
              onClick={handleRefreshAll}
              disabled={refreshing}
            >
              {refreshing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Refresh
            </Button>
          </div>
          <div className="rounded-md bg-muted p-3">
            <p className="text-xs text-muted-foreground">
              Data syncs from Google Sheets to Redis. Click Refresh to
              trigger a full sync of all tracked sheets.
            </p>
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* Service Account Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Service Account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-2">
            Share your Google Sheets with this email to grant read access:
          </p>
          <code className="block rounded-md bg-muted p-3 text-sm font-mono break-all">
            n8n-1-291@outreachify-486520.iam.gserviceaccount.com
          </code>
        </CardContent>
      </Card>

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
                      <Badge variant="outline" className={u.role === "admin" ? "text-emerald-500 border-emerald-500/30" : "text-muted-foreground"}>
                        <Shield className="mr-1 h-3 w-3" />
                        {u.role}
                      </Badge>
                      {u.role !== "admin" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          disabled={deletingId === u.id}
                          onClick={() => handleDeleteUser(u.id, u.email)}
                        >
                          {deletingId === u.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

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
