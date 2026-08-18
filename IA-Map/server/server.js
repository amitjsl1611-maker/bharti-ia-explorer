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

app.use(express.json({ limit: '2mb' }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'IA Map Server' }));

app.post('/', async (req, res) => {
  const { action, url, competitors_manual, targetData, competitorData, competitors } = req.body || {};

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured.' });
  }

  try {
    // ── PASS 2: IA structure ──
    if (action === 'synthesise') {
      const result = await synthesiseIA(targetData, competitorData);
      return res.json(result);
    }

    // ── PASS 3: Analysis ──
    if (action === 'analyse') {
      const result = await analyseIA(targetData, competitorData, competitors);
      return res.json(result);
    }

    // ── PASS 1: Scrape ──
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const tData = await scrapeSite(url);
    const comps  = await identifyCompetitors(url, tData.title || url, competitors_manual);
    const compResults = await Promise.allSettled(
      comps.slice(0, 3).map(c => scrapeSite(`https://${c.domain}`).then(d => ({ ...d, meta: c })))
    );
    const compData = compResults.filter(r => r.status === 'fulfilled').map(r => r.value);

    return res.json({ scraped: true, targetData: tData, competitorData: compData, competitors: comps });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

app.listen(PORT, () => console.log(`IA Map server running on port ${PORT}`));

/* ═══════════════════════════════════════════
   SCRAPING
═══════════════════════════════════════════ */
async function scrapeSite(rawUrl) {
  const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  let domain;
  try { domain = new URL(url).origin; } catch { domain = url; }

  const result = { domain, title: '', nav: [], sitemap_urls: [], footer_links: [], page_count: 0, meta_desc: '' };
  const UA = 'Mozilla/5.0 (compatible; IAMap/1.0; +https://netbramha.com)';

  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap/sitemap.xml']) {
    try {
      const res = await fetch(`${domain}${path}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const xml = await res.text();
        const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
        if (urls.length) { result.sitemap_urls = urls.slice(0, 120); result.page_count = urls.length; break; }
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
            result.sitemap_urls = urls.slice(0, 120); result.page_count = urls.length;
          }
        }
      }
    } catch { /* silent */ }
  }

  try {
    const res = await fetch(domain, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(8000), redirect: 'follow' });
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

  return result;
}

function extractLinks(html, domain) {
  return [...html.matchAll(/<a[^>]+href=["']([^"'#?]{1,200})["'][^>]*>\s*([^<]{1,60})\s*<\/a>/g)]
    .map(m => ({ href: m[1].startsWith('http') ? m[1] : `${domain}${m[1].startsWith('/') ? m[1] : '/' + m[1]}`, text: m[2].replace(/\s+/g, ' ').trim() }))
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
   PASS 2 — IA STRUCTURE (Sonnet, no timeout)
═══════════════════════════════════════════ */
async function synthesiseIA(targetData, competitorData) {
  const system = `You are a senior IA expert. Propose a revamped website IA from scraped nav/sitemap data.
Rules: 4-6 primary nav items, labelled by visitor need not org structure. Utility nav: CONTACT, INVESTORS, CAREERS, TRUST. Use NEWSROOM not "Media Centre", WHO WE ARE not "About Us". Surface Trust/Security for fintech, Investors for listed entities, API nav for API-first products. Surface all unique product lines and flagship features as nav items.
Return ONLY valid JSON, no markdown:
{"company":{"name":"","domain":"","tagline":"","existing_issues":["max 6"]},"proposed_ia":{"primary_nav":[{"id":"","name":"CAPS","utility":false,"desc":"","info":["","",""],"actions":["",""],"l2":[{"name":"","desc":"","info":["",""],"actions":[""],"l3":[{"name":""}]}]}],"utility_nav":[{"id":"","name":"CAPS","utility":true,"desc":"","info":[""],"actions":[""],"l2":[]}]},"best_practices_applied":["max 6"],"rationale":"2-3 sentences"}`;

  const user = `TARGET:
${JSON.stringify({ domain: targetData.domain, title: targetData.title, nav: targetData.nav?.slice(0,15), structured_nav: targetData.structured_nav?.slice(0,15), sitemap_sample: targetData.sitemap_urls?.slice(0,30), footer_links: targetData.footer_links?.slice(0,12) })}

COMPETITORS (context):
${JSON.stringify(competitorData.map(c => ({ domain: c.domain, nav: c.nav?.slice(0,10), structured_nav: c.structured_nav?.slice(0,10) })))}

Propose revamped IA. Surface all major product lines and unique sections. Max 6 primary nav, max 6 L2 each, max 4 L3 each. Return ONLY the JSON.`;

  const response = await callClaude({ model: 'claude-sonnet-4-6', max_tokens: 5000, system, messages: [{ role: 'user', content: user }] });
  const cleaned = response.content[0].text.replace(/```json|```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI returned invalid JSON structure');
  return JSON.parse(jsonMatch[0]);
}

/* ═══════════════════════════════════════════
   PASS 3 — ANALYSIS (Sonnet, no timeout)
═══════════════════════════════════════════ */
async function analyseIA(targetData, competitorData, competitorMeta) {
  const system = `You are a senior IA expert. Analyse what changed between the existing site and a proposed revamp, and benchmark against competitors.
Return ONLY valid JSON, no markdown:
{"ia_changes":[{"item":"","existed":"Yes|No|Partial","action":"added|elevated|moved|renamed|kept|reorganised","label":"","notes":""}],"competitors":[{"name":"","domain":"","type":"global|local","primary_nav_count":0,"has_newsroom":true,"has_investors":true,"has_sustainability":true,"has_careers":true,"portfolio_organization":"","ia_structure":"","notable_pattern":"","findings":[{"pattern":"","adopted":"yes|partial|no","reason":""}]}],"best_practices_applied":["max 6"]}`;

  const user = `TARGET SITE:
${JSON.stringify({ domain: targetData.domain, title: targetData.title, nav: targetData.nav?.slice(0,15), structured_nav: targetData.structured_nav?.slice(0,15), sitemap_sample: targetData.sitemap_urls?.slice(0,25), footer_links: targetData.footer_links?.slice(0,12) })}

COMPETITOR SITES:
${JSON.stringify(competitorData.map(c => ({ domain: c.domain, title: c.title, nav: c.nav?.slice(0,12), structured_nav: c.structured_nav?.slice(0,12), sitemap_sample: c.sitemap_urls?.slice(0,15), footer_links: c.footer_links?.slice(0,10), meta: c.meta })))}

Generate: (1) ia_changes — max 15 rows documenting what existed vs what changed. (2) competitors — one entry per competitor with 4-5 findings on patterns adopted or not. Return ONLY the JSON.`;

  const response = await callClaude({ model: 'claude-sonnet-4-6', max_tokens: 4000, system, messages: [{ role: 'user', content: user }] });
  const cleaned = response.content[0].text.replace(/```json|```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI returned invalid JSON for analysis');
  return JSON.parse(jsonMatch[0]);
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
