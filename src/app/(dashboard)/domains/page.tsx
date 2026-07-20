"use client";

import { PageHeader } from "@/components/shared/page-header";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BuyDomainsPanel } from "@/components/domains/buy-domains-panel";
import { AllDomainsTable } from "@/components/domains/all-domains-table";

export default function DomainsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Domains"
        description="Discover + buy domains on the outboundhero Porkbun account, and browse your full domain inventory across both accounts."
      />

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
  );
}
