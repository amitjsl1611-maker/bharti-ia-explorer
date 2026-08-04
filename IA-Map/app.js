/* ══════════════════════════════════════════════
   app.js — IA Map frontend logic
   State management · Worker calls · Loading UI
══════════════════════════════════════════════ */

'use strict';

/* ── CONFIG — set your Worker URL here after deploy ── */
const WORKER_URL = 'https://ia-map-worker.ajaiswal-bd5.workers.dev/';

/* ── STATE ── */
let manualCompetitors = [];
let competitorsPanelOpen = false;

/* ═══════════════════════════════════════════
   STATE TRANSITIONS
═══════════════════════════════════════════ */
function showState(id) {
  document.querySelectorAll('.state').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const floatBtn = document.getElementById('comp-float-btn');
  if (floatBtn) floatBtn.style.display = id === 'state-result' ? 'flex' : 'none';
}

/* ═══════════════════════════════════════════
   INPUT STATE
═══════════════════════════════════════════ */
function toggleCompetitors() {
  const panel = document.getElementById('comp-panel');
  panel.classList.toggle('hidden');
}

function addCompetitor() {
  const input = document.getElementById('comp-input');
  const val = input.value.trim();
  if (!val) return;
  if (manualCompetitors.length >= 6) return;
  if (manualCompetitors.includes(val)) { input.value = ''; return; }
  manualCompetitors.push(val);
  renderCompChips();
  input.value = '';
}

function removeCompetitor(val) {
  manualCompetitors = manualCompetitors.filter(c => c !== val);
  renderCompChips();
}

function renderCompChips() {
  const wrap = document.getElementById('comp-chips');
  wrap.innerHTML = manualCompetitors.map(c => `
    <div class="comp-chip">
      ${c}
      <button class="comp-chip-remove" onclick="removeCompetitor('${c.replace(/'/g, "\\'")}')">×</button>
    </div>`).join('');
}

// Allow enter key in competitor input
document.getElementById('comp-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addCompetitor();
});

// Validate URL on input
document.getElementById('url-input').addEventListener('input', () => {
  document.getElementById('url-error').textContent = '';
});
document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') startGenerate();
});

function validateUrl(raw) {
  if (!raw) return null;
  try {
    const url = raw.startsWith('http') ? raw : `https://${raw}`;
    new URL(url); // throws if invalid
    return url;
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════
   GENERATE — kick off the pipeline
═══════════════════════════════════════════ */
async function startGenerate() {
  const raw = document.getElementById('url-input').value.trim();
  const errEl = document.getElementById('url-error');
  const url = validateUrl(raw);

  if (!url) {
    errEl.textContent = 'Please enter a valid URL (e.g. https://tata.com)';
    return;
  }

  // Transition to loading
  const domain = new URL(url).hostname;
  document.getElementById('loading-domain').textContent = domain;
  document.getElementById('ls-domain-name').textContent = domain;
  showState('state-loading');
  resetLoadingSteps();

  try {
    await runPass1(url, domain);
  } catch (err) {
    console.error(err);
    showError(err.message || 'Analysis failed. Try again or check your connection.');
  }
}

function resetLoadingSteps() {
  ['ls-scrape','ls-competitors','ls-comp-scrape','ls-synthesis','ls-render'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove('active','done');
    el.classList.add('pending');
    el.querySelector('.lstep-icon').className = 'lstep-icon';
    el.querySelector('.lstep-icon').textContent = '○';
  });
}

function stepActive(id) {
  const el = document.getElementById(id);
  el.classList.remove('pending');
  el.classList.add('active');
  el.querySelector('.lstep-icon').className = 'lstep-icon spin';
  el.querySelector('.lstep-icon').textContent = '⟳';
}

function stepDone(id) {
  const el = document.getElementById(id);
  el.classList.remove('pending','active');
  el.classList.add('done');
  el.querySelector('.lstep-icon').className = 'lstep-icon';
  el.querySelector('.lstep-icon').textContent = '✓';
}

/* ═══════════════════════════════════════════
   TWO-PASS PIPELINE
   Pass 1: scrape target + competitors (~15s)
   Pass 2: Claude Sonnet synthesis (~20s)
═══════════════════════════════════════════ */

// Holds scraped data between passes
let _scrapedCache = null;

async function runPass1(url, domain) {
  stepActive('ls-scrape');
  simulatePass1Progress();

  const response = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'scrape', url, competitors_manual: manualCompetitors }),
  });

  if (!response.ok) {
    const errMsg = await parseWorkerError(response);
    throw new Error(errMsg);
  }

  const data = await response.json();
  _scrapedCache = data;

  // Mark scraping steps done
  stepDone('ls-scrape');
  stepDone('ls-competitors');
  stepDone('ls-comp-scrape');

  // Show mid-point prompt in loading screen
  showScrapeReady(domain, data);
}

async function runPass2() {
  if (!_scrapedCache) return;
  const { targetData, competitorData, competitors } = _scrapedCache;

  stepActive('ls-synthesis');

  const response = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'synthesise', targetData, competitorData, competitors }),
  });

  if (!response.ok) {
    const errMsg = await parseWorkerError(response);
    throw new Error(errMsg);
  }

  stepDone('ls-synthesis');
  stepActive('ls-render');

  const data = await response.json();
  renderResult(data);
}

async function parseWorkerError(response) {
  try {
    const json = await response.json();
    return json.error || 'Analysis failed.';
  } catch {
    const text = await response.text();
    return text.slice(0, 200) || 'Analysis failed.';
  }
}

function showScrapeReady(domain, scraped) {
  const compCount = (scraped.competitors || []).length;
  const el = document.getElementById('loading-eta');
  if (!el) return;
  el.innerHTML = `
    <div class="scrape-ready">
      <div class="sr-check">✓</div>
      <div class="sr-text">Scraped <strong>${domain}</strong> and ${compCount} competitor${compCount !== 1 ? 's' : ''}.<br>Ready to generate the IA.</div>
      <button class="sr-btn" onclick="handleGenerateIA()">Generate IA →</button>
    </div>`;
}

async function handleGenerateIA() {
  document.getElementById('loading-eta').innerHTML = 'Estimated time: 20–30 seconds';
  try {
    await runPass2();
  } catch (err) {
    console.error(err);
    showError(err.message || 'IA generation failed. Try again.');
  }
}

function simulatePass1Progress() {
  const timings = [
    { action: stepActive, id: 'ls-competitors', delay: 4000 },
    { action: stepDone,   id: 'ls-scrape',      delay: 5000 },
    { action: stepActive, id: 'ls-comp-scrape', delay: 5500 },
    { action: stepDone,   id: 'ls-competitors', delay: 8000 },
  ];
  timings.forEach(t => setTimeout(() => t.action(t.id), t.delay));
}

/* ═══════════════════════════════════════════
   RENDER RESULT
═══════════════════════════════════════════ */
function renderResult(data) {
  stepDone('ls-render');

  // Populate topbar company name
  const companyName = data.company?.name || new URL(
    document.getElementById('loading-domain').textContent.startsWith('http')
      ? document.getElementById('loading-domain').textContent
      : `https://${document.getElementById('loading-domain').textContent}`
  ).hostname;
  document.getElementById('tb-company-name').textContent = companyName;

  // Show result state
  showState('state-result');

  // Build the canvas via renderer.js — default to Sitemap mode like the prototype
  buildRenderer(data);
  setMode('sitemap');

  // Show existing issues in rationale bar if present
  if (data.company?.existing_issues?.length) {
    const bar = document.getElementById('rationale-bar');
    const textEl = document.getElementById('rationale-text');
    if (bar && textEl) {
      textEl.textContent = `${data.company.existing_issues.length} issues found in current IA. Proposed redesign addresses: ${data.company.existing_issues.slice(0,2).join('; ')}.`;
      bar.classList.add('show');
      setTimeout(() => {
        if (data.rationale) textEl.textContent = data.rationale;
      }, 7000);
    }
  }
}

/* ═══════════════════════════════════════════
   ERROR
═══════════════════════════════════════════ */
function showError(msg) {
  showState('state-input');
  document.getElementById('url-error').textContent = msg;
}

/* ═══════════════════════════════════════════
   BACK TO INPUT
═══════════════════════════════════════════ */
function goBack() {
  showState('state-input');
  // Reset canvas state
  smBuilt = false;
  manualCompetitors = [];
  renderCompChips();
  document.getElementById('url-input').value = '';
  document.getElementById('url-error').textContent = '';
  // Clear canvas
  const c = document.getElementById('canvas');
  const s = document.getElementById('sm-canvas');
  if (c) { c.innerHTML = ''; c.appendChild(document.getElementById('svg') || document.createElementNS('http://www.w3.org/2000/svg','svg')); }
  if (s) s.innerHTML = '';
  document.body.classList.remove('sitemap');
  const islandNav = document.getElementById('island-nav');
  if (islandNav) islandNav.style.display = 'none';
  document.body.classList.remove('has-inav');
  const compPanel = document.getElementById('comp-side-panel');
  if (compPanel) compPanel.classList.remove('open');
  const floatBtn = document.getElementById('comp-float-btn');
  if (floatBtn) floatBtn.classList.remove('open');
}

