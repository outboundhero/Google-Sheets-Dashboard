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
  sheetsProcessed: number;
  totalSheets: number;
  durationMs: number;
  complete: boolean;
  nextOffset: number;
  errors: { sheetId: string; name: string; error: string }[];
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms for ${label}`)), ms)
    ),
  ]);
}

// Google Sheets API: 300 reads/min per project (service account)
// Process 10 sheets per chunk, all 10 concurrently (1 batch per chunk)
const CHUNK_SIZE = 10;
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 2000;
const SHEET_TIMEOUT_MS = 30000; // 30s timeout per sheet fetch
const MAX_RETRIES = 2; // Retry failed sheets up to 2 times

/**
 * Sync a chunk of sheets starting from `offset`.
 * Call repeatedly with increasing offsets until `complete` is true.
 */
export async function syncChunk(offset: number = 0): Promise<SyncResult> {
  const startTime = Date.now();
  const config = await getConfig();

  if (config.sheets.length === 0) {
    await storeSyncMetadata({
      lastSyncAt: new Date().toISOString(),
      syncInProgress: false,
      syncStartedAt: null,
      totalLeads: 0,
      sheetsSuccess: 0,
      sheetsError: 0,
      sheetKeys: [],
      errors: [],
    });
    return {
      totalLeads: 0, sheetsSuccess: 0, sheetsError: 0,
      sheetsProcessed: 0, totalSheets: 0,
      durationMs: 0, complete: true, nextOffset: 0, errors: [],
    };
  }

  const sheetsToProcess = config.sheets.slice(offset, offset + CHUNK_SIZE);
  const nextOffset = offset + sheetsToProcess.length;
  const complete = nextOffset >= config.sheets.length;

  // Mark sync as in progress on first chunk
  if (offset === 0) {
    const existingMeta = await getSyncMetadata();
    await storeSyncMetadata({
      ...existingMeta,
      syncInProgress: true,
      syncStartedAt: new Date().toISOString(),
    });
  }

  let totalLeads = 0;
  let sheetsSuccess = 0;
  let sheetsError = 0;
  const errors: { sheetId: string; name: string; error: string }[] = [];
  const newSheetKeys: string[] = [];

  // Process in small batches with delay
  for (let i = 0; i < sheetsToProcess.length; i += BATCH_SIZE) {
    const batch = sheetsToProcess.slice(i, i + BATCH_SIZE);

    if (i > 0) {
      await delay(BATCH_DELAY_MS);
    }

    const results = await Promise.allSettled(
      batch.map((s) =>
        withTimeout(
          getLeadsFromSheet(s.id, s.sheetName || "Leads", s.clientTag),
          SHEET_TIMEOUT_MS,
          s.name
        )
      )
    );

    const toStore: { sheetId: string; data: StoredSheetData }[] = [];
    const failedSheets: typeof batch = [];

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const sheetInfo = batch[j];

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
        newSheetKeys.push(`leads-store:sheet:${sheetInfo.id}`);
        totalLeads += trimmedLeads.length;
        sheetsSuccess++;
      } else {
        console.warn(
          `[syncChunk] First attempt failed for "${sheetInfo.name}" (${sheetInfo.id}):`,
          result.reason?.message || result.reason
        );
        failedSheets.push(sheetInfo);
      }
    }

    // Pipeline write successful sheets from this batch
    await storeMultipleSheetLeads(toStore);

    // Retry failed sheets one at a time with increasing delays
    if (failedSheets.length > 0) {
      for (const sheetInfo of failedSheets) {
        let succeeded = false;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          await delay(BATCH_DELAY_MS * attempt); // Increasing backoff: 2s, 4s
          try {
            const leads = await withTimeout(
              getLeadsFromSheet(sheetInfo.id, sheetInfo.sheetName || "Leads", sheetInfo.clientTag),
              SHEET_TIMEOUT_MS,
              sheetInfo.name
            );
            const trimmedLeads = leads.map(trimLeadForStorage);
            await storeMultipleSheetLeads([{
              sheetId: sheetInfo.id,
              data: {
                sheetId: sheetInfo.id,
                clientTag: sheetInfo.clientTag,
                sheetName: sheetInfo.sheetName || "Leads",
                syncedAt: new Date().toISOString(),
                leads: trimmedLeads,
              },
            }]);
            newSheetKeys.push(`leads-store:sheet:${sheetInfo.id}`);
            totalLeads += trimmedLeads.length;
            sheetsSuccess++;
            console.log(`[syncChunk] Retry ${attempt} succeeded for "${sheetInfo.name}"`);
            succeeded = true;
            break;
          } catch (retryErr) {
            const errorMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            console.warn(`[syncChunk] Retry ${attempt}/${MAX_RETRIES} failed for "${sheetInfo.name}":`, errorMsg);
            if (attempt === MAX_RETRIES) {
              console.error(`[syncChunk] All retries exhausted for "${sheetInfo.name}" (${sheetInfo.id})`);
              errors.push({ sheetId: sheetInfo.id, name: sheetInfo.name, error: errorMsg });
              sheetsError++;
            }
          }
        }
      }
    }
  }

  // Update metadata — merge new sheet keys with existing ones
  const currentMeta = await getSyncMetadata();
  const mergedSheetKeys = [...new Set([...currentMeta.sheetKeys, ...newSheetKeys])];

  const meta: SyncMetadata = {
    lastSyncAt: new Date().toISOString(),
    syncInProgress: !complete, // Stay "in progress" until all chunks done
    syncStartedAt: complete ? null : currentMeta.syncStartedAt,
    totalLeads: (currentMeta.totalLeads || 0) + totalLeads,
    sheetsSuccess: (currentMeta.sheetsSuccess || 0) + sheetsSuccess,
    sheetsError: (currentMeta.sheetsError || 0) + sheetsError,
    sheetKeys: mergedSheetKeys,
    errors: [...(currentMeta.errors || []), ...errors].slice(0, 20),
  };

  // On first chunk, reset counters (don't accumulate from previous full sync)
  if (offset === 0) {
    meta.totalLeads = totalLeads;
    meta.sheetsSuccess = sheetsSuccess;
    meta.sheetsError = sheetsError;
    meta.errors = errors.slice(0, 20);
  }

  await storeSyncMetadata(meta);

  return {
    totalLeads,
    sheetsSuccess,
    sheetsError,
    sheetsProcessed: sheetsToProcess.length,
    totalSheets: config.sheets.length,
    durationMs: Date.now() - startTime,
    complete,
    nextOffset: complete ? 0 : nextOffset,
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
