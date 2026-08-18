/* ══════════════════════════════════════════════
   ia-map-server — Railway / Node.js
   No timeout constraints — uses Sonnet for all passes.

   Environment variables:
     ANTHROPIC_API_KEY   (required)
     ALLOWED_ORIGIN      (optional, defaults to *)
     PORT                (set automatically by Railway)
══════════════════════════════════════════════ */

import express from 'express';

const app  = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(express.json({ limit: '4mb' }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'IA Map Server v2' }));

app.post('/', async (req, res) => {
  const { action, url, competitors_manual, targetData, competitorData, competitors } = req.body || {};

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured.' });
  }

  try {
    if (action === 'synthesise') {
      const result = await synthesiseIA(targetData, competitorData);
      return res.json(result);
    }

    if (action === 'analyse') {
      const result = await analyseIA(targetData, competitorData, competitors);
      return res.json(result);
    }

    // ── PASS 1: Scrape ──
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const tData = await scrapeSite(url, true);   // deep=true for target
    const comps  = await identifyCompetitors(url, tData.title || url, competitors_manual);
    const compResults = await Promise.allSettled(
      comps.slice(0, 3).map(c => scrapeSite(`https://${c.domain}`, false).then(d => ({ ...d, meta: c })))
    );
    const compData = compResults.filter(r => r.status === 'fulfilled').map(r => r.value);

    return res.json({ scraped: true, targetData: tData, competitorData: compData, competitors: comps });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

app.listen(PORT, () => console.log(`IA Map server v2 running on port ${PORT}`));

/* ═══════════════════════════════════════════
   SCRAPING — homepage + inner pages for target
═══════════════════════════════════════════ */

// Priority inner pages to deep-scrape on target site
const INNER_PAGE_PATTERNS = [
  /\/(about|who-we-are|about-us|company|our-story)\/?$/i,
  /\/(solutions|products|services|offerings|platform|capabilities)\/?$/i,
  /\/(industries|sectors|verticals|segments)\/?$/i,
  /\/(technology|tech|innovation|ai|data)\/?$/i,
  /\/(newsroom|news|media|press|insights|resources)\/?$/i,
];

async function scrapeSite(rawUrl, deep = false) {
  const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  let domain;
  try { domain = new URL(url).origin; } catch { domain = url; }

  const result = {
    domain, title: '', nav: [], sitemap_urls: [], footer_links: [],
    page_count: 0, meta_desc: '', inner_pages: [],
  };
  const UA = 'Mozilla/5.0 (compatible; IAMap/1.0; +https://netbramha.com)';

  // ── Sitemap ──
  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap/sitemap.xml']) {
    try {
      const res = await fetch(`${domain}${path}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const xml = await res.text();
        const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
        if (urls.length) { result.sitemap_urls = urls.slice(0, 150); result.page_count = urls.length; break; }
      }
    } catch { /* silent */ }
  }

  if (!result.sitemap_urls.length) {
    try {
      const res = await fetch(`${domain}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const text = await res.text();
        const match = text.match(/Sitemap:\s*(https?:\/\/[^\s]+)/i);
        if (match) {
          const smRes = await fetch(match[1], { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
          if (smRes.ok) {
            const xml = await smRes.text();
            const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
            result.sitemap_urls = urls.slice(0, 150); result.page_count = urls.length;
          }
        }
      }
    } catch { /* silent */ }
  }

  // ── Homepage ──
  try {
    const res = await fetch(domain, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(8000), redirect: 'follow',
    });
    if (res.ok) {
      const html = await res.text();
      const len  = html.length;
      const titleMatch = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
      result.title = titleMatch ? titleMatch[1].trim() : domain;
      const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i);
      result.meta_desc = metaMatch ? metaMatch[1].trim() : '';
      result.nav = extractLinks(html.slice(0, Math.floor(len * 0.25)), domain).slice(0, 24);
      result.footer_links = extractLinks(html.slice(Math.floor(len * 0.85)), domain).slice(0, 32);
      const navBlocks = [...html.matchAll(/<(?:nav|header)[^>]*>([\s\S]{1,8000}?)<\/(?:nav|header)>/gi)];
      if (navBlocks.length) result.structured_nav = extractLinks(navBlocks.map(m => m[1]).join(' '), domain).slice(0, 20);
    }
  } catch { /* silent */ }

  // ── Deep inner-page scraping (target only) ──
  if (deep) {
    const candidateUrls = result.sitemap_urls.length
      ? result.sitemap_urls
      : result.nav.map(l => l.href);

    const toScrape = [];
    for (const pattern of INNER_PAGE_PATTERNS) {
      const match = candidateUrls.find(u => pattern.test(u));
      if (match && !toScrape.includes(match)) toScrape.push(match);
      if (toScrape.length >= 5) break;
    }

    const innerResults = await Promise.allSettled(
      toScrape.map(pageUrl => scrapeInnerPage(pageUrl, domain, UA))
    );
    result.inner_pages = innerResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
  }

  return result;
}

async function scrapeInnerPage(pageUrl, domain, UA) {
  try {
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(8000), redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();

    const titleMatch = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : pageUrl;

    // Extract headings (H1–H3) as section evidence
    const headings = [...html.matchAll(/<h[1-3][^>]*>\s*([^<]{2,120})\s*<\/h[1-3]>/gi)]
      .map(m => m[1].replace(/\s+/g, ' ').trim())
      .filter(h => h.length > 3 && h.length < 100)
      .slice(0, 20);

    // Sub-links on this page
    const links = extractLinks(html, domain).slice(0, 20);

    // Page-level meta description
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i);
    const meta_desc = metaMatch ? metaMatch[1].trim() : '';

    return { url: pageUrl, title, meta_desc, headings, links };
  } catch {
    return null;
  }
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
async function identifyCompetitors(url, companyName, manualList) {
  const manual = (manualList || []).map(c => ({
    domain: c.startsWith('http') ? new URL(c).hostname : c.replace(/^www\./, ''),
    name: c, type: 'manual',
  }));
  const MAX_COMP = 3;
  if (manual.length >= MAX_COMP) return manual.slice(0, MAX_COMP);
  const needed = MAX_COMP - manual.length;
  try {
    const response = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: `Company: "${companyName}" (URL: ${url})\nIdentify exactly ${needed} competitor(s) for IA benchmarking. Pick companies known for best-in-class website IA in the same industry — mix of global and regional peers.\nReturn ONLY a JSON array:\n[{"name":"Company Name","domain":"domain.com","type":"global|local"}]` }],
    });
    const text = response.content[0].text;
    const jsonMatch = text.replace(/```json|```/g, '').trim().match(/\[[\s\S]*\]/);
    if (jsonMatch) return [...manual, ...JSON.parse(jsonMatch[0])].slice(0, MAX_COMP);
  } catch (e) { console.error('Competitor ID failed:', e); }
  return manual;
}

