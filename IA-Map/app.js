/* ══════════════════════════════════════════════
   app.js — IA Map frontend logic
   4-step wizard · Railway backend · 3-pass pipeline
══════════════════════════════════════════════ */

'use strict';

const WORKER_URL = 'https://bharti-ia-explorer-production.up.railway.app';

/* ═══════════════════════════════════════════
   STATE
═══════════════════════════════════════════ */
let manualCompetitors  = [];
let competitorsPanelOpen = false;
let _scrapedCache      = null;
try { const s = localStorage.getItem('ia_scraped_cache'); if (s) _scrapedCache = JSON.parse(s); } catch (_) {}
let _analysisLoaded    = false;
let _analysisLoading   = false;

// Wizard state
let wizardStep         = 1;
let briefFileBase64    = null;
let briefFileMediaType = null;
let briefFileName      = null;

/* ═══════════════════════════════════════════
   SCREEN TRANSITIONS
═══════════════════════════════════════════ */
function showState(id) {
  document.querySelectorAll('.state').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const floatBtn = document.getElementById('comp-float-btn');
  if (floatBtn) floatBtn.style.display = id === 'state-result' ? 'flex' : 'none';
}

/* ═══════════════════════════════════════════
   WIZARD — STEP MANAGEMENT
═══════════════════════════════════════════ */
function goToStep(n) {
  // Validate before advancing
  if (n > wizardStep) {
    if (wizardStep === 1) {
      const raw = document.getElementById('url-input').value.trim();
      const errEl = document.getElementById('url-error');
      if (!validateUrl(raw)) {
        errEl.textContent = 'Please enter a valid URL (e.g. https://company.com)';
        return;
      }
      errEl.textContent = '';
    }
  }

  // Hide all panels, show target
  document.querySelectorAll('.wiz-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`ws-${n}`).classList.add('active');

  // Update progress dots
  for (let i = 1; i <= 4; i++) {
    const dot = document.getElementById(`wp-${i}`);
    if (!dot) continue;
    dot.classList.toggle('done', i < n);
    dot.classList.toggle('active', i === n);
    dot.classList.toggle('upcoming', i > n);
  }
  // Update connector lines
  for (let i = 1; i <= 3; i++) {
    const line = document.getElementById(`wl-${i}-${i+1}`);
    if (line) line.classList.toggle('filled', i < n);
  }

  wizardStep = n;

  // Auto-trigger understanding fetch when reaching step 4
  if (n === 4) fetchUnderstanding();
}

/* ═══════════════════════════════════════════
   WIZARD — BRIEF / FILE
═══════════════════════════════════════════ */
function triggerFileUpload() {
  document.getElementById('brief-file').click();
}

function updateWordCount() {
  const ta = document.getElementById('brief-text');
  const numEl = document.getElementById('brief-word-num');
  if (!ta || !numEl) return;
  const words = ta.value.trim() === '' ? 0 : ta.value.trim().split(/\s+/).length;
  numEl.textContent = words;
  numEl.style.color = words > 400 ? '#c0392b' : words > 350 ? '#e67e22' : '#999';
  // Enforce limit: trim to 400 words if exceeded
  if (words > 400) {
    ta.value = ta.value.trim().split(/\s+/).slice(0, 400).join(' ');
    numEl.textContent = 400;
    numEl.style.color = '#c0392b';
  }
}

document.getElementById('brief-file').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const fileNameEl = document.getElementById('file-name');
  fileNameEl.textContent = file.name;
  briefFileName = file.name;

  // Detect media type
  if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
    briefFileMediaType = 'application/pdf';
  } else {
    briefFileMediaType = 'text/plain';
  }

  // Read as base64
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    briefFileBase64 = dataUrl.split(',')[1]; // strip "data:...;base64,"
  };
  reader.readAsDataURL(file);
});

