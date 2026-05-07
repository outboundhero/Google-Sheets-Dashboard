const NICHE = "commercial cleaning";
const TLD = ".info";
const COUNT = 80;
const MODEL = "gpt-4o-mini";

function buildPrompt(examples: string[]): string {
  const exampleBlock = examples.length > 0
    ? `Style reference — match the look/length/word-choice of these existing domains we already own:
${examples.map((e) => `- ${e}`).join("\n")}

`
    : "";

  return `${exampleBlock}Generate ${COUNT} fresh ${TLD} domain name suggestions for a ${NICHE} business.
Rules:
- Match the style of the reference domains above: descriptive multi-word names that combine an industry term (cleaning, janitorial, facility, sanitation, custodial, maintenance, etc.) with a business descriptor (services, solutions, group, hub, pros, experts, team, co, plus, max, prime, elite, building, commercial).
- Lowercase, no hyphens, no numbers, no spaces.
- Each name must end in ${TLD}.
- Avoid trademarked or famous brand names.
- Do not repeat any of the reference domains above.

Return JSON only: { "domains": ["name1${TLD}", "name2${TLD}", ...] }`;
}

export async function generateDomainCandidates(examples: string[] = []): Promise<string[]> {
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
        { role: "system", content: "You generate domain name lists. Output JSON only." },
        { role: "user", content: buildPrompt(examples) },
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
  const exampleSet = new Set(examples.map((e) => e.toLowerCase()));
  const cleaned = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const lower = item.trim().toLowerCase();
    if (!lower) continue;
    const withTld = lower.endsWith(TLD) ? lower : lower.replace(/\.[a-z]+$/, "") + TLD;
    if (!/^[a-z0-9-]+\.info$/.test(withTld)) continue;
    if (withTld.startsWith("-") || withTld.endsWith("-.info")) continue;
    if (exampleSet.has(withTld)) continue;
    cleaned.add(withTld);
  }
  return Array.from(cleaned);
}
