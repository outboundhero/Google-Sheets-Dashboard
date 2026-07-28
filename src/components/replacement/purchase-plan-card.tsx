"use client";

// Purchase calculator card — observe-only. "Buy X more domains per instance" so
// every active client can be topped to its cap (20 B2B / 5 B2C) while keeping a
// reserve buffer. Reads GET /api/replacement/purchase-plan; nothing is bought.
import { useState } from "react";
import { RefreshCw, ShoppingCart, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface ShortClient { clientTag: string; staying: number; capMax: number; short: number }
interface InstancePurchase {
  instance: string;
  tier: string;
  clients: number;
  capDeficit: number;
  reserveFloor: number;
  availableReserve: number;
  toBuy: number;
  shortClients: ShortClient[];
}
interface PurchasePlanResult {
  generatedFor: string;
  reserveFloor: number;
  totalToBuy: number;
  byInstance: InstancePurchase[];
}

export function PurchasePlanCard() {
  const [data, setData] = useState<PurchasePlanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/replacement/purchase-plan");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setData(json as PurchasePlanResult);
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
            <div className="text-sm font-medium flex items-center gap-2">
              <ShoppingCart className="h-4 w-4" /> Purchase calculator — buy X more domains
            </div>
            <div className="text-[11px] text-muted-foreground">
              Per instance: bring every client to cap (20 B2B / 5 B2C) + keep a reserve buffer. Buy = cap shortfall + floor − reserve on hand. Observe-only.
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Calculating…" : "Calculate"}
          </Button>
        </div>

        {err && <p className="text-sm text-destructive">{err}</p>}

        {data && (
          <>
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-muted-foreground">Total to buy <b className={data.totalToBuy > 0 ? "text-amber-500" : "text-emerald-500"}>{data.totalToBuy.toLocaleString()}</b></span>
              <span className="text-muted-foreground">Reserve floor <b className="text-foreground">{data.reserveFloor}</b>/instance</span>
            </div>

            <div className="rounded-lg border divide-y">
              <div className="grid grid-cols-[1fr_60px_90px_80px_90px_80px] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-muted/30">
                <span>Instance</span><span className="text-center">Clients</span><span className="text-center">Cap short</span>
                <span className="text-center">Floor</span><span className="text-center">Reserve</span><span className="text-center">Buy</span>
              </div>
              {data.byInstance.map((i) => {
                const expandable = i.shortClients.length > 0;
                const isOpen = !!open[i.instance];
                return (
                  <div key={i.instance}>
                    <button
                      type="button"
                      disabled={!expandable}
                      onClick={() => setOpen((o) => ({ ...o, [i.instance]: !o[i.instance] }))}
                      className="w-full grid grid-cols-[1fr_60px_90px_80px_90px_80px] gap-2 px-3 py-2 text-xs items-center text-left disabled:cursor-default hover:bg-muted/20"
                    >
                      <span className="font-medium flex items-center gap-1">
                        {expandable ? (isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />) : <span className="w-3" />}
                        {i.instance}
                        <Badge variant="outline" className="text-[9px] ml-1">{i.tier}</Badge>
                      </span>
                      <span className="text-center tabular-nums text-muted-foreground">{i.clients}</span>
                      <span className="text-center tabular-nums">{i.capDeficit}</span>
                      <span className="text-center tabular-nums text-muted-foreground">{i.reserveFloor}</span>
                      <span className={`text-center tabular-nums ${i.availableReserve > 0 ? "text-emerald-500" : "text-destructive"}`}>{i.availableReserve}</span>
                      <span className={`text-center tabular-nums font-semibold ${i.toBuy > 0 ? "text-amber-500" : "text-muted-foreground"}`}>{i.toBuy}</span>
                    </button>
                    {isOpen && expandable && (
                      <div className="px-3 pb-2 pl-8 space-y-1">
                        {i.shortClients.map((c) => (
                          <div key={c.clientTag} className="grid grid-cols-[1fr_auto] gap-2 text-[11px] text-muted-foreground">
                            <span className="font-medium text-foreground">{c.clientTag}</span>
                            <span className="tabular-nums">{c.staying}/{c.capMax} → short <b className="text-amber-500">{c.short}</b></span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
