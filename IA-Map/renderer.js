/* ══════════════════════════════════════════════
   renderer.js — IA Map canvas renderer
   Faithfully ports bharti-ia-prototype.html's
   exact rendering patterns to a data-driven API.
══════════════════════════════════════════════ */

'use strict';

/* ── IA COORDINATE CONSTANTS ── */
const CW        = 440;
const SLOT      = 560;
const L1_Y      = 310;
const L1_CARD_Y = 390;
const L2_SY     = 830;
const L2_Y      = 870;
const L2_CARD_Y = 944;
const L3_SY     = 1344;
const L3_Y      = 1384;
const SPINE_Y   = 258;
const START_Y   = 145;
const L1_FOCUS_CY = 545;
const L2_FOCUS_CY = L2_Y + 140; // ~1010

/* ── SITEMAP CONSTANTS ── */
const SM_SPINE_Y  = 120;
const SM_L1_Y     = 148;
const SM_L1_PW    = 180;
const SM_L1_PH    = 26;
const SM_L2_STY   = 220;
const SM_L2_ROW_H = 50;
const SM_L2_PW    = 190;
const SM_L2_PH    = 24;
const SM_L1_Y_REF = 148;
const SM_SLOT     = 340; // horizontal spacing between L1 sections

/* ── SVG TARGET (prototype pattern) ── */
let svgTarget = null; // null = root svg; <g> when building L2 connectors

/* ── STATE ── */
let SECTIONS      = [];
let mainStops     = [];
let currentStop   = 0;
let currentL2idx  = -1;
let currentSectionId = null;
let l2Opened      = new Set();
let isSMMode      = false;
let smBuilt       = false;
let smSecIdx      = 0;
let SM_SEC_CXS    = [];
let smL2Open      = new Set();
let companyName   = 'SITE';

// IA camera
let tx = 0, ty = 0, sc = 0.065;
let zoomTarget = { tx: 0, ty: 0, sc: 0.065 };
let zoomRaf = null;
let zoomEase = 0.16;

// SM camera
let smTx = 0, smTy = 0, smSc = 0.3;
let smZoomTarget = { tx: 0, ty: 0, sc: 0.3 };
let smZoomRaf = null;

/* ── DOM REFS ── */
let container, canvas, svg, smCanvas, smSvg;
let START_CX; // global IA canvas start x

/* ═══════════════════════════════════════════
   COORDINATE ASSIGNMENT
═══════════════════════════════════════════ */
function assignCoordinates(proposed) {
  const allSections = [
    ...(proposed.primary_nav || []),
    ...(proposed.utility_nav || []),
  ];

  let curX = 350;
  const SECT_GAP = 200;

  allSections.forEach((sec, si) => {
    const n = sec.l2 ? sec.l2.length : 0;
    const secW = n === 0 ? 200 : n * SLOT - 120;
    sec.cx  = curX + secW / 2;
    sec._secW = secW; // store for dynamic card width

    if (n > 0) {
      sec.l2.forEach((l2, i) => {
        l2.cx = curX + CW / 2 + i * SLOT;
        if (l2.l3 && l2.l3.length) {
          const l3n = l2.l3.length;
          l2.l3.forEach((l3, j) => {
            l3.cx = l2.cx - Math.floor((l3n - 1) / 2) * SLOT + j * SLOT;
          });
        }
      });
    }
    curX += secW + SECT_GAP;
  });

  return { sections: allSections, totalWidth: curX + 200 };
}

/* ═══════════════════════════════════════════
   MAIN BUILD ENTRY POINT
═══════════════════════════════════════════ */
function buildRenderer(iaData) {
  container = document.getElementById('container');
  canvas    = document.getElementById('canvas');
  svg       = document.getElementById('svg');
  smCanvas  = document.getElementById('sm-canvas');
  smSvg     = document.getElementById('sm-svg');

  companyName = iaData.company?.name || 'SITE';

  // Reset state
  smBuilt = false;
  smL2Open = new Set();
  l2Opened = new Set();
  currentStop = 0;
  currentL2idx = -1;
  currentSectionId = null;
  smSecIdx = 0;

  const { sections, totalWidth } = assignCoordinates(iaData.proposed_ia);
  SECTIONS = sections;

  const canvasH = 2200;
  canvas.style.width  = totalWidth + 'px';
  canvas.style.height = canvasH + 'px';
  svg.setAttribute('width',  totalWidth);
  svg.setAttribute('height', canvasH);
  svg.style.cssText = 'position:absolute;top:0;left:0;overflow:visible;pointer-events:none;';

  // IA START position — centered on canvas
  START_CX = totalWidth / 2;

  // Build tour stops (includes data: sec reference like the prototype)
  mainStops = [
    {
      id: 'overview',
      name: 'Overview',
      desc: `${SECTIONS.length} sections · Full proposed architecture`,
      cx: START_CX,
      cy: 600,
      sc: 0.065,
      data: null,
    },
    ...SECTIONS.map(s => ({
      id: s.id || s.name.toLowerCase().replace(/\s+/g, '-'),
      name: s.name,
      desc: s.desc || '',
      cx: s.cx,
      cy: 600,
      sc: sectionScale(s),
      data: s,
    })),
  ];

  buildCanvas(totalWidth, canvasH);
  buildIslandNav();
  setupCamera(totalWidth);
  setupInteraction();
  updateBar(mainStops[0], null);
  updateNavButtons();

  if (iaData.competitors) buildCompetitorsPanel(iaData);
  if (iaData.rationale)   showRationale(iaData.rationale);
}

/* ═══════════════════════════════════════════
   SVG HELPERS (route via svgTarget)
═══════════════════════════════════════════ */
function addLine(x1, y1, x2, y2) {
  const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  l.setAttribute('x1', x1); l.setAttribute('y1', y1);
  l.setAttribute('x2', x2); l.setAttribute('y2', y2);
  l.setAttribute('stroke', '#8B5FD4');
  l.setAttribute('stroke-width', '2');
  l.setAttribute('stroke-linecap', 'round');
  (svgTarget || svg).appendChild(l);
  return l;
}