/* ═══════════════════════════════════════════
   PASS 2 — IA STRUCTURE (Sonnet, full prompt)
═══════════════════════════════════════════ */
async function synthesiseIA(targetData, competitorData) {

  // Detect industry from nav/title/meta for tailored rules
  const industryHint = detectIndustry(targetData);

  const system = `You are a Principal Information Architect with 15+ years designing navigation and site structure for large organisations. Your output is used directly in client presentations.

## TASK
Given scraped nav, sitemap URLs, inner page headings, and footer links from a real website, propose a best-in-class revamped IA. Use competitor sites as benchmarks for what good looks like in this industry.

## CORE IA RULES (apply all 12)
1. VISITOR NEED LABELS — primary nav items must be named from the visitor's perspective, not org structure. "Solutions" not "Business Units", "Who We Are" not "About Company".
2. CAPS CONVENTION — all nav labels in TITLE CASE but rendered in CAPS in the JSON name field. e.g. "SOLUTIONS", "WHO WE ARE".
3. STANDARD UTILITY NAV — always include: CONTACT, CAREERS. Add INVESTORS for listed companies. Add TRUST & SECURITY for fintech/regulated industries. Add NEWSROOM for companies with a media presence.
4. SECTION NAMING — prefer "NEWSROOM" over "Media Centre" or "Press Room" for established organisations with regular press activity. For startups or content-led brands, "BLOG" or "INSIGHTS" may be more honest. Prefer "WHO WE ARE" over "About Us" for large enterprises and professional services firms; "ABOUT" is acceptable for smaller or consumer-facing brands where warmth matters more than gravitas. Always match the label to the company's tone and scale.
5. CONTEXT-APPROPRIATE DEPTH — a startup or SME site warrants 4 primary nav items and shallow L2. A large enterprise or listed company warrants 5–6 primary nav items with rich L2–L3 to surface product breadth. Match complexity to the organisation's actual size and portfolio.
6. SURFACE ALL PRODUCT LINES — every distinct product, service line, or platform found in the sitemap or inner pages must appear as at minimum an L2 item. Do not collapse them into a generic "Products" bucket.
7. DEPTH RULES — primary nav: 4–6 items max. Each L2: 4–8 items max. Each L3: 3–6 items max. Utility nav: 3–5 items, no L2 unless needed for CONTACT.
8. NO ORG CHART MIRRORING — do not mirror internal department structure. Group by customer journey stage or capability cluster.
9. COMPETITOR PATTERNS — adopt proven patterns from competitors: e.g. if competitors surface AI/Technology as a top-level nav, consider it. If competitors have a dedicated Insights hub, adopt it.
10. INDUSTRY SIGNAL — ${industryHint.rule}
11. FAILURE PATTERNS TO AVOID — do NOT: bury products 3 levels deep; create a "Miscellaneous" or "More" nav item; use internal jargon as nav labels; duplicate content across primary and utility nav; create L2 items with only one child.
12. RATIONALE — always explain why each primary nav item was chosen in the rationale field. Reference competitor patterns where adopted.

## OUTPUT SCHEMA (return ONLY valid JSON, no markdown, no explanation)
{
  "company": {
    "name": "",
    "domain": "",
    "industry": "${industryHint.label}",
    "tagline": "",
    "existing_issues": ["list up to 8 specific problems with the current IA"]
  },
  "proposed_ia": {
    "primary_nav": [
      {
        "id": "snake_case_id",
        "name": "CAPS LABEL",
        "utility": false,
        "desc": "What a visitor finds here and why this nav item exists",
        "info": ["key content type 1", "key content type 2", "key content type 3"],
        "actions": ["primary CTA 1", "primary CTA 2"],
        "l2": [
          {
            "name": "L2 Label",
            "desc": "Brief description",
            "info": ["content 1", "content 2"],
            "actions": ["CTA"],
            "l3": [{ "name": "L3 item" }]
          }
        ]
      }
    ],
    "utility_nav": [
      {
        "id": "snake_case_id",
        "name": "CAPS LABEL",
        "utility": true,
        "desc": "",
        "info": [""],
        "actions": [""],
        "l2": []
      }
    ]
  },
  "best_practices_applied": ["up to 8 specific IA decisions made and why"],
  "rationale": "3-4 sentences explaining the overall IA strategy and key tradeoffs"
}`;

  const user = `## TARGET SITE
${JSON.stringify({
    domain: targetData.domain,
    title: targetData.title,
    meta_desc: targetData.meta_desc,
    nav: targetData.nav?.slice(0, 20),
    structured_nav: targetData.structured_nav?.slice(0, 20),
    footer_links: targetData.footer_links?.slice(0, 15),
    sitemap_sample: targetData.sitemap_urls?.slice(0, 50),
    inner_pages: (targetData.inner_pages || []).map(p => ({
      url: p.url, title: p.title, headings: p.headings, links: p.links?.slice(0, 10),
    })),
  })}

## COMPETITOR BENCHMARKS
${JSON.stringify(competitorData.map(c => ({
    domain: c.domain,
    title: c.title,
    nav: c.nav?.slice(0, 12),
    structured_nav: c.structured_nav?.slice(0, 12),
    sitemap_sample: c.sitemap_urls?.slice(0, 20),
    footer_links: c.footer_links?.slice(0, 10),
  })))}

Apply all 12 rules. Surface every distinct product line and capability as at minimum an L2. Return ONLY the JSON.`;

  const response = await callClaude({
    model: 'claude-sonnet-4-6',
    max_tokens: 6000,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const cleaned = response.content[0].text.replace(/```json|```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI returned invalid JSON structure');
  return JSON.parse(jsonMatch[0]);
}

/* ═══════════════════════════════════════════
   PASS 3 — ANALYSIS (Sonnet, full prompt)
═══════════════════════════════════════════ */
async function analyseIA(targetData, competitorData, competitorMeta) {

  const system = `You are a Principal Information Architect delivering a post-design analysis to a senior client stakeholder. Be specific and evidence-based — reference actual nav items and page names, not generic advice.

## TASK
1. Document every meaningful IA change between the existing site and the proposed revamp (ia_changes table).
2. Benchmark each competitor against the proposed IA — what patterns did we adopt, partially adopt, or skip and why.

## ANALYSIS RULES
- ia_changes: compare existing nav/sitemap items to the proposed IA. Classify each change precisely (added, elevated, moved, renamed, reorganised, kept, removed). Include WHY the change was made in the notes field. Min 10 rows, max 18 rows.
- competitors: for each competitor, identify 5–6 specific IA patterns they use. For each, judge whether the proposed IA adopted it (yes/partial/no) and explain the reason concisely.
- findings should cite real page names or nav labels from the scraped data — not generic platitudes.
- portfolio_organization: describe HOW the competitor groups its products/services (e.g. "by industry vertical", "by product family", "by customer size").
- ia_structure: describe the structural pattern (e.g. "hub-and-spoke", "mega-menu with L3 panels", "flat utility-first").

## OUTPUT SCHEMA (return ONLY valid JSON, no markdown)
{
  "ia_changes": [
    {
      "item": "Nav item or section name",
      "existed": "Yes | No | Partial",
      "action": "added | elevated | moved | renamed | kept | reorganised | removed",
      "label": "New label in proposed IA",
      "notes": "Why this change was made — reference actual content evidence"
    }
  ],
  "competitors": [
    {
      "name": "",
      "domain": "",
      "type": "global | local",
      "primary_nav_count": 0,
      "has_newsroom": true,
      "has_investors": true,
      "has_sustainability": true,
      "has_careers": true,
      "portfolio_organization": "",
      "ia_structure": "",
      "notable_pattern": "",
      "findings": [
        {
          "pattern": "Specific IA pattern this competitor uses",
          "adopted": "yes | partial | no",
          "reason": "Why we adopted, partially adopted, or skipped it"
        }
      ]
    }
  ],
  "best_practices_applied": ["up to 8 specific decisions — cite actual nav items or page names"]
}`;

  const user = `## TARGET SITE (existing)
${JSON.stringify({
    domain: targetData.domain,
    title: targetData.title,
    nav: targetData.nav?.slice(0, 20),
    structured_nav: targetData.structured_nav?.slice(0, 20),
    sitemap_sample: targetData.sitemap_urls?.slice(0, 40),
    footer_links: targetData.footer_links?.slice(0, 15),
    inner_pages: (targetData.inner_pages || []).map(p => ({ url: p.url, headings: p.headings })),
  })}

## COMPETITOR SITES
${JSON.stringify(competitorData.map(c => ({
    domain: c.domain,
    title: c.title,
    nav: c.nav?.slice(0, 15),
    structured_nav: c.structured_nav?.slice(0, 15),
    sitemap_sample: c.sitemap_urls?.slice(0, 20),
    footer_links: c.footer_links?.slice(0, 10),
    meta: c.meta,
  })))}

Generate minimum 10 ia_changes rows and 5-6 findings per competitor. Be evidence-specific. Return ONLY the JSON.`;

  const response = await callClaude({
    model: 'claude-sonnet-4-6',
    max_tokens: 5000,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const cleaned = response.content[0].text.replace(/```json|```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI returned invalid JSON for analysis');
  return JSON.parse(jsonMatch[0]);
}

/* ═══════════════════════════════════════════
   INDUSTRY DETECTION
═══════════════════════════════════════════ */
function detectIndustry(targetData) {
  const corpus = [
    targetData.title || '',
    targetData.meta_desc || '',
    ...(targetData.nav || []).map(l => l.text),
    ...(targetData.sitemap_urls || []).slice(0, 30),
  ].join(' ').toLowerCase();

  if (/rating|credit|risk|analytics|compliance|esg|financial data|market data|indices/.test(corpus)) {
    return {
      label: 'Financial Data & Analytics',
      rule: 'Surface RATINGS, RESEARCH/INSIGHTS, RISK SOLUTIONS, and ESG as primary or L2 nav. Investors section mandatory. Trust/Methodology section for credibility.',
    };
  }
  if (/bank|insurance|lending|wealth|mutual fund|nse|bse|stock|investment|fintech/.test(corpus)) {
    return {
      label: 'Financial Services / Fintech',
      rule: 'Surface TRUST & SECURITY as utility nav. Regulatory/compliance pages must be reachable in ≤2 clicks. Products by customer segment (Individual, Business, Enterprise).',
    };
  }
  if (/saas|platform|api|developer|integration|cloud|software|enterprise/.test(corpus)) {
    return {
      label: 'B2B SaaS / Technology',
      rule: 'PLATFORM or PRODUCT as primary nav. DEVELOPERS or API section if developer audience exists. CUSTOMERS/CASE STUDIES must be surfaced. Pricing visible in utility nav.',
    };
  }
  if (/conglomerate|group|subsidiary|business|diversified|holding/.test(corpus)) {
    return {
      label: 'Conglomerate / Diversified Group',
      rule: 'OUR BUSINESSES as primary nav grouping subsidiaries. SUSTAINABILITY mandatory. Investor Relations as utility nav. Avoid flattening all business lines into one nav item.',
    };
  }
  if (/hospital|health|pharma|medicine|clinical|patient|diagnostic/.test(corpus)) {
    return {
      label: 'Healthcare / Life Sciences',
      rule: 'Separate PATIENTS and PROFESSIONALS/HCP navigation paths. Regulatory and safety information must be ≤2 clicks. Research/Pipeline for pharma.',
    };
  }
  if (/university|college|education|course|student|faculty|campus/.test(corpus)) {
    return {
      label: 'Higher Education',
      rule: 'Distinct paths for PROSPECTIVE STUDENTS, CURRENT STUDENTS, ALUMNI, FACULTY. Research and Admissions as primary nav items.',
    };
  }
  return {
    label: 'General / Mixed',
    rule: 'Follow standard IA best practices. Primary nav by visitor need. Surface all product/service lines explicitly.',
  };
}

/* ═══════════════════════════════════════════
   CLAUDE API HELPER
═══════════════════════════════════════════ */
async function callClaude(params) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', ...params }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}
