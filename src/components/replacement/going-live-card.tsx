"use client";

// "Clients going live" forecast card — observe-only. Shows which clients are
// scheduled to launch around the upcoming 1st / 15th so domains can be bought +
// warmed in advance. Reads GET /api/replacement/going-live.
import { useState } from "react";
import { RefreshCw, Rocket, CalendarClock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface GoingLiveClient {
  clientAbbr: string;
  companyName: string;
  date: string;
  daysUntil: number;
  source: "goLiveDate" | "startDate";
  status: string;
}
interface GoingLiveForecast {
  today: string;
  nextFirst: string;
  nextFifteenth: string;
  horizonDays: number;
  onNextFirst: GoingLiveClient[];
  onNextFifteenth: GoingLiveClient[];
  otherUpcoming: GoingLiveClient[];
  totalUpcoming: number;
}

function ClientRow({ c }: { c: GoingLiveClient }) {
  return (
    <div className="grid grid-cols-[70px_1fr_auto] gap-2 px-3 py-1.5 text-xs items-center">
      <span className="font-medium">{c.clientAbbr}</span>
      <span className="text-muted-foreground truncate" title={c.companyName}>{c.companyName}</span>
      <span className="text-muted-foreground tabular-nums whitespace-nowrap">
        {c.date} · <b className="text-foreground">{c.daysUntil}d</b>
        {c.source === "startDate" && <span className="text-[10px] ml-1 text-amber-500">(start)</span>}
      </span>
    </div>
  );
}

function Bucket({ title, date, clients }: { title: string; date: string; clients: GoingLiveClient[] }) {
  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
        <span className="text-xs font-medium flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5" /> {title}</span>
        <span className="text-[11px] text-muted-foreground">{date} · <b className="text-foreground">{clients.length}</b></span>
      </div>
      {clients.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-muted-foreground">None scheduled.</p>
      ) : (
        <div className="divide-y">{clients.map((c) => <ClientRow key={`${c.clientAbbr}:${c.date}`} c={c} />)}</div>
      )}
    </div>
  );
}

export function GoingLiveCard() {
  const [data, setData] = useState<GoingLiveForecast | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/replacement/going-live");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setData(json as GoingLiveForecast);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium flex items-center gap-2"><Rocket className="h-4 w-4" /> Clients going live — forecast</div>
            <div className="text-[11px] text-muted-foreground">Upcoming launches around the next 1st / 15th. Buy + warm domains before they need inboxes. Observe-only.</div>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Loading…" : "Forecast"}
          </Button>
        </div>

        {err && <p className="text-sm text-destructive">{err}</p>}

        {data && (
          <>
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-muted-foreground">Upcoming (≤ {data.horizonDays}d) <b className="text-foreground">{data.totalUpcoming}</b></span>
              <span className="text-muted-foreground">On next 1st <b className="text-emerald-500">{data.onNextFirst.length}</b></span>
              <span className="text-muted-foreground">On next 15th <b className="text-emerald-500">{data.onNextFifteenth.length}</b></span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Bucket title="Next 1st" date={data.nextFirst} clients={data.onNextFirst} />
              <Bucket title="Next 15th" date={data.nextFifteenth} clients={data.onNextFifteenth} />
            </div>
            {data.otherUpcoming.length > 0 && (
              <div className="rounded-lg border">
                <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
                  <span className="text-xs font-medium">Other upcoming</span>
                  <Badge variant="outline" className="text-[10px]">{data.otherUpcoming.length}</Badge>
                </div>
                <div className="divide-y max-h-[240px] overflow-y-auto">{data.otherUpcoming.map((c) => <ClientRow key={`${c.clientAbbr}:${c.date}`} c={c} />)}</div>
              </div>
            )}
            {data.totalUpcoming === 0 && <p className="text-sm text-muted-foreground">No clients scheduled to go live in the next {data.horizonDays} days.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