/* ═══════════════════════════════════════════
   WIZARD — COMPETITORS (step 3)
═══════════════════════════════════════════ */
function addCompetitor() {
  const input = document.getElementById('comp-input');
  const val = input.value.trim();
  if (!val || manualCompetitors.length >= 6 || manualCompetitors.includes(val)) {
    input.value = '';
    return;
  }
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

document.getElementById('comp-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addCompetitor();
});

/* ═══════════════════════════════════════════
   WIZARD — STEP 4: SCOPE UNDERSTANDING
═══════════════════════════════════════════ */
async function fetchUnderstanding() {
  const bulletsEl = document.getElementById('understanding-bullets');
  const genBtn    = document.getElementById('wizard-generate-btn');
  const errEl     = document.getElementById('understand-error');

  bulletsEl.innerHTML = '<div class="u-loading"><span class="u-spinner">⟳</span> Reading your inputs…</div>';
  if (genBtn) genBtn.disabled = true;
  if (errEl) errEl.textContent = '';

  try {
    const url = validateUrl(document.getElementById('url-input').value.trim());
    const brief = document.getElementById('brief-text').value.trim();

    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'understand',
        url,
        brief_text: brief || undefined,
        competitors_hint: manualCompetitors.length ? manualCompetitors.join(', ') : undefined,
      }),
    });

    if (!res.ok) throw new Error('Understanding call failed');
    let data;
    try { data = await res.json(); } catch { data = {}; }
    const bullets = Array.isArray(data.bullets) ? data.bullets : [];

    if (bullets.length) {
      bulletsEl.innerHTML = bullets.map(b => `
        <div class="u-bullet">
          <span class="u-dash">—</span>
          <span>${b}</span>
        </div>`).join('');
    } else {
      bulletsEl.innerHTML = '<div class="u-fallback">Scope understood. Click Generate IA to proceed.</div>';
    }
  } catch {
    bulletsEl.innerHTML = '<div class="u-fallback">Scope understood. Click Generate IA to proceed.</div>';
  }

  if (genBtn) genBtn.disabled = false;
}

/* ═══════════════════════════════════════════
   URL VALIDATION
═══════════════════════════════════════════ */
function validateUrl(raw) {
  if (!raw) return null;
  try {
    const url = raw.startsWith('http') ? raw : `https://${raw}`;
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

document.getElementById('url-input').addEventListener('input', () => {
  document.getElementById('url-error').textContent = '';
});
document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') goToStep(2);
});

