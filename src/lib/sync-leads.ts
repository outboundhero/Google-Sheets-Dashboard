import { getConfig } from "@/lib/sheets-config";
import { getLeadsFromSheet } from "@/lib/google-sheets";
import {
  getSyncMetadata,
  storeSyncMetadata,
  storeMultipleSheetLeads,
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
  complete: boolean;
  errors: { sheetId: string; name: string; error: string }[];
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      errors: [],
    };
    await storeSyncMetadata(meta);
    return { totalLeads: 0, sheetsSuccess: 0, sheetsError: 0, durationMs: 0, complete: true, errors: [] };
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

  // Google Sheets API: 60 reads/min per user (service account)
  // Use batch of 10 with 2s delay to spread requests and avoid rate limiting
  const batchSize = 10;
  const batchDelay = 2000;

  for (let i = 0; i < config.sheets.length; i += batchSize) {
    // Check if we're approaching the function timeout (leave 10s margin)
    if (Date.now() - startTime > 48000) {
      console.warn(`[syncAllLeads] Approaching timeout, stopping at sheet ${i}/${config.sheets.length}`);
      break;
    }

    const batch = config.sheets.slice(i, i + batchSize);

    // Add delay between batches (not before the first one)
    if (i > 0) {
      await delay(batchDelay);
    }

    const results = await Promise.allSettled(
      batch.map((s) => getLeadsFromSheet(s.id, s.sheetName || "Leads", s.clientTag))
    );

    // Collect successful results for batch pipeline write
    const toStore: { sheetId: string; data: StoredSheetData }[] = [];

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const sheetInfo = batch[j];
      const sheetKey = `leads-store:sheet:${sheetInfo.id}`;

      if (result.status === "fulfilled") {
        const trimmedLeads = result.value.map(trimLeadForStorage);
        toStore.push({
          sheetId: sheetInfo.id,
          data: {
            sheetId: sheetInfo.id,
            clientTag: sheetInfo.clientTag,
            sheetName: sheetInfo.sheetName || "Leads",
            syncedAt: new Date().toISOString(),
            leads: trimmedLeads,
          },
        });
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

    // Pipeline write all successful sheets from this batch
    await storeMultipleSheetLeads(toStore);
  }

  // Merge with any previously stored sheet keys (from prior partial syncs)
  const mergedSheetKeys = [...new Set([...existingMeta.sheetKeys, ...sheetKeys])];

  // Update metadata with results and errors
  const meta: SyncMetadata = {
    lastSyncAt: new Date().toISOString(),
    syncInProgress: false,
    syncStartedAt: null,
    totalLeads,
    sheetsSuccess,
    sheetsError,
    sheetKeys: mergedSheetKeys,
    errors: errors.slice(0, 20), // Keep first 20 errors for visibility
  };
  await storeSyncMetadata(meta);

  return {
    totalLeads,
    sheetsSuccess,
    sheetsError,
    durationMs: Date.now() - startTime,
    complete: sheetsSuccess + sheetsError === config.sheets.length,
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
