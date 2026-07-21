import type { InboxOrderAlias, InboxOrderProvider, Persona, NameSpec } from "@/types/inbox-order";
import { MAILBOX_COUNT_BY_PROVIDER } from "@/types/inbox-order";

const MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT = `You generate female identity records as plaintext rows. Output rows only.`;

function buildUserPrompt(provider: InboxOrderProvider, count: number): string {
  return `Generate female identity records based on the requested total output count.

Provider: ${provider}
Total rows requested: ${count}

Rules:
- Generate exactly ${count} output rows.
- Each row contains either an American woman's name or a Latina woman's name.
- Mix style: roughly 2 American names for every 1 Latina name.

Name requirements:
- Names should resemble real women in the United States born between 1990–2005.
- Use realistic, common names only.
- Avoid celebrity names, unusual spellings, or exaggerated names.
- Occasionally include longer or multi-syllable last names for realism.

American names — simple, common U.S. female names. Examples of style only:
Ashley Miller
Megan Brooks
Lauren Mitchell

Latina names — simple, common Latina names. Examples of style only:
Camila Navarro
Daniela Ruiz
Sofia Martinez

Alias rules:
- all lowercase
- no numbers
- no email domains
- only letters, periods, and underscores allowed
- aliases should resemble real personal email usernames
- aliases must be unique within this output

Allowed alias styles:
first.last, firstlast, f.lastname, firstl, first_last, lastname.first, first.m.last, flast

Output format (one row per line, no numbering, no headers, no blank lines):
First Last | alias

Do NOT include numbering, headers, explanations, bullet points, or blank lines.`;
}

function parseRows(text: string, count: number): InboxOrderAlias[] {
  const seen = new Set<string>();
  const out: InboxOrderAlias[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("|").map((p) => p.trim());
    if (parts.length < 2) continue;
    const nameParts = parts[0].split(/\s+/);
    if (nameParts.length < 2) continue;
    const first_name = nameParts[0];
    const last_name = nameParts.slice(1).join(" ");
    const alias = parts[1].toLowerCase();
    if (!/^[a-z._]+$/.test(alias)) continue;
    if (seen.has(alias)) continue;
    seen.add(alias);
    out.push({ first_name, last_name, alias });
    if (out.length >= count) break;
  }
  return out;
}

// One OpenAI call → up to `count` identity rows (name|alias), aliases unique
// within this call.
async function fetchIdentityRows(provider: InboxOrderProvider, count: number): Promise<InboxOrderAlias[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(provider, count) },
      ],
      temperature: 0.9,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("OpenAI returned no content");
  }
  return parseRows(content, count);
}

export async function generateAliases(
  provider: InboxOrderProvider,
  count?: number
): Promise<InboxOrderAlias[]> {
  const targetCount = count ?? MAILBOX_COUNT_BY_PROVIDER[provider];
  const aliases = await fetchIdentityRows(provider, targetCount);
  if (aliases.length < targetCount) {
    throw new Error(`Aliases generator returned ${aliases.length}/${targetCount} valid rows`);
  }
  return aliases.slice(0, targetCount);
}

// Auto mode with UNIQUE identities: every mailbox gets its own distinct full
// name AND alias (no two mailboxes share a name within an order). Requests a
// buffer + tops up across a few calls to absorb duplicate names the model
// returns.
export async function generateUniqueIdentities(
  provider: InboxOrderProvider,
  count: number
): Promise<InboxOrderAlias[]> {
  const seenNames = new Set<string>();
  const seenAliases = new Set<string>();
  const out: InboxOrderAlias[] = [];

  for (let attempt = 0; attempt < 6 && out.length < count; attempt++) {
    const need = count - out.length;
    // Ask for more than we need so name/alias collisions still leave enough.
    const ask = Math.min(count + 15, need + Math.ceil(need * 0.4) + 5);
    let rows: InboxOrderAlias[] = [];
    try {
      rows = await fetchIdentityRows(provider, ask);
    } catch (e) {
      if (attempt === 0) throw e; // first call failing is fatal; later ones we tolerate
      break;
    }
    for (const r of rows) {
      const nameKey = `${r.first_name} ${r.last_name}`.trim().toLowerCase();
      if (!nameKey || seenNames.has(nameKey) || seenAliases.has(r.alias)) continue;
      seenNames.add(nameKey);
      seenAliases.add(r.alias);
      out.push(r);
      if (out.length >= count) break;
    }
  }

  if (out.length < count) {
    throw new Error(`Could only generate ${out.length}/${count} unique sender names — try again`);
  }
  return out.slice(0, count);
}

// ── 1–2 persona model ────────────────────────────────────────────────────────
// A domain's mailboxes are built from 1 or 2 sender personas (display names).
// 1 name → every mailbox uses that person; 2 names → mailboxes split half/half.
// Each mailbox's `alias` (email prefix) is a UNIQUE variation of ITS persona's
// name only (never a different name).