/* ═══════════════════════════════════════════
   GENERATE — kick off full pipeline from step 4
═══════════════════════════════════════════ */
async function startGenerate() {
  const raw = document.getElementById('url-input').value.trim();
  const url = validateUrl(raw);
  if (!url) return;

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

/* ═══════════════════════════════════════════
   LOADING LOG — live activity feed
═══════════════════════════════════════════ */
let _logTimers = [];

function resetLoadingSteps() {
  // Clear any running timers from previous run
  _logTimers.forEach(t => clearTimeout(t));
  _logTimers = [];
  const log = document.getElementById('loading-log');
  if (log) log.innerHTML = '';
}

// Add a new log line; returns its element so it can be updated later
function addLog(text, type = 'active') {
  const log = document.getElementById('loading-log');
  if (!log) return null;
  const row = document.createElement('div');
  row.className = `ll-row ll-${type}`;
  const icon = type === 'done' ? '✓' : type === 'section' ? '' : '→';
  row.innerHTML = `<span class="ll-icon">${icon}</span><span class="ll-text">${text}</span>`;
  log.appendChild(row);
  // Scroll to bottom
  log.scrollTop = log.scrollHeight;
  return row;
}

// Schedule a log message after delay ms; returns timer id
function schedLog(delay, text, type = 'active') {
  const t = setTimeout(() => addLog(text, type), delay);
  _logTimers.push(t);
  return t;
}

// Update an existing row's text and type
function updateLogRow(row, text, type = 'done') {
  if (!row) return;
  row.className = `ll-row ll-${type}`;
  const icon = type === 'done' ? '✓' : type === 'error' ? '✕' : '→';
  row.innerHTML = `<span class="ll-icon">${icon}</span><span class="ll-text">${text}</span>`;
  const log = document.getElementById('loading-log');
  if (log) log.scrollTop = log.scrollHeight;
}

// No-op stubs so old renderer.js calls don't crash
function stepActive() {}
function stepDone() {}

/* ═══════════════════════════════════════════
   PASS 1 — SCRAPE (auto-flows to Pass 2)
═══════════════════════════════════════════ */
async function runPass1(url, domain) {
  // ── Timed log messages during scraping ──
  addLog(`<strong>Pass 1 — Scraping</strong>`, 'section');
  const rowHomepage = addLog(`Fetching ${domain} homepage…`);
  schedLog(1800,  `Reading sitemap.xml for full page inventory…`);
  schedLog(4000,  `Extracting nav structure, footer links and page hierarchy…`);
  schedLog(6500,  `Scanning inner pages: About, Solutions, Products, Services…`);
  schedLog(9500,  `Asking Claude to identify best-in-class competitors…`);
  schedLog(13000, `Fetching competitor site 1…`);
  schedLog(17000, `Fetching competitor site 2…`);
  schedLog(21000, `Fetching competitor site 3…`);

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
  try { localStorage.setItem('ia_scraped_cache', JSON.stringify(data)); } catch (_) {}

  // ── Show actual results from the scrape ──
  const pageCount = data.targetData?.page_count || 0;
  const innerPages = data.targetData?.inner_pages?.length || 0;
  updateLogRow(rowHomepage,
    `${domain} scraped — ${pageCount ? pageCount + ' pages in sitemap' : 'homepage + nav extracted'}${innerPages ? ', ' + innerPages + ' inner pages read' : ''}`,
    'done');

  const compNames = (data.competitors || []).map(c => c.name || c.domain);
  if (compNames.length) {
    const chips = compNames.map(n => `<span class="ll-comp-chip">${n}</span>`).join('');
    const row = addLog(`Benchmarking against: ${chips}`, 'done');
    if (row) row.classList.add('ll-comp-highlight');
  }

  const compCount = (data.competitorData || []).length;
  if (compCount) addLog(`${compCount} competitor site${compCount > 1 ? 's' : ''} scraped successfully`, 'done');

  // Update ETA based on actual page count
  const etaEl = document.getElementById('loading-eta');
  if (etaEl && pageCount) {
    const secs = pageCount > 300 ? '60–90 seconds' : pageCount > 100 ? '45–75 seconds' : '30–50 seconds';
    etaEl.textContent = `Estimated time remaining: ${secs}`;
  }

  // ── Auto-advance to Pass 2 ──
  await runPass2();
}

/* ═══════════════════════════════════════════
   PASS 2 — IA SYNTHESIS
═══════════════════════════════════════════ */
async function runPass2() {
  if (!_scrapedCache) return;
  const { targetData, competitorData } = _scrapedCache;

  addLog(`<strong>Pass 2 — Synthesis</strong>`, 'section');
  const rowSynth = addLog(`Generating proposed IA with Claude Sonnet…`);
  schedLog(8000,  `Applying 12 IA rules and industry-specific patterns…`);
  schedLog(18000, `Building L1 → L2 → L3 nav structure…`);
  schedLog(30000, `Finalising rationale and best practices…`);
  // Pulsing progress bar so screen doesn't look frozen during synthesis
  const synthBar = document.getElementById('synth-progress-bar');
  if (synthBar) synthBar.style.display = '';

  const brief = document.getElementById('brief-text').value.trim();
  const mustInclude = document.getElementById('must-include')?.value.trim();
  const mustExclude = document.getElementById('must-exclude')?.value.trim();

  const response = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'synthesise',
      targetData,
      competitorData,
      brief_text: brief || undefined,
      must_include: mustInclude || undefined,
      must_exclude: mustExclude || undefined,
      document_base64: briefFileBase64 || undefined,
      document_media_type: briefFileMediaType || undefined,
    }),
  });

  if (!response.ok) {
    const errMsg = await parseWorkerError(response);
    throw new Error(errMsg);
  }

  let data;
  try { data = await response.json(); } catch {
    throw new Error('The IA response was too large or got cut off. Try a simpler site first, or try again.');
  }
  if (!data || !data.proposed_ia) throw new Error('Invalid IA response from server. Please try again.');

  const sb = document.getElementById('synth-progress-bar'); if (sb) sb.style.display = 'none';
  updateLogRow(rowSynth, 'Proposed IA generated', 'done');
  addLog('Rendering interactive prototype…', 'active');
  renderResult(data);
}

