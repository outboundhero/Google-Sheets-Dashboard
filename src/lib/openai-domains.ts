const MODEL = "gpt-4o-mini";
const DEFAULT_COUNT = 80;
const DEFAULT_NICHE = "commercial cleaning";

export const SUPPORTED_TLDS = [".info", ".com", ".co", ".net", ".org"] as const;
export type SupportedTld = (typeof SUPPORTED_TLDS)[number];

export type GenerationMode = "niche" | "lookalike";

export interface GenerateParams {
  mode: GenerationMode;
  tlds: SupportedTld[];       // ≥1, subset of SUPPORTED_TLDS
  count?: number;             // default 80
  niche?: string;             // mode "niche" (default "commercial cleaning")
  seedDomain?: string;        // mode "lookalike" (required)
  examples?: string[];        // few-shot style refs + exclusion set
}

function tldListText(tlds: SupportedTld[]): string {
  return tlds.join(", ");
}

function buildPrompt(params: GenerateParams): string {
  const { mode, tlds } = params;
  const count = params.count ?? DEFAULT_COUNT;
  const examples = params.examples ?? [];
  const exampleBlock =
    examples.length > 0
      ? `Style reference — match the look/length/word-choice of these existing domains:
${examples.map((e) => `- ${e}`).join("\n")}

`
      : "";

  const tldRule = `Each name must end in exactly one of these TLDs: ${tldListText(tlds)}. Spread the ${count} names roughly evenly across the allowed TLDs.`;

  if (mode === "lookalike") {
    const seed = (params.seedDomain || "").trim().toLowerCase();
    return `${exampleBlock}Generate ${count} close "look-a-like" domain name variants of the seed domain "${seed}".
Rules:
- Produce believable alternatives a business might use alongside "${seed}": word-order swaps, added prefixes/suffixes (get, try, go, my, the, hq, app, hello, book), close synonyms, and TLD swaps.
- Keep the core brand/keywords of the seed recognizable.
- Lowercase, no hyphens, no numbers, no spaces.
- ${tldRule}
- Avoid trademarked or famous brand names. Do not repeat the seed or any reference domain above.

Return JSON only: { "domains": ["variant1${tlds[0]}", "variant2${tlds[0]}", ...] }`;
  }

  const niche = (params.niche || DEFAULT_NICHE).trim();
  return `${exampleBlock}Generate ${count} fresh domain name suggestions for a ${niche} business.
Rules:
- Descriptive multi-word names that combine an industry term with a business descriptor (services, solutions, group, hub, pros, experts, team, co, plus, max, prime, elite, building, commercial, etc.).
- Lowercase, no hyphens, no numbers, no spaces.
- ${tldRule}
- Avoid trademarked or famous brand names.
- Do not repeat any of the reference domains above.

Return JSON only: { "domains": ["name1${tlds[0]}", "name2${tlds[0]}", ...] }`;
}

export async function generateDomainCandidates(params: GenerateParams): Promise<string[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const tlds: SupportedTld[] = params.tlds && params.tlds.length > 0 ? params.tlds : [".info"];
  const p: GenerateParams = { ...params, tlds };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You generate domain name lists. Output JSON only." },
        { role: "user", content: buildPrompt(p) },
      ],
      response_format: { type: "json_object" },
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

  let parsed: { domains?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OpenAI response was not valid JSON");
  }

  const raw = Array.isArray(parsed.domains) ? parsed.domains : [];
  const exampleSet = new Set((params.examples ?? []).map((e) => e.toLowerCase()));
  // Accept a candidate only if it already ends in one of the selected TLDs.
  const tldAlt = tlds.map((t) => t.replace(".", "\\.")).join("|");
  const re = new RegExp(`^[a-z0-9-]+(${tldAlt})$`);
  const cleaned = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const lower = item.trim().toLowerCase();
    if (!lower) continue;
    if (!re.test(lower)) continue;
    if (lower.startsWith("-") || /-\.[a-z]+$/.test(lower)) continue;
    if (exampleSet.has(lower)) continue;
    cleaned.add(lower);
  }
  return Array.from(cleaned);
}
