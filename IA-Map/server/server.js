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
    // ── PASS 0: Scope understanding (quick, no scrape) ──
    if (action === 'understand') {
      const { url: uUrl, brief_text, competitors_hint } = req.body;
      const bullets = await understandScope(uUrl, brief_text, competitors_hint);
      return res.json({ bullets });
    }

    if (action === 'synthesise') {
      const { brief_text, document_base64, document_media_type } = req.body;
      const result = await synthesiseIA(targetData, competitorData, brief_text, document_base64, document_media_type);
      return res.json(result);
    }

    if (action === 'analyse') {
      const result = await analyseIA(targetData, competitorData, competitors);
      return res.json(result);
    }

    // ── PASS 1: Scrape ──
    if (!url) return res.status(400).json({ error: 'URL is required' });

    // Derive a company name hint from the URL for early competitor ID
    let domainHint = url;
    try { domainHint = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, ''); } catch {}

    // Run target scrape + competitor identification in parallel
    const [tData, comps] = await Promise.all([
      scrapeSite(url, true),   // deep=true for target
      identifyCompetitors(url, domainHint, competitors_manual),
    ]);

    // Scrape competitors (shallow) in parallel — cap at 3
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
   SCRAPING
═══════════════════════════════════════════ */

const UA = 'Mozilla/5.0 (compatible; IAMap/1.0; +https://netbramha.com)';