/* ═══════════════════════════════════════════
   PASS 3 — ANALYSIS (triggered on panel open)
═══════════════════════════════════════════ */
async function runPass3() {
  if (!_scrapedCache) return;
  const { targetData, competitorData, competitors } = _scrapedCache;

  const response = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'analyse', targetData, competitorData, competitors }),
  });

  if (!response.ok) {
    const errMsg = await parseWorkerError(response);
    throw new Error(errMsg);
  }

  let analysis;
  try { analysis = await response.json(); } catch (e) { throw new Error('Analysis returned invalid data. Try opening the panel again.'); }
  if (window._currentIAData) {
    window._currentIAData.ia_changes = analysis.ia_changes || [];
    window._currentIAData.competitors = analysis.competitors || [];
    window._currentIAData.best_practices_applied = analysis.best_practices_applied || [];
    buildCompetitorsPanel(window._currentIAData);
  }
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


/* ═══════════════════════════════════════════
   RENDER RESULT
═══════════════════════════════════════════ */
function renderResult(data) {
  window._currentIAData = data;
  _analysisLoaded  = false;
  _analysisLoading = false;
  stepDone('ls-render');

  const companyName = data.company?.name || new URL(
    document.getElementById('loading-domain').textContent.startsWith('http')
      ? document.getElementById('loading-domain').textContent
      : `https://${document.getElementById('loading-domain').textContent}`
  ).hostname;
  document.getElementById('tb-company-name').textContent = companyName;

  showState('state-result');
  buildRenderer(data);
  setMode('sitemap');

  if (data.company?.existing_issues?.length) {
    const bar   = document.getElementById('rationale-bar');
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
  goToStep(1);
  // Show a clean message — never expose raw JS errors to the user
  const clean = (msg && !msg.includes('JSON') && !msg.includes('fetch') && msg.length < 120)
    ? msg
    : 'Something went wrong. Please try again.';
  document.getElementById('url-error').textContent = clean;
}

/* ═══════════════════════════════════════════
   BACK TO INPUT / RESET
═══════════════════════════════════════════ */
function goBack() {
  showState('state-input');
  goToStep(1);
  smBuilt = false;
  manualCompetitors = [];
  briefFileBase64 = null;
  briefFileMediaType = null;
  briefFileName = null;
  renderCompChips();
  document.getElementById('url-input').value = '';
  document.getElementById('url-error').textContent = '';
  document.getElementById('brief-text').value = '';
  document.getElementById('file-name').textContent = '';
  const mi = document.getElementById('must-include'); if (mi) mi.value = '';
  const me = document.getElementById('must-exclude'); if (me) me.value = '';
  document.getElementById('brief-file').value = '';
  const c = document.getElementById('canvas');
  const s = document.getElementById('sm-canvas');
  if (c) { c.innerHTML = ''; c.appendChild(document.getElementById('svg') || document.createElementNS('http://www.w3.org/2000/svg','svg')); }
  if (s) s.innerHTML = '';
  document.body.classList.remove('sitemap','has-inav');
  const islandNav = document.getElementById('island-nav');
  if (islandNav) islandNav.style.display = 'none';
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

/* ── Analysis panel — triggers Pass 3 on first open ── */
function toggleCompPanel() {
  const panel   = document.getElementById('comp-side-panel');
  const floatBtn = document.getElementById('comp-float-btn');
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  if (floatBtn) floatBtn.classList.toggle('open', isOpen);

  const labelEl = document.getElementById('comp-float-label');

  if (isOpen && !_analysisLoaded && !_analysisLoading && _scrapedCache) {
    _analysisLoading = true;
    if (labelEl) labelEl.textContent = 'Analysing…';
    if (floatBtn) floatBtn.style.opacity = '0.6';
    const cardsEl = document.getElementById('csp-cards');
    if (cardsEl) cardsEl.innerHTML = '<div style="padding:24px;color:#888;font-size:13px;">Generating analysis with Claude Sonnet…</div>';
    runPass3()
      .then(() => {
        _analysisLoaded = true;
        _analysisLoading = false;
        if (labelEl) labelEl.textContent = 'Go Deeper';
        if (floatBtn) floatBtn.style.opacity = '';
      })
      .catch(err => {
        _analysisLoading = false;
        if (labelEl) labelEl.textContent = 'Go Deeper';
        if (floatBtn) floatBtn.style.opacity = '';
        if (cardsEl) cardsEl.innerHTML = `<div style="padding:24px;color:#c00;font-size:13px;">Analysis failed: ${err.message}</div>`;
      });
  }
}

/* ══════════════════════════════════════════════
   MOCK / DEMO DATA
   Load with ?mock, ?mercury, or ?crisil in URL
══════════════════════════════════════════════ */
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
        ],
      },
      {
        id: 'impact', name: 'IMPACT', utility: false,
        desc: 'ESG strategy, sustainability commitments and foundation work',
        info: ['ESG framework and goals', 'Annual impact report', 'Community investment figures'],
        actions: ['Download ESG report', 'Read impact stories', 'View SDG alignment'],
        l2: [
          { name: 'ESG Strategy', desc: '', info: ['Pillars and 2030 targets'], actions: ['Download report'], l3: [] },
          { name: 'Environment', desc: '', info: ['Carbon targets', 'Green initiatives'], actions: ['View commitments'], l3: [] },
          { name: 'Foundation', desc: '', info: ['Foundation overview', 'Grant programmes'], actions: ['Apply for grant'], l3: [] },
        ],
      },
      {
        id: 'newsroom', name: 'NEWSROOM', utility: false,
        desc: 'Press releases, media coverage and editorial content',
        info: ['Filterable article feed', 'Media library', 'Spokesperson contacts'],
        actions: ['Filter by topic', 'Download press kit', 'Contact media team'],
        l2: [
          { name: 'Press Releases', desc: '', info: ['Chronological releases'], actions: ['Filter by date'], l3: [] },
          { name: 'In the Media', desc: '', info: ['Curated coverage'], actions: ['Read articles'], l3: [] },
        ],
      },
    ],
    utility_nav: [
      { id: 'investors', name: 'INVESTORS', utility: true, desc: 'Investor relations and financials', info: ['Financial highlights'], actions: ['Download annual report'], l2: [] },
      { id: 'careers',  name: 'CAREERS',   utility: true, desc: 'Job listings and employer brand', info: ['Live job listings'], actions: ['Search jobs'], l2: [] },
      { id: 'contact',  name: 'CONTACT',   utility: true, desc: 'Get in touch', info: ['Head office address'], actions: ['Send enquiry'], l2: [] },
    ],
  },
  competitors: [],
  best_practices_applied: ['Portfolio organised by sector', 'NEWSROOM replaces Media Centre', 'IMPACT as primary nav', 'Utility nav: INVESTORS, CAREERS, CONTACT'],
  rationale: 'The proposed IA consolidates a fragmented existing structure into four clear primary sections.',
  ia_changes: [
    { item: 'About Us', existed: 'yes', action: 'renamed', label: 'WHO WE ARE', notes: 'Confident identity framing.' },
    { item: 'Media Centre', existed: 'yes', action: 'renamed', label: 'NEWSROOM', notes: 'Editorial framing with permalink articles.' },
  ],
};

