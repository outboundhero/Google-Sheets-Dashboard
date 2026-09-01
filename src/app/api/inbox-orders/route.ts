import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { generateUniqueIdentities, buildAliasesFromNameSpec } from "@/lib/inbox-order-aliases";
import * as scaledmail from "@/lib/scaledmail";
import * as milkbox from "@/lib/milkbox";
import * as inboxing from "@/lib/inboxing";
import { resolveDomainOrders, milkboxSequencerFor } from "@/lib/inbox-order-accounts";
import { meansNoRedirect } from "@/lib/deliverability/redirect-normalize";
import { DEFAULT_INBOXING_ACCOUNT, toInboxingAccount, inboxingRegistrarCredential } from "@/lib/inboxing-accounts";
import type {
  CreateOrderInput,
  InboxOrderProvider,
  InboxOrderAlias,
  NameSpec,
} from "@/types/inbox-order";
import { MAILBOX_COUNT_BY_PROVIDER } from "@/types/inbox-order";
import {
  ALL_INSTANCE_SLUGS,
  isInstanceSlug,
  DEFAULT_INSTANCE,
} from "@/lib/bison-instances";

export const maxDuration = 60;

// No default redirect (Spencer 2026-09-02: "we don't want the redirect to go
// to anything"). Stock domains are created with NO redirect and stay that way
// until the replacement system assigns them to a client and applies the
// client's real website. The old placeholder default
// (findlocalcommercialcleaning.com) is gone; INBOX_ORDER_DEFAULT_REDIRECT_URL
// is intentionally no longer read.

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
    // Which Inboxing login this order belongs to (Spencer 2026-08-12): sst is
    // US-IP ("Premium Tenants"), ohco is Asia-IP ("Regular Tenants"). Stored on
    // the row so every later call about this domain uses the SAME account's key.
    let inboxingAccount = toInboxingAccount(body?.inboxingAccount) ?? DEFAULT_INBOXING_ACCOUNT;
    const instance = isInstanceSlug(body?.instance) ? body.instance : DEFAULT_INSTANCE;
    const domain = typeof body?.domain === "string" ? body.domain.trim().toLowerCase() : "";
    const tag = typeof body?.tag === "string" ? body.tag.slice(0, 20) : null;
    const companyName = typeof body?.companyName === "string" ? body.companyName.trim() : null;
    const clientTag = typeof body?.clientTag === "string" ? body.clientTag.trim() : null;
    const redirectRaw = typeof body?.redirectUrl === "string" ? body.redirectUrl.trim() : "";
    // Blank/omitted and "n/a"/"none"/"-" all mean NO redirect → empty string,
    // which the provider layer turns into its no-redirect state. Only an
    // explicit URL sets a redirect at creation.
    const redirectUrl = !redirectRaw || meansNoRedirect(redirectRaw) ? "" : redirectRaw;

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
    // Aliases come from one of three sources, in priority order:
    //  1. a finalized (possibly hand-edited) `aliases` array from the preview,
    //  2. a NameSpec ({nameMode, personaCount, names}) → built server-side,
    //  3. legacy default (unchanged) when neither is supplied.
    let aliases: InboxOrderAlias[];
    if (Array.isArray(body?.aliases) && body.aliases.length > 0) {
      aliases = (body.aliases as InboxOrderAlias[])
        .filter((a) => a && typeof a.first_name === "string" && typeof a.last_name === "string" && typeof a.alias === "string" && a.alias.trim())
        .map((a) => ({ first_name: a.first_name.trim(), last_name: a.last_name.trim(), alias: a.alias.trim().toLowerCase() }))
        .slice(0, mailboxCount);
      if (aliases.length === 0) {
        return NextResponse.json({ error: "aliases invalid" }, { status: 400 });
      }
    } else if (body?.nameMode || body?.personaCount || Array.isArray(body?.names)) {
      const spec: NameSpec = {
        nameMode: body?.nameMode === "manual" ? "manual" : "auto",
        personaCount: body?.personaCount === 2 ? 2 : 1,
        names: Array.isArray(body?.names) ? body.names : undefined,
      };
      aliases = (await buildAliasesFromNameSpec(provider, spec)).aliases;
    } else {
      // Legacy default = auto: a unique full name per mailbox.
      aliases = await generateUniqueIdentities(provider, mailboxCount);
    }

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

    // Resolve the provider account from the domain's Porkbun account (All
    // Domains inventory). Wrong account → the provider can't manage the domain's
    // DNS → order failures. Block up-front with a clear message if unresolved.
    const resolved = (await resolveDomainOrders([domain], provider)).get(domain);
    if (!resolved || !resolved.ok) {
      return NextResponse.json({
        error: `Can't place this ${provider} order for ${domain}: ${resolved?.reason || "unknown Porkbun account — run Refresh Porkbun"}.`,
      }, { status: 400 });
    }

    if (provider === "scaledmail") {
      const r = await scaledmail.createOrder(orderInput, resolved.scaledmail);
      providerOrderId = r.orderId;
    } else if (provider === "milkbox") {
      const r = await milkbox.createOrder(orderInput, {
        domainProviderId: resolved.milkbox?.domainProviderId,
        sequencerId: milkboxSequencerFor(instance), // per Bison instance
      });
      providerOrderId = r.orderId;
    } else {
      const r = await inboxing.createDomain(
        orderInput,
        {
          // registrar credential must come from the SAME Inboxing account
          registrarCredentialId:
            inboxingRegistrarCredential(inboxingAccount, resolved.source ?? null)
            ?? resolved.inboxing?.registrarCredentialId ?? null,
          cloudflareCredentialId: null, // resolved per-account inside createDomain
        },
        inboxingAccount,
      );
      providerDomainId = r.domainId;
      providerStatusRaw = r.raw.status || null;
      // An adopted domain may sit on the OTHER Inboxing login — record where it
      // actually is, or the status poller queries the wrong account and 404s.
      if (r.account) inboxingAccount = r.account;
    }

    const supabase = getSupabaseAdmin();
    const { data: inserted, error: insertErr } = await supabase
      .from("inbox_orders")
      .insert({
        instance,
        provider,
        inboxing_account: provider === "inboxing" ? inboxingAccount : null,
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
