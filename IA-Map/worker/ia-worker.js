/* ══════════════════════════════════════════════
   ia-worker.js — Cloudflare Worker
   Scrapes target + competitors, calls Claude,
   returns structured IA JSON to frontend.

   Environment variables (set via wrangler secret):
     ANTHROPIC_API_KEY
     ALLOWED_ORIGIN
══════════════════════════════════════════════ */

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const { url, competitors_manual } = body;
    if (!url) {
      return new Response(JSON.stringify({ error: 'URL is required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Guard: API key must be present
    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY secret not configured in Cloudflare Worker settings.' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    let step = 'init';
    try {
      // Step 1 — Scrape target site
      step = 'scrape-target';
      const targetData = await scrapeSite(url);

      // Step 2 — Identify competitors (max 3 to keep total time under 55s)
      step = 'identify-competitors';
      const competitors = await identifyCompetitors(url, targetData.title || url, competitors_manual, env);

      // Step 3 — Scrape competitors in parallel (cap at 3)
      step = 'scrape-competitors';
      const competitorResults = await Promise.allSettled(
        competitors.slice(0, 3).map(c => scrapeSite(`https://${c.domain}`).then(d => ({ ...d, meta: c })))
      );
      const competitorData = competitorResults
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      // Step 4 — AI synthesis
      step = 'synthesise';
      const result = await synthesiseIA(targetData, competitorData, competitors, env);

      return new Response(JSON.stringify(result), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });

    } catch (err) {
      console.error(`Worker error at step [${step}]:`, err);
      return new Response(JSON.stringify({
        error: `Step "${step}" failed: ${err.message || 'Unknown error'}`,
      }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },
};

/* ═══════════════════════════════════════════
   SCRAPING
═══════════════════════════════════════════ */
async function scrapeSite(rawUrl) {
  const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  let domain;
  try { domain = new URL(url).origin; } catch { domain = url; }

  const result = {
    domain,
    title: '',
    nav: [],
    sitemap_urls: [],
    footer_links: [],
    page_count: 0,
    meta_desc: '',
  };

  const UA = 'Mozilla/5.0 (compatible; IAMap/1.0; +https://netbramha.com)';

  // ── Priority 1: sitemap.xml ──
  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap/sitemap.xml']) {
    try {
      const res = await fetch(`${domain}${path}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const xml = await res.text();
        const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
        if (urls.length) {
          result.sitemap_urls = urls.slice(0, 120);
          result.page_count   = urls.length;
          break;
        }
      }
    } catch { /* silent */ }
  }

  // ── Priority 2: robots.txt for alternate sitemap ──
  if (!result.sitemap_urls.length) {
    try {
      const res = await fetch(`${domain}/robots.txt`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const text = await res.text();
        const match = text.match(/Sitemap:\s*(https?:\/\/[^\s]+)/i);
        if (match) {
          const smRes = await fetch(match[1], { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
          if (smRes.ok) {
            const xml = await smRes.text();
            const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
            result.sitemap_urls = urls.slice(0, 120);
            result.page_count   = urls.length;
          }
        }
      }
    } catch { /* silent */ }
  }

  // ── Priority 3: Homepage HTML ──
  try {
    const res = await fetch(domain, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (res.ok) {
      const html = await res.text();
      const len  = html.length;

      // Title
      const titleMatch = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
      result.title = titleMatch ? titleMatch[1].trim() : domain;

      // Meta description
      const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i);
      result.meta_desc = metaMatch ? metaMatch[1].trim() : '';

      // Extract all anchor text from early HTML (nav heuristic)
      const earlyHtml = html.slice(0, Math.floor(len * 0.25));
      result.nav = extractLinks(earlyHtml, domain).slice(0, 24);

      // Footer links (last 15%)
      const lateHtml = html.slice(Math.floor(len * 0.85));
      result.footer_links = extractLinks(lateHtml, domain).slice(0, 32);

      // Try to extract structured nav from <nav> or <header> elements
      const navBlocks = [...html.matchAll(/<(?:nav|header)[^>]*>([\s\S]{1,8000}?)<\/(?:nav|header)>/gi)];
      if (navBlocks.length) {
        const navText = navBlocks.map(m => m[1]).join(' ');
        result.structured_nav = extractLinks(navText, domain).slice(0, 20);
      }
    }
  } catch { /* silent */ }

  return result;
}

function extractLinks(html, domain) {
  return [...html.matchAll(/<a[^>]+href=["']([^"'#?]{1,200})["'][^>]*>\s*([^<]{1,60})\s*<\/a>/g)]
    .map(m => ({
      href: m[1].startsWith('http') ? m[1] : `${domain}${m[1].startsWith('/') ? m[1] : '/' + m[1]}`,
      text: m[2].replace(/\s+/g, ' ').trim(),
    }))
    .filter(l => l.text.length > 1 && l.text.length < 50 && !/^(login|sign|cookie|privacy|terms)/i.test(l.text));
}

/* ═══════════════════════════════════════════
   COMPETITOR IDENTIFICATION
═══════════════════════════════════════════ */
async function identifyCompetitors(url, companyName, manualList, env) {
  const manual = (manualList || []).map(c => ({
    domain: c.startsWith('http') ? new URL(c).hostname : c.replace(/^www\./, ''),
    name: c,
    type: 'manual',
  }));

  const MAX_COMP = 3;
  if (manual.length >= MAX_COMP) return manual.slice(0, MAX_COMP);

  const needed = MAX_COMP - manual.length;

  try {
    const response = await callClaude(env, {
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Company: "${companyName}" (URL: ${url})

Identify exactly ${needed} competitor(s) for IA benchmarking. Pick companies known for best-in-class website IA in the same industry — mix of global and regional peers.

Return ONLY a JSON array, no other text:
[{"name": "Company Name", "domain": "domain.com", "type": "global|local"}]`,
      }],
    });

    const text = response.content[0].text;
    const cleaned = text.replace(/```json|```/g, '').trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const auto = JSON.parse(jsonMatch[0]);
      return [...manual, ...auto].slice(0, MAX_COMP);
    }
  } catch (e) {
    console.error('Competitor identification failed:', e);
  }

  return manual;
}

