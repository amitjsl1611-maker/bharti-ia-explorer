/* ══════════════════════════════════════════════
   renderer.js — IA Map canvas renderer
   Accepts the AI-generated JSON and draws the
   full interactive IA + Sitemap explorer.
══════════════════════════════════════════════ */

'use strict';

/* ── COORDINATE CONSTANTS (match prototype) ── */
const CW        = 440;   // Card width
const SLOT      = 560;   // Horizontal slot per L2
const L1_Y      = 310;   // L1 pill top Y
const L1_CARD_Y = 390;   // L1 card top Y
const L2_SY     = 830;   // L2 horizontal spine Y
const L2_Y      = 870;   // L2 pill top Y
const L2_CARD_Y = 944;   // L2 card top Y
const L3_SY     = 1344;  // L3 horizontal spine Y
const L3_Y      = 1384;  // L3 pill top Y
const L3_CARD_Y = 1458;  // L3 card top Y
const SPINE_Y   = 258;   // Main spine Y
const START_Y   = 145;   // START pill top Y

/* ── COLOR SYSTEM ── */
const COL = {
  start:      '#F5B840',
  l1Primary:  '#3D6B35',
  l1Utility:  '#1A3A5C',
  l2Primary:  '#1A4040',
  l2Utility:  '#1A3050',
  l3:         '#333333',
  connector:  '#8B5FD4',
  infoBg:     '#E6F4F4', infoText:   '#1A4040',
  actionBg:   '#FFF8E8', actionText: '#7A5500',
  cardBg:     '#ffffff', cardBorder: '#e0e0e0',
  textWhite:  '#ffffff', textDark:   '#1A1A1A',
};

/* ── STATE ── */
let SECTIONS = [];        // flat array of all sections after assignCoordinates
let mainStops = [];       // tour stops
let currentStop = 0;
let currentL2idx = -1;
let currentSectionId = null;
let l2Opened = new Set();
let highlighted = new Set();
let isSMMode = false;

// IA camera
let tx = 0, ty = 0, sc = 0.065;
let zoomTarget = { tx: 0, ty: 0, sc: 0.065 };
let zoomRaf = null;

// SM camera
let smTx = 0, smTy = 0, smSc = 0.3;
let smZoomTarget = { tx: 0, ty: 0, sc: 0.3 };
let smZoomRaf = null;
let smSecIdx = 0;
let smBuilt = false;

// SM layout constants
const SM_L1_Y_REF = 220;
let SM_SEC_CXS = [];