/* ── Fetch all URLs from sitemap, following sitemap index files ── */
async function fetchSitemapUrls(domain) {
  const candidates = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap/sitemap.xml'];

  // Also check robots.txt for a Sitemap: directive
  try {
    const rb = await fetch(`${domain}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) });
    if (rb.ok) {
      const txt = await rb.text();
      const m = txt.match(/Sitemap:\s*(https?:\/\/[^\s]+)/gi);
      if (m) m.forEach(line => { const u = line.replace(/^sitemap:\s*/i,'').trim(); if (!candidates.includes(u)) candidates.push(u); });
    }
  } catch { /* silent */ }

  for (const path of candidates) {
    try {
      const sitemapUrl = path.startsWith('http') ? path : `${domain}${path}`;
      const res = await fetch(sitemapUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const xml = await res.text();
      if (!xml.includes('<loc>')) continue;

      // Sitemap index — follow child sitemaps
      if (xml.includes('<sitemapindex')) {
        const childUrls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
        const childResults = await Promise.allSettled(
          childUrls.slice(0, 15).map(async child => {
            try {
              const r = await fetch(child, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
              if (!r.ok) return [];
              const x = await r.text();
              return [...x.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
            } catch { return []; }
          })
        );
        const all = childResults.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
        if (all.length) return { urls: all, total: all.length };
      }

      // Regular sitemap
      const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
      if (urls.length) return { urls, total: urls.length };
    } catch { /* silent */ }
  }

  return { urls: [], total: 0 };
}

/* ── Build a section map: path segment → page count ── */
function buildSectionMap(urls, domain) {
  const sections = {};
  for (const url of urls) {
    try {
      const path = new URL(url).pathname;
      const seg = path.split('/').filter(Boolean)[0];
      if (!seg || seg.match(/\.(xml|html|pdf|jpg|png)$/i)) continue;
      sections[seg] = (sections[seg] || 0) + 1;
    } catch { /* silent */ }
  }
  return Object.entries(sections)
    .sort((a, b) => b[1] - a[1])
    .map(([seg, count]) => `/${seg}/ — ${count} page${count > 1 ? 's' : ''}`);
}

/* ── Section-aware inner page selection ── */
function selectInnerPages(sitemapUrls, navLinks, domain, max = 12) {
  const allUrls = [
    ...sitemapUrls,
    ...navLinks.map(l => l.href).filter(h => h.startsWith(domain)),
  ];
  const seen = new Set();
  const selected = [];

  // Priority patterns first
  const priority = [
    /\/(about|who-we-are|about-us|company|our-story|overview)\/?$/i,
    /\/(solutions|products|services|offerings|platform|capabilities)\/?$/i,
    /\/(investor|investor-services|invest)\/?$/i,
    /\/(enroll|register|sign-up|signup)\/?$/i,
    /\/(industries|sectors|verticals|segments)\/?$/i,
    /\/(technology|tech|innovation|ai|data|digital)\/?$/i,
    /\/(newsroom|news|media|press|insights|resources|blog)\/?$/i,
    /\/(careers|jobs|join-us|work-with-us)\/?$/i,
    /\/(contact|reach-us|get-in-touch)\/?$/i,
    /\/(transact|transaction|mutual-fund|mf)\/?$/i,
    /\/(partners|distributors|advisors|ifa)\/?$/i,
    /\/(tools|calculators|calculator)\/?$/i,
  ];

  for (const pat of priority) {
    const match = allUrls.find(u => pat.test(u) && !seen.has(u));
    if (match) { selected.push(match); seen.add(match); }
    if (selected.length >= max) break;
  }

  // Fill remaining slots: one representative URL per top-level path section
  const sections = {};
  for (const url of allUrls) {
    try {
      const seg = new URL(url).pathname.split('/').filter(Boolean)[0];
      if (!seg) continue;
      if (!sections[seg]) sections[seg] = [];
      sections[seg].push(url);
    } catch { /* silent */ }
  }
  for (const urls of Object.values(sections)) {
    if (selected.length >= max) break;
    const pick = urls.find(u => !seen.has(u));
    if (pick) { selected.push(pick); seen.add(pick); }
  }

  return selected.slice(0, max);
}

async function scrapeSite(rawUrl, deep = false) {
  const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  let domain;
  try { domain = new URL(url).origin; } catch { domain = url; }

  const result = {
    domain, title: '', nav: [], sitemap_urls: [], site_sections: [],
    footer_links: [], page_count: 0, meta_desc: '', inner_pages: [],
  };

  // ── Sitemap — follow index files, aggregate all child sitemaps ──
  const { urls: sitemapUrls, total } = await fetchSitemapUrls(domain);
  result.sitemap_urls = sitemapUrls.slice(0, 300); // keep up to 300 for section analysis
  result.page_count   = total;
  result.site_sections = buildSectionMap(sitemapUrls, domain); // structured section breakdown

  // ── Homepage ──
  try {
    const res = await fetch(domain, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(10000), redirect: 'follow',
    });
    if (res.ok) {
      const html = await res.text();
      const len  = html.length;
      const titleMatch = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
      result.title = titleMatch ? titleMatch[1].trim() : domain;
      const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i);
      result.meta_desc = metaMatch ? metaMatch[1].trim() : '';
      result.nav = extractLinks(html.slice(0, Math.floor(len * 0.25)), domain).slice(0, 30);
      result.footer_links = extractLinks(html.slice(Math.floor(len * 0.85)), domain).slice(0, 40);
      const navBlocks = [...html.matchAll(/<(?:nav|header)[^>]*>([\s\S]{1,12000}?)<\/(?:nav|header)>/gi)];
      if (navBlocks.length) result.structured_nav = extractLinks(navBlocks.map(m => m[1]).join(' '), domain).slice(0, 30);
    }
  } catch { /* silent */ }

  // ── Deep inner-page scraping (target only, up to 12 pages) ──
  if (deep) {
    const toScrape = selectInnerPages(result.sitemap_urls, result.nav, domain, 8);
    console.log(`Deep scraping ${toScrape.length} inner pages for ${domain}`);
    const innerResults = await Promise.allSettled(
      toScrape.map(pageUrl => scrapeInnerPage(pageUrl, domain))
    );
    result.inner_pages = innerResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
  }

  return result;
}

async function scrapeInnerPage(pageUrl, domain) {
  try {
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(10000), redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();

    const titleMatch = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : pageUrl;

    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i);
    const meta_desc = metaMatch ? metaMatch[1].trim() : '';

    // H1–H3 headings
    const headings = [...html.matchAll(/<h[1-3][^>]*>\s*([\s\S]{2,200}?)\s*<\/h[1-3]>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim())
      .filter(h => h.length > 3 && h.length < 120)
      .slice(0, 24);

    // Card / teaser titles (common in service/product pages)
    const cardTitles = [...html.matchAll(/<(?:h4|h5|strong|b|dt)[^>]*>\s*([^<]{4,80})\s*<\/(?:h4|h5|strong|b|dt)>/gi)]
      .map(m => m[1].replace(/\s+/g,' ').trim())
      .filter(t => t.length > 4 && t.length < 80 && !/^\d+$/.test(t))
      .slice(0, 16);

    // Body copy — first meaningful paragraphs (strip nav/footer noise by targeting <main> or <article> first)
    const mainMatch = html.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
    const bodySource = mainMatch ? mainMatch[1] : html;
    const bodyText = [...bodySource.matchAll(/<p[^>]*>\s*([\s\S]{20,600}?)\s*<\/p>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim())
      .filter(t => t.length > 30 && !/^(cookie|copyright|all rights|©|\d{4})/i.test(t))
      .slice(0, 5)
      .join(' ')
      .slice(0, 600);

    // Sub-links on this page (good proxy for what the page covers)
    const links = extractLinks(html, domain).slice(0, 24);

    return { url: pageUrl, title, meta_desc, headings, card_titles: cardTitles, body_text: bodyText, links };
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
  const MAX_COMP = 3;
  // If manual entries provided, resolve their real domains + fill remaining slots
  const manualRaw = (manualList || []).slice(0, MAX_COMP);
  const needed = MAX_COMP - manualRaw.length;

  let resolved = [];
  if (manualRaw.length) {
    try {
      const res = await callClaude({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{ role: 'user', content: `Resolve these competitor names/abbreviations to their real company name and website domain:\n${manualRaw.join(', ')}\n\nReturn ONLY a JSON array (one entry per input, same order):\n[{"name":"Full Company Name","domain":"domain.com","type":"manual"}]` }],
      });
      const txt = res.content[0].text.replace(/```json|```/g, '').trim();
      const m = txt.match(/\[[\s\S]*\]/);
      if (m) resolved = JSON.parse(m[0]);
    } catch (e) { console.error('Manual competitor resolve failed:', e); }
    // Fallback: use raw strings if resolve failed
    if (!resolved.length) resolved = manualRaw.map(c => ({ name: c, domain: c.replace(/^www\./, ''), type: 'manual' }));
  }

  if (needed <= 0) return resolved.slice(0, MAX_COMP);

  try {
    const response = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: `Company: "${companyName}" (URL: ${url})\nAlready benchmarking: ${resolved.map(c => c.name).join(', ') || 'none'}.\nIdentify exactly ${needed} additional competitor(s) for IA benchmarking — different from the ones already listed. Best-in-class website IA in the same industry.\nReturn ONLY a JSON array:\n[{"name":"Company Name","domain":"domain.com","type":"global|local"}]` }],
    });
    const text = response.content[0].text;
    const jsonMatch = text.replace(/```json|```/g, '').trim().match(/\[[\s\S]*\]/);
    if (jsonMatch) return [...resolved, ...JSON.parse(jsonMatch[0])].slice(0, MAX_COMP);
  } catch (e) { console.error('Competitor ID failed:', e); }
  return resolved;
}

/* ═══════════════════════════════════════════
   PASS 0 — SCOPE UNDERSTANDING (fast, no scrape)
═══════════════════════════════════════════ */
async function understandScope(url, brief_text, competitors_hint) {
  const prompt = `You are about to analyze the website at "${url || 'the provided URL'}" to propose a revamped information architecture.

${brief_text ? `CLIENT BRIEF / INTENT:\n${brief_text}\n\n` : ''}${competitors_hint ? `REQUESTED COMPETITORS: ${competitors_hint}\n\n` : ''}Generate 5–7 crisp bullet points summarising what you understand about this project. Each bullet must be ONE short sentence — maximum 18 words. No sub-clauses, no lists within a bullet. Specific and concrete — reference the actual company name (infer from URL) and real deliverables.

Cover in this order:
1. Company name and what they do (one line)
2. Core IA problem on the existing site (one line)
3. Primary goal of this revamp (one line)
4. Key requirement from the brief (one line, only if brief provided)
5. Competitors to benchmark against (one line)
6. What the proposed IA will prioritise surfacing (one line)
7. Depth of output — L1/L2/L3 scope (one line)

Return ONLY a JSON array of short strings, no explanation, no markdown:
["bullet 1", "bullet 2", ...]`;

  try {
    const response = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch (e) { console.error('understand failed:', e); }
  return [
    `Analysing ${url} for a full IA and sitemap revamp`,
    'Proposing a need-based primary navigation (4–6 items)',
    'Benchmarking against 3 industry-relevant competitors',
    'Surfacing all product lines and capabilities at L2',
    'Generating L1 → L2 → L3 IA with rationale and analysis',
  ];
}

/* ═══════════════════════════════════════════
   COMPETITOR DELTA PRE-PROCESSING
   Structured diff of target vs competitors —
   surfaces concrete gaps before synthesis.
═══════════════════════════════════════════ */
async function buildCompetitorDelta(targetData, competitorData) {
  const targetNav = (targetData.structured_nav || targetData.nav || [])
    .slice(0, 16).map(l => l.text).filter(Boolean).join(', ');

  const compRows = competitorData.map(c => {
    const nav = (c.structured_nav || c.nav || []).slice(0, 16).map(l => l.text).filter(Boolean).join(', ');
    const sections = (c.site_sections || []).slice(0, 10).join(', ');
    return `${c.domain} — nav: [${nav}]${sections ? ` | sections: ${sections}` : ''}`;
  }).join('\n');

  const prompt = `You are comparing a target website's navigation against its competitors to find IA gaps.

TARGET SITE: ${targetData.domain}
TARGET NAV: [${targetNav}]
TARGET SECTIONS: ${(targetData.site_sections||[]).slice(0,12).join(', ')||'unknown'}

COMPETITORS:
${compRows}

Produce a structured gap analysis. For each gap, be specific — name the actual nav label or section.

Return ONLY a JSON array, no markdown:
[
  {
    "gap": "short label for the gap (e.g. 'Missing advisor/distributor section')",
    "competitors_with_it": ["domain1.com", "domain2.com"],
    "recommendation": "adopt | consider | skip",
    "reason": "one sentence — why this matters for the target site's audience"
  }
]

Only include gaps that are genuinely meaningful for IA decisions. 5–9 gaps max.`;

  try {
    const response = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].text.replace(/```json|```/g,'').trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch (e) { console.error('Competitor delta failed:', e); return []; }
}

/* ═══════════════════════════════════════════
   CHAIN-OF-THOUGHT PRE-PASS
   Reason about IA problems before generating JSON.
   Output is injected as hidden context into Pass 2.
═══════════════════════════════════════════ */
async function reasonAboutIA(targetData, competitorData, briefText, industryLabel) {
  const compSummary = competitorData.map(c =>
    `- ${c.domain}: nav = [${(c.structured_nav || c.nav || []).slice(0, 8).map(l => l.text).join(', ')}]`
  ).join('\n');

  const innerSummary = (targetData.inner_pages || []).slice(0, 6).map(p =>
    `  ${p.url}: headings=[${(p.headings||[]).slice(0,5).join(' / ')}]${p.body_text ? ` | body="${p.body_text.slice(0,120)}..."` : ''}`
  ).join('\n');

  const prompt = `You are a senior IA consultant. Before generating a proposed site structure, reason carefully about this website.

COMPANY: ${targetData.title} (${targetData.domain})
INDUSTRY: ${industryLabel}
CURRENT NAV: ${(targetData.structured_nav || targetData.nav || []).slice(0,12).map(l=>l.text).join(' | ')}
SITE SECTIONS: ${(targetData.site_sections||[]).slice(0,15).join(', ')}
PAGE COUNT: ${targetData.page_count || 'unknown'}
${briefText ? `CLIENT BRIEF: ${briefText.slice(0,400)}\n` : ''}
INNER PAGE SAMPLES:
${innerSummary}

COMPETITOR NAV PATTERNS:
${compSummary}

Answer these 4 questions in plain prose (2-3 sentences each). Be specific — name actual nav items, pages, and product lines you can see.

1. CURRENT IA PROBLEMS: What are the 3 most significant structural problems with the current navigation? (e.g. buried products, missing sections, jargon labels, wrong depth)

2. CONTENT GAPS: What content areas or product lines are visible in inner pages / site sections but NOT surfaced in the primary nav? These are the key things being missed.

3. COMPETITOR LESSONS: What specific navigation patterns do competitors use that this site should adopt? Be concrete — name the competitor and the pattern.

4. IA STRATEGY: Given the company type, portfolio, and brief, what should the overall IA philosophy be? What are the 2-3 most important structural decisions?`;

  try {
    const response = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0].text.trim();
  } catch (e) {
    console.error('CoT pre-pass failed:', e);
    return null;
  }
}

/* ═══════════════════════════════════════════
   PASS 2 — IA STRUCTURE (Sonnet, full prompt)
═══════════════════════════════════════════ */
async function synthesiseIA(targetData, competitorData, briefText, documentBase64, documentMediaType) {

  // Detect industry from nav/title/meta for tailored rules
  const industryHint = detectIndustry(targetData);

  const system = `You are a Principal Information Architect with 15+ years designing navigation and site structure for large organisations. Your output is used directly in client presentations.

## TASK
Given scraped nav, sitemap URLs, inner page headings, and footer links from a real website, propose a best-in-class revamped IA. Use competitor sites as benchmarks for what good looks like in this industry.

## CORE IA RULES (apply all 14)
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
13. NO MARKETING-SPEAK LABELS — never use "Why [Company]", "Why Us", "Our Difference", "Our Story", "Our Approach" as standalone primary nav items. These are self-congratulatory and visitor-repelling. Fold proof points and differentiation into "WHO WE ARE" L2s (e.g. "Our Advantage", "Leadership", "Client Stories") or surface them as content within relevant sections. A visitor never navigates to "Why Us" — they navigate to what they need and discover the why along the way.
14. CONVERSION PATHWAY — every proposed IA must include at least one explicit conversion entry point in the primary or utility nav. For B2B: "Talk to an Expert", "Request a Demo", or "Get Started" as a prominent action in CONTACT L2 or a sticky CTA label. For B2C: "Get Started", "Open Account", or "Apply Now" surfaced in primary nav actions. The desc and actions fields of the relevant nav item must name the conversion CTA explicitly — do not leave it implicit.

## WORKED EXAMPLE (study this pattern — apply the same quality of thinking)
INPUT — Current site: SS&C Technologies (ssctech.com)
Current nav: [Solutions, Products, Services, About, News, Careers, Contact]
Problems identified: org-chart structure, "Solutions/Products/Services" are three overlapping buckets, no audience segmentation, no trust signals, no conversion pathway visible.

OUTPUT — Proposed IA:
Primary nav:
- WHO WE SERVE [L1] → Asset Managers / Hedge Funds / Private Equity / Insurance / Banks & Credit Unions / Government
- CAPABILITIES [L1] → Fund Administration / Transfer Agency / Regulatory Reporting / Data & Analytics / Digital & CX / Technology Platform
- TECHNOLOGY [L1] → Advent Portfolio / Black Diamond / Sylvan / Algorithmics / EVOLV / Integrations
- INSIGHTS [L1] → Research & Reports / Webinars / Case Studies / Blog / Events
Utility nav: NEWSROOM / CAREERS / INVESTORS / CONTACT (L2: Talk to an Expert / Existing Client Support / Partner With Us)

Why this works:
- "WHO WE SERVE" replaces the org-chart "Solutions/Products/Services" triple — visitor self-identifies by entity type, not by guessing which bucket their need falls into
- "CAPABILITIES" surfaces what SS&C actually does at a service level — distinct from the technology platforms
- "TECHNOLOGY" is separated because SS&C has named flagship platforms (Advent, Black Diamond) that prospects search for by name — burying them under "Products" loses SEO and recognition value
- CONTACT L2 has explicit conversion CTAs — "Talk to an Expert" is the B2B conversion action, not a generic form

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

  // Run CoT reasoning + competitor delta in parallel — failures are non-fatal
  const [cotResult, deltaResult] = await Promise.allSettled([
    reasonAboutIA(targetData, competitorData, briefText, industryHint.label),
    buildCompetitorDelta(targetData, competitorData),
  ]);
  const cotReasoning   = cotResult.status   === 'fulfilled' ? cotResult.value   : null;
  const competitorDelta = deltaResult.status === 'fulfilled' ? deltaResult.value : [];

  const userText = `${briefText ? `## CLIENT BRIEF / PROJECT INTENT\n${briefText}\n\nFactor these requirements and constraints into every IA decision you make. If the brief names specific sections, products, or goals, ensure they are reflected in the proposed nav.\n\n` : ''}${cotReasoning ? `## STRATEGIC IA ANALYSIS (your own prior reasoning — build on this, don't contradict it)
${cotReasoning}

` : ''}## TARGET SITE
${JSON.stringify({
    domain: targetData.domain,
    title: targetData.title,
    meta_desc: targetData.meta_desc,
    nav: targetData.nav?.slice(0, 20),
    structured_nav: targetData.structured_nav?.slice(0, 20),
    footer_links: targetData.footer_links?.slice(0, 15),
    page_count: targetData.page_count,
    site_sections: targetData.site_sections?.slice(0, 30),
    sitemap_sample: targetData.sitemap_urls?.slice(0, 60),
    inner_pages: (targetData.inner_pages || []).map(p => ({
      url: p.url, title: p.title, meta_desc: p.meta_desc,
      headings: p.headings, card_titles: p.card_titles,
      body_text: p.body_text, links: p.links?.slice(0, 12),
    })),
  })}

## COMPETITOR BENCHMARKS
${JSON.stringify(competitorData.map(c => ({
    domain: c.domain,
    title: c.title,
    nav: c.nav?.slice(0, 14),
    structured_nav: c.structured_nav?.slice(0, 14),
    page_count: c.page_count,
    sitemap_sample: c.sitemap_urls?.slice(0, 25),
    footer_links: c.footer_links?.slice(0, 12),
  })))}

${competitorDelta.length ? `## COMPETITOR GAP ANALYSIS (act on these — don't just note them)
${competitorDelta.map(g =>
  `- ${g.gap} [${g.recommendation.toUpperCase()}] — seen at: ${g.competitors_with_it.join(', ')} — ${g.reason}`
).join('\n')}

` : ''}Apply all 14 rules. No marketing-speak labels. Include explicit conversion CTA. Surface every distinct product line as at minimum an L2. For every gap marked ADOPT above, ensure it appears in the proposed IA. Return ONLY the JSON.`;

  // Build content array — include uploaded document if provided
  const userContent = [];
  if (documentBase64 && documentMediaType) {
    userContent.push({
      type: 'document',
      source: { type: 'base64', media_type: documentMediaType, data: documentBase64 },
      title: 'Client Brief / Project Document',
      cache_control: { type: 'ephemeral' },
    });
  }
  userContent.push({ type: 'text', text: userText });

  const response = await callClaude({
    model: 'claude-sonnet-4-6',
    max_tokens: 10000,
    system,
    messages: [{ role: 'user', content: userContent }],
  });

  const raw = response.content[0].text.replace(/```json|```/g, '').trim();
  const jsonMatch = raw.match(/\{[\s\S]*/);
  if (!jsonMatch) throw new Error('AI returned no JSON');

  let jsonStr = jsonMatch[0];

  // Repair truncated JSON — close any unclosed brackets/braces
  if (response.stop_reason === 'max_tokens') {
    console.warn('synthesiseIA: hit max_tokens, attempting JSON repair');
    const opens  = (jsonStr.match(/[\[{]/g) || []).length;
    const closes = (jsonStr.match(/[\]}]/g) || []).length;
    let diff = opens - closes;
    // Strip trailing incomplete property/value
    jsonStr = jsonStr.replace(/,\s*"[^"]*"?\s*:?\s*[^,}\]]*$/, '');
    while (diff > 0) {
      const lastOpen = [...jsonStr].reverse().find(c => c === '[' || c === '{');
      jsonStr += lastOpen === '[' ? ']' : '}';
      diff--;
    }
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error('AI returned malformed JSON even after repair — try again');
  }
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
    page_count: targetData.page_count,
    site_sections: targetData.site_sections?.slice(0, 20),
    sitemap_sample: targetData.sitemap_urls?.slice(0, 40),
    footer_links: targetData.footer_links?.slice(0, 15),
    inner_pages: (targetData.inner_pages || []).map(p => ({ url: p.url, headings: p.headings, body_text: p.body_text })),
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
