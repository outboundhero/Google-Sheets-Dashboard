import type { InboxOrderAlias, InboxOrderProvider } from "@/types/inbox-order";
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

export async function generateAliases(
  provider: InboxOrderProvider,
  count?: number
): Promise<InboxOrderAlias[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const targetCount = count ?? MAILBOX_COUNT_BY_PROVIDER[provider];

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
        { role: "user", content: buildUserPrompt(provider, targetCount) },
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

  const aliases = parseRows(content, targetCount);
  if (aliases.length < targetCount) {
    throw new Error(`Aliases generator returned ${aliases.length}/${targetCount} valid rows`);
  }
  return aliases.slice(0, targetCount);
}