function addDot(cx, cy) {
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', cx); c.setAttribute('cy', cy);
  c.setAttribute('r', '4'); c.setAttribute('fill', '#8B5FD4');
  (svgTarget || svg).appendChild(c);
}

function svgG(attrs) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  Object.entries(attrs).forEach(([k, v]) => g.setAttribute(k, v));
  return g;
}

/* ── Pill helper (left = cx - w/2, matching prototype) ── */
function pill(label, cls, cx, y, w, h, dataset = {}) {
  const p = document.createElement('div');
  p.className = 'pill ' + cls;
  p.textContent = label;
  p.style.cssText = `left:${cx - w / 2}px;top:${y}px;width:${w}px;`;
  Object.entries(dataset).forEach(([k, v]) => p.dataset[k] = v);
  canvas.appendChild(p);
  return p;
}

/* ── Card helper (cx - w/2) ── */
function card(cx, y, w, desc, info, actions, extraClass) {
  const c = document.createElement('div');
  c.className = 'card ia-el' + (extraClass ? ' ' + extraClass : '');
  c.style.cssText = `left:${cx - w / 2}px;top:${y}px;width:${w}px;`;
  let h = `<div class="card-desc">${desc || ''}</div>`;
  h += `<div class="band band-i">INFORMATION</div>`;
  (info || []).forEach(i => h += `<div class="bullet">– ${i}</div>`);
  h += `<div class="band band-a">ACTIONS</div>`;
  (actions || []).forEach(a => h += `<div class="bullet">→ ${a}</div>`);
  c.innerHTML = h;
  canvas.appendChild(c);
  return c;
}

/* ═══════════════════════════════════════════
   CANVAS DRAWING (exact prototype pattern)
═══════════════════════════════════════════ */
function buildCanvas(totalWidth, canvasH) {
  // Clear and re-append svg
  canvas.innerHTML = '';
  svg.innerHTML = '';
  canvas.appendChild(svg);
  svgTarget = null;

  const allCX = SECTIONS.map(s => s.cx);
  const minCX = Math.min(...allCX);
  const maxCX = Math.max(...allCX);

  // START pill
  const startPill = pill(companyName, 'pill-start', START_CX, START_Y, 200, 38);
  startPill.onclick = () => applyStop(0);

  // Main spine
  addLine(START_CX, START_Y + 38, START_CX, SPINE_Y);
  addLine(minCX, SPINE_Y, maxCX, SPINE_Y);
  addDot(START_CX, SPINE_Y);

  SECTIONS.forEach((sec, si) => {
    const cx = sec.cx;
    const isUtil = sec.utility === true;
    // card width fits within available section slot; min 240, max CW
    const cardW = Math.min(CW, Math.max(240, (sec._secW || CW) + 200 - 40));

    addDot(cx, SPINE_Y);
    addLine(cx, SPINE_Y, cx, L1_Y);

    // L1 pill — dataset.section = sec.id (for highlight queries)
    const cls = isUtil ? 'pill-l1 utility' : 'pill-l1';
    const l1p = pill(sec.name, cls, cx, L1_Y, 200, 34, { section: sec.id });
    l1p.onclick = () => focusSection(sec.id);

    // L1 card — width capped to available slot
    const l1c = card(cx, L1_CARD_Y, cardW, sec.desc, sec.info, sec.actions, 'l1-card');

    if (!sec.l2 || !sec.l2.length) return;

    // CTA button — starts without .visible (hidden via CSS)
    const ctaBtn = document.createElement('div');
    ctaBtn.className = 'show-l2-btn';
    ctaBtn.dataset.l2sec = sec.id;
    ctaBtn.style.cssText = `left:${cx}px;top:670px`;
    ctaBtn.innerHTML = `
      <div class="show-l2-rings">
        <div class="ping-ring"></div><div class="ping-ring"></div><div class="ping-ring"></div>
        <div class="show-l2-dot"></div>
      </div>
      <div class="show-l2-label">Show Level 2 info ↓</div>`;
    ctaBtn.onclick = () => revealL2(sec.id);
    canvas.appendChild(ctaBtn);

    // L2 SVG group — hidden by default (prototype pattern)
    const l2g = svgG({ 'class': 'l2-svg-group', 'data-l2sec': sec.id });
    l2g.style.display = 'none';
    svg.appendChild(l2g);
    svgTarget = l2g; // all subsequent addLine/addDot go into this group

    // L2 spread connectors
    const l2cxs = sec.l2.map(l => l.cx);
    const l2L = Math.min(...l2cxs), l2R = Math.max(...l2cxs);
    addLine(cx, L1_Y + 34, cx, L2_SY);
    addDot(cx, L2_SY);
    if (l2L !== l2R) addLine(l2L, L2_SY, l2R, L2_SY);

    sec.l2.forEach(l2 => {
      addDot(l2.cx, L2_SY);
      addLine(l2.cx, L2_SY, l2.cx, L2_Y);

      // L2 pill — hidden by default, dataset matches prototype's revealL2 query
      const l2cls = isUtil ? 'pill-l2 utility' : 'pill-l2';
      const l2p = pill(l2.name, l2cls, l2.cx, L2_Y, cardW, 30, {
        section: sec.id,
        l2name: l2.name,
        l2cx: String(l2.cx),
        level: 'l2',
      });
      l2p.style.display = 'none'; // hidden until revealL2()
      l2p.onclick = e => { e.stopPropagation(); focusL2(sec.id, sec.l2.indexOf(l2)); };

      // L2 card — hidden by default
      addLine(l2.cx, L2_Y + 30, l2.cx, L2_CARD_Y);
      const l2c = card(l2.cx, L2_CARD_Y, cardW, l2.desc || l2.name, l2.info || [], l2.actions || []);
      l2c.dataset.l2sec = sec.id;
      l2c.dataset.level = 'l2';
      l2c.style.display = 'none'; // hidden until revealL2()

      // L3 pages
      if (l2.l3 && l2.l3.length) {
        const l3cxs = l2.l3.map(p => p.cx);
        const l3L = Math.min(...l3cxs), l3R = Math.max(...l3cxs);
        addLine(l2.cx, L2_CARD_Y + 280, l2.cx, L3_SY);
        addDot(l2.cx, L3_SY);
        if (l3L !== l3R) addLine(l3L, L3_SY, l3R, L3_SY);
        l2.l3.forEach(l3 => {
          addDot(l3.cx, L3_SY);
          addLine(l3.cx, L3_SY, l3.cx, L3_Y);
          const l3p = pill(l3.name, 'pill-l3', l3.cx, L3_Y, CW - 30, 26, {
            l2sec: sec.id,
            level: 'l3',
          });
          l3p.style.display = 'none'; // hidden until revealL2()
        });
      }
    });

    svgTarget = null; // back to root svg
  });
}

