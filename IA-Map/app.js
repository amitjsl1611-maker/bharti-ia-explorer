/* ══════════════════════════════════════════════
   app.js — IA Map frontend logic
   State management · Worker calls · Loading UI
══════════════════════════════════════════════ */

'use strict';

/* ── CONFIG — set your Worker URL here after deploy ── */
const WORKER_URL = 'https://ia-map-worker.your-subdomain.workers.dev';

/* ── STATE ── */
let manualCompetitors = [];
let competitorsPanelOpen = false;

/* ═══════════════════════════════════════════
   STATE TRANSITIONS
═══════════════════════════════════════════ */
function showState(id) {
  document.querySelectorAll('.state').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
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
    const data = await runPipeline(url, domain);
    renderResult(data);
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
   PIPELINE — single Worker call with SSE-style
   progress simulation while awaiting response
═══════════════════════════════════════════ */
async function runPipeline(url, domain) {
  // Animate loading steps in sequence while request is in flight
  stepActive('ls-scrape');

  const progressTimer = simulateProgress();

  const response = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, competitors_manual: manualCompetitors }),
  });

  clearInterval(progressTimer);

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 408 || text.includes('timeout')) {
      throw new Error(`Could not reach ${domain}. Check the URL and try again.`);
    }
    throw new Error('Analysis failed. Try again or check your connection.');
  }

  stepDone('ls-synthesis');
  stepActive('ls-render');

  const data = await response.json();
  return data;
}

function simulateProgress() {
  const steps = [
    { id: 'ls-scrape',      delay: 0 },
    { id: 'ls-competitors', delay: 4000 },
    { id: 'ls-comp-scrape', delay: 9000 },
    { id: 'ls-synthesis',   delay: 18000 },
  ];
  const dones = [
    { id: 'ls-scrape',      delay: 3500 },
    { id: 'ls-competitors', delay: 8500 },
    { id: 'ls-comp-scrape', delay: 17000 },
  ];
  steps.forEach(s  => setTimeout(() => stepActive(s.id),  s.delay));
  dones.forEach(d  => setTimeout(() => stepDone(d.id),    d.delay));
  // Return a fake handle (no actual interval)
  return setInterval(() => {}, 99999);
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
  const compBtn = document.getElementById('comp-panel-btn');
  if (compBtn) compBtn.classList.remove('open');
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
    { name: 'Tata Group', domain: 'tata.com', type: 'global', primary_nav_count: 5, has_newsroom: true,  has_investors: true,  has_sustainability: true,  has_careers: true,  portfolio_organization: 'sector', notable_pattern: 'Tata Stories editorial format gives the newsroom a strong brand identity distinct from a press release feed.' },
    { name: 'Mahindra',   domain: 'mahindra.com', type: 'global', primary_nav_count: 6, has_newsroom: true,  has_investors: true,  has_sustainability: true,  has_careers: true,  portfolio_organization: 'sector', notable_pattern: 'Rise philosophy integrated into every section, not siloed to a sustainability page.' },
    { name: 'OTB Group',  domain: 'otb.net',  type: 'global', primary_nav_count: 5, has_newsroom: true,  has_investors: false, has_sustainability: true,  has_careers: true,  portfolio_organization: 'brand',  notable_pattern: 'Sustainability is top-level, signalling ESG is a strategic priority not an afterthought.' },
    { name: 'Aldar',      domain: 'aldar.com', type: 'local', primary_nav_count: 6, has_newsroom: true,  has_investors: true,  has_sustainability: true,  has_careers: true,  portfolio_organization: 'sector', notable_pattern: 'Clear separation of retail and institutional investor journeys from the homepage.' },
  ],
  best_practices_applied: [
    'Portfolio organised by sector, not geography',
    'NEWSROOM replaces "Media Centre" — editorial framing with permalink articles',
    'WHO WE ARE replaces "About Us" — confident identity positioning',
    'IMPACT as primary nav elevates ESG to strategic priority',
    'Utility nav: INVESTORS, CAREERS, CONTACT — all one click from anywhere',
  ],
  rationale: 'The proposed IA consolidates a fragmented existing structure into five clear primary sections mirroring the group\'s identity, portfolio, footprint, purpose and voice. The utility nav ensures investor and talent journeys are never more than one click away.',
};

/* ── Quick test: load mock data immediately if URL has ?mock ── */
if (new URLSearchParams(window.location.search).has('mock')) {
  setTimeout(() => {
    renderResult(MOCK_DATA);
  }, 300);
}