/* ── DOM REFS ── */
let container, canvas, svg, smCanvas, smSvg;

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

  allSections.forEach(sec => {
    const n = sec.l2 ? sec.l2.length : 0;
    const secW = n === 0 ? 200 : n * SLOT - 120;
    sec.cx = curX + secW / 2;

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

  const totalWidth = curX + 200;
  return { sections: allSections, totalWidth };
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

  // Assign coordinates
  const { sections, totalWidth } = assignCoordinates(iaData.proposed_ia);
  SECTIONS = sections;

  // Canvas size
  const canvasH = 2000;
  canvas.style.width  = totalWidth + 'px';
  canvas.style.height = canvasH + 'px';
  svg.setAttribute('width',  totalWidth);
  svg.setAttribute('height', canvasH);

  // Build tour stops
  const START_CX = totalWidth / 2;
  mainStops = [
    { id: 'overview', name: 'Overview', desc: `${SECTIONS.length} sections · Full architecture`, cx: START_CX, cy: 600, sc: 0.065, l2: [] },
    ...SECTIONS.map(s => ({
      id: s.id || s.name.toLowerCase().replace(/\s+/g, '-'),
      name: s.name,
      desc: s.desc || '',
      cx: s.cx,
      cy: L1_CARD_Y + 200,
      sc: sectionScale(s),
      l2: s.l2 || [],
    })),
  ];

  // Draw
  drawCanvas(totalWidth, canvasH, START_CX);
  buildIslandNav();
  setupCamera(totalWidth, START_CX);
  setupInteraction();
  updateBar(mainStops[0], -1);
  updateNavButtons();

  // Build competitors panel
  if (iaData.competitors) buildCompetitorsPanel(iaData);
  if (iaData.rationale)   showRationale(iaData.rationale);
}

/* ═══════════════════════════════════════════
   CANVAS DRAWING
═══════════════════════════════════════════ */
function drawCanvas(totalWidth, canvasH, START_CX) {
  canvas.innerHTML = '';
  svg.innerHTML = '';
  // Re-append svg
  canvas.appendChild(svg);

  const allL1CXs = SECTIONS.map(s => s.cx);
  const minCX = Math.min(...allL1CXs);
  const maxCX = Math.max(...allL1CXs);

  // ── START pill ──
  addPill(canvas, {
    x: START_CX - 100, y: START_Y, w: 200, h: 38, r: 6,
    bg: COL.start, color: COL.textDark,
    text: 'START', fontSize: 12,
    onclick: () => applyStop(0),
  });

  // ── Main spine ──
  addSvgLine(svg, START_CX, START_Y + 38, START_CX, SPINE_Y);
  addSvgLine(svg, minCX, SPINE_Y, maxCX, SPINE_Y);

  // ── Sections ──
  SECTIONS.forEach((sec, idx) => {
    const cx = sec.cx;
    const isUtil = sec.utility === true;
    const l1Color = isUtil ? COL.l1Utility : COL.l1Primary;
    const stopIdx = idx + 1;

    // spine dot + vertical drop
    addSvgDot(svg, cx, SPINE_Y);
    addSvgLine(svg, cx, SPINE_Y, cx, L1_Y);

    // L1 pill
    addPill(canvas, {
      x: cx - 100, y: L1_Y, w: 200, h: 34, r: 6,
      bg: l1Color, color: COL.textWhite,
      text: sec.name, fontSize: 10,
      id: `l1-pill-${sec.id || idx}`,
      classes: 'pill',
      onclick: () => { currentStop = stopIdx; applyStop(stopIdx); },
    });

    // L1 card
    addCard(canvas, {
      x: cx - CW / 2, y: L1_CARD_Y, w: CW, h: 200,
      desc: sec.desc || '',
      info: sec.info || [],
      actions: sec.actions || [],
      classes: 'card ia-el',
      id: `l1-card-${sec.id || idx}`,
    });

    // show-L2 button (IA mode)
    if (sec.l2 && sec.l2.length) {
      addShowL2Btn(canvas, cx, L1_CARD_Y + 210, sec.id || `sec-${idx}`, sec.l2.length);

      // L2 spine
      const l2Cxs = sec.l2.map(l => l.cx);
      const minL2 = Math.min(...l2Cxs);
      const maxL2 = Math.max(...l2Cxs);
      addSvgLine(svg, cx, L1_Y + 34, cx, L2_SY, 'ia-el');
      addSvgLine(svg, minL2, L2_SY, maxL2, L2_SY, 'ia-el');

      sec.l2.forEach((l2, l2i) => {
        const l2cx = l2.cx;
        const secId = sec.id || `sec-${idx}`;

        addSvgDot(svg, l2cx, L2_SY, 'ia-el');
        addSvgLine(svg, l2cx, L2_SY, l2cx, L2_Y, 'ia-el');

        // L2 pill
        addPill(canvas, {
          x: l2cx - CW / 2, y: L2_Y, w: CW, h: 30, r: 6,
          bg: isUtil ? COL.l2Utility : COL.l2Primary, color: COL.textWhite,
          text: l2.name, fontSize: 10,
          id: `l2-pill-${secId}-${l2i}`,
          classes: 'pill ia-el',
          'data-secid': secId, 'data-l2i': l2i,
          onclick: () => jumpToL2(stopIdx - 1, l2i),
        });

        // L2→card line + card
        addSvgLine(svg, l2cx, L2_Y + 30, l2cx, L2_CARD_Y, 'ia-el');
        addCard(canvas, {
          x: l2cx - CW / 2, y: L2_CARD_Y, w: CW, h: 220,
          desc: l2.desc || '',
          info: l2.info || [],
          actions: l2.actions || [],
          classes: 'card ia-el',
          id: `l2-card-${secId}-${l2i}`,
        });

        // L3 pages
        if (l2.l3 && l2.l3.length) {
          const l3Cxs = l2.l3.map(p => p.cx);
          const minL3 = Math.min(...l3Cxs);
          const maxL3 = Math.max(...l3Cxs);
          addSvgLine(svg, l2cx, L2_CARD_Y + 220, l2cx, L3_SY, 'ia-el');
          addSvgLine(svg, minL3, L3_SY, maxL3, L3_SY, 'ia-el');

          l2.l3.forEach((l3, l3i) => {
            addSvgDot(svg, l3.cx, L3_SY, 'ia-el');
            addSvgLine(svg, l3.cx, L3_SY, l3.cx, L3_Y, 'ia-el');
            addPill(canvas, {
              x: l3.cx - 205, y: L3_Y, w: 410, h: 26, r: 4,
              bg: COL.l3, color: COL.textWhite,
              text: l3.name, fontSize: 9,
              classes: 'pill ia-el',
            });
          });
        }
      });
    }
  });
}

/* ── SVG helpers ── */
function addSvgLine(svg, x1, y1, x2, y2, cls) {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', x1); line.setAttribute('y1', y1);
  line.setAttribute('x2', x2); line.setAttribute('y2', y2);
  line.setAttribute('stroke', COL.connector);
  line.setAttribute('stroke-width', '2');
  if (cls) line.classList.add(cls);
  svg.appendChild(line);
}
function addSvgDot(svg, cx, cy, cls) {
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', '4');
  c.setAttribute('fill', COL.connector);
  if (cls) c.classList.add(cls);
  svg.appendChild(c);
}

/* ── Pill helper ── */
function addPill(parent, opts) {
  const el = document.createElement('div');
  el.className = opts.classes || 'pill';
  if (opts.id) el.id = opts.id;
  Object.entries(opts).forEach(([k, v]) => {
    if (k.startsWith('data-')) el.setAttribute(k, v);
  });
  el.style.cssText = `
    left:${opts.x}px;top:${opts.y}px;
    width:${opts.w}px;height:${opts.h}px;
    border-radius:${opts.r}px;
    background:${opts.bg};color:${opts.color};
    font-size:${opts.fontSize || 11}px;
  `;
  el.textContent = opts.text;
  if (opts.onclick) el.addEventListener('click', opts.onclick);
  parent.appendChild(el);
  return el;
}

/* ── Card helper ── */
function addCard(parent, opts) {
  const el = document.createElement('div');
  el.className = opts.classes || 'card';
  if (opts.id) el.id = opts.id;
  el.style.cssText = `left:${opts.x}px;top:${opts.y}px;width:${opts.w}px;`;

  let html = '';
  if (opts.desc) html += `<div class="card-desc">${opts.desc}</div>`;
  if (opts.info && opts.info.length) {
    html += `<div class="band band-i">Information</div>`;
    opts.info.forEach(b => { html += `<div class="bullet">– ${b}</div>`; });
  }
  if (opts.actions && opts.actions.length) {
    html += `<div class="band band-a">Actions</div>`;
    opts.actions.forEach(b => { html += `<div class="bullet">→ ${b}</div>`; });
  }
  el.innerHTML = html;
  parent.appendChild(el);
  return el;
}

/* ── Show-L2 button ── */
function addShowL2Btn(parent, cx, y, secId, count) {
  const el = document.createElement('div');
  el.className = 'show-l2-btn ia-el visible';
  el.style.left = cx + 'px';
  el.style.top  = y + 'px';
  el.dataset.secid = secId;
  el.innerHTML = `
    <div class="show-l2-rings">
      <div class="ping-ring"></div><div class="ping-ring"></div><div class="ping-ring"></div>
      <div class="show-l2-dot"></div>
    </div>
    <div class="show-l2-label">+ Show ${count} pages</div>`;
  el.addEventListener('click', () => revealL2(secId));
  parent.appendChild(el);
}

/* ═══════════════════════════════════════════
   ISLAND NAV
═══════════════════════════════════════════ */
function buildIslandNav() {
  const nav = document.getElementById('island-nav');
  nav.innerHTML = '';
  SECTIONS.forEach((sec, idx) => {
    const btn = document.createElement('button');
    btn.className = 'nav-pill' + (sec.utility ? ' utility' : '');
    btn.dataset.secid = sec.id || `sec-${idx}`;
    const count = sec.l2 ? sec.l2.length : 0;
    btn.innerHTML = sec.name + (count ? `<span class="nav-pill-count">${count}</span>` : '');
    btn.addEventListener('click', () => {
      const stopIdx = idx + 1;
      currentStop = stopIdx;
      applyStop(stopIdx);
    });
    nav.appendChild(btn);
  });
}

function syncIslandNav(secId) {
  document.querySelectorAll('.nav-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.secid === secId);
  });
}

