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

    try {
      // Step 1 — Scrape target site
      const targetData = await scrapeSite(url);

      // Step 2 — Identify competitors
      const competitors = await identifyCompetitors(url, targetData.title || url, competitors_manual, env);

      // Step 3 — Scrape competitors in parallel
      const competitorResults = await Promise.allSettled(
        competitors.slice(0, 8).map(c => scrapeSite(`https://${c.domain}`).then(d => ({ ...d, meta: c })))
      );
      const competitorData = competitorResults
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      // Step 4 — AI synthesis
      const result = await synthesiseIA(targetData, competitorData, competitors, env);

      return new Response(JSON.stringify(result), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });

    } catch (err) {
      console.error('Worker error:', err);
      return new Response(JSON.stringify({ error: err.message || 'Analysis failed' }), {
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

  if (manual.length >= 8) return manual.slice(0, 8);

  const needed = 8 - manual.length;

  try {
    const response = await callClaude(env, {
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Company: "${companyName}" (URL: ${url})

Identify ${needed} competitors for IA benchmarking — a mix of global conglomerates, regional peers, and companies known for best-in-class corporate websites.

Return ONLY a JSON array, no other text:
[{"name": "Company Name", "domain": "domain.com", "type": "global|local"}]`,
      }],
    });

    const text = response.content[0].text;
    const cleaned = text.replace(/```json|```/g, '').trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const auto = JSON.parse(jsonMatch[0]);
      return [...manual, ...auto].slice(0, 8);
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
  const systemPrompt = `You are a senior information architect with 20 years of experience specialising in corporate conglomerate, holding company, and large enterprise websites.

You have deep expertise in:
- How diversified holding companies should structure their digital presence
- Investor relations sections for both private groups and publicly listed subsidiaries
- Portfolio/business showcase design patterns
- Editorial newsroom architecture
- Global presence communication
- ESG and sustainability section design
- Executive leadership and governance presentation
- Careers hub patterns for large groups
- Heritage and milestone storytelling

BEST PRACTICE RULES YOU ALWAYS APPLY:
1. Primary nav: maximum 5-6 items. Anything beyond creates cognitive overload.
2. Utility nav (top-right): INVESTORS, CAREERS, CONTACT, SEARCH. These are destinations, not browse sections.
3. Never organise a portfolio by geography first — always by sector, then geography within sector.
4. NEWSROOM beats "Media Centre" — it signals editorial ambition and is the international standard.
5. WHO WE ARE beats "About Us" — confident identity framing for a company of stature.
6. OUR BUSINESSES beats "Our Companies" — active, forward-looking.
7. IMPACT beats "[Foundation name]" in primary nav — communicates purpose to any audience.
8. GLOBAL PRESENCE should be primary nav for any company operating in 3+ countries.
9. Chairman's / Founder's Message must be a standalone deep-linkable page, never just an anchor.
10. Heritage and milestones must be an interactive timeline page, not a buried section.
11. Newsroom must have individual article URLs — no paginated carousels without permalink.
12. Never bury Investors more than 1 click from homepage for any listed entity.
13. Business detail pages should follow a reusable template — one template for all entities.
14. Sustainability must be top-level or one click from primary nav (not 3 levels deep).
15. Search must be persistent in the utility nav, not a hamburger-menu afterthought.

THE 12 CRITICAL FAILURE PATTERNS (check each against the target):
1. Portfolio organised by geography not sector — kills narrative coherence
2. "About Us" framing — passive, lacks confidence for a company of stature
3. Foundation/CSR buried 3+ levels deep — signals ESG is not a priority
4. Newsroom as anchor-link page — no individual article URLs, kills SEO
5. Chairman/Founder message without a standalone URL — not citable, not shareable
6. No dedicated Global Presence page for multi-country operations
7. Investors section absent or buried without its own section
8. Heritage as a sub-section anchor — should be a full interactive timeline page
9. Strategic investments shown without individual pages — creates a dead end
10. Careers only in footer — signals talent is not a priority
11. Search absent from persistent nav
12. No reusable Business Detail template — creates inconsistent portfolio experience

SECTION NAMING CONVENTIONS:
- Use: WHO WE ARE, OUR BUSINESSES, GLOBAL PRESENCE, IMPACT, NEWSROOM
- Avoid: About Us, Our Companies, Worldwide, CSR/Foundation name only, Media Centre
- Utility: INVESTORS, CAREERS, CONTACT (all caps)

OUTPUT FORMAT: Return ONLY valid JSON. No markdown, no explanation, no preamble. Match this exact schema:
{
  "company": {
    "name": "string",
    "domain": "string",
    "tagline": "string",
    "existing_issues": ["string"]
  },
  "proposed_ia": {
    "primary_nav": [
      {
        "id": "kebab-case-id",
        "name": "SECTION NAME",
        "utility": false,
        "desc": "one-line italic descriptor",
        "info": ["info bullet 1", "info bullet 2", "info bullet 3"],
        "actions": ["action bullet 1", "action bullet 2"],
        "l2": [
          {
            "name": "Sub-section Name",
            "desc": "descriptor",
            "info": ["info 1", "info 2"],
            "actions": ["action 1"],
            "l3": [{"name": "Page Name"}]
          }
        ]
      }
    ],
    "utility_nav": [
      {
        "id": "kebab-case-id",
        "name": "UTILITY NAME",
        "utility": true,
        "desc": "descriptor",
        "info": [],
        "actions": [],
        "l2": []
      }
    ]
  },
  "competitors": [
    {
      "name": "string",
      "domain": "string",
      "type": "global|local|manual",
      "primary_nav_count": 0,
      "has_newsroom": true,
      "has_investors": true,
      "has_sustainability": true,
      "has_careers": true,
      "portfolio_organization": "sector|geography|brand",
      "nav_labels": ["string"],
      "notable_pattern": "one sentence"
    }
  ],
  "best_practices_applied": ["string"],
  "rationale": "2-3 sentences"
}`;

  const userPrompt = `Analyse this company's existing website and propose a new information architecture.

TARGET COMPANY DATA:
${JSON.stringify(targetData, null, 2)}

COMPETITOR SITES DATA:
${JSON.stringify(competitorData.map(c => ({
  domain: c.domain,
  title: c.title,
  meta: c.meta,
  nav: c.nav?.slice(0, 15),
  structured_nav: c.structured_nav?.slice(0, 15),
  sitemap_sample: c.sitemap_urls?.slice(0, 30),
  footer_links: c.footer_links?.slice(0, 15),
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