/* ═══════════════════════════════════════════
   ISLAND NAV
═══════════════════════════════════════════ */
function buildIslandNav() {
  const nav = document.getElementById('island-nav');
  nav.innerHTML = '';
  nav.style.display = 'flex';
  document.body.classList.add('has-inav');
  SECTIONS.forEach((sec, i) => {
    if (i > 0) {
      const sep = document.createElement('div');
      sep.className = 'inav-sep';
      nav.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.className = 'inav-tab' + (sec.utility ? ' utility' : '');
    btn.dataset.secid = sec.id;
    const label = sec.name.split(' ').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
    let html = label;
    if (sec.l2 && sec.l2.length) html += ` <span class="inav-count">${sec.l2.length}</span>`;
    btn.innerHTML = html;
    btn.onclick = () => focusSection(sec.id);
    nav.appendChild(btn);
  });
  // "All" tab resets to overview
  const sep = document.createElement('div'); sep.className = 'inav-sep'; nav.appendChild(sep);
  const allBtn = document.createElement('button');
  allBtn.className = 'inav-tab'; allBtn.dataset.secid = '__all__';
  allBtn.textContent = 'All';
  allBtn.onclick = () => resetView();
  nav.appendChild(allBtn);
}

function syncIslandNav(secId) {
  document.querySelectorAll('.inav-tab').forEach(btn => {
    const isAll = btn.dataset.secid === '__all__';
    btn.classList.toggle('active', isAll ? !secId : btn.dataset.secid === secId);
  });
}

/* ═══════════════════════════════════════════
   CAMERA
═══════════════════════════════════════════ */
function setupCamera(totalWidth) {
  const vpw = container.clientWidth || 1280;
  const vph = container.clientHeight || 600;
  sc = Math.min(0.065, vpw / totalWidth * 0.9);
  tx = vpw / 2 - START_CX * sc;
  ty = vph / 2 - 600 * sc;
  zoomTarget = { tx, ty, sc };
  applyTransform(false);
}

function applyTransform(animated) {
  if (animated) {
    canvas.style.transition = 'transform .75s cubic-bezier(0.4,0,0.2,1)';
    setTimeout(() => canvas.style.transition = 'none', 800);
  } else {
    canvas.style.transition = 'none';
  }
  canvas.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`;
  const zl = document.getElementById('zoom-label');
  if (zl) zl.textContent = Math.round(sc * 100) + '%';
}

function applyTransformSM() {
  smCanvas.style.transform = `translate(${smTx}px,${smTy}px) scale(${smSc})`;
  const zl = document.getElementById('zoom-label');
  if (zl) zl.textContent = Math.round(smSc * 100) + '%';
}

function smoothZoomStep() {
  const ease = zoomEase;
  const dsc = zoomTarget.sc - sc, dtx = zoomTarget.tx - tx, dty = zoomTarget.ty - ty;
  if (Math.abs(dsc) < 0.0002 && Math.abs(dtx) < 0.15 && Math.abs(dty) < 0.15) {
    sc = zoomTarget.sc; tx = zoomTarget.tx; ty = zoomTarget.ty;
    applyTransform(false); zoomRaf = null; zoomEase = 0.12; return;
  }
  sc += dsc * ease; tx += dtx * ease; ty += dty * ease;
  applyTransform(false);
  zoomRaf = requestAnimationFrame(smoothZoomStep);
}

function smoothSmStep() {
  const ease = 0.18;
  const dsc = smZoomTarget.sc - smSc, dtx = smZoomTarget.tx - smTx, dty = smZoomTarget.ty - smTy;
  if (Math.abs(dsc) < 0.0005 && Math.abs(dtx) < 0.3 && Math.abs(dty) < 0.3) {
    smSc = smZoomTarget.sc; smTx = smZoomTarget.tx; smTy = smZoomTarget.ty;
    applyTransformSM(); smZoomRaf = null; return;
  }
  smSc += dsc * ease; smTx += dtx * ease; smTy += dty * ease;
  applyTransformSM();
  smZoomRaf = requestAnimationFrame(smoothSmStep);
}

function flyTo(cx, cy, targetSc, animate = true) {
  const vpw = container.clientWidth || 1280, vph = container.clientHeight || 600;
  const destTx = vpw / 2 - cx * targetSc;
  const destTy = vph / 2 - cy * targetSc;
  if (zoomRaf) { cancelAnimationFrame(zoomRaf); zoomRaf = null; }
  zoomTarget = { sc: targetSc, tx: destTx, ty: destTy };
  zoomEase = animate ? 0.2 : 1;
  zoomRaf = requestAnimationFrame(smoothZoomStep);
}

function smFlyTo(cx, cy, targetSc) {
  const vpw = container.clientWidth || 1280, vph = container.clientHeight || 600;
  smZoomTarget.tx = vpw / 2 - cx * targetSc;
  smZoomTarget.ty = vph / 2 - cy * targetSc;
  smZoomTarget.sc = targetSc;
  if (smZoomRaf) { cancelAnimationFrame(smZoomRaf); smZoomRaf = null; }
  smZoomRaf = requestAnimationFrame(smoothSmStep);
}

/* ── Scale functions (exact prototype) ── */
function sectionScale(sec) {
  if (!sec.l2 || !sec.l2.length) return 0.75;
  const l2cxs = sec.l2.map(l => l.cx);
  const span = (Math.max(...l2cxs) - Math.min(...l2cxs)) + CW + 100;
  return Math.min(0.65, Math.max(0.18, ((container.clientWidth || 1280) * 0.85) / span));
}

function l1FocusScale() {
  const contentH = 480, contentW = CW + 80;
  const sh = (container.clientHeight || 600) * 0.82 / contentH;
  const sw = (container.clientWidth || 1280) * 0.78 / contentW;
  return Math.min(sh, sw, 1.5);
}

function l2FocusScale() {
  const h = container.clientHeight || 600;
  const w = container.clientWidth || 1280;
  const contentH = L2_CARD_Y - L2_Y + 180; // ~254px
  const contentW = CW + 40;                 // ~480px
  const sh = h * 0.92 / contentH;
  const sw = w * 0.80 / contentW;
  return Math.min(Math.max(sh, sw), 1.8);
}

/* ── Zoom controls ── */
function zoomIn()  { adjustZoom(1.25); }
function zoomOut() { adjustZoom(0.8); }
function adjustZoom(factor) {
  const vpw = container.clientWidth || 1280, vph = container.clientHeight || 600;
  const newSc = Math.min(3, Math.max(0.03, sc * factor));
  zoomTarget.tx = vpw / 2 - (vpw / 2 - tx) * newSc / sc;
  zoomTarget.ty = vph / 2 - (vph / 2 - ty) * newSc / sc;
  zoomTarget.sc = newSc;
  if (zoomRaf) cancelAnimationFrame(zoomRaf);
  zoomRaf = requestAnimationFrame(smoothZoomStep);
}

function resetView() {
  if (isSMMode) {
    const vpw = container.clientWidth || 1280, vph = container.clientHeight || 600;
    smSc = Math.min(vpw / (SECTIONS.length * SM_SLOT + 400), vph / 480) * 0.86;
    const midCx = SM_SEC_CXS[Math.floor(SM_SEC_CXS.length / 2)] || 0;
    smTx = vpw / 2 - midCx * smSc;
    smTy = vph / 2 - 280 * smSc;
    applyTransformSM();
    syncIslandNav(null);
    return;
  }
  hideAllL2(); hideAllCtas(); syncIslandNav(null);
  flyTo(START_CX, 700, 0.065);
}

/* ═══════════════════════════════════════════
   INTERACTION (pan + wheel zoom)
═══════════════════════════════════════════ */
function setupInteraction() {
  let isPanning = false, panSX, panSY, panTX, panTY;

  container.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.pill,.show-l2-btn,.sm-l2-toggle,.inav-tab,.nav-pill,.tb-nav-text')) return;
    isPanning = true;
    panSX = e.clientX; panSY = e.clientY;
    panTX = isSMMode ? smTx : tx;
    panTY = isSMMode ? smTy : ty;
    container.classList.add('panning');
    if (isSMMode && smZoomRaf) { cancelAnimationFrame(smZoomRaf); smZoomRaf = null; }
    (isSMMode ? smCanvas : canvas).style.transition = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!isPanning) return;
    const ntx = panTX + (e.clientX - panSX);
    const nty = panTY + (e.clientY - panSY);
    if (isSMMode) { smTx = ntx; smTy = nty; applyTransformSM(); }
    else { tx = ntx; ty = nty; zoomTarget.tx = tx; zoomTarget.ty = ty; applyTransform(false); }
  });

  document.addEventListener('mouseup', () => {
    if (isPanning) { isPanning = false; container.classList.remove('panning'); }
  });

  container.addEventListener('wheel', e => {
    e.preventDefault();
    if (isSMMode) {
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newSc = Math.max(0.05, Math.min(4, smSc * f));
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      smTx = mx - (mx - smTx) * newSc / smSc;
      smTy = my - (my - smTy) * newSc / smSc;
      smSc = newSc; applyTransformSM(); return;
    }
    const f = e.deltaY < 0 ? 1.06 : 1 / 1.06;
    const newSc = Math.max(0.04, Math.min(3, zoomTarget.sc * f));
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    zoomTarget.tx = mx - (mx - zoomTarget.tx) * newSc / zoomTarget.sc;
    zoomTarget.ty = my - (my - zoomTarget.ty) * newSc / zoomTarget.sc;
    zoomTarget.sc = newSc;
    if (!zoomRaf) zoomRaf = requestAnimationFrame(smoothZoomStep);
  }, { passive: false });

  document.addEventListener('keydown', e => {
    if (!document.getElementById('state-result').classList.contains('active')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextStop();
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   prevStop();
    if (e.key === 'r' || e.key === 'R') resetView();
    if (e.key === 'm' || e.key === 'M') setMode(isSMMode ? 'ia' : 'sitemap');
    if (e.key === 'Escape') clearHighlight();
  });
}

/* ═══════════════════════════════════════════
   L2 SHOW / HIDE (prototype pattern)
═══════════════════════════════════════════ */
function hideAllCtas() {
  document.querySelectorAll('.show-l2-btn').forEach(b => b.classList.remove('visible'));
}

function hideAllL2() {
  document.querySelectorAll('.l2-svg-group').forEach(g => g.style.display = 'none');
  document.querySelectorAll('.pill[data-level="l2"]').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.pill[data-level="l3"]').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.card[data-level="l2"]').forEach(c => c.style.display = 'none');
  l2Opened.clear();
}

function revealL2(secId) {
  const sec = SECTIONS.find(s => s.id === secId);
  if (!sec) return;
  l2Opened.add(secId);
  // Show SVG group
  const g = svg.querySelector(`.l2-svg-group[data-l2sec="${secId}"]`);
  if (g) g.style.display = '';
  // Show L2 pills
  document.querySelectorAll(`.pill[data-section="${secId}"][data-level="l2"]`).forEach(p => p.style.display = '');
  // Show L3 pills
  document.querySelectorAll(`.pill[data-l2sec="${secId}"][data-level="l3"]`).forEach(p => p.style.display = '');
  // Show L2 cards
  document.querySelectorAll(`.card[data-l2sec="${secId}"]`).forEach(c => c.style.display = '');
  // Hide CTA
  const btn = canvas.querySelector(`.show-l2-btn[data-l2sec="${secId}"]`);
  if (btn) btn.classList.remove('visible');
  // Zoom to full section
  flyTo(sec.cx, 1000, sectionScale(sec));
}

/* ═══════════════════════════════════════════
   HIGHLIGHT
═══════════════════════════════════════════ */
function clearHighlight() {
  document.querySelectorAll('.pill').forEach(p => p.classList.remove('highlight', 'dimmed'));
  document.querySelectorAll('.card').forEach(c => c.classList.remove('dimmed'));
}

function highlightSection(secId) {
  clearHighlight();
  const sec = SECTIONS.find(s => s.id === secId);
  if (!sec) return;
  document.querySelectorAll('.pill').forEach(p => {
    const matches = p.dataset.section === secId || p.textContent.trim() === companyName;
    p.classList.toggle('highlight', matches);
    p.classList.toggle('dimmed', !matches && !!p.dataset.section && p.dataset.section !== secId);
  });
}

function highlightL2(secId, l2idx) {
  clearHighlight();
  const sec = SECTIONS.find(s => s.id === secId);
  if (!sec || !sec.l2[l2idx]) return;
  const l2 = sec.l2[l2idx];
  document.querySelectorAll('.pill').forEach(p => {
    const isTarget = p.dataset.section === secId && p.dataset.l2cx == l2.cx;
    const isParent = p.textContent.trim() === sec.name || p.textContent.trim() === companyName;
    p.classList.toggle('highlight', isTarget || isParent);
    p.classList.toggle('dimmed', !isTarget && !isParent && !!p.dataset.section);
  });
}

/* ═══════════════════════════════════════════
   TOUR / STOPS (faithful prototype port)
═══════════════════════════════════════════ */
function applyStop(idx, l2idx = -1) {
  const stop = mainStops[idx];
  if (!stop) return;
  currentStop = idx;
  currentL2idx = l2idx;

  if (l2idx === -1) {
    // L1 stop
    currentSectionId = stop.id;
    const sec = stop.data;
    hideAllL2();
    hideAllCtas();
    if (sec && sec.l2 && sec.l2.length) {
      const btn = canvas.querySelector(`.show-l2-btn[data-l2sec="${stop.id}"]`);
      if (btn) btn.classList.add('visible');
      flyTo(stop.cx, L1_FOCUS_CY, l1FocusScale());
    } else {
      flyTo(stop.cx, L1_FOCUS_CY, l1FocusScale());
    }
    updateBar(stop, null);
    if (sec) { highlightSection(stop.id); syncIslandNav(stop.id); }
    else { clearHighlight(); syncIslandNav(null); }
  } else {
    // L2 stop
    const sec = stop.data;
    if (!sec || !sec.l2[l2idx]) return;
    const l2 = sec.l2[l2idx];
    // Ensure L2 is revealed first
    if (!l2Opened.has(stop.id)) revealL2(stop.id);
    flyTo(l2.cx, L2_FOCUS_CY, l2FocusScale());
    updateBar(stop, l2);
    highlightL2(stop.id, l2idx);
  }
  updateNavButtons();
}

function nextStop() {
  if (isSMMode) {
    if (smSecIdx < SECTIONS.length - 1) { smSecIdx++; focusSection(SECTIONS[smSecIdx].id); }
    updateSmNavBtns(); return;
  }
  const stop = mainStops[currentStop];
  const sec = stop ? stop.data : null;
  if (currentL2idx > -1) {
    const next = currentL2idx + 1;
    if (next < sec.l2.length) { applyStop(currentStop, next); return; }
    if (currentStop < mainStops.length - 1) { currentStop++; applyStop(currentStop); }
    return;
  }
  if (sec && sec.l2 && sec.l2.length && l2Opened.has(sec.id)) { applyStop(currentStop, 0); return; }
  if (currentStop < mainStops.length - 1) { currentStop++; applyStop(currentStop); }
}

function prevStop() {
  if (isSMMode) {
    if (smSecIdx > 0) { smSecIdx--; focusSection(SECTIONS[smSecIdx].id); }
    updateSmNavBtns(); return;
  }
  if (currentL2idx > -1) {
    if (currentL2idx > 0) { applyStop(currentStop, currentL2idx - 1); return; }
    applyStop(currentStop, -1); return;
  }
  if (currentStop > 0) { currentStop--; applyStop(currentStop); }
}

function focusSection(secId) {
  if (isSMMode) {
    const idx = SECTIONS.findIndex(s => s.id === secId);
    if (idx < 0) return;
    const cx = SM_SEC_CXS[idx];
    const sec = SECTIONS[idx];
    const vpw = container.clientWidth || 1280, vph = container.clientHeight || 600;
    const l2Vis = smL2Open.has(sec.id) && sec.l2 && sec.l2.length > 0;
    const contentH = l2Vis ? (SM_L2_STY + sec.l2.length * SM_L2_ROW_H + 60) : (SM_L1_Y_REF + 56);
    const targetSc = Math.min(vpw * 0.62 / 300, vph * 0.72 / contentH, 1.3);
    const focusCy = l2Vis ? (SM_L1_Y_REF + (SM_L2_STY + sec.l2.length * SM_L2_ROW_H) / 2) : SM_L1_Y_REF + 13;
    smSecIdx = idx;
    syncIslandNav(secId);
    smFlyTo(cx, focusCy, targetSc);
    updateSmNavBtns();
    const stopIdx = mainStops.findIndex(s => s.id === secId);
    if (stopIdx > -1) updateBar(mainStops[stopIdx], null);
    return;
  }
  const idx = mainStops.findIndex(s => s.id === secId);
  if (idx > -1) { currentStop = idx; applyStop(idx); }
}

function focusL2(secId, l2idx) {
  const idx = mainStops.findIndex(s => s.id === secId);
  if (idx > -1) { currentStop = idx; applyStop(idx, l2idx); }
}

function goBackToL1() {
  if (currentL2idx > -1 && currentStop > 0) applyStop(currentStop, -1);
}

function updateNavButtons() {
  const prev = document.getElementById('btn-prev');
  const next = document.getElementById('btn-next');
  if (prev) prev.disabled = currentStop <= 0 && currentL2idx < 0;
  if (next) next.disabled = currentStop >= mainStops.length - 1 && currentL2idx < 0;
}

function updateSmNavBtns() {
  const prev = document.getElementById('btn-prev');
  const next = document.getElementById('btn-next');
  if (prev) prev.disabled = smSecIdx <= 0;
  if (next) next.disabled = smSecIdx >= SECTIONS.length - 1;
}

/* ── Tour bar ── */
function updateBar(stop, l2) {
  const nameEl    = document.getElementById('tour-name');
  const descEl    = document.getElementById('tour-desc');
  const counterEl = document.getElementById('tour-counter');
  const chipsEl   = document.getElementById('tour-chips');
  const bcEl      = document.getElementById('bc-l1');
  if (!stop) return;

  if (l2) {
    bcEl.textContent = '← ' + stop.name;
    bcEl.classList.add('visible');
    if (nameEl) nameEl.textContent = l2.name;
    if (descEl) descEl.textContent = (l2.info && l2.info[0]) ? l2.info[0] : '';
    const chips = (l2.l3 || []).map(l3 => `<span class="tour-chip">${l3.name}</span>`).join('');
    if (chipsEl) chipsEl.innerHTML = chips;
  } else {
    bcEl.classList.remove('visible');
    bcEl.textContent = '';
    if (nameEl) nameEl.textContent = stop.name;
    if (descEl) descEl.textContent = stop.desc || '';
    const data = stop.data;
    if (!isSMMode && data && data.l2 && data.l2.length && l2Opened.has(data.id)) {
      const chips = data.l2.map((l2item, i) =>
        `<span class="tour-chip" onclick="focusL2('${data.id}',${i})">${l2item.name}</span>`
      ).join('');
      if (chipsEl) chipsEl.innerHTML = chips;
    } else {
      if (chipsEl) chipsEl.innerHTML = '';
    }
  }

  const total = mainStops.length - 1;
  if (counterEl) counterEl.textContent = currentStop === 0 ? `${total} sections` : `${currentStop} / ${total}`;
}

/* ═══════════════════════════════════════════
   MODE SWITCHING
═══════════════════════════════════════════ */
function setMode(m) {
  const fromSecId = isSMMode ? (SECTIONS[smSecIdx]?.id || null) : currentSectionId;

  isSMMode = (m === 'sitemap');
  document.body.classList.toggle('sitemap', isSMMode);
  document.getElementById('btn-ia').classList.toggle('active', m === 'ia');
  document.getElementById('btn-sm').classList.toggle('active', m === 'sitemap');
  canvas.style.display   = isSMMode ? 'none' : 'block';
  smCanvas.style.display = isSMMode ? 'block' : 'none';

  if (isSMMode) {
    clearHighlight();
    document.getElementById('bc-l1').classList.remove('visible');
    if (document.getElementById('tour-chips')) document.getElementById('tour-chips').innerHTML = '';
    if (!smBuilt) { buildSitemapCanvas(); smBuilt = true; }
    const vpw = container.clientWidth || 1280, vph = container.clientHeight || 600;
    const midCx = SM_SEC_CXS[Math.floor(SM_SEC_CXS.length / 2)] || 0;
    smSc = Math.min(vpw / (SECTIONS.length * SM_SLOT + 400), vph / 480) * 0.88;
    smTx = vpw / 2 - midCx * smSc;
    smTy = vph / 2 - 280 * smSc;
    applyTransformSM();
    smSecIdx = 0; updateSmNavBtns(); syncIslandNav(null);
    updateBar(mainStops[0], null);
    if (fromSecId) {
      const idx = SECTIONS.findIndex(s => s.id === fromSecId);
      if (idx >= 0) { smSecIdx = idx; focusSection(fromSecId); }
    }
  } else {
    if (fromSecId) {
      const idx = mainStops.findIndex(s => s.id === fromSecId);
      if (idx > -1) { currentStop = idx; applyStop(idx, -1); }
      else resetView();
    } else {
      resetView();
    }
  }
}

/* ═══════════════════════════════════════════
   SITEMAP CANVAS (exact prototype pattern)
═══════════════════════════════════════════ */
function buildSitemapCanvas() {
  smCanvas.innerHTML = '';
  smSvg.innerHTML = '';
  smCanvas.appendChild(smSvg);

  // Compute section x positions (340px apart, starting at 200)
  SM_SEC_CXS = SECTIONS.map((_, i) => 200 + i * SM_SLOT);

  const SM_SCX = SM_SEC_CXS[Math.floor(SECTIONS.length / 2)] || 200; // start pill cx
  const SM_STY = 46; // start pill top y

  const totalW = SECTIONS.length * SM_SLOT + 400;
  const totalH = SM_L2_STY + Math.max(...SECTIONS.map(s => (s.l2 ? s.l2.length : 0))) * SM_L2_ROW_H + 120;
  smCanvas.style.width  = totalW + 'px';
  smCanvas.style.height = Math.max(totalH, 600) + 'px';
  smSvg.setAttribute('width',  totalW);
  smSvg.setAttribute('height', Math.max(totalH, 600));

  function smPill(label, cls, cx, y, w, h, opts = {}) {
    const p = document.createElement('div');
    p.className = 'pill ' + cls;
    p.textContent = label;
    p.style.cssText = `left:${cx - w / 2}px;top:${y}px;width:${w}px;height:${h}px;font-size:10px;border-radius:6px;`;
    if (opts.hidden) p.style.display = 'none';
    if (opts.cursor) p.style.cursor = opts.cursor;
    if (opts.bg) p.style.background = opts.bg;
    if (opts.color) p.style.color = opts.color;
    if (opts.dataset) Object.entries(opts.dataset).forEach(([k, v]) => p.dataset[k] = v);
    if (opts.onclick) p.onclick = opts.onclick;
    smCanvas.appendChild(p);
    return p;
  }

  function smLine(x1, y1, x2, y2, g) {
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1);
    l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('stroke', '#8B5FD4');
    l.setAttribute('stroke-width', '1.5');
    l.setAttribute('stroke-linecap', 'round');
    (g || smSvg).appendChild(l);
  }

  function smDot(cx, cy, g) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy);
    c.setAttribute('r', '3'); c.setAttribute('fill', '#8B5FD4');
    (g || smSvg).appendChild(c);
  }

  // START pill
  const sp = smPill(companyName, 'pill-start', SM_SCX, SM_STY, 160, 30,
    { cursor: 'pointer' });
  sp.style.fontSize = '11px';
  smLine(SM_SCX, SM_STY + 30, SM_SCX, SM_SPINE_Y);

  // Main spine
  smLine(SM_SEC_CXS[0], SM_SPINE_Y, SM_SEC_CXS[SM_SEC_CXS.length - 1], SM_SPINE_Y);
  smDot(SM_SCX, SM_SPINE_Y);

  SECTIONS.forEach((sec, idx) => {
    const cx = SM_SEC_CXS[idx];
    const isUtil = sec.utility === true;

    smDot(cx, SM_SPINE_Y);
    smLine(cx, SM_SPINE_Y, cx, SM_L1_Y);

    const l1cls = isUtil ? 'pill-l1 utility' : 'pill-l1';
    const l1p = smPill(sec.name, l1cls, cx, SM_L1_Y, SM_L1_PW, SM_L1_PH, {
      cursor: 'pointer',
    });
    l1p.onclick = () => { smSecIdx = idx; syncIslandNav(sec.id); updateBar(mainStops[idx + 1], null); smFlyTo(cx, SM_L1_Y_REF + 20, 1.0); };

    if (!sec.l2 || !sec.l2.length) return;

    // Toggle button
    const toggleBtn = document.createElement('div');
    toggleBtn.className = 'sm-l2-toggle' + (isUtil ? ' utility' : '');
    toggleBtn.dataset.smsec = sec.id;
    toggleBtn.textContent = '+ Show pages';
    toggleBtn.style.cssText = `left:${cx}px;top:${SM_L1_Y + SM_L1_PH + 8}px;transform:translateX(-50%);`;
    toggleBtn.onclick = e => { e.stopPropagation(); toggleSmL2(sec.id); };
    smCanvas.appendChild(toggleBtn);

    // SVG group for L2 connectors — hidden by default
    const l2g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    l2g.setAttribute('class', 'sm-l2g');
    l2g.setAttribute('data-smsec', sec.id);
    l2g.style.display = 'none';
    smSvg.appendChild(l2g);

    const n = sec.l2.length;
    const branchX = cx - SM_L2_PW / 2 - 18;
    const firstCY = SM_L2_STY + SM_L2_PH / 2;
    const lastCY  = SM_L2_STY + (n - 1) * SM_L2_ROW_H + SM_L2_PH / 2;

    smLine(cx, SM_L1_Y + SM_L1_PH, cx, firstCY, l2g);
    smLine(cx, firstCY, branchX, firstCY, l2g);
    if (n > 1) smLine(branchX, firstCY, branchX, lastCY, l2g);

    sec.l2.forEach((l2, i) => {
      const l2Y  = SM_L2_STY + i * SM_L2_ROW_H;
      const l2CY = l2Y + SM_L2_PH / 2;
      smDot(branchX, l2CY, l2g);
      smLine(branchX, l2CY, cx - SM_L2_PW / 2, l2CY, l2g);

      const l2cls = isUtil ? 'pill-l2 utility' : 'pill-l2';
      smPill(l2.name, l2cls, cx, l2Y, SM_L2_PW, SM_L2_PH, {
        hidden: true,
        cursor: 'pointer',
        dataset: { smsec: sec.id, sml2idx: String(i) },
        onclick: e => { e.stopPropagation(); smL2Click(sec.id, i); },
      });
    });
  });
}

function toggleSmL2(secId) {
  const sec = SECTIONS.find(s => s.id === secId);
  if (!sec || !sec.l2 || !sec.l2.length) return;
  const isOpen = smL2Open.has(secId);
  if (isOpen) { smL2Open.delete(secId); } else { smL2Open.add(secId); }
  const nowOpen = !isOpen;

  smCanvas.querySelectorAll(`.pill[data-smsec="${secId}"]`).forEach(p => {
    p.style.display = nowOpen ? '' : 'none';
  });
  const g = smSvg.querySelector(`.sm-l2g[data-smsec="${secId}"]`);
  if (g) g.style.display = nowOpen ? '' : 'none';
  const btn = smCanvas.querySelector(`.sm-l2-toggle[data-smsec="${secId}"]`);
  if (btn) {
    btn.classList.toggle('open', nowOpen);
    btn.textContent = nowOpen ? '− Hide pages' : '+ Show pages';
  }
  if (nowOpen) {
    const idx = SECTIONS.findIndex(s => s.id === secId);
    if (idx >= 0) focusSection(secId);
  }
}

function smL2Click(secId, l2idx) {
  setMode('ia');
  revealL2(secId);
  const stopIdx = mainStops.findIndex(s => s.id === secId);
  if (stopIdx > -1) { currentStop = stopIdx; applyStop(stopIdx, l2idx); }
  showToast('Switched to IA view');
  showBackToSm();
}

function showToast(msg) {
  const t = document.getElementById('ia-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

function showBackToSm() {
  const btn = document.getElementById('back-to-sm');
  if (!btn) return;
  btn.style.display = 'block';
  requestAnimationFrame(() => btn.classList.add('visible'));
}

function hideBackToSm() {
  const btn = document.getElementById('back-to-sm');
  if (!btn) return;
  btn.classList.remove('visible');
  setTimeout(() => { if (btn && !btn.classList.contains('visible')) btn.style.display = 'none'; }, 300);
}

function backToSitemap() {
  hideBackToSm();
  setMode('sitemap');
}


/* ═══════════════════════════════════════════
   COMPETITORS PANEL
═══════════════════════════════════════════ */
function buildCompetitorsPanel(iaData) {
  const rationaleEl = document.getElementById('csp-rationale');
  if (rationaleEl && iaData.rationale) rationaleEl.textContent = iaData.rationale;

  // Update panel header title
  const hdr = document.querySelector('.csp-header h3');
  if (hdr) hdr.textContent = 'Analysis';

  const cards = document.getElementById('csp-cards');
  if (!cards) return;

  const comps = iaData.competitors || [];
  const changes = iaData.ia_changes || [];
  const company = iaData.company?.name || 'Site';

  // Status pill helper
  function statusPill(action) {
    const map = {
      added:    ['added',    '+ Added new'],
      elevated: ['elevated', '↑ Elevated'],
      moved:    ['moved',    '→ Moved'],
      renamed:  ['renamed',  '✎ Renamed'],
      kept:     ['kept',     '· Kept'],
      reorganised: ['elevated', '⟳ Reorganised'],
    };
    const [cls, txt] = map[action] || ['kept', action];
    return `<span class="csp-status ${cls}">${txt}</span>`;
  }

  // Adopted pill helper
  function adoptedPill(val) {
    if (val === 'yes')     return `<span class="csp-status yes">✓ Adopted</span>`;
    if (val === 'partial') return `<span class="csp-status partial">~ Partial</span>`;
    return `<span class="csp-status no">✗ Not adopted</span>`;
  }

  // Build tab bar: Changes first, then one tab per competitor
  const tabBar = `<div class="csp-tab-bar">
    <button class="csp-tab active" data-tab="changes">Changes</button>
    ${comps.map(c => `<button class="csp-tab" data-tab="${c.name}">${c.name}</button>`).join('')}
  </div>`;

  // Changes panel
  let changesRows = '';
  if (changes.length) {
    changes.forEach(row => {
      changesRows += `<tr>
        <td style="font-weight:700;color:#111;">${row.item}</td>
        <td>${row.existed === 'Yes' ? '<span style="color:#1a7a3a;font-weight:700;">Yes</span>' : row.existed === 'No' ? '<span style="color:#c0392b;font-weight:700;">No</span>' : `<span style="color:#a06000;font-weight:700;">${row.existed}</span>`}</td>
        <td>${statusPill(row.action)}</td>
        <td style="color:#666;">${row.notes}</td>
      </tr>`;
    });
  }
  const changesPanel = `<div class="csp-panel active" data-panel="changes">
    <div class="csp-section-label">What existed in ${company} · What changed</div>
    <table class="csp-table">
      <thead><tr>
        <th style="width:28%">Nav item</th>
        <th style="width:10%">Existed?</th>
        <th style="width:16%">Action</th>
        <th>Notes</th>
      </tr></thead>
      <tbody>${changesRows}</tbody>
    </table>
  </div>`;

  // Competitor panels
  let compPanels = '';
  comps.forEach(c => {
    const type = (c.type || 'global').toLowerCase();
    const findings = c.findings || [];
    let rows = '';
    findings.forEach(f => {
      rows += `<tr>
        <td style="font-weight:600;color:#111;">${f.pattern}</td>
        <td>${adoptedPill(f.adopted)}</td>
        <td style="color:#666;">${f.reason}</td>
      </tr>`;
    });
    compPanels += `<div class="csp-panel" data-panel="${c.name}">
      <div class="csp-comp-header">
        <span class="csp-comp-name">${c.name}</span>
        <span class="csp-badge ${type}">${type.toUpperCase()}</span>
        <span class="csp-domain">${c.domain}</span>
      </div>
      ${c.ia_structure ? `<div class="csp-section-label">Their IA structure</div>
      <div style="font-size:12px;color:#555;line-height:1.6;padding-bottom:12px;border-bottom:1px solid #f0f0f0;">${c.ia_structure}</div>` : ''}
      <div class="csp-section-label">What we picked (and didn't)</div>
      <table class="csp-table">
        <thead><tr>
          <th style="width:38%">Pattern observed</th>
          <th style="width:18%">Adopted?</th>
          <th>Reason</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  });

  cards.innerHTML = tabBar + changesPanel + compPanels;

  // Tab switching
  cards.querySelectorAll('.csp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      cards.querySelectorAll('.csp-tab').forEach(t => t.classList.remove('active'));
      cards.querySelectorAll('.csp-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const key = btn.dataset.tab;
      const panel = cards.querySelector(`.csp-panel[data-panel="${key}"]`);
      if (panel) panel.classList.add('active');
    });
  });

  // Fallback legacy path (no findings/ia_changes) — original card layout
  if (!changes.length && !comps.some(c => c.findings)) {
    cards.innerHTML = '';
    iaData.competitors.forEach(c => {
    const type = (c.type || 'global').toLowerCase();
    const badge = type === 'manual' ? 'manual' : type === 'local' ? 'local' : 'global';
    const check = '✓', cross = '–';
    cards.innerHTML += `
      <div class="csp-card">
        <div class="csp-card-top">
          <div>
            <div class="csp-company">${c.name}</div>
            <div class="csp-domain">${c.domain}</div>
          </div>
          <span class="csp-badge ${badge}">${type.toUpperCase()}</span>
        </div>
        <div class="csp-divider"></div>
        <div class="csp-facts">
          <div class="csp-fact"><span>Primary nav</span><span class="csp-fact-val">${c.primary_nav_count || '—'} items</span></div>
          <div class="csp-fact"><span>Newsroom</span><span class="${c.has_newsroom ? 'csp-fact-check' : 'csp-fact-cross'}">${c.has_newsroom ? check : cross}</span></div>
          <div class="csp-fact"><span>Investors</span><span class="${c.has_investors ? 'csp-fact-check' : 'csp-fact-cross'}">${c.has_investors ? check : cross}</span></div>
          <div class="csp-fact"><span>Sustainability</span><span class="${c.has_sustainability ? 'csp-fact-check' : 'csp-fact-cross'}">${c.has_sustainability ? check : cross}</span></div>
          <div class="csp-fact"><span>Careers</span><span class="${c.has_careers ? 'csp-fact-check' : 'csp-fact-cross'}">${c.has_careers ? check : cross}</span></div>
          <div class="csp-fact"><span>Portfolio org</span><span class="csp-fact-val">${c.portfolio_organization || '—'}</span></div>
        </div>
        ${c.notable_pattern ? `<div class="csp-notable">"${c.notable_pattern}"</div>` : ''}
      </div>`;
    });
  } // end legacy fallback
}

function toggleCompPanel() {
  const panel = document.getElementById('comp-side-panel');
  const btn   = document.getElementById('comp-panel-btn');
  if (panel) panel.classList.toggle('open');
  if (btn) btn.classList.toggle('open');
}

function showRationale(text) {
  const bar   = document.getElementById('rationale-bar');
  const textEl = document.getElementById('rationale-text');
  if (!bar || !textEl) return;
  textEl.textContent = text;
  bar.classList.add('show');
  setTimeout(() => bar.classList.remove('show'), 6000);
}