/* ═══════════════════════════════════════════
   CAMERA
═══════════════════════════════════════════ */
function setupCamera(totalWidth, START_CX) {
  const vpw = container.clientWidth;
  const vph = container.clientHeight;
  sc = Math.min(0.065, vpw / totalWidth * 0.9);
  tx = vpw / 2 - START_CX * sc;
  ty = vph / 2 - 600 * sc;
  zoomTarget = { tx, ty, sc };
  applyTransform(false);
}

function applyTransform(animated) {
  if (animated) {
    canvas.style.transition = 'transform 700ms cubic-bezier(0.4,0,0.2,1)';
    setTimeout(() => canvas.style.transition = 'none', 760);
  } else {
    canvas.style.transition = 'none';
  }
  canvas.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`;
  updateMinimap();
}

function smoothZoomStep() {
  const ease = 0.16;
  const dsc = zoomTarget.sc - sc;
  const dtx = zoomTarget.tx - tx;
  const dty = zoomTarget.ty - ty;
  if (Math.abs(dsc) < 0.0005 && Math.abs(dtx) < 0.3 && Math.abs(dty) < 0.3) {
    sc = zoomTarget.sc; tx = zoomTarget.tx; ty = zoomTarget.ty;
    applyTransform(false); zoomRaf = null; return;
  }
  sc += dsc * ease; tx += dtx * ease; ty += dty * ease;
  applyTransform(false);
  zoomRaf = requestAnimationFrame(smoothZoomStep);
}

function flyTo(cx, cy, targetSc) {
  const vpw = container.clientWidth, vph = container.clientHeight;
  zoomTarget.tx = vpw / 2 - cx * targetSc;
  zoomTarget.ty = vph / 2 - cy * targetSc;
  zoomTarget.sc = targetSc;
  if (zoomRaf) { cancelAnimationFrame(zoomRaf); zoomRaf = null; }
  zoomRaf = requestAnimationFrame(smoothZoomStep);
}

function sectionScale(sec) {
  if (!sec.l2 || !sec.l2.length) return 0.75;
  const cxs = sec.l2.map(l => l.cx);
  const span = (Math.max(...cxs) - Math.min(...cxs)) + CW + 100;
  return Math.min(0.65, Math.max(0.18, (container.clientWidth * 0.85) / span));
}

/* ── Zoom controls ── */
function zoomIn()  { const f = 1.25; adjustZoom(f); }
function zoomOut() { const f = 0.8;  adjustZoom(f); }
function adjustZoom(factor) {
  const vpw = container.clientWidth, vph = container.clientHeight;
  const cx = vpw / 2, cy = vph / 2;
  const newSc = Math.min(3, Math.max(0.03, sc * factor));
  zoomTarget.tx = cx - (cx - tx) * newSc / sc;
  zoomTarget.ty = cy - (cy - ty) * newSc / sc;
  zoomTarget.sc = newSc;
  if (zoomRaf) cancelAnimationFrame(zoomRaf);
  zoomRaf = requestAnimationFrame(smoothZoomStep);
}
function resetView() { applyStop(0); }

/* ═══════════════════════════════════════════
   INTERACTION (pan + wheel zoom)
═══════════════════════════════════════════ */
function setupInteraction() {
  let dragging = false, startX, startY, startTx, startTy;

  container.addEventListener('mousedown', e => {
    if (e.target !== container && !e.target.id.includes('canvas')) return;
    dragging = true; startX = e.clientX; startY = e.clientY;
    startTx = tx; startTy = ty;
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    tx = startTx + (e.clientX - startX);
    ty = startTy + (e.clientY - startY);
    zoomTarget.tx = tx; zoomTarget.ty = ty;
    applyTransform(false);
  });
  window.addEventListener('mouseup', () => dragging = false);

  container.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newSc = Math.min(3, Math.max(0.03, sc * factor));
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    zoomTarget.tx = mx - (mx - tx) * newSc / sc;
    zoomTarget.ty = my - (my - ty) * newSc / sc;
    zoomTarget.sc = newSc;
    if (zoomRaf) cancelAnimationFrame(zoomRaf);
    zoomRaf = requestAnimationFrame(smoothZoomStep);
  }, { passive: false });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (document.getElementById('state-result').classList.contains('active')) {
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   navigate(-1);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown')  navigate(1);
      if (e.key === 'r' || e.key === 'R') resetView();
      if (e.key === 'm' || e.key === 'M') setMode(isSMMode ? 'ia' : 'sitemap');
      if (e.key === 'Escape') clearHighlight();
    }
  });
}

/* ═══════════════════════════════════════════
   TOUR / STOPS
═══════════════════════════════════════════ */
function applyStop(stopIdx, l2idx = -1) {
  currentStop = stopIdx;
  currentL2idx = l2idx;
  const stop = mainStops[stopIdx];
  if (!stop) return;

  currentSectionId = stop.id;
  syncIslandNav(stop.id === 'overview' ? null : stop.id);

  if (l2idx >= 0 && stop.l2 && stop.l2[l2idx]) {
    const l2 = stop.l2[l2idx];
    flyTo(l2.cx, L2_CARD_Y + 110, 0.72);
    highlightSection(stop.id, l2idx);
    updateBar(stop, l2idx);
  } else {
    flyTo(stop.cx, stop.cy, stop.sc);
    if (stopIdx === 0) clearHighlight();
    else { highlightSection(stop.id, -1); revealL2(stop.id); }
    updateBar(stop, -1);
  }
  updateNavButtons();
}

function navigate(dir) {
  if (currentL2idx >= 0) {
    const stop = mainStops[currentStop];
    const next = currentL2idx + dir;
    if (next >= 0 && next < stop.l2.length) { jumpToL2(currentStop - 1, next); return; }
    if (dir < 0) { applyStop(currentStop); return; }
    if (next >= stop.l2.length) { applyStop(currentStop + 1); return; }
  }
  const next = currentStop + dir;
  if (next >= 0 && next < mainStops.length) applyStop(next);
}

function jumpToL2(secArrayIdx, l2i) {
  const stopIdx = secArrayIdx + 1;
  applyStop(stopIdx, l2i);
}

function goBackToL1() {
  if (currentStop > 0) applyStop(currentStop, -1);
}

/* ── Reveal L2 ── */
function revealL2(secId) {
  l2Opened.add(secId);
  canvas.querySelectorAll('.show-l2-btn').forEach(btn => {
    if (btn.dataset.secid === secId) btn.style.display = 'none';
  });
  canvas.querySelectorAll('.ia-el').forEach(el => {
    // L2 elements are always ia-el; they show when l2 is opened
    el.style.opacity = '';
  });
}

/* ── Highlight ── */
function highlightSection(secId, l2idx) {
  clearHighlight();
  document.querySelectorAll('.pill').forEach(p => {
    const matches = p.id && (p.id.includes(secId));
    if (matches) p.classList.add('highlighted');
    else p.classList.add('dimmed');
  });
}

function clearHighlight() {
  document.querySelectorAll('.pill').forEach(p => {
    p.classList.remove('highlighted', 'dimmed');
  });
  document.querySelectorAll('.card').forEach(c => {
    c.classList.remove('dimmed');
  });
}

/* ── Tour bar ── */
function updateBar(stop, l2idx) {
  const nameEl   = document.getElementById('tour-name');
  const descEl   = document.getElementById('tour-desc');
  const counterEl = document.getElementById('tour-counter');
  const chipsEl  = document.getElementById('tour-chips');
  const bcEl     = document.getElementById('bc-l1');

  if (!stop) return;

  if (l2idx >= 0 && stop.l2 && stop.l2[l2idx]) {
    const l2 = stop.l2[l2idx];
    bcEl.textContent = '← ' + stop.name;
    bcEl.classList.add('visible');
    nameEl.textContent = l2.name;
    descEl.textContent = l2.desc || '';
    chipsEl.innerHTML = '';
  } else {
    bcEl.textContent = '';
    bcEl.classList.remove('visible');
    nameEl.textContent = stop.name;
    descEl.textContent = stop.desc || '';

    if (!isSMMode && stop.l2 && stop.l2.length) {
      chipsEl.innerHTML = stop.l2.map((l2, i) =>
        `<button class="tour-chip" onclick="jumpToL2(${currentStop - 1},${i})">${l2.name}</button>`
      ).join('');
    } else {
      chipsEl.innerHTML = '';
    }
  }

  const total = mainStops.length - 1;
  counterEl.textContent = currentStop === 0 ? `${total} sections` : `${currentStop} / ${total}`;
}

function updateNavButtons() {
  const prev = document.getElementById('btn-prev');
  const next = document.getElementById('btn-next');
  if (prev) prev.disabled = (currentStop === 0 && currentL2idx < 0);
  if (next) next.disabled = (currentStop >= mainStops.length - 1 && currentL2idx < 0);
}

/* ═══════════════════════════════════════════
   MODE SWITCHING (IA ↔ SITEMAP)
═══════════════════════════════════════════ */
function setMode(m) {
  isSMMode = (m === 'sitemap');
  document.body.classList.toggle('sitemap', isSMMode);
  document.getElementById('btn-ia').classList.toggle('active', m === 'ia');
  document.getElementById('btn-sm').classList.toggle('active', m === 'sitemap');
  canvas.style.display   = isSMMode ? 'none' : 'block';
  smCanvas.style.display = isSMMode ? 'block' : 'none';

  if (isSMMode) {
    clearHighlight();
    if (!smBuilt) { buildSitemapCanvas(); smBuilt = true; }
    smFlyToSection(smSecIdx);
    document.getElementById('tour-chips').innerHTML = '';
  } else {
    applyStop(currentStop, -1);
  }
}

/* ═══════════════════════════════════════════
   SITEMAP CANVAS
═══════════════════════════════════════════ */
const SM_L1_H   = 36;
const SM_GAP    = 80;
const SM_L2_Y   = SM_L1_Y_REF + SM_L1_H + 40;
const SM_L2_H   = 28;

function buildSitemapCanvas() {
  smCanvas.innerHTML = '';
  smSvg.innerHTML = '';
  smCanvas.appendChild(smSvg);

  SM_SEC_CXS = [];
  let curX = 120;

  SECTIONS.forEach((sec, idx) => {
    const cx = curX;
    SM_SEC_CXS.push(cx);

    // L1 pill
    const p = document.createElement('div');
    p.className = 'sm-pill';
    const isUtil = sec.utility === true;
    p.style.cssText = `
      left:${cx - 90}px;top:${SM_L1_Y_REF}px;
      width:180px;height:${SM_L1_H}px;
      background:${isUtil ? COL.l1Utility : COL.l1Primary};
      color:#fff;font-size:10px;
    `;
    p.textContent = sec.name;
    p.addEventListener('click', () => {
      smSecIdx = idx;
      syncIslandNav(sec.id || `sec-${idx}`);
      updateBar(mainStops[idx + 1], -1);
      smFlyToSection(idx);
    });
    smCanvas.appendChild(p);

    // L2 pills
    if (sec.l2 && sec.l2.length) {
      const l2s = sec.l2;
      const l2Total = l2s.length * 180 + (l2s.length - 1) * 8;
      let l2StartX = cx - l2Total / 2;

      l2s.forEach((l2, l2i) => {
        const l2cx = l2StartX + l2i * 188 + 90;
        const lp = document.createElement('div');
        lp.className = 'sm-pill';
        lp.style.cssText = `
          left:${l2StartX + l2i * 188}px;top:${SM_L2_Y}px;
          width:180px;height:${SM_L2_H}px;
          background:${isUtil ? COL.l2Utility : COL.l2Primary};
          color:#fff;font-size:9px;
          display:none;
        `;
        lp.dataset.smsec = sec.id || `sec-${idx}`;
        lp.textContent = l2.name;
        lp.addEventListener('click', () => {
          setMode('ia');
          applyStop(idx + 1, l2i);
        });
        smCanvas.appendChild(lp);

        // SVG connector
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', cx); line.setAttribute('y1', SM_L1_Y_REF + SM_L1_H);
        line.setAttribute('x2', l2cx); line.setAttribute('y2', SM_L2_Y);
        line.setAttribute('stroke', COL.connector);
        line.setAttribute('stroke-width', '1');
        line.style.display = 'none';
        line.dataset.smsec = sec.id || `sec-${idx}`;
        smSvg.appendChild(line);
      });

      // Show pages toggle
      const toggle = document.createElement('div');
      toggle.className = 'sm-toggle';
      toggle.dataset.secid = sec.id || `sec-${idx}`;
      toggle.style.cssText = `
        position:absolute;left:${cx - 50}px;top:${SM_L1_Y_REF + SM_L1_H + 8}px;
        background:#fff;border:1.5px solid ${isUtil ? COL.l1Utility : COL.l1Primary};
        border-radius:20px;padding:3px 12px;font-size:8.5px;font-weight:800;
        color:${isUtil ? COL.l1Utility : COL.l1Primary};cursor:pointer;
        font-family:'Inter',sans-serif;white-space:nowrap;z-index:5;
        transition:background .15s,color .15s;
      `;
      toggle.textContent = '+ Show pages';
      toggle.addEventListener('click', () => toggleSmL2(sec.id || `sec-${idx}`));
      smCanvas.appendChild(toggle);
    }

    curX += 280;
  });

  const totalW = curX + 120;
  smCanvas.style.width  = totalW + 'px';
  smCanvas.style.height = '600px';
  smSvg.setAttribute('width',  totalW);
  smSvg.setAttribute('height', '600px');
}

function toggleSmL2(secId) {
  const showing = smCanvas.querySelector(`.sm-pill[data-smsec="${secId}"]`)?.style.display === 'flex';
  smCanvas.querySelectorAll(`.sm-pill[data-smsec="${secId}"]`).forEach(p => {
    p.style.display = showing ? 'none' : 'flex';
  });
  smSvg.querySelectorAll(`line[data-smsec="${secId}"]`).forEach(l => {
    l.style.display = showing ? 'none' : '';
  });
  const toggle = smCanvas.querySelector(`.sm-toggle[data-secid="${secId}"]`);
  if (toggle) toggle.textContent = showing ? '+ Show pages' : '− Hide pages';
}

/* ── Sitemap smooth camera ── */
function applyTransformSM() {
  smCanvas.style.transform = `translate(${smTx}px,${smTy}px) scale(${smSc})`;
}

function smoothSmStep() {
  const ease = 0.18;
  const dsc = smZoomTarget.sc - smSc;
  const dtx = smZoomTarget.tx - smTx;
  const dty = smZoomTarget.ty - smTy;
  if (Math.abs(dsc) < 0.0005 && Math.abs(dtx) < 0.3 && Math.abs(dty) < 0.3) {
    smSc = smZoomTarget.sc; smTx = smZoomTarget.tx; smTy = smZoomTarget.ty;
    applyTransformSM(); smZoomRaf = null; return;
  }
  smSc += dsc * ease; smTx += dtx * ease; smTy += dty * ease;
  applyTransformSM();
  smZoomRaf = requestAnimationFrame(smoothSmStep);
}

function smFlyTo(cx, cy, targetSc) {
  const vpw = container.clientWidth, vph = container.clientHeight;
  smZoomTarget.tx = vpw / 2 - cx * targetSc;
  smZoomTarget.ty = vph / 2 - cy * targetSc;
  smZoomTarget.sc = targetSc;
  if (smZoomRaf) { cancelAnimationFrame(smZoomRaf); smZoomRaf = null; }
  smZoomRaf = requestAnimationFrame(smoothSmStep);
}

function smFlyToSection(idx) {
  if (!SM_SEC_CXS.length) return;
  const cx = SM_SEC_CXS[idx] || SM_SEC_CXS[0];
  const vpw = container.clientWidth, vph = container.clientHeight;
  const targetSc = Math.min(vpw * 0.6 / 280, vph * 0.7 / 200, 1.4);
  smFlyTo(cx, SM_L1_Y_REF + 40, targetSc);
  smSecIdx = idx;
  syncIslandNav(SECTIONS[idx]?.id || `sec-${idx}`);
}

/* ═══════════════════════════════════════════
   MINIMAP
═══════════════════════════════════════════ */
function updateMinimap() {
  const mm = document.getElementById('minimap');
  if (!mm || !canvas) return;
  const ctx = mm.getContext('2d');
  const mmW = mm.width, mmH = mm.height;
  ctx.clearRect(0, 0, mmW, mmH);

  // Background
  ctx.fillStyle = '#f4f4f6';
  ctx.fillRect(0, 0, mmW, mmH);

  // Viewport indicator
  const cw = parseFloat(canvas.style.width) || 22400;
  const ch = parseFloat(canvas.style.height) || 2000;
  const scaleX = mmW / cw;
  const scaleY = mmH / ch;
  const vpw = container.clientWidth;
  const vph = container.clientHeight;

  const vx = (-tx / sc) * scaleX;
  const vy = (-ty / sc) * scaleY;
  const vw = (vpw / sc) * scaleX;
  const vh = (vph / sc) * scaleY;

  ctx.fillStyle = 'rgba(107,63,212,.18)';
  ctx.fillRect(vx, vy, vw, vh);
  ctx.strokeStyle = '#6B3FD4';
  ctx.lineWidth = 1;
  ctx.strokeRect(vx, vy, vw, vh);
}

/* ═══════════════════════════════════════════
   COMPETITORS PANEL
═══════════════════════════════════════════ */
function buildCompetitorsPanel(iaData) {
  const rationalEl = document.getElementById('csp-rationale');
  if (rationalEl && iaData.rationale) rationalEl.textContent = iaData.rationale;

  const cards = document.getElementById('csp-cards');
  if (!cards || !iaData.competitors) return;
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
}

function toggleCompPanel() {
  const panel = document.getElementById('comp-side-panel');
  const btn   = document.getElementById('comp-panel-btn');
  panel.classList.toggle('open');
  btn.classList.toggle('open');
}

function showRationale(text) {
  const bar = document.getElementById('rationale-bar');
  const textEl = document.getElementById('rationale-text');
  if (!bar || !textEl) return;
  textEl.textContent = text;
  bar.classList.add('show');
  setTimeout(() => bar.classList.remove('show'), 6000);
}
