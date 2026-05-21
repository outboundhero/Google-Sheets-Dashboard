import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { generateAliases } from "@/lib/inbox-order-aliases";
import * as scaledmail from "@/lib/scaledmail";
import * as milkbox from "@/lib/milkbox";
import * as inboxing from "@/lib/inboxing";
import type {
  CreateOrderInput,
  InboxOrderProvider,
} from "@/types/inbox-order";
import { MAILBOX_COUNT_BY_PROVIDER } from "@/types/inbox-order";
import {
  ALL_INSTANCE_SLUGS,
  isInstanceSlug,
  DEFAULT_INSTANCE,
} from "@/lib/bison-instances";

export const maxDuration = 60;

const DEFAULT_REDIRECT =
  process.env.INBOX_ORDER_DEFAULT_REDIRECT_URL || "https://findlocalcommercialcleaning.com";

function isValidProvider(v: unknown): v is InboxOrderProvider {
  return v === "scaledmail" || v === "milkbox" || v === "inboxing";
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instancesParam = searchParams.get("instances");
    const instances = instancesParam
      ? instancesParam.split(",").map((s) => s.trim()).filter(isInstanceSlug)
      : [...ALL_INSTANCE_SLUGS];
    const scoped = instances.length > 0 ? instances : [...ALL_INSTANCE_SLUGS];

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("inbox_orders")
      .select("*")
      .in("instance", scoped)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return NextResponse.json({ orders: data || [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const provider = body?.provider;
    const instance = isInstanceSlug(body?.instance) ? body.instance : DEFAULT_INSTANCE;
    const domain = typeof body?.domain === "string" ? body.domain.trim().toLowerCase() : "";
    const tag = typeof body?.tag === "string" ? body.tag.slice(0, 20) : null;
    const companyName = typeof body?.companyName === "string" ? body.companyName.trim() : null;
    const clientTag = typeof body?.clientTag === "string" ? body.clientTag.trim() : null;
    const redirectUrl =
      typeof body?.redirectUrl === "string" && body.redirectUrl.trim()
        ? body.redirectUrl.trim()
        : DEFAULT_REDIRECT;

    if (!isValidProvider(provider)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    if (!domain || !/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      return NextResponse.json({ error: "Invalid domain" }, { status: 400 });
    }
    if (provider === "milkbox" && !companyName) {
      return NextResponse.json({ error: "companyName required for MilkBox" }, { status: 400 });
    }

    const mailboxCount = MAILBOX_COUNT_BY_PROVIDER[provider];
    const aliases = await generateAliases(provider, mailboxCount);

    const orderInput: CreateOrderInput = {
      domain,
      redirectUrl,
      aliases,
      tag: tag || undefined,
      companyName: companyName || undefined,
    };

    let providerOrderId: string | null = null;
    let providerDomainId: string | null = null;
    let providerStatusRaw: string | null = null;

    if (provider === "scaledmail") {
      const r = await scaledmail.createOrder(orderInput);
      providerOrderId = r.orderId;
    } else if (provider === "milkbox") {
      const r = await milkbox.createOrder(orderInput);
      providerOrderId = r.orderId;
    } else {
      const r = await inboxing.createDomain(orderInput);
      providerDomainId = r.domainId;
      providerStatusRaw = r.raw.status || null;
    }

    const supabase = getSupabaseAdmin();
    const { data: inserted, error: insertErr } = await supabase
      .from("inbox_orders")
      .insert({
        instance,
        provider,
        provider_order_id: providerOrderId,
        provider_domain_id: providerDomainId,
        provider_status_raw: providerStatusRaw,
        domain,
        redirect_url: redirectUrl,
        mailbox_count: mailboxCount,
        tag,
        company_name: companyName,
        client_tag: clientTag,
        status: "pending",
        aliases,
      })
      .select("*")
      .single();
    if (insertErr) throw new Error(insertErr.message);

    return NextResponse.json({ order: inserted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
