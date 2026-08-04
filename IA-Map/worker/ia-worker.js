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

    const { action, url, competitors_manual, targetData: preScraped, competitorData: preCompetitors, competitors: preCompMeta } = body;

    // Guard: API key must be present for synthesise
    if ((action === 'synthesise' || !action) && !env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY secret not configured in Cloudflare Worker settings.' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ── PASS 2: synthesise only (pre-scraped data sent from frontend) ──
    if (action === 'synthesise') {
      let step = 'synthesise';
      try {
        const result = await synthesiseIA(preScraped, preCompetitors, preCompMeta, env);
        return new Response(JSON.stringify(result), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        console.error(`Worker error at step [${step}]:`, err);
        return new Response(JSON.stringify({ error: `Step "${step}" failed: ${err.message || 'Unknown error'}` }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── PASS 1: scrape target + competitors ──
    if (!url) {
      return new Response(JSON.stringify({ error: 'URL is required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    let step = 'init';
    try {
      // Step 1 — Scrape target site
      step = 'scrape-target';
      const targetData = await scrapeSite(url);

      // Step 2 — Identify competitors (max 3)
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

      // Return scraped data for frontend to store; user triggers Pass 2
      return new Response(JSON.stringify({ scraped: true, targetData, competitorData, competitors }), {
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
      model: 'claude-sonnet-4-6',
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
  const systemPrompt = `You are a senior IA expert. Propose a revamped website IA from scraped data.

RULES: Primary nav 4-5 items max, labelled by visitor need not org structure. Utility nav for CONTACT/INVESTORS/CAREERS/TRUST. Use NEWSROOM not "Media Centre", WHO WE ARE not "About Us". Surface Trust for fintech, Investors for listed entities, API for API-first companies.

Return ONLY compact valid JSON, no markdown:
{
  "company":{"name":"","domain":"","tagline":"","existing_issues":["3-4 key failures only"]},
  "proposed_ia":{
    "primary_nav":[{"id":"","name":"CAPS","utility":false,"desc":"","info":["",""],"actions":[""],"l2":[{"name":"","desc":"","l3":[{"name":""}]}]}],
    "utility_nav":[{"id":"","name":"CAPS","utility":true,"desc":"","info":[""],"actions":[""],"l2":[]}]
  },
  "ia_changes":[{"item":"","existed":"Yes|No","action":"added|elevated|moved|renamed|kept","label":"","notes":""}],
  "competitors":[{"name":"","domain":"","type":"global|local","primary_nav_count":0,"has_newsroom":true,"has_investors":true,"has_sustainability":true,"has_careers":true,"portfolio_organization":"","notable_pattern":"","findings":[{"pattern":"","adopted":"yes|no","reason":""}]}],
  "best_practices_applied":["3-4 only"],
  "rationale":"1 sentence"
}`;

  const userPrompt = `Analyse this company's existing website and propose a new information architecture.

TARGET COMPANY DATA:
${JSON.stringify({
  domain: targetData.domain,
  title: targetData.title,
  nav: targetData.nav?.slice(0, 12),
  structured_nav: targetData.structured_nav?.slice(0, 12),
  sitemap_sample: targetData.sitemap_urls?.slice(0, 20),
  footer_links: targetData.footer_links?.slice(0, 10),
  page_count: targetData.page_count,
}, null, 2)}

COMPETITOR SITES DATA:
${JSON.stringify(competitorData.map(c => ({
  domain: c.domain,
  title: c.title,
  nav: c.nav?.slice(0, 8),
  structured_nav: c.structured_nav?.slice(0, 8),
  sitemap_sample: c.sitemap_urls?.slice(0, 10),
  footer_links: c.footer_links?.slice(0, 8),
})), null, 2)}

Propose a revamped IA. Keep it compact: max 5 primary nav items, max 4 L2 per item, max 3 L3 per L2, max 3 competitors with max 3 findings each, max 6 ia_changes rows. Return ONLY the JSON.`;

  const response = await callClaude(env, {
    max_tokens: 2000,
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
      model: params.model || 'claude-haiku-4-5-20251001',
      ...params,
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err.slice(0, 200)}`);
  }

  return res.json();
}
