"use client";

import { RefreshCw, Loader2 } from "lucide-react";
import { useState } from "react";
import { useSheets } from "@/lib/hooks/use-sheets";
import { PageHeader } from "@/components/shared/page-header";
import { AddSheetDialog } from "@/components/settings/add-sheet-dialog";
import { TrackedSheetsList } from "@/components/settings/tracked-sheets-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";

export default function SettingsPage() {
  const { sheets, mutate } = useSheets();
  const [refreshing, setRefreshing] = useState(false);

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
              Data is cached for 5 minutes. The cache refreshes automatically,
              but you can force a refresh here.
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
    </div>
  );
}