/* ── New IA button ── */
function handleNew() {
  const nameEl = document.getElementById('tb-company-name');
  const nm = document.getElementById('nm-company');
  if (nm && nameEl) nm.textContent = nameEl.textContent || 'current';
  document.getElementById('new-modal').style.display = 'flex';
}

function closeNewModal() {
  document.getElementById('new-modal').style.display = 'none';
}

function downloadIA() {
  // Export current SECTIONS data as formatted JSON
  const payload = {
    company: document.getElementById('tb-company-name')?.textContent || 'IA Export',
    exported: new Date().toISOString(),
    sections: typeof SECTIONS !== 'undefined' ? SECTIONS : [],
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = (payload.company.toLowerCase().replace(/\s+/g,'-')) + '-ia.json';
  a.click();
  URL.revokeObjectURL(url);
}

function proceedAnyway() {
  closeNewModal();
  goBack();
}

/* override toggleCompPanel to also toggle float btn state */
const _origToggleCompPanel = typeof toggleCompPanel === 'function' ? toggleCompPanel : null;
function toggleCompPanel() {
  const panel = document.getElementById('comp-side-panel');
  const floatBtn = document.getElementById('comp-float-btn');
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  if (floatBtn) floatBtn.classList.toggle('open', isOpen);
}

/* ═══════════════════════════════════════════
   MOCK DATA — for local testing without Worker
   Remove / comment out before production
═══════════════════════════════════════════ */
const MOCK_DATA = {
  company: {
    name: 'Example Corp',
    domain: 'example.com',
    tagline: 'A diversified global conglomerate',
    existing_issues: [
      'Portfolio organised by geography, not sector',
      'No standalone Newsroom — press releases buried in About',
    ],
  },
  proposed_ia: {
    primary_nav: [
      {
        id: 'who-we-are', name: 'WHO WE ARE', utility: false,
        desc: 'Corporate identity, leadership, history and governance',
        info: ['Group overview and positioning', 'Board and executive leadership', 'Heritage timeline since founding'],
        actions: ['Download corporate profile', 'View leadership team', 'Explore milestones'],
        l2: [
          { name: 'Overview', desc: 'Group at a glance', info: ['Mission and values', 'Key facts and figures'], actions: ['Download brochure'], l3: [] },
          { name: 'Leadership', desc: 'Board and management', info: ['Board of Directors', 'Group CEO message'], actions: ['View full profiles'], l3: [] },
          { name: 'Heritage', desc: 'Interactive founding timeline', info: ['Milestones since inception', 'Archive photography'], actions: ['Explore timeline'], l3: [] },
          { name: 'Governance', desc: 'Policies and frameworks', info: ['Corporate governance framework', 'Code of conduct'], actions: ['Download governance report'], l3: [] },
        ],
      },
      {
        id: 'our-businesses', name: 'OUR BUSINESSES', utility: false,
        desc: 'Portfolio of businesses organised by sector',
        info: ['Sector overview cards', 'Business entity detail pages', 'Key metrics per entity'],
        actions: ['Filter by sector', 'Visit business website', 'Download portfolio overview'],
        l2: [
          { name: 'Energy', desc: '', info: ['Energy sector overview'], actions: ['View businesses'], l3: [{ name: 'Renewables' }, { name: 'Oil & Gas' }] },
          { name: 'Financial Services', desc: '', info: ['FS sector overview'], actions: ['View businesses'], l3: [{ name: 'Banking' }, { name: 'Insurance' }] },
          { name: 'Real Estate', desc: '', info: ['RE portfolio overview'], actions: ['Explore properties'], l3: [{ name: 'Commercial' }, { name: 'Residential' }] },
          { name: 'Technology', desc: '', info: ['Tech portfolio overview'], actions: ['View businesses'], l3: [{ name: 'Software' }, { name: 'Infrastructure' }] },
          { name: 'Consumer', desc: '', info: ['Consumer brands overview'], actions: ['Explore brands'], l3: [] },
        ],
      },
      {
        id: 'global-presence', name: 'GLOBAL PRESENCE', utility: false,
        desc: 'Geographic footprint across markets and regions',
        info: ['Interactive world map', 'Country-by-country presence', 'Number of employees per region'],
        actions: ['Filter by region', 'Find local office', 'View country profile'],
        l2: [
          { name: 'Middle East', desc: '', info: ['Regional overview', 'Key entities'], actions: ['View offices'], l3: [] },
          { name: 'Africa',      desc: '', info: ['Regional overview'], actions: ['View offices'], l3: [] },
          { name: 'Asia Pacific',desc: '', info: ['Regional overview'], actions: ['View offices'], l3: [] },
          { name: 'Europe',      desc: '', info: ['Regional overview'], actions: ['View offices'], l3: [] },
        ],
      },
      {
        id: 'impact', name: 'IMPACT', utility: false,
        desc: 'ESG strategy, sustainability commitments and foundation work',
        info: ['ESG framework and goals', 'Annual impact report', 'Community investment figures'],
        actions: ['Download ESG report', 'Read impact stories', 'View SDG alignment'],
        l2: [
          { name: 'ESG Strategy',    desc: '', info: ['Pillars and 2030 targets'], actions: ['Download report'], l3: [] },
          { name: 'Environment',     desc: '', info: ['Carbon targets', 'Green initiatives'], actions: ['View commitments'], l3: [] },
          { name: 'Social',          desc: '', info: ['Community programmes'], actions: ['Read stories'], l3: [] },
          { name: 'Foundation',      desc: '', info: ['Foundation overview', 'Grant programmes'], actions: ['Apply for grant'], l3: [] },
        ],
      },
      {
        id: 'newsroom', name: 'NEWSROOM', utility: false,
        desc: 'Press releases, media coverage and editorial content',
        info: ['Filterable article feed', 'Media library', 'Spokesperson contacts'],
        actions: ['Filter by topic', 'Download press kit', 'Contact media team'],
        l2: [
          { name: 'Press Releases', desc: '', info: ['Chronological releases with permalinks'], actions: ['Filter by date/topic'], l3: [] },
          { name: 'In the Media',   desc: '', info: ['Curated coverage'], actions: ['Read articles'], l3: [] },
          { name: 'Media Library',  desc: '', info: ['Photography', 'Brand assets'], actions: ['Download assets'], l3: [] },
        ],
      },
    ],
    utility_nav: [
      {
        id: 'investors', name: 'INVESTORS', utility: true,
        desc: 'Investor relations, financials and governance disclosures',
        info: ['Financial highlights', 'Annual reports', 'IR contacts'],
        actions: ['Download annual report', 'Subscribe to IR updates', 'Contact IR team'],
        l2: [],
      },
      {
        id: 'careers', name: 'CAREERS', utility: true,
        desc: 'Join the group — job listings and employer brand',
        info: ['Why join us', 'Live job listings', 'Graduate programmes'],
        actions: ['Search jobs', 'Apply now', 'Subscribe to alerts'],
        l2: [],
      },
      {
        id: 'contact', name: 'CONTACT', utility: true,
        desc: 'Get in touch — HQ, regional offices, media enquiries',
        info: ['Head office address', 'Department contacts', 'Social media links'],
        actions: ['Send enquiry', 'Find nearest office', 'Follow on LinkedIn'],
        l2: [],
      },
    ],
  },
  competitors: [
    { name: 'Tata Group', domain: 'tata.com', type: 'global', primary_nav_count: 5, has_newsroom: true,  has_investors: true,  has_sustainability: true,  has_careers: true,  portfolio_organization: 'sector', notable_pattern: 'Tata Stories editorial format gives the newsroom a strong brand identity distinct from a press release feed.',
      findings: [
        { pattern: 'Tata Stories editorial newsroom', adopted: 'yes', reason: 'Adopted as NEWSROOM with editorial permalink format — same principle, own brand voice.' },
        { pattern: 'Sector-based portfolio nav', adopted: 'yes', reason: 'OUR BUSINESSES organises by sector, matching Tata\'s proven wayfinding model.' },
        { pattern: 'Tata Sustainability standalone page', adopted: 'partial', reason: 'IMPACT elevated to primary nav, but structured differently — purpose-led rather than report-driven.' },
      ],
    },
    { name: 'Mahindra',   domain: 'mahindra.com', type: 'global', primary_nav_count: 6, has_newsroom: true,  has_investors: true,  has_sustainability: true,  has_careers: true,  portfolio_organization: 'sector', notable_pattern: 'Rise philosophy integrated into every section, not siloed to a sustainability page.',
      findings: [
        { pattern: 'Rise philosophy woven across all sections', adopted: 'partial', reason: 'Brand philosophy integration is a direction for content strategy, not replicated structurally in this IA.' },
        { pattern: 'Investor Relations in utility nav', adopted: 'yes', reason: 'Adopted — INVESTORS moved to utility nav for persistent access, exactly as Mahindra does.' },
        { pattern: 'Careers always visible in header', adopted: 'yes', reason: 'CAREERS in utility nav mirrors Mahindra\'s persistent talent-acquisition placement.' },
      ],
    },
    { name: 'OTB Group',  domain: 'otb.net',  type: 'global', primary_nav_count: 5, has_newsroom: true,  has_investors: false, has_sustainability: true,  has_careers: true,  portfolio_organization: 'brand',  notable_pattern: 'Sustainability is top-level, signalling ESG is a strategic priority not an afterthought.',
      findings: [
        { pattern: 'Sustainability as top-level nav item', adopted: 'yes', reason: 'IMPACT elevated to primary nav — directly inspired by OTB\'s ESG-first positioning.' },
        { pattern: 'Brand-based portfolio organisation', adopted: 'no', reason: 'Sector organisation chosen instead — more relevant for a diversified conglomerate than a brand house.' },
        { pattern: 'No dedicated Investors section', adopted: 'no', reason: 'Investors is a required section for a listed group — OTB\'s omission is not appropriate to replicate.' },
      ],
    },
    { name: 'Aldar',      domain: 'aldar.com', type: 'local', primary_nav_count: 6, has_newsroom: true,  has_investors: true,  has_sustainability: true,  has_careers: true,  portfolio_organization: 'sector', notable_pattern: 'Clear separation of retail and institutional investor journeys from the homepage.',
      findings: [
        { pattern: 'Dual investor journey split (retail vs institutional)', adopted: 'no', reason: 'Not applicable — group investor relations primarily targets institutional and analyst audiences.' },
        { pattern: 'Newsroom as distinct top-level section', adopted: 'yes', reason: 'NEWSROOM adopted — Aldar validates that editorial framing works even for non-media companies.' },
        { pattern: 'Sector portfolio wayfinding', adopted: 'yes', reason: 'Sector-first portfolio organisation adopted, consistent with Aldar\'s approach.' },
      ],
    },
  ],
  best_practices_applied: [
    'Portfolio organised by sector, not geography',
    'NEWSROOM replaces "Media Centre" — editorial framing with permalink articles',
    'WHO WE ARE replaces "About Us" — confident identity positioning',
    'IMPACT as primary nav elevates ESG to strategic priority',
    'Utility nav: INVESTORS, CAREERS, CONTACT — all one click from anywhere',
  ],
  rationale: 'The proposed IA consolidates a fragmented existing structure into five clear primary sections mirroring the group\'s identity, portfolio, footprint, purpose and voice. The utility nav ensures investor and talent journeys are never more than one click away.',
  ia_changes: [
    { item: 'About Us', existed: 'yes', action: 'renamed', label: 'WHO WE ARE', notes: 'Confident identity framing; same content, stronger positioning.' },
    { item: 'Media Centre', existed: 'yes', action: 'renamed', label: 'NEWSROOM', notes: 'Editorial framing with permalink articles replaces static press-release list.' },
    { item: 'Sustainability', existed: 'yes', action: 'elevated', label: 'IMPACT', notes: 'Moved from sub-section to primary nav — ESG is a strategic pillar, not a footnote.' },
    { item: 'Investors', existed: 'yes', action: 'moved', label: 'INVESTORS (utility)', notes: 'Moved to utility nav for persistent one-click access from all pages.' },
    { item: 'Careers', existed: 'yes', action: 'moved', label: 'CAREERS (utility)', notes: 'Moved to utility nav — talent acquisition benefits from always-visible placement.' },
    { item: 'Portfolio', existed: 'yes', action: 'reorganised', label: 'OUR BUSINESSES', notes: 'Reorganised by sector instead of geography; clearer mental model for site visitors.' },
    { item: 'Contact', existed: 'yes', action: 'moved', label: 'CONTACT (utility)', notes: 'Persisted in utility nav so it is always reachable.' },
  ],
};

/* ── Mercury IA data — load with ?mercury ── */
const MERCURY_DATA = {
  company: {
    name: 'Mercury',
    domain: 'mercury.com',
    tagline: 'Radically different banking for ambitious companies',
    existing_issues: [
      'Developer API buried 3 levels deep under Products › Intelligence › API',
      'Trust & Security not surfaced — FDIC/SOC2 scattered across pages',
      'Solutions dropdown overwhelmed with 11 flat industry verticals',
      'Help Center misplaced inside About dropdown',
      'No dedicated Customers / Case Studies section',
      'Mercury Command (AI flagship) lacks prominence in current nav',
    ],
  },
  proposed_ia: {
    primary_nav: [
      {
        id: 'platform',
        name: 'PLATFORM',
        utility: false,
        desc: 'All Mercury financial products — banking, cards, payments, loans and AI intelligence',
        info: ['Unified product overview', 'Feature comparison by tier', 'What\'s included for free'],
        actions: ['Open an account', 'Launch demo', 'Compare plans'],
        l2: [
          { name: 'Banking', desc: 'FDIC-insured checking and savings with no account fees', info: ['Checking & Savings accounts', 'Up to $5M FDIC coverage via partner banks', 'No minimum balance, no monthly fees'], actions: ['Open account', 'View rates'], l3: [] },
          { name: 'Cards & Expenses', desc: 'Credit cards and expense management with real-time controls', info: ['Business credit cards', 'Virtual cards — instant issuance', 'Expense management & receipt capture', '1.5% unlimited cashback'], actions: ['Apply for card', 'See expense features'], l3: [] },
          { name: 'Payments & Invoicing', desc: 'Send, receive and automate all money movement in one place', info: ['Domestic & international payments', 'Invoicing with ACH debit', 'Bill pay automation', 'Accounting automations'], actions: ['Set up payments', 'Create first invoice'], l3: [] },
          { name: 'Loans', desc: 'Working capital and venture debt for growth-stage companies', info: ['Working Capital Loans', 'Venture Debt', 'Eligibility requirements'], actions: ['Check eligibility', 'Talk to advisor'], l3: [] },
          { name: 'Treasury', desc: 'Earn up to 3.81% yield on idle cash — same-day liquidity', info: ['Money market funds', 'Ultra-short bond portfolio', 'Auto-transfer rules between accounts', 'SIPC insured via Apex Clearing'], actions: ['Open Treasury', 'Compare fund options'], l3: [] },
          { name: 'AI & Intelligence', desc: 'Mercury Command and Insights — AI-native financial intelligence', info: ['Mercury Command — natural language financial queries', 'Insights dashboard', 'Automated transaction categorisation', 'MCP Server for AI agents'], actions: ['Try Command', 'Explore Insights'], l3: [] },
          { name: 'Personal Banking', desc: 'Banking for founders and individuals, linked to your business account', info: ['Personal checking', 'High-yield savings', 'Linked to business account for easy transfers'], actions: ['Open personal account', 'See personal features'], l3: [] },
        ],
      },
      {
        id: 'solutions',
        name: 'SOLUTIONS',
        utility: false,
        desc: 'Mercury shaped for your company stage and your industry',
        info: ['Stage-based paths from day one to Series B+', 'Industry-specific feature highlights', 'Dedicated partner programmes for firms and funds'],
        actions: ['Find your fit', 'Talk to sales'],
        l2: [
          { name: 'By Stage', desc: 'From pre-revenue to established — Mercury scales with you', info: ['Startups — open in 10 minutes, no minimums', 'Scaling teams — expense controls, team cards, Plus tier', 'Established — Pro tier with relationship manager and NetSuite'], actions: ['See startup features', 'Explore Pro tier'], l3: [{ name: 'Startups' }, { name: 'Scaling' }, { name: 'Established' }] },
          { name: 'By Industry', desc: 'Tailored for the sectors Mercury knows best', info: ['Tech & SaaS', 'Ecommerce', 'Life Science & Climate', 'Healthcare Services', 'Real Estate & Construction', 'Crypto', 'Agencies & Consultants'], actions: ['Find your industry'], l3: [{ name: 'Tech & SaaS' }, { name: 'Ecommerce' }, { name: 'Life Science' }, { name: 'Healthcare' }] },
          { name: 'For Accounting Firms', desc: 'Help your clients bank better — and grow your practice with Mercury', info: ['Multi-client dashboard', 'Bookkeeper access controls', 'Xero & QuickBooks integrations', 'Referral programme'], actions: ['Become a partner', 'Refer a client'], l3: [] },
          { name: 'For VC Funds', desc: 'Fund banking and portfolio company visibility in one place', info: ['Fund account banking', 'Portfolio company overview', 'Investor Database access', 'SAFE Generator'], actions: ['Open fund account', 'Explore fund features'], l3: [] },
        ],
      },
      {
        id: 'developers',
        name: 'DEVELOPERS',
        utility: false,
        desc: 'Build on Mercury — full banking API, MCP server, CLI and sandbox environment',
        info: ['REST API for all banking operations', 'MCP Server for AI agent integrations', 'CLI for terminal-native automation', 'Sandbox test environment', 'SOC 2 Type II certified'],
        actions: ['Read the docs', 'Get API token', 'Open sandbox'],
        l2: [
          { name: 'API Reference', desc: 'Programmatic access to balances, payments and transactions', info: ['ACH transfers & payouts', 'Balance & transaction queries', '100 free ACH transfers/month on all plans', 'Scoped API tokens + IP allow-listing'], actions: ['View API docs', 'Get API key'], l3: [] },
          { name: 'MCP Server', desc: 'AI-native integration — query your finances in natural language', info: ['Read-only AI agent access', 'Compatible with Claude, GPT and other LLMs', 'Natural language financial reporting'], actions: ['Set up MCP', 'See examples'], l3: [] },
          { name: 'Integrations', desc: 'Connect Mercury to the tools your team already uses', info: ['Accounting: Xero, QuickBooks, NetSuite', 'HR & payroll: Gusto, Rippling', 'Cap table: Carta', 'Finance: Pilot, Kruze Consulting'], actions: ['Browse all integrations', 'Request an integration'], l3: [] },
          { name: 'CLI & Sandbox', desc: 'Test before you build — then automate from the terminal', info: ['Command-line interface for scripting', 'Sandbox environment mirrors production', 'Webhook subscriptions & event logs'], actions: ['Download CLI', 'Open sandbox'], l3: [] },
        ],
      },
      {
        id: 'resources',
        name: 'RESOURCES',
        utility: false,
        desc: 'Guides, free tools and partner savings to help your business grow',
        info: ['Editorial content across three series', 'Free financial calculators and databases', '305+ partner perks worth thousands', 'Product release notes'],
        actions: ['Read the blog', 'Browse perks', 'Use free tools'],
        l2: [
          { name: 'Blog', desc: 'Founder-focused editorial published across three series', info: ['Library — practical guides on operations & finance', 'Meridian — long-form founder and startup stories', 'Inside Mercury — company news and product milestones'], actions: ['Read Library', 'Explore Meridian', 'See company news'], l3: [{ name: 'Library' }, { name: 'Meridian' }, { name: 'Inside Mercury' }] },
          { name: 'Tools', desc: 'Free calculators and databases built for startup founders', info: ['Burn Rate Calculator', 'SAFE Generator', 'Investor Database'], actions: ['Calculate burn rate', 'Generate a SAFE', 'Search investors'], l3: [] },
          { name: 'Perks & Savings', desc: '305+ partner discounts across software, infrastructure and services', info: ['Startup Launch Bundle', 'Growth Bundle', 'Ecommerce Bundle', 'AI Productivity Bundle', 'AWS, Google Cloud, Notion, Linear, Supabase and more'], actions: ['Browse all perks', 'Claim a perk'], l3: [{ name: 'Startup Bundle' }, { name: 'Growth Bundle' }, { name: 'AI Bundle' }] },
          { name: 'Product Updates', desc: 'What the Mercury team has shipped — changelog and coming soon', info: ['New feature announcements', 'Full changelog', 'Upcoming product previews'], actions: ['See latest release', 'Subscribe to updates'], l3: [] },
        ],
      },
      {
        id: 'company',
        name: 'COMPANY',
        utility: false,
        desc: 'The team, mission, culture and story behind Mercury',
        info: ['1,000+ employees worldwide', 'Backed by tier-one venture capitalists', '2,500+ community investors', 'Forbes Fintech 50 · Fast Company Most Innovative'],
        actions: ['Read our story', 'View open roles', 'See press coverage'],
        l2: [
          { name: 'Our Story', desc: 'Why we built Mercury and where we are going', info: ['Founding mission', 'Company values and culture', 'Key milestones'], actions: ['Read our story'], l3: [] },
          { name: 'Customers', desc: 'How 300K+ businesses use Mercury to grow', info: ['Case studies by industry', 'Case studies by company stage', 'Video testimonials', 'Logo wall'], actions: ['Read case studies', 'Watch stories'], l3: [] },
          { name: 'Careers', desc: 'Join the team building the future of business banking', info: ['Open roles across Engineering, Design, Finance and Ops', 'Remote-friendly culture', 'Benefits and compensation'], actions: ['See open roles', 'Learn about our culture'], l3: [] },
          { name: 'Press', desc: 'Mercury in the media — coverage, media kit and brand assets', info: ['Press coverage archive', 'Downloadable media kit', 'Spokesperson contacts', 'Brand logos and assets'], actions: ['Download media kit', 'Contact press team'], l3: [] },
          { name: 'Events', desc: 'Meetups, webinars and conferences Mercury attends or hosts', info: ['Upcoming events', 'Past event recordings', 'Founder community meetups'], actions: ['Register for an event', 'Watch past sessions'], l3: [] },
          { name: 'Partnerships', desc: 'Work with Mercury as a referral or integration partner', info: ['Referral programme', 'Integration partnership', 'Accounting firm programme'], actions: ['Become a partner', 'Refer a business'], l3: [] },
        ],
      },
    ],
    utility_nav: [
      {
        id: 'pricing',
        name: 'PRICING',
        utility: true,
        desc: 'Start free — upgrade when you need more power',
        info: ['Free for all businesses — no account fees', 'Plus — $29.90/month for invoicing power', 'Pro — $299/month with relationship manager', 'Annual billing saves up to 20%'],
        actions: ['Compare all plans', 'Start for free', 'Talk to sales'],
        l2: [],
      },
      {
        id: 'trust',
        name: 'TRUST & SECURITY',
        utility: true,
        desc: 'How Mercury keeps your money and data safe',
        info: ['$5M FDIC coverage — 20x standard via partner banks', 'SOC 2 Type II certified', 'SIPC insurance for Treasury accounts ($500K)', 'Fraud detection and granular account controls', 'Encryption in transit and at rest'],
        actions: ['Read security overview', 'Download SOC 2 report', 'View compliance details'],
        l2: [],
      },
      {
        id: 'support',
        name: 'SUPPORT',
        utility: true,
        desc: 'Help when you need it — docs, FAQs, chat and phone',
        info: ['Help Center — searchable knowledge base', 'FAQ library', 'Live chat for Plus & Pro accounts', 'Dedicated relationship manager on Pro tier', 'Contact form for all accounts'],
        actions: ['Visit Help Center', 'Chat with support', 'Submit a request'],
        l2: [],
      },
    ],
  },
  competitors: [
    {
      name: 'Brex',
      domain: 'brex.com',
      type: 'global',
      primary_nav_count: 5,
      has_newsroom: true,
      has_investors: false,
      has_sustainability: false,
      has_careers: true,
      portfolio_organization: 'stage',
      ia_structure: 'Products (Corporate Cards · Expenses · Travel · Bill Pay · Banking & Treasury) · Solutions by Stage (Startup · Mid-size · Enterprise) · Platform · Resources · Company',
      unique_adopted: 'Stage-based Solutions segmentation — adopted as "By Stage" (Startup / Scaling / Established) under Mercury\'s Solutions section',
      unique_not_adopted: 'Role-based entry points (CFO, Controller, Procurement Manager, Travel Manager) · Travel as a standalone product',
      notable_pattern: 'Role-based nav makes sense for Brex because they sell to finance teams inside mid-size and enterprise companies — different roles have genuinely different workflows. Mercury\'s primary user is the founder themselves, wearing all those hats at once. Adding role nav would signal the wrong audience. Travel product also not relevant — Mercury doesn\'t offer travel booking.',
      findings: [
        { pattern: 'Stage-based Solutions segmentation (Startup / Mid-size / Enterprise)', adopted: 'yes', reason: 'Adopted as Solutions → By Stage (Startup / Scaling / Established). Maps to Mercury\'s tier structure and founder mental model.' },
        { pattern: 'Role-based entry points (CFO, Controller, Procurement, Travel Manager)', adopted: 'no', reason: 'Mercury\'s user is the founder wearing all these hats. Role nav signals the wrong audience and would confuse a solo founder doing their own finance.' },
        { pattern: 'Travel as a standalone product in the nav', adopted: 'no', reason: 'Mercury does not offer travel booking. Not relevant to product scope.' },
        { pattern: 'Platform as a named L1 nav section', adopted: 'yes', reason: 'Adopted as Mercury\'s primary L1 — consolidates all financial products under one roof.' },
      ],
    },
    {
      name: 'Ramp',
      domain: 'ramp.com',
      type: 'global',
      primary_nav_count: 7,
      has_newsroom: true,
      has_investors: false,
      has_sustainability: false,
      has_careers: true,
      portfolio_organization: 'function',
      ia_structure: 'Products (Cards · Expenses · AP · Travel · Procurement · Intelligence · Accounting · Banking) · Solutions · Integrations · Pricing · Docs · Trust Center · Help Center',
      unique_adopted: 'Trust Center as utility nav — adopted as "Trust & Security" · Integrations directory as a dedicated L2 · Help Center moved to utility nav (away from About)',
      unique_not_adopted: 'Procurement as a standalone product category · Travel management product · Persistent utility strip (Docs · Help · Pricing · Trust) always visible in header',
      notable_pattern: 'Ramp\'s persistent utility strip (Docs · Help · Pricing · Trust Center) always visible in the header is excellent pattern for a developer-facing product. Mercury could adopt this as the product grows. Not included now because Mercury\'s primary audience is still founders, not finance ops teams — but worth revisiting at scale.',
      findings: [
        { pattern: 'Trust Center as utility nav', adopted: 'yes', reason: 'Adopted as "Trust & Security" in utility nav. FDIC, SOC2, SIPC consolidated in one findable place.' },
        { pattern: 'Integrations as a dedicated directory', adopted: 'yes', reason: 'Adopted as Developers → Integrations with named integration partners.' },
        { pattern: 'Help Center in utility nav (not buried in About)', adopted: 'yes', reason: 'Adopted as "Support" in utility nav — matches user mental model.' },
        { pattern: 'Persistent utility strip (Docs · Help · Pricing · Trust) always visible', adopted: 'no', reason: 'Excellent pattern for a developer-facing product. Not adopted now — Mercury\'s primary audience is founders, not finance ops teams. Worth revisiting as Mercury scales.' },
        { pattern: 'Procurement as a standalone product', adopted: 'no', reason: 'Mercury does not offer procurement. Different product scope.' },
        { pattern: 'Travel management product in nav', adopted: 'no', reason: 'Mercury does not offer travel booking.' },
      ],
    },
    {
      name: 'Relay',
      domain: 'relayfi.com',
      type: 'local',
      primary_nav_count: 4,
      has_newsroom: false,
      has_investors: false,
      has_sustainability: false,
      has_careers: true,
      portfolio_organization: 'function',
      ia_structure: 'Products (Checking · Savings · Accounts Payable · Expense Management · Invoices · Integrations) · Solutions (Accountants & Bookkeepers · Industries) · Resources (Blog · Guides · Webinars · Advisor Directory) · Pricing · About',
      unique_adopted: 'Accounting Firms as a dedicated partner audience with their own section — adopted under Mercury\'s Solutions as "For Accounting Firms"',
      unique_not_adopted: 'Industry guides as a standalone content type (distinct from blog posts, e.g. Real Estate Banking Guide, HVAC Guide) · Profit First banking methodology as a named product · Advisor directory as a public resource',
      notable_pattern: 'Relay\'s industry guides (separate from blog) are a strong SEO and trust signal. Not adopted for Mercury because Mercury\'s content is already mature under Library/Meridian — adding a third content type would fragment the architecture. Mercury\'s blog can absorb this if tagged properly.',
      findings: [
        { pattern: 'Accounting Firms as a dedicated partner audience', adopted: 'yes', reason: 'Adopted as Solutions → For Accounting Firms with multi-client dashboard, bookkeeper access and referral programme.' },
        { pattern: 'Industry guides as a separate content type (distinct from blog)', adopted: 'no', reason: 'Mercury\'s content is already mature under Library / Meridian. A third content type would fragment the architecture. Blog can absorb this with proper tagging.' },
        { pattern: 'Profit First banking methodology as a named product', adopted: 'no', reason: 'Mercury\'s product philosophy is different — not method-banking focused. Not relevant to Mercury\'s positioning.' },
        { pattern: 'Advisor directory as a public resource', adopted: 'no', reason: 'Mercury\'s partner model is different (referral programme, not public advisor search). Could be considered at scale.' },
      ],
    },
  ],
  ia_changes: [
    { item: 'PLATFORM (L1)', existed: 'Partial', action: 'renamed', label: 'Renamed + reorganised', notes: 'Was "Products" — a flat 11-item dropdown. Restructured into 7 clearly described L2s.' },
    { item: 'Platform → Banking', existed: 'Yes', action: 'kept', label: 'Organised', notes: 'Existed but lacked description of FDIC coverage and fee structure.' },
    { item: 'Platform → Cards & Expenses', existed: 'Yes', action: 'kept', label: 'Kept', notes: 'Existed under Products. Now with explicit cashback and controls callouts.' },
    { item: 'Platform → Payments & Invoicing', existed: 'Yes', action: 'kept', label: 'Kept', notes: 'Was flat item. Now includes invoicing, bill pay, accounting automations.' },
    { item: 'Platform → Treasury', existed: 'Yes', action: 'kept', label: 'Kept', notes: 'Existed. Yield rate and liquidity info now surfaced in description.' },
    { item: 'Platform → AI & Intelligence (Mercury Command)', existed: 'Partial', action: 'elevated', label: 'Elevated', notes: 'Was buried under Products → Intelligence. Flagship AI product — now prominently named L2.' },
    { item: 'Platform → Personal Banking', existed: 'Yes', action: 'kept', label: 'Kept', notes: 'Existed but had no distinguishing description vs business accounts.' },
    { item: 'SOLUTIONS (L1)', existed: 'Partial', action: 'renamed', label: 'Restructured', notes: 'Was a flat 11-item "Solutions" dropdown. Now split into By Stage and By Industry.' },
    { item: 'Solutions → By Stage (Startup / Scaling / Established)', existed: 'No', action: 'added', label: 'Added new', notes: 'Stage-based segmentation — maps to Mercury\'s tier structure. Adopted from Brex.' },
    { item: 'Solutions → By Industry', existed: 'Partial', action: 'reorganised', label: 'Reorganised', notes: 'Existed as flat list. Now a named L2 with industry sub-items.' },
    { item: 'Solutions → For Accounting Firms', existed: 'Partial', action: 'elevated', label: 'Elevated', notes: 'Partner programme existed but was not a dedicated nav item. Adopted from Relay.' },
    { item: 'Solutions → For VC Funds', existed: 'Partial', action: 'elevated', label: 'Elevated', notes: 'Fund banking existed but had no dedicated entry. Investor Database and SAFE Generator now surfaced.' },
    { item: 'DEVELOPERS (L1)', existed: 'No', action: 'added', label: 'Added new', notes: 'Developer API was buried 3 levels deep under Products → Intelligence → API. Now a full L1.' },
    { item: 'Developers → API Reference', existed: 'Yes', action: 'elevated', label: 'Elevated', notes: 'Was deeply buried. API is core to Mercury\'s growth and developer audience.' },
    { item: 'Developers → MCP Server', existed: 'Yes', action: 'elevated', label: 'Elevated', notes: 'Existed but not surfaced. AI-native integration deserves prominent placement.' },
    { item: 'Developers → Integrations', existed: 'Partial', action: 'elevated', label: 'Elevated', notes: 'Integrations listed elsewhere; now given a dedicated, described L2.' },
    { item: 'Developers → CLI & Sandbox', existed: 'Yes', action: 'elevated', label: 'Elevated', notes: 'Existed but not surfaced anywhere in nav.' },
    { item: 'RESOURCES (L1)', existed: 'Partial', action: 'reorganised', label: 'Expanded', notes: 'Blog existed under Resources. Now includes Tools, Perks, and Product Updates as explicit sub-sections.' },
    { item: 'Resources → Product Updates', existed: 'No', action: 'added', label: 'Added new', notes: 'No changelog/release notes page in primary nav previously.' },
    { item: 'TRUST & SECURITY (utility)', existed: 'No', action: 'added', label: 'Added new', notes: 'FDIC, SOC2, SIPC details scattered across pages. Consolidated into utility nav.' },
    { item: 'SUPPORT (utility)', existed: 'Partial', action: 'moved', label: 'Moved to utility', notes: 'Help Center was inside About dropdown. Moved to utility nav — matches user mental model.' },
    { item: 'PRICING (utility)', existed: 'Yes', action: 'kept', label: 'Kept in utility', notes: 'Was already in utility nav.' },
    { item: 'Company → Customers', existed: 'No', action: 'added', label: 'Added new', notes: 'No dedicated case studies or testimonials section existed in nav.' },
    { item: 'Company → Press', existed: 'Partial', action: 'added', label: 'Added + described', notes: 'Press coverage existed but no media kit or brand assets page in nav.' },
  ],
  best_practices_applied: [
    'Developer API elevated to L1 primary nav — was buried 3 levels deep',
    'Trust & Security added as utility nav — FDIC, SOC2, SIPC in one findable place',
    'Solutions split by Stage AND Industry — collapses 11-item flat dropdown',
    'Mercury Command elevated as AI & Intelligence L2 under Platform',
    'Customers section added under Company with case studies and testimonials',
    'Help Center moved from About to utility nav — matches user mental model',
    'Integrations given dedicated L2 under Developers — key buying signal',
    'Perks and Tools separated as clear sub-items under Resources',
    'Press page added under Company with media kit and brand assets',
    'Personal Banking given proper description and entry point',
  ],
  rationale: 'The revamped Mercury IA consolidates overlapping product groupings into a clean Platform section, elevates Developer tooling to match Mercury\'s API-first positioning, and fixes the core navigation problem: too many things buried in the wrong parent. Trust & Security and Support move to utility nav where users expect them. Solutions are segmented by Stage — matching how Mercury\'s founder-first users think about themselves, not by corporate role titles.',
};

/* ── CRISIL IA data — load with ?crisil ── */
const CRISIL_DATA = {
  company: {
    name: 'CRISIL',
    domain: 'crisil.com',
    tagline: 'Making markets function better',
    existing_issues: [
      'No "What We Do" at L1 — all services buried behind business-unit sub-domains',
      'Contact Us absent from primary nav — only appears on sub-domain navs',
      'CRISIL AI and 1Academy buried under "Who We Are > More From CRISIL"',
      'Investor Relations grouped under "Who We Are" — low discoverability for financial audience',
      'Only 4 L1 nav items for a company with 5 business units and 10+ service areas',
      '"Homepage" used as nav label for business units — CMS artifact leaking into production',
      'Duplicate press release URLs: /press-release.html vs /newsroom/press-releases.html',
      '/sitemap.xml returns 400 — no public sitemap, crawlability risk',
    ],
  },
  proposed_ia: {
    primary_nav: [
      {
        id: 'solutions',
        name: 'SOLUTIONS',
        utility: false,
        desc: 'All CRISIL capabilities — navigate by the problem you need solved, not by internal business unit',
        info: ['Ratings · Research · ESG · Risk · Data & AI · Consulting', 'Mapped to industries and geographies', 'Start from your need, not our org chart'],
        actions: ['Explore all solutions', 'Talk to a specialist'],
        l2: [
          { name: 'Ratings & Credit Risk', desc: 'India\'s most trusted credit rating agency — bank loans, bonds, structured finance and more', info: ['Bank loan ratings', 'Bond and NCD ratings', 'Structured finance ratings', 'SME ratings', 'Rating methodologies and criteria'], actions: ['Get a rating', 'Check a rating', 'Download methodology'], l3: [] },
          { name: 'Research & Analytics', desc: 'Macro, sector, company and fixed-income research powering 20,000+ professionals globally', info: ['Economic & industry research', 'Company financial research', 'Fixed income research and data', 'Customised analytics and reports'], actions: ['Browse research', 'Request custom research'], l3: [{ name: 'Economic Research' }, { name: 'Industry Research' }, { name: 'Fixed Income' }, { name: 'Custom Analytics' }] },
          { name: 'ESG & Sustainability', desc: 'ESG ratings, assessments, transition risk and sustainability consulting for India and global markets', info: ['ESG ratings for listed companies', 'Green and social bond opinions', 'Net-zero transition risk analysis', 'BRSR and disclosure advisory', 'Sustainability scoring'], actions: ['Get ESG rated', 'Download ESG methodology', 'Talk to sustainability team'], l3: [{ name: 'ESG Ratings' }, { name: 'Green Bond Opinions' }, { name: 'BRSR Advisory' }] },
          { name: 'Risk & Compliance', desc: 'End-to-end risk solutions — model validation, regulatory compliance and stress testing', info: ['Credit risk models and validation', 'Regulatory reporting (RBI, Basel IV)', 'Stress testing and IFRS 9', 'AML/KYC analytics', 'Model risk management'], actions: ['Talk to risk team', 'Download risk brochure'], l3: [] },
          { name: 'Data & Technology', desc: 'Structured financial data, indices, valuations and AI-powered analytics tools', info: ['Bonds and loans data', 'Equity and mutual fund data', 'CRISIL Bond Index series', 'Instrument valuations (MF, treasury)', 'CRISIL AI platform'], actions: ['Explore data products', 'Get API access', 'Download data catalogue'], l3: [{ name: 'Bonds & Loans Data' }, { name: 'Indices' }, { name: 'Valuations' }, { name: 'CRISIL AI' }] },
          { name: 'Consulting', desc: 'Strategy and sector consulting across infrastructure, energy, financial services and consumer markets', info: ['Urban infrastructure & transport', 'Energy, commodities & renewables', 'Mining & metals', 'Financial sector consulting', 'Consumer & retail strategy'], actions: ['Explore consulting', 'Meet the team'], l3: [{ name: 'Infrastructure' }, { name: 'Energy & Renewables' }, { name: 'Financial Services' }] },
        ],
      },
      {
        id: 'businesses',
        name: 'BUSINESSES',
        utility: false,
        desc: 'Five focused business units — deep specialisation, each with its own research, data and analytical engine',
        info: ['CRISIL Ratings · CRISIL Intelligence · CRISIL ESG · Integral IQ · Coalition Greenwich', 'All backed by S&P Global partnership and CRISIL\'s 35+ year track record', 'Combined reach: 30,000+ ratings, 1,400+ reports/year, 3,500+ global institutions'],
        actions: ['Go to CRISIL Ratings', 'Go to Intelligence', 'Explore all businesses'],
        l2: [
          { name: 'CRISIL Ratings', desc: 'India\'s largest credit rating agency — 30,000+ entity ratings across every instrument class', info: ['Corporate and bank ratings', 'Structured finance and securitisation', 'Real estate and NBFC ratings', 'Municipal and infrastructure bond ratings', 'Rating criteria, methodologies and regulatory disclosures'], actions: ['Visit CRISIL Ratings', 'Submit for rating', 'Check a rating'], l3: [] },
          { name: 'CRISIL Intelligence', desc: 'Market intelligence hub — research, consulting, data analytics, sustainability and risk under one roof', info: ['1,200+ research reports annually', 'Sector research across 80+ industries', 'Consulting engagements across 7 sectors', 'Risk solutions and model services', 'Sustainability advisory'], actions: ['Visit Intelligence', 'Browse reports', 'Talk to analyst'], l3: [] },
          { name: 'CRISIL ESG', desc: 'Dedicated ESG ratings and sustainability analytics — a separately regulated entity', info: ['ESG ratings for listed Indian companies', 'Green and sustainable bond second-party opinions', 'ESG disclosure and BRSR advisory', 'Transition risk and net-zero analysis'], actions: ['Visit CRISIL ESG', 'Get ESG rated'], l3: [] },
          { name: 'Integral IQ', desc: 'Fixed income data, valuations and tools for asset managers, treasuries and regulators', info: ['Bond pricing and instrument valuations', 'Fixed income analytics platform', 'Instrument-level data feeds', 'MF valuations and NAV support'], actions: ['Visit Integral IQ', 'Explore platform'], l3: [] },
          { name: 'Coalition Greenwich', desc: 'Strategic benchmarking and market analytics for financial institutions worldwide — 3,500+ firms tracked', info: ['Voice of the Client benchmarking studies', 'Market share analytics for wholesale banking', 'Investment management and equity research insights', 'Annual research covering US, Europe and Asia'], actions: ['Visit Coalition Greenwich', 'Download Coalition research'], l3: [] },
        ],
      },
      {
        id: 'insights',
        name: 'INSIGHTS',
        utility: false,
        desc: 'Research, reports, events and tools published by CRISIL — free previews and subscriber access',
        info: ['1,400+ articles, reports and blogs published annually', 'Flagship events: CRISIL Annual Summit, India Outlook, Sector Conclaves', 'Free interactive data tools and calculators', 'Full access gated via My CRISIL login'],
        actions: ['Browse all insights', 'Subscribe to research', 'Register for next event'],
        l2: [
          { name: 'Reports & Research', desc: 'Sector reports, rating commentaries, economic outlooks and capital market analysis', info: ['Annual economy and credit outlook', 'Sector reports across 80+ industries', 'Credit and fixed income reports', 'ESG and sustainability research', 'Coalition Greenwich annual studies'], actions: ['Browse reports', 'Download free sample', 'Subscribe for full access'], l3: [{ name: 'Economy & Markets' }, { name: 'Sector Research' }, { name: 'Credit & Fixed Income' }] },
          { name: 'Articles & Blogs', desc: 'Short-form analysis from CRISIL economists, analysts and sector specialists', info: ['Macro commentary and data stories', 'Sector deep-dives and expert opinions', 'Leadership opinion pieces', 'Infographics and visual explainers'], actions: ['Read latest articles', 'Subscribe to weekly digest'], l3: [] },
          { name: 'Events & Webinars', desc: 'Live and on-demand — roundtables, sector conclaves and the annual CRISIL summit', info: ['Upcoming events calendar', 'On-demand webinar library', 'CRISIL Annual Summit recordings', 'Industry roundtables and conclaves'], actions: ['See upcoming events', 'Watch past sessions', 'Register now'], l3: [] },
          { name: 'Data Tools', desc: 'Free interactive financial tools — yield curve, bond calculator, inflation tracker, indices performance', info: ['Yield curve visualiser', 'Bond price and yield calculator', 'Inflation and GDP tracker', 'CRISIL Bond Indices performance dashboard'], actions: ['Open tools', 'Export data'], l3: [] },
        ],
      },
      {
        id: 'about',
        name: 'ABOUT',
        utility: false,
        desc: 'CRISIL\'s story, leadership, investor relations and global footprint — established 1987, S&P Global subsidiary',
        info: ['4,000+ employees across India, UK, US, Argentina', 'Listed on NSE and BSE', 'S&P Global subsidiary since 1996', '35+ year track record in Indian financial markets'],
        actions: ['Read our story', 'Meet leadership', 'Visit investor relations'],
        l2: [
          { name: 'Who We Are', desc: 'Our purpose, values and the story of CRISIL since 1987', info: ['Our purpose and values', 'Company history and milestones', 'S&P Global relationship and group structure', 'Awards and recognitions', 'Global locations: Mumbai · London · New York · Buenos Aires'], actions: ['Read about us', 'Download company overview'], l3: [] },
          { name: 'Leadership', desc: 'Board of Directors, Executive Management Committee and independent directors', info: ['Board of Directors', 'Executive Management Committee', 'Independent director profiles', 'Committee compositions'], actions: ['View leadership team', 'Download annual report'], l3: [] },
          { name: 'Investor Relations', desc: 'Financial results, governance, shareholder services and regulatory disclosures for listed company', info: ['Quarterly and annual financial results', 'Annual reports archive', 'Shareholder and dividend information', 'Corporate governance documents', 'Board and committee details', 'Corporate announcements', 'Sustainability report', 'Analyst hub and disclosures (LODR Reg 46)'], actions: ['View financials', 'Download annual report', 'Contact investor relations'], l3: [{ name: 'Financials' }, { name: 'Governance' }, { name: 'Shareholder Services' }] },
          { name: 'Newsroom', desc: 'Press releases, media kit, brand assets and media contact', info: ['Press releases (single canonical URL, no duplicates)', 'Press kit & media assets', 'Media contacts', 'CRISIL in the news coverage'], actions: ['Read latest news', 'Download press kit', 'Contact media team'], l3: [] },
          { name: 'Foundation & CSR', desc: 'CRISIL Foundation\'s social impact work — financial literacy, rural livelihoods and urban inclusion', info: ['Mein Pragati (rural women\'s livelihoods)', 'CRISIL RE (urban infrastructure)', 'GramShakti (rural India empowerment)', 'MoneyWise CFL (financial literacy)', 'Annual impact reports'], actions: ['Visit CRISIL Foundation', 'Read impact report'], l3: [] },
          { name: 'Careers', desc: 'Join 4,000+ professionals shaping Indian and global financial markets', info: ['Open roles across India, UK, US, Argentina', 'Life at CRISIL and employee stories', 'Learning & development — CRISIL 1Academy', 'Graduate and campus programmes', 'Diversity and inclusion commitments'], actions: ['See open roles', 'Explore life at CRISIL', 'Connect on LinkedIn'], l3: [] },
        ],
      },
    ],
    utility_nav: [
      {
        id: 'crisil-ai',
        name: 'CRISIL AI',
        utility: true,
        desc: 'AI-powered analytics, document intelligence and workflow automation built on CRISIL\'s proprietary data',
        info: ['Document intelligence for credit and research workflows', 'NLP-driven rating commentary analysis', 'AI-assisted financial modelling', 'Integrated with CRISIL\'s 35+ years of proprietary data assets'],
        actions: ['Explore CRISIL AI', 'Request demo', 'Talk to AI team'],
        l2: [],
      },
      {
        id: 'academy',
        name: '1ACADEMY',
        utility: true,
        desc: 'CRISIL\'s learning platform — certifications, courses and training for finance professionals',
        info: ['Credit analysis certifications', 'Fixed income and derivatives courses', 'ESG training modules', 'Online and in-person delivery', 'Recognised by employers across BFSI sector'],
        actions: ['Browse courses', 'Enrol now', 'View certifications'],
        l2: [],
      },
      {
        id: 'contact',
        name: 'CONTACT',
        utility: true,
        desc: 'Get in touch with the right CRISIL team — sales, ratings, research, media or investor queries',
        info: ['Mumbai HQ: CRISIL House, Central Avenue, Powai', 'London and New York offices', 'Business-specific contact forms', 'Investor relations and media contacts'],
        actions: ['Contact sales', 'Contact ratings team', 'Find nearest office'],
        l2: [],
      },
    ],
  },
  competitors: [
    {
      name: 'ICRA',
      domain: 'icra.in',
      type: 'local',
      primary_nav_count: 6,
      has_newsroom: true,
      has_investors: true,
      has_sustainability: false,
      has_careers: true,
      portfolio_organization: 'function',
      ia_structure: 'Ratings (Bank Loan · Issuer · Structured Finance · Municipal) · Research (Industry · Economy · Thought Leadership) · Risk Solutions · Products & Services · About · Investor Relations',
      unique_adopted: 'Ratings as a surfaced capability — adopted under Solutions > Ratings & Credit Risk; Research as a distinct section — merged into Insights; Investor Relations as a visible page — adopted under About > Investor Relations',
      unique_not_adopted: '"Risk Solutions" as a standalone L1; "Products & Services" as a separate data-tools nav item',
      notable_pattern: 'ICRA (Moody\'s subsidiary) separates Ratings and Research into distinct L1 items. Works for institutional buyers who distinguish between a rating search and a research report search. CRISIL\'s broader audience makes capability-first Solutions more scalable — but a power-user shortcut to Ratings search could be added to utility nav later.',
      findings: [
        { pattern: 'Ratings as a separate L1 nav item', adopted: 'partial', reason: 'Adopted as Solutions → Ratings & Credit Risk. Not a standalone L1 — CRISIL\'s breadth of services warrants capability grouping over single-product L1s.' },
        { pattern: 'Research as a distinct L1 section', adopted: 'partial', reason: 'Merged into Insights hub. Research is one content type alongside articles, events and tools.' },
        { pattern: 'Investor Relations as a visible, dedicated section', adopted: 'yes', reason: 'Adopted as About → Investor Relations with all sub-pages (financials, governance, shareholder services).' },
        { pattern: 'Risk Solutions as a standalone L1', adopted: 'no', reason: 'Adopted as L2 within Solutions. A standalone L1 would overweight one service against CRISIL\'s much broader portfolio.' },
        { pattern: 'Products & Services nav for data tools', adopted: 'no', reason: 'Data tools merged into Solutions → Data & Technology. Separate nav track fragments user journey.' },
      ],
    },
    {
      name: 'CARE Ratings',
      domain: 'careratings.com',
      type: 'local',
      primary_nav_count: 7,
      has_newsroom: true,
      has_investors: true,
      has_sustainability: true,
      has_careers: true,
      portfolio_organization: 'function',
      ia_structure: 'Ratings (Corporate · Bank Loan · SME · Structured · Municipal · Infrastructure) · Research (Economy · Industry · Credit · Fixed Income) · ESG · Knowledge Centre · Investor Relations · About · Careers',
      unique_adopted: 'ESG as a visible standalone section — adopted as Solutions > ESG & Sustainability and as a full Business unit (CRISIL ESG); Knowledge Centre content hub — adopted as "Insights" L1; Contact Us in primary nav — adopted as utility nav item',
      unique_not_adopted: 'Dedicated SME ratings section in nav; "Pay Online" utility link for rating fees; Careers as a standalone L1',
      notable_pattern: 'CARE Ratings surfaces a Knowledge Centre and ESG prominently — both adopted. "Pay Online" for rating fees is a smart transactional shortcut for India\'s smaller-issuer market, where fees are paid directly. Not adopted for CRISIL because CRISIL\'s fees flow through relationship managers and key accounts, not a self-serve payment flow.',
      findings: [
        { pattern: 'ESG as a visible standalone section', adopted: 'yes', reason: 'Adopted in two places: Solutions → ESG & Sustainability (capability view) and Businesses → CRISIL ESG (brand/entity view).' },
        { pattern: 'Knowledge Centre / content hub at L1', adopted: 'yes', reason: 'Adopted and expanded as "Insights" L1 — adds Events, Data Tools, and structured sub-types that CARE\'s Knowledge Centre lacked.' },
        { pattern: 'Contact Us in primary nav', adopted: 'yes', reason: 'Added as utility nav item (CONTACT). Was entirely missing from crisil.com — a critical gap for an enterprise B2B site.' },
        { pattern: 'Pay Online utility link for rating fees', adopted: 'no', reason: 'CRISIL\'s fee flows go through relationship managers and key accounts, not self-serve online payment. Wrong UX model for CRISIL\'s client base.' },
        { pattern: 'SME Ratings as a dedicated nav section', adopted: 'no', reason: 'SME ratings are a sub-item within Solutions → Ratings & Credit Risk. Not prominent enough in CRISIL\'s pipeline to need its own L2 nav slot.' },
        { pattern: 'Careers as a standalone L1 item', adopted: 'no', reason: 'Moved under About → Careers. A rootless L1 Careers item signals a job board, not a coherent company story.' },
      ],
    },
    {
      name: 'India Ratings',
      domain: 'indiaratings.co.in',
      type: 'local',
      primary_nav_count: 5,
      has_newsroom: true,
      has_investors: false,
      has_sustainability: true,
      has_careers: true,
      portfolio_organization: 'function',
      ia_structure: 'Ratings (Corporate · Structured Finance · Public Finance · Banks & FIs) · Research (Sector Outlooks · Special Reports · Rating Criteria) · Sustainability · Regulatory & Criteria · About',
      unique_adopted: 'Regulatory & Criteria as a discoverable path to methodologies — adopted as sub-items within Solutions > Ratings & Credit Risk; Sector Outlooks as a named content type — adopted in Insights > Reports & Research',
      unique_not_adopted: '"Regulatory & Criteria" as a standalone L1 nav section; Public Finance ratings as a distinct L2; Fitch group branding in nav',
      notable_pattern: 'India Ratings (Fitch subsidiary) surfaces "Regulatory & Criteria" as an L1 — a smart transparency signal for institutional buyers who start from the methodology. Not adopted at L1 for CRISIL because methodologies are contextually linked within each solution page. Worth revisiting if CRISIL wants to compete explicitly on rating transparency against SEBI requirements.',
      findings: [
        { pattern: 'Regulatory & Criteria as a dedicated L1 section', adopted: 'partial', reason: 'Methodology pages embedded as sub-items inside Solutions → Ratings & Credit Risk. Not L1 — contextually linked within solution pages. Revisit if SEBI tightens transparency requirements.' },
        { pattern: 'Sector Outlooks as a named content type', adopted: 'yes', reason: 'Adopted in Insights → Reports & Research as a distinct, explicitly named content category. Improves discoverability for research subscribers.' },
        { pattern: 'Public Finance ratings as a distinct L2', adopted: 'no', reason: 'Not yet prominent enough in CRISIL\'s pipeline for a dedicated nav slot. Could be a tagged filter inside Solutions → Ratings & Credit Risk.' },
        { pattern: 'Fitch / parent branding in nav', adopted: 'no', reason: 'Not applicable. CRISIL is the parent brand; S&P relationship described in About, not surfaced in nav.' },
      ],
    },
  ],
  ia_changes: [
    { item: 'SOLUTIONS (L1)', existed: 'No', action: 'added', label: 'Added new', notes: 'Zero capability-first nav on crisil.com. Services only reachable via business unit sub-domains.' },
    { item: 'Solutions → Ratings & Credit Risk', existed: 'Partial', action: 'elevated', label: 'Surfaced', notes: 'Was only reachable via crisilratings.com sub-domain, not from crisil.com primary nav.' },
    { item: 'Solutions → Research & Analytics', existed: 'Partial', action: 'elevated', label: 'Surfaced', notes: 'Buried inside intelligence.crisil.com sub-domain. Not accessible from main nav.' },
    { item: 'Solutions → ESG & Sustainability', existed: 'Partial', action: 'elevated', label: 'Surfaced', notes: 'CRISIL ESG listed under Who We Are but never described by capability.' },
    { item: 'Solutions → Risk & Compliance', existed: 'No', action: 'added', label: 'Added new', notes: 'Existed as a service but never appeared in any navigation on crisil.com.' },
    { item: 'Solutions → Data & Technology', existed: 'No', action: 'added', label: 'Added new', notes: 'Data products scattered across Integral IQ and Intelligence sub-domains, not on main site.' },
    { item: 'Solutions → Consulting', existed: 'No', action: 'added', label: 'Added new', notes: 'Consulting was a live service with no navigation entry on crisil.com.' },
    { item: 'BUSINESSES (L1)', existed: 'Partial', action: 'elevated', label: 'Elevated', notes: 'Was buried as "Our Businesses" group inside Who We Are dropdown — 2 levels deep.' },
    { item: 'Businesses → CRISIL Ratings', existed: 'Yes', action: 'moved', label: 'Moved up', notes: 'Was L3 under Who We Are → Our Businesses. Now L2 at top level.' },
    { item: 'Businesses → CRISIL Intelligence', existed: 'Yes', action: 'moved', label: 'Moved + relabelled', notes: 'Was labelled "Intelligence → Homepage" — CMS artifact leaking into nav. Fixed.' },
    { item: 'Businesses → Integral IQ', existed: 'Yes', action: 'moved', label: 'Moved + relabelled', notes: 'Same "Homepage" label issue. Now properly described.' },
    { item: 'Businesses → Coalition Greenwich', existed: 'Yes', action: 'moved', label: 'Moved + relabelled', notes: 'Same.' },
    { item: 'INSIGHTS (L1)', existed: 'Partial', action: 'renamed', label: 'Renamed + expanded', notes: '"What We Think" was a single direct link with no sub-sections. Now has 4 L2 sub-sections.' },
    { item: 'Insights → Reports & Research', existed: 'Yes', action: 'kept', label: 'Organised', notes: 'Content existed but no L2 structure — flat dump. Now categorised into 3 sub-types.' },
    { item: 'Insights → Articles & Blogs', existed: 'Yes', action: 'kept', label: 'Organised', notes: 'Existed inside What We Think but no dedicated entry.' },
    { item: 'Insights → Events & Webinars', existed: 'Yes', action: 'moved', label: 'Merged into Insights', notes: '"Events" was a standalone L1 item. Now contextually grouped under Insights.' },
    { item: 'Insights → Data Tools', existed: 'No', action: 'added', label: 'Added new', notes: 'Tools existed on Intelligence sub-domain only. Now surfaced on crisil.com.' },
    { item: 'ABOUT (L1)', existed: 'Partial', action: 'renamed', label: 'Consolidated', notes: 'Content was split across "Who We Are" (cluttered dropdown) and scattered L1 items.' },
    { item: 'About → Investor Relations', existed: 'Yes', action: 'moved', label: 'Moved to About L2', notes: 'Was 3 levels deep: Who We Are → More From CRISIL → Investor Relations.' },
    { item: 'About → Newsroom', existed: 'Yes', action: 'moved', label: 'Moved to About L2', notes: 'Was buried under More From CRISIL. Duplicate URLs also consolidated.' },
    { item: 'About → Foundation & CSR', existed: 'Yes', action: 'moved', label: 'Moved to About L2', notes: 'CRISIL Foundation had no logical parent — now under About.' },
    { item: 'About → Careers', existed: 'Yes', action: 'moved', label: 'Moved under About', notes: 'Was a rootless standalone L1 item with no organisational context.' },
    { item: 'CRISIL AI (utility nav)', existed: 'No', action: 'added', label: 'Elevated', notes: 'Was 3 levels deep: Who We Are → More From CRISIL → CRISIL AI. Flagship product — completely hidden.' },
    { item: '1ACADEMY (utility nav)', existed: 'No', action: 'added', label: 'Elevated', notes: 'Buried under More From CRISIL alongside AI and Foundation. Recurring revenue product with no nav prominence.' },
    { item: 'CONTACT (utility nav)', existed: 'No', action: 'added', label: 'Added new', notes: 'Contact Us was entirely missing from crisil.com primary nav. Only on sub-domain navs.' },
  ],
  best_practices_applied: [
    '"What We Do / Solutions" added at L1 — current site has zero product/capability navigation at the top level',
    'Contact Us surfaced in utility nav — was completely missing from crisil.com primary nav',
    'Investor Relations moved to About > L2 — was buried under Who We Are > More From CRISIL',
    'CRISIL AI elevated to utility nav — was 3 levels deep under Who We Are > More From CRISIL',
    '1Academy elevated to utility nav — was buried alongside AI and Foundation with no prominence',
    'Businesses section created at L1 for users who know which unit they need (brand-aware audience)',
    'Insights hub replaces "What We Think" — Events, Tools, Articles and Research under one roof',
    'Foundation and CSR consolidated under About — now discoverable alongside company information',
    'Duplicate press release URLs consolidated to a single canonical Newsroom path',
    'Careers moved under About as L2 — was a standalone L1 orphan with no contextual parent',
  ],
  rationale: 'CRISIL\'s current IA is an org-chart navigation — visitors must already know which internal business unit answers their question. The revamp introduces a capability-first Solutions layer so buyers navigate by need (ratings, research, ESG, risk, data, consulting) rather than by CRISIL\'s internal structure. This is especially critical as CRISIL competes with S&P Global and Moody\'s Analytics internationally, where need-based navigation is table stakes for enterprise B2B SaaS.',
};

/* ── Quick-load: skip input screen when ?mock, ?mercury or ?crisil is in URL ── */
(function () {
  const p = new URLSearchParams(window.location.search);
  const data = p.has('crisil') ? CRISIL_DATA : p.has('mercury') ? MERCURY_DATA : p.has('mock') ? MOCK_DATA : null;
  if (!data) return;
  document.getElementById('state-input').classList.remove('active');
  setTimeout(() => renderResult(data), 50);
}());
