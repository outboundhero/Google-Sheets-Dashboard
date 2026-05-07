const NICHE = "commercial cleaning";
const TLD = ".info";
const COUNT = 80;
const MODEL = "gpt-4o-mini";

const PROMPT = `Generate ${COUNT} generic ${TLD} domain name suggestions for a ${NICHE} business.
Rules:
- Use only a single suffix OR a single prefix attached to a real-word root (not both).
- Brandable, easy to type, lowercase, no hyphens, no numbers.
- Each name must end in ${TLD}.
- Prefer common cleaning/business adjectives like pro, hub, group, services, solutions, plus, max, prime, elite, co (used at most once per name).
- Avoid trademarked or famous brand names.

Return JSON only: { "domains": ["name1${TLD}", "name2${TLD}", ...] }`;

export async function generateDomainCandidates(): Promise<string[]> {
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
        { role: "user", content: PROMPT },
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
  const cleaned = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const lower = item.trim().toLowerCase();
    if (!lower) continue;
    const withTld = lower.endsWith(TLD) ? lower : lower.replace(/\.[a-z]+$/, "") + TLD;
    if (!/^[a-z0-9-]+\.info$/.test(withTld)) continue;
    if (withTld.startsWith("-") || withTld.endsWith("-.info")) continue;
    cleaned.add(withTld);
  }
  return Array.from(cleaned);
}
