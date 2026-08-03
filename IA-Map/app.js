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
    },
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

/* ── Quick-load: skip input screen when ?mock or ?mercury is in URL ── */
(function () {
  const p = new URLSearchParams(window.location.search);
  const data = p.has('mercury') ? MERCURY_DATA : p.has('mock') ? MOCK_DATA : null;
  if (!data) return;
  document.getElementById('state-input').classList.remove('active');
  setTimeout(() => renderResult(data), 50);
}());
