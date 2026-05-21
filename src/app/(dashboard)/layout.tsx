import { AppShell } from "@/components/layout/app-shell";
import { InstanceProvider } from "@/lib/instance-context";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <InstanceProvider>
      <AppShell>{children}</AppShell>
    </InstanceProvider>
  );
}
