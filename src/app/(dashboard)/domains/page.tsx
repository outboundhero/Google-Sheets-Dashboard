"use client";

import { PageHeader } from "@/components/shared/page-header";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BuyDomainsPanel } from "@/components/domains/buy-domains-panel";
import { AllDomainsTable } from "@/components/domains/all-domains-table";
import { DiscoveryProvider } from "@/components/domains/discovery-context";
import { DiscoveryProgressBanner } from "@/components/domains/discovery-progress-banner";
import { InventoryProvider } from "@/components/domains/inventory-context";
import { InventoryProgressBanner } from "@/components/domains/inventory-progress-banner";

export default function DomainsPage() {
  return (
    <DiscoveryProvider>
      <InventoryProvider>
      <div className="space-y-6">
        <PageHeader
          title="Domains"
          description="Discover + buy domains on the outboundhero Porkbun account, and browse your full domain inventory across both accounts."
        />

        {/* Always-visible progress — both the discovery loop and the Porkbun
            refresh keep running (and show here) regardless of the active tab. */}
        <DiscoveryProgressBanner />
        <InventoryProgressBanner />

        <Tabs defaultValue="buy" className="space-y-6">
          <TabsList>
            <TabsTrigger value="buy">Buy</TabsTrigger>
            <TabsTrigger value="all">All Domains</TabsTrigger>
          </TabsList>

          <TabsContent value="buy">
            <BuyDomainsPanel />
          </TabsContent>

          <TabsContent value="all">
            <AllDomainsTable />
          </TabsContent>
        </Tabs>
      </div>
      </InventoryProvider>
    </DiscoveryProvider>
  );
}