function slug(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
}

// Ordered stream of unique alias candidates for one name: clean numberless
// variations first, then (only once those run out) the same variations with a
// numeric suffix so we can always reach a large mailbox count from one name.
function* aliasCandidates(first: string, last: string): Generator<string> {
  const f = slug(first) || "user";
  const l = slug(last) || "mail";
  const fi = f[0];
  const li = l[0];
  const bases = [
    `${f}.${l}`, `${f}${l}`, `${fi}.${l}`, `${f}.${li}`, `${fi}${l}`, `${f}${li}`,
    `${f}_${l}`, `${l}.${f}`, `${l}${f}`, `${fi}_${l}`, `${l}.${fi}`, `${f}.${fi}.${l}`,
    `${l}_${f}`, `${f}`, `${l}`, `${fi}.${li}`,
  ].filter((a, i, arr) => /^[a-z._]+$/.test(a) && a.length >= 2 && arr.indexOf(a) === i);
  const seen = new Set<string>();
  for (const b of bases) { if (!seen.has(b)) { seen.add(b); yield b; } }
  // Clean set exhausted — same name, numeric suffix, to guarantee the count.
  for (let n = 2; ; n++) {
    for (const b of bases) {
      const cand = `${b}${n}`;
      if (!seen.has(cand)) { seen.add(cand); yield cand; }
    }
  }
}

/** Build `mailboxCount` mailboxes from 1–2 personas (split half/half for 2). */
export function buildAliases(personas: Persona[], mailboxCount: number): InboxOrderAlias[] {
  const clean = (personas || [])
    .filter((p) => p.first_name?.trim() && p.last_name?.trim())
    .slice(0, 2);
  if (clean.length === 0) throw new Error("At least one sender name is required");
  const shares = clean.length === 1
    ? [mailboxCount]
    : [Math.ceil(mailboxCount / 2), Math.floor(mailboxCount / 2)];

  const used = new Set<string>();
  const out: InboxOrderAlias[] = [];
  clean.forEach((p, idx) => {
    const gen = aliasCandidates(p.first_name, p.last_name);
    let got = 0;
    while (got < shares[idx]) {
      const next = gen.next().value as string;
      if (used.has(next)) continue; // globally unique across both personas
      used.add(next);
      out.push({ first_name: p.first_name.trim(), last_name: p.last_name.trim(), alias: next });
      got++;
    }
  });
  return out;
}

/** AI-generate 1–2 realistic female personas (display names only). */
export async function generateFemalePersonas(count: number): Promise<Persona[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const n = Math.max(1, Math.min(2, count));
  const prompt = `Output exactly ${n} realistic female full name${n === 1 ? "" : "s"}, one per line as "First Last".
Rules: common United States or Latina women's names, as if born 1990–2005; realistic and common; no celebrities, no unusual spellings, no numbering, no extra text.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You output female full names as plaintext rows. Output rows only." },
        { role: "user", content: prompt },
      ],
      temperature: 0.9,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const personas: Persona[] = [];
  for (const line of content.split(/\r?\n/)) {
    const parts = line.trim().replace(/^\d+[.)]\s*/, "").split(/\s+/);
    if (parts.length < 2) continue;
    personas.push({ first_name: parts[0], last_name: parts.slice(1).join(" ") });
    if (personas.length >= n) break;
  }
  if (personas.length < n) throw new Error(`Persona generator returned ${personas.length}/${n}`);
  return personas;
}

/** Resolve a NameSpec → the full mailbox alias list for a provider. */
export async function buildAliasesFromNameSpec(
  provider: InboxOrderProvider,
  spec: NameSpec,
): Promise<{ personas: Persona[]; aliases: InboxOrderAlias[] }> {
  const mailboxCount = MAILBOX_COUNT_BY_PROVIDER[provider];

  // AUTO: every mailbox gets its own unique full name + alias (personaCount is
  // ignored — it only applies to manual, where the user supplies 1–2 names).
  if (spec.nameMode !== "manual") {
    const aliases = await generateUniqueIdentities(provider, mailboxCount);
    const personas = aliases.map((a) => ({ first_name: a.first_name, last_name: a.last_name }));
    return { personas, aliases };
  }

  // MANUAL: use exactly the 1–2 supplied names, shared/split across mailboxes.
  const personaCount = spec.personaCount === 2 ? 2 : 1;
  const personas = (spec.names || [])
    .filter((p) => p.first_name?.trim() && p.last_name?.trim())
    .slice(0, personaCount);
  if (personas.length < personaCount) {
    throw new Error(`Provide ${personaCount} name${personaCount === 1 ? "" : "s"} with a first and last name`);
  }
  return { personas, aliases: buildAliases(personas, mailboxCount) };
}
