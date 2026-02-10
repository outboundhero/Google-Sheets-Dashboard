import { NextResponse } from "next/server";
import {
  getConfig,
  addSheet,
  removeSheet,
  extractSheetId,
} from "@/lib/sheets-config";
import { getSheetMetadata } from "@/lib/google-sheets";

export async function GET() {
  try {
    const config = getConfig();
    return NextResponse.json(config.sheets);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to read config" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { url, clientTag } = body as { url: string; clientTag: string };

    if (!url || !clientTag) {
      return NextResponse.json(
        { error: "URL and Client Tag are required" },
        { status: 400 }
      );
    }

    const sheetId = extractSheetId(url);

    // Verify access by fetching metadata
    const metadata = await getSheetMetadata(sheetId);

    const sheet = {
      id: sheetId,
      name: metadata.title,
      clientTag,
      addedAt: new Date().toISOString(),
    };

    addSheet(sheet);
    return NextResponse.json(sheet, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to add sheet";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const { id } = body as { id: string };

    if (!id) {
      return NextResponse.json(
        { error: "Sheet ID is required" },
        { status: 400 }
      );
    }

    removeSheet(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to remove sheet" },
      { status: 500 }
    );
  }
}