/* ═══════════════════════════════════════════
   AI SYNTHESIS
═══════════════════════════════════════════ */
async function synthesiseIA(targetData, competitorData, competitorMeta, env) {
  const systemPrompt = `You are a senior information architect with 20 years of experience in corporate, B2B SaaS, fintech, and large enterprise websites.

═══ IA BEST PRACTICE RULES (always apply) ═══

NAVIGATION STRUCTURE
1. Primary nav: 4–6 items maximum. Beyond 6 creates cognitive overload.
2. Utility nav (top-right or persistent strip): high-frequency destinations only — CONTACT, SEARCH, LOGIN, PRICING, TRUST, SUPPORT. These are shortcuts, not browse sections.
3. Never organise primary nav by internal org chart. Users navigate by need, not by your org structure.
4. Every L1 must answer: "What problem does this solve for the visitor?" If it can't, it belongs elsewhere.
5. Capability/solution-first beats product-first for B2B: group by what you do for the buyer, not by what you sell.

NAMING CONVENTIONS
- Use: SOLUTIONS, PLATFORM, BUSINESSES, INSIGHTS, ABOUT, NEWSROOM, WHO WE ARE
- Avoid: "About Us" (passive), "Our Companies" (internal), "Media Centre" (dated), "Offerings" (vague)
- Utility: CONTACT, INVESTORS, CAREERS, TRUST, PRICING, SUPPORT (all caps)

CONTENT HIERARCHY
6. Contact must be in persistent nav for any B2B company — it is a CTA, not a footer link.
7. Investor Relations must be max 1 click from homepage for any listed entity.
8. Trust / Security must be surfaced for any fintech, financial services, or data company.
9. Developer tools (API, SDK, docs) must be a top-level nav item for any API-first company.
10. Careers must not be a rootless standalone L1 — it belongs under About or Company.
11. ESG / Sustainability must be max 1 click from primary nav for any regulated or public-market company.
12. A content hub (blog/research/insights) must have named sub-types (reports, articles, events, tools) — never a flat unstructured list.

FAILURE PATTERNS (check each against the target site)
F1. No capability/solution nav at L1 — services buried behind internal business unit names
F2. Contact Us missing from primary nav
F3. Help Center or Support buried inside About/Company dropdown
F4. Developer API buried 3+ levels deep on an API-first product
F5. Trust / Security / Compliance not surfaced for a financial services or data company
F6. AI or flagship product feature buried inside a generic Products dropdown
F7. Duplicate or conflicting URLs for the same content type (e.g. two press release paths)
F8. Business unit names used as nav labels without describing what they do
F9. Investor Relations buried under About or More From [Company]
F10. Newsroom / Press buried under About — should be a named L2 at minimum
F11. Foundation / CSR buried 3+ levels deep — signals ESG is not a priority
F12. Solutions dropdown with 10+ flat items — needs segmentation (by stage, industry, or use case)

═══ ANALYSIS FRAMEWORK ═══

For each competitor you analyse, identify:
- Their IA structure (L1 nav items, major groupings)
- Unique patterns that work well
- What you adopted into the proposed revamp and why
- What you chose NOT to adopt and why (be specific about the reasoning)

For the ia_changes table, document every significant nav item:
- What existed in the current site (Yes / No / Partial)
- What action was taken: "added" | "elevated" | "moved" | "renamed" | "kept" | "reorganised"
- A concise note explaining why

═══ OUTPUT FORMAT ═══

Return ONLY valid JSON. No markdown fences, no explanation text, no preamble. Exact schema:

{
  "company": {
    "name": "string",
    "domain": "string",
    "tagline": "string — their actual tagline or a descriptor",
    "existing_issues": ["string — specific IA failure identified, max 8"]
  },
  "proposed_ia": {
    "primary_nav": [
      {
        "id": "kebab-case-id",
        "name": "L1 NAV LABEL IN CAPS",
        "utility": false,
        "desc": "One-line description of what this section is for",
        "info": ["info bullet 1", "info bullet 2", "info bullet 3"],
        "actions": ["Primary CTA", "Secondary CTA"],
        "l2": [
          {
            "name": "Sub-section Name",
            "desc": "One-line description",
            "info": ["info bullet 1", "info bullet 2", "info bullet 3"],
            "actions": ["action 1", "action 2"],
            "l3": [{"name": "Page or sub-item Name"}]
          }
        ]
      }
    ],
    "utility_nav": [
      {
        "id": "kebab-case-id",
        "name": "UTILITY LABEL IN CAPS",
        "utility": true,
        "desc": "One-line description",
        "info": ["info bullet 1", "info bullet 2"],
        "actions": ["action 1"],
        "l2": []
      }
    ]
  },
  "ia_changes": [
    {
      "item": "NAV ITEM OR SECTION NAME",
      "existed": "Yes | No | Partial",
      "action": "added | elevated | moved | renamed | kept | reorganised",
      "label": "Short human-readable action label",
      "notes": "One sentence explaining what changed and why"
    }
  ],
  "competitors": [
    {
      "name": "string",
      "domain": "string",
      "type": "global | local | manual",
      "primary_nav_count": 0,
      "has_newsroom": true,
      "has_investors": true,
      "has_sustainability": true,
      "has_careers": true,
      "portfolio_organization": "function | stage | geography | brand",
      "ia_structure": "L1 nav items and major groupings described in one line",
      "unique_adopted": "What unique pattern from this competitor was adopted, and where",
      "unique_not_adopted": "What unique pattern was NOT adopted",
      "notable_pattern": "One sentence explanation of the most interesting thing about their IA",
      "findings": [
        {
          "pattern": "Short name of the pattern observed",
          "adopted": "yes | partial | no",
          "reason": "One sentence: why adopted or why not"
        }
      ]
    }
  ],
  "best_practices_applied": ["string — specific rule applied, max 10"],
  "rationale": "2-3 sentences explaining the overall IA strategy and the single most important problem it solves"
}`;

  const userPrompt = `Analyse this company's existing website and propose a new information architecture.

TARGET COMPANY DATA:
${JSON.stringify(targetData, null, 2)}

COMPETITOR SITES DATA:
${JSON.stringify(competitorData.map(c => ({
  domain: c.domain,
  title: c.title,
  meta: c.meta,
  nav: c.nav?.slice(0, 10),
  structured_nav: c.structured_nav?.slice(0, 10),
  sitemap_sample: c.sitemap_urls?.slice(0, 15),
  footer_links: c.footer_links?.slice(0, 10),
  page_count: c.page_count,
})), null, 2)}

Based on:
1. What exists on the current site (identify gaps and failure patterns from the 12-point list)
2. What the best competitors are doing
3. IA best practice rules above
4. The standard expected for a company of this type and scale

Propose a complete new IA. For each L2 page, provide 2-3 INFORMATION items and 1-2 ACTIONS.
Populate the competitors array with what you can infer from their scraped data.
Return ONLY the JSON.`;

  const response = await callClaude(env, {
    max_tokens: 6000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].text;
  const cleaned = text.replace(/```json|```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI returned invalid JSON structure');
  return JSON.parse(jsonMatch[0]);
}

/* ═══════════════════════════════════════════
   CLAUDE API HELPER
═══════════════════════════════════════════ */
async function callClaude(env, params) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      ...params,
    }),
    signal: AbortSignal.timeout(55000), // under CF's 60s limit
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err.slice(0, 200)}`);
  }

  return res.json();
}
