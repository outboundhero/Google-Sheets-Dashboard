import { getConfig } from "@/lib/sheets-config";
import { getLeadsFromSheet } from "@/lib/google-sheets";
import {
  getSyncMetadata,
  storeSyncMetadata,
  storeSheetLeads,
  trimLeadForStorage,
  type SyncMetadata,
  type StoredSheetData,
} from "@/lib/leads-store";

export interface SyncResult {
  totalLeads: number;
  sheetsSuccess: number;
  sheetsError: number;
  durationMs: number;
  errors: { sheetId: string; name: string; error: string }[];
}

export async function syncAllLeads(): Promise<SyncResult> {
  const startTime = Date.now();
  const config = await getConfig();

  if (config.sheets.length === 0) {
    const meta: SyncMetadata = {
      lastSyncAt: new Date().toISOString(),
      syncInProgress: false,
      syncStartedAt: null,
      totalLeads: 0,
      sheetsSuccess: 0,
      sheetsError: 0,
      sheetKeys: [],
    };
    await storeSyncMetadata(meta);
    return { totalLeads: 0, sheetsSuccess: 0, sheetsError: 0, durationMs: 0, errors: [] };
  }

  // Mark sync as in progress
  const existingMeta = await getSyncMetadata();
  await storeSyncMetadata({
    ...existingMeta,
    syncInProgress: true,
    syncStartedAt: new Date().toISOString(),
  });

  let totalLeads = 0;
  let sheetsSuccess = 0;
  let sheetsError = 0;
  const errors: { sheetId: string; name: string; error: string }[] = [];
  const sheetKeys: string[] = [];

  // Process in batches of 25
  const batchSize = 25;
  for (let i = 0; i < config.sheets.length; i += batchSize) {
    const batch = config.sheets.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((s) => getLeadsFromSheet(s.id, s.sheetName || "Leads", s.clientTag))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const sheetInfo = batch[j];
      const sheetKey = `leads-store:sheet:${sheetInfo.id}`;

      if (result.status === "fulfilled") {
        const trimmedLeads = result.value.map(trimLeadForStorage);
        const storedData: StoredSheetData = {
          sheetId: sheetInfo.id,
          clientTag: sheetInfo.clientTag,
          sheetName: sheetInfo.sheetName || "Leads",
          syncedAt: new Date().toISOString(),
          leads: trimmedLeads,
        };
        await storeSheetLeads(sheetInfo.id, storedData);
        sheetKeys.push(sheetKey);
        totalLeads += trimmedLeads.length;
        sheetsSuccess++;
      } else {
        const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.error(
          `[syncAllLeads] Failed sheet "${sheetInfo.name}" (${sheetInfo.id}):`,
          errorMsg
        );
        errors.push({ sheetId: sheetInfo.id, name: sheetInfo.name, error: errorMsg });
        sheetsError++;
      }
    }
  }

  // Update metadata
  const meta: SyncMetadata = {
    lastSyncAt: new Date().toISOString(),
    syncInProgress: false,
    syncStartedAt: null,
    totalLeads,
    sheetsSuccess,
    sheetsError,
    sheetKeys,
  };
  await storeSyncMetadata(meta);

  return {
    totalLeads,
    sheetsSuccess,
    sheetsError,
    durationMs: Date.now() - startTime,
    errors,
  };
}

export async function syncSingleSheet(
  sheetId: string,
  sheetName: string,
  clientTag: string
): Promise<void> {
  try {
    const leads = await getLeadsFromSheet(sheetId, sheetName, clientTag);
    const trimmedLeads = leads.map(trimLeadForStorage);
    const storedData: StoredSheetData = {
      sheetId,
      clientTag,
      sheetName,
      syncedAt: new Date().toISOString(),
      leads: trimmedLeads,
    };
    await storeSheetLeads(sheetId, storedData);

    // Add this sheet's key to metadata
    const meta = await getSyncMetadata();
    const sheetKey = `leads-store:sheet:${sheetId}`;
    if (!meta.sheetKeys.includes(sheetKey)) {
      meta.sheetKeys.push(sheetKey);
      meta.totalLeads += trimmedLeads.length;
      meta.sheetsSuccess++;
      await storeSyncMetadata(meta);
    }
  } catch (error) {
    console.error(`[syncSingleSheet] Failed for ${sheetId}:`, error);
  }
}