/* ── CRISIL data (abbreviated for quick load) ── */
const CRISIL_DATA = {
  company: {
    name: 'CRISIL',
    domain: 'crisil.com',
    tagline: 'Making markets function better',
    existing_issues: [
      'No "What We Do" at L1 — all services buried behind business-unit sub-domains',
      'Contact Us absent from primary nav',
      'CRISIL AI and 1Academy buried under Who We Are > More From CRISIL',
      'Investor Relations grouped under Who We Are — low discoverability',
      'Only 4 L1 nav items for a company with 5 business units and 10+ service areas',
      '"Homepage" used as nav label for business units — CMS artifact leaking into production',
    ],
  },
  proposed_ia: {
    primary_nav: [
      {
        id: 'solutions', name: 'SOLUTIONS', utility: false,
        desc: 'All CRISIL capabilities — navigate by the problem you need solved',
        info: ['Ratings · Research · ESG · Risk · Data & AI · Consulting', 'Mapped to industries and geographies'],
        actions: ['Explore all solutions', 'Talk to a specialist'],
        l2: [
          { name: 'Ratings & Credit Risk', desc: "India's most trusted credit rating agency", info: ['Bank loan ratings', 'Bond ratings', 'SME ratings'], actions: ['Get a rating', 'Check a rating'], l3: [] },
          { name: 'Research & Analytics', desc: 'Macro, sector and company research', info: ['Economic research', 'Industry research', 'Fixed income research'], actions: ['Browse research', 'Request custom research'], l3: [{ name: 'Economic Research' }, { name: 'Industry Research' }, { name: 'Fixed Income' }] },
          { name: 'ESG & Sustainability', desc: 'ESG ratings, assessments and sustainability consulting', info: ['ESG ratings', 'Green bond opinions', 'BRSR advisory'], actions: ['Get ESG rated', 'Download methodology'], l3: [] },
          { name: 'Risk & Compliance', desc: 'End-to-end risk solutions', info: ['Credit risk models', 'Regulatory reporting', 'Stress testing'], actions: ['Talk to risk team'], l3: [] },
          { name: 'Data & Technology', desc: 'Structured financial data and AI-powered analytics', info: ['Bond data', 'Indices', 'CRISIL AI platform'], actions: ['Explore data products', 'Get API access'], l3: [{ name: 'Bonds & Loans Data' }, { name: 'Indices' }, { name: 'CRISIL AI' }] },
          { name: 'Consulting', desc: 'Strategy and sector consulting', info: ['Infrastructure', 'Energy', 'Financial services'], actions: ['Explore consulting', 'Meet the team'], l3: [] },
        ],
      },
      {
        id: 'businesses', name: 'BUSINESSES', utility: false,
        desc: 'Five focused business units — each with its own analytical engine',
        info: ['CRISIL Ratings · CRISIL Intelligence · CRISIL ESG · Integral IQ · Coalition Greenwich'],
        actions: ['Go to CRISIL Ratings', 'Go to Intelligence', 'Explore all businesses'],
        l2: [
          { name: 'CRISIL Ratings', desc: "India's largest credit rating agency — 30,000+ entity ratings", info: ['Corporate and bank ratings', 'Structured finance', 'Real estate ratings'], actions: ['Visit CRISIL Ratings', 'Submit for rating'], l3: [] },
          { name: 'CRISIL Intelligence', desc: 'Market intelligence hub — research, consulting and data analytics', info: ['1,200+ research reports annually', 'Sector research across 80+ industries'], actions: ['Visit Intelligence', 'Browse reports'], l3: [] },
          { name: 'CRISIL ESG', desc: 'Dedicated ESG ratings and sustainability analytics', info: ['ESG ratings for listed Indian companies', 'Green bond second-party opinions'], actions: ['Visit CRISIL ESG', 'Get ESG rated'], l3: [] },
          { name: 'Integral IQ', desc: 'Fixed income data, valuations and tools', info: ['Bond pricing', 'Fixed income analytics', 'MF valuations'], actions: ['Visit Integral IQ', 'Explore platform'], l3: [] },
          { name: 'Coalition Greenwich', desc: 'Strategic benchmarking for financial institutions worldwide', info: ['Voice of the Client studies', 'Market share analytics', 'Investment management insights'], actions: ['Visit Coalition Greenwich', 'Download Coalition research'], l3: [] },
        ],
      },
      {
        id: 'insights', name: 'INSIGHTS', utility: false,
        desc: 'Research, reports, events and tools published by CRISIL',
        info: ['1,400+ articles and reports annually', 'Flagship events: CRISIL Annual Summit', 'Free interactive data tools'],
        actions: ['Browse all insights', 'Subscribe to research', 'Register for next event'],
        l2: [
          { name: 'Reports & Research', desc: 'Sector reports, rating commentaries, economic outlooks', info: ['Annual economy outlook', 'Sector reports across 80+ industries', 'Credit and fixed income reports'], actions: ['Browse reports', 'Subscribe for full access'], l3: [{ name: 'Economy & Markets' }, { name: 'Sector Research' }, { name: 'Credit & Fixed Income' }] },
          { name: 'Articles & Blogs', desc: 'Short-form analysis from CRISIL analysts', info: ['Macro commentary', 'Sector deep-dives', 'Leadership opinion pieces'], actions: ['Read latest articles'], l3: [] },
          { name: 'Events & Webinars', desc: 'Live and on-demand — roundtables, conclaves and the annual summit', info: ['Upcoming events calendar', 'On-demand webinar library'], actions: ['See upcoming events', 'Register now'], l3: [] },
          { name: 'Data Tools', desc: 'Free interactive financial tools', info: ['Yield curve visualiser', 'Bond price calculator', 'Indices performance dashboard'], actions: ['Open tools', 'Export data'], l3: [] },
        ],
      },
      {
        id: 'about', name: 'ABOUT', utility: false,
        desc: "CRISIL's story, leadership, investor relations and global footprint",
        info: ['4,000+ employees across India, UK, US, Argentina', 'Listed on NSE and BSE', 'S&P Global subsidiary since 1996'],
        actions: ['Read our story', 'Meet leadership', 'Visit investor relations'],
        l2: [
          { name: 'Who We Are', desc: 'Our purpose, values and the story of CRISIL since 1987', info: ['Purpose and values', 'Company history', 'S&P Global relationship'], actions: ['Read about us'], l3: [] },
          { name: 'Leadership', desc: 'Board of Directors and Executive Management Committee', info: ['Board of Directors', 'Executive Management Committee'], actions: ['View leadership team'], l3: [] },
          { name: 'Investor Relations', desc: 'Financial results, governance and regulatory disclosures', info: ['Quarterly and annual financial results', 'Annual reports', 'Shareholder information'], actions: ['View financials', 'Download annual report', 'Contact investor relations'], l3: [{ name: 'Financials' }, { name: 'Governance' }, { name: 'Shareholder Services' }] },
          { name: 'Newsroom', desc: 'Press releases, media kit and brand assets', info: ['Press releases', 'Press kit & media assets', 'Media contacts'], actions: ['Read latest news', 'Download press kit'], l3: [] },
          { name: 'Foundation & CSR', desc: "CRISIL Foundation's social impact work", info: ['Mein Pragati', 'GramShakti', 'MoneyWise CFL'], actions: ['Visit CRISIL Foundation'], l3: [] },
          { name: 'Careers', desc: 'Join 4,000+ professionals shaping financial markets', info: ['Open roles across India, UK, US, Argentina', 'CRISIL 1Academy', 'Graduate programmes'], actions: ['See open roles', 'Explore life at CRISIL'], l3: [] },
        ],
      },
    ],
    utility_nav: [
      { id: 'crisil-ai', name: 'CRISIL AI', utility: true, desc: 'AI-powered analytics built on CRISIL data', info: ['Document intelligence', 'NLP-driven analysis', 'AI-assisted financial modelling'], actions: ['Explore CRISIL AI', 'Request demo'], l2: [] },
      { id: 'academy',   name: '1ACADEMY', utility: true, desc: "CRISIL's learning platform for finance professionals", info: ['Credit analysis certifications', 'Fixed income courses', 'ESG training'], actions: ['Browse courses', 'Enrol now'], l2: [] },
      { id: 'contact',   name: 'CONTACT',  utility: true, desc: 'Get in touch with the right CRISIL team', info: ['Mumbai HQ: CRISIL House, Central Avenue, Powai', 'Business-specific contact forms'], actions: ['Contact sales', 'Contact ratings team'], l2: [] },
    ],
  },
  competitors: [],
  best_practices_applied: [
    '"What We Do / Solutions" added at L1 — current site has zero product/capability navigation at the top level',
    'Contact Us surfaced in utility nav — was completely missing from crisil.com primary nav',
    'Investor Relations moved to About > L2 — was buried under Who We Are > More From CRISIL',
    'CRISIL AI elevated to utility nav — was 3 levels deep under Who We Are > More From CRISIL',
    '1Academy elevated to utility nav — was buried alongside AI and Foundation with no prominence',
    'Businesses section created at L1 for users who know which unit they need',
    'Insights hub replaces "What We Think" — Events, Tools, Articles and Research under one roof',
    'Careers moved under About as L2 — was a standalone L1 orphan with no contextual parent',
  ],
  rationale: "CRISIL's current IA is an org-chart navigation — visitors must already know which internal business unit answers their question. The revamp introduces a capability-first Solutions layer so buyers navigate by need (ratings, research, ESG, risk, data, consulting) rather than by CRISIL's internal structure.",
  ia_changes: [
    { item: 'SOLUTIONS (L1)', existed: 'No', action: 'added', label: 'Added new', notes: 'Zero capability-first nav on crisil.com. Services only reachable via business unit sub-domains.' },
    { item: 'BUSINESSES (L1)', existed: 'Partial', action: 'elevated', label: 'Elevated', notes: 'Was buried as "Our Businesses" inside Who We Are dropdown — 2 levels deep.' },
    { item: 'INSIGHTS (L1)', existed: 'Partial', action: 'renamed', label: 'Renamed + expanded', notes: '"What We Think" was a single link with no sub-sections. Now has 4 L2 sub-sections.' },
    { item: 'About → Investor Relations', existed: 'Yes', action: 'moved', label: 'Moved to About L2', notes: 'Was 3 levels deep: Who We Are → More From CRISIL → Investor Relations.' },
    { item: 'CRISIL AI (utility nav)', existed: 'No', action: 'added', label: 'Elevated', notes: 'Was 3 levels deep. Flagship product — completely hidden.' },
    { item: '1ACADEMY (utility nav)', existed: 'No', action: 'added', label: 'Elevated', notes: 'Buried under More From CRISIL with no prominence.' },
    { item: 'CONTACT (utility nav)', existed: 'No', action: 'added', label: 'Added new', notes: 'Contact Us was entirely missing from crisil.com primary nav.' },
  ],
};

/* ── Quick-load demo data via URL params ── */
(function () {
  const p = new URLSearchParams(window.location.search);
  const data = p.has('crisil') ? CRISIL_DATA : p.has('mock') ? MOCK_DATA : null;
  if (!data) return;
  document.getElementById('state-input').classList.remove('active');
  setTimeout(() => renderResult(data), 50);
}());
