/* =========================================================
   JGVRP Speedometer HUD  (cluster analog 3 gauge)
   API (dipanggil dari game / CEF):
     setSpeed(m/s)            setRPM(0.0 - 1.0)   (1.0 = 8000 rpm)
     setFuel(0-1 | 0-100)     setHealth(0-1 | 0-1000)  -> jarum OIL PSI
     setGear(n)               setHeadlights(0 off | 1 low | 2 high)
     setSeatbelts(bool)       updateLockStatus(state)
     setOdometer(miles)       setEngine(bool)
     setTheme('red'|'blue'|'amber'|'green')
   Efek:
     setEngine(true)  -> dial jadi terang + jarum menyapu (kontak ON)
     setHeadlights(1|2) -> semua jarum menyala (glow), seperti lampu dashboard asli
   ========================================================= */

const MPS_TO_MPH = 2.236936;
const MAX_MPH = 200;
const MAX_RPM = 8;          // skala tachometer (x1000)
const REDLINE = 6.2;        // mulai zona merah (x1000)
const LIMITER = 0.96;       // RPM (0-1) mulai dianggap kena limiter -> jarum geter

const NOOP_EL = document.createElement('div');   // pengaman kalau ada elemen yang dihapus dari HTML
const $ = (id) => document.getElementById(id) || NOOP_EL;
const elHud = $('hud');
const svg = $('dial');

function isLockedState(val) {
    return val === true || val === 1 || val === '1' || val === 'true' || val === 2 || val === '2';
}
function isTrueValue(val) {
    return val === true || val === 1 || val === '1' || val === 'true';
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ---------- Geometri (koordinat mengikuti gambar referensi 1774x887) ----------
const SPD = { cx: 886,  cy: 436, bezel: 322, ring: 299, face: 286, a0: 144, sweep: 252 };
const RPM = { cx: 337,  cy: 489, bezel: 264, ring: 246, face: 234, a0: 145, sweep: 245 };
const AUX = { cx: 1445, cy: 490, bezel: 264, ring: 246, face: 234 };
const FUEL = { cx: 1350, cy: 510, a0: 146, sweep: 75,  r: 122 };   // E (kiri bawah) -> F (kiri atas)
const OIL  = { cx: 1511, cy: 510, a0: 42,  sweep: -82, r: 130 };   // 0 (kanan bawah) -> 100 (kanan atas)

const pol = (cx, cy, r, a) => {
    const t = (a * Math.PI) / 180;
    return [(cx + r * Math.cos(t)).toFixed(2), (cy + r * Math.sin(t)).toFixed(2)];
};
function sector(cx, cy, r1, r2, a1, a2) {
    const [x1, y1] = pol(cx, cy, r2, a1), [x2, y2] = pol(cx, cy, r2, a2);
    const [x3, y3] = pol(cx, cy, r1, a2), [x4, y4] = pol(cx, cy, r1, a1);
    const large = a2 - a1 > 180 ? 1 : 0;
    return `M${x1} ${y1}A${r2} ${r2} 0 ${large} 1 ${x2} ${y2}L${x3} ${y3}A${r1} ${r1} 0 ${large} 0 ${x4} ${y4}Z`;
}
function arcPath(cx, cy, r, a1, a2) {
    const [x1, y1] = pol(cx, cy, r, a1), [x2, y2] = pol(cx, cy, r, a2);
    return `M${x1} ${y1}A${r} ${r} 0 ${Math.abs(a2 - a1) > 180 ? 1 : 0} ${a2 > a1 ? 1 : 0} ${x2} ${y2}`;
}
const tick = (cx, cy, a, r1, r2, w) => {
    const [x1, y1] = pol(cx, cy, r1, a), [x2, y2] = pol(cx, cy, r2, a);
    return `<line class="tk" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${w}"/>`;
};
const txt = (cls, x, y, size, s) => `<text class="${cls}" x="${x}" y="${y}" font-size="${size}">${s}</text>`;

// Bezel hitam + ring krom + muka dial putih
function bezelFace(g) {
    return `
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.bezel}" fill="#09090a"/>
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.bezel - 4}" fill="none" stroke="url(#chrome)" stroke-width="4" opacity="0.55"/>
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.ring}" fill="none" stroke="url(#chrome)" stroke-width="9"/>
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.ring - 7}" fill="#111214"/>
    <circle cx="${g.cx}" cy="${g.cy}" r="${g.face}" fill="url(#faceG)"/>`;
}
const shade = (g) => `<circle class="shade" cx="${g.cx}" cy="${g.cy}" r="${g.face}"/>`;

// Jarum + hub hitam
function needle(id, g, L, hubR) {
    const t = hubR - 8;
    return `
    <g id="${id}" transform="translate(${g.cx} ${g.cy}) rotate(0)">
      <path class="ndl" d="M${-t} -5.5L0 -8.5L${L} -1.4L${L} 1.4L0 8.5L${-t} 5.5Z"/>
    </g>
    <circle cx="${g.cx}" cy="${g.cy}" r="${hubR}" fill="url(#hubG)"/>
    <circle class="hub-ring" cx="${g.cx}" cy="${g.cy}" r="${hubR - 1}"/>
    <circle cx="${g.cx}" cy="${g.cy}" r="${hubR}" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2"/>
    <line x1="${g.cx - hubR * 0.62}" y1="${g.cy + hubR * 0.36}" x2="${g.cx + hubR * 0.62}" y2="${g.cy - hubR * 0.36}" stroke="rgba(255,255,255,0.13)" stroke-width="4"/>`;
}

// Ikon (viewBox 24x24) ditaruh di (x,y) dengan skala s
const icon = (id, cls, x, y, s, inner) =>
    `<g id="${id}" class="ind ${cls}" transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;

const ICON_HEADLIGHT = `
    <path d="M12 4h2a8 8 0 0 1 0 16h-2z" fill="currentColor" fill-opacity=".15"/>
    <g class="beam-low"><path d="M9 5L2 7.5M9 9L2 11.5M9 13L2 15.5M9 17L2 19.5"/></g>
    <g class="beam-high"><path d="M9 6H2M9 10H2M9 14H2M9 18H2"/></g>`;
const ICON_SEATBELT = `
    <circle cx="12" cy="4" r="2.2" fill="currentColor" stroke="none"/>
    <path d="M8 22v-5.5L7 11.5C7 9.6 8.4 8 10.2 8h3.6C15.6 8 17 9.6 17 11.5l-1 5V22"/>
    <path d="M9 8.5l7.5 10"/>`;
const ICON_LOCK = `
    <rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" stroke="none"/>
    <circle cx="12" cy="15.2" r="1.4" fill="#f4f1ec" stroke="none"/>
    <path class="shackle-closed" d="M8 11V8a4 4 0 0 1 8 0v3"/>
    <path class="shackle-open" d="M8 11V8a4 4 0 0 1 7.4-2.1"/>`;
const ICON_FUEL = `<path fill="currentColor" stroke="none" d="M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77zM12 10H6V5h6v5zm6 0c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z"/>`;
const ICON_OIL = `<path fill="currentColor" stroke="none" d="M2.5 10h4.2l1.3-2h2V6.5H8V5h6v1.5h-2V8h2.5l2 1.8 5-2.8 1 1.2-6.6 7.3H8.4L7 13H2.5zM20.2 14.6c0-.9 1.1-2.3 1.1-2.3s1.1 1.4 1.1 2.3c0 .6-.5 1.1-1.1 1.1s-1.1-.5-1.1-1.1z"/>`;

const ODO_N = 6, ODO_W = 31.4, ODO_ROW = 56, ODO_Y = 575, ODO_X0 = 792.8;   // geometri jendela ODO

function buildDial() {
    const sA = (v) => SPD.a0 + (v / MAX_MPH) * SPD.sweep;      // sudut speedo
    const rA = (v) => RPM.a0 + (v / MAX_RPM) * RPM.sweep;       // sudut tacho
    let s = `
    <defs>
      <linearGradient id="chrome" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#6c6f76"/>
        <stop offset="0.65" stop-color="#2a2b2f"/><stop offset="1" stop-color="#d9dbe0"/>
      </linearGradient>
      <radialGradient id="faceG" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0.45" style="stop-color:var(--face-a)"/><stop offset="1" style="stop-color:var(--face-b)"/>
      </radialGradient>
      <linearGradient id="drumShade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0.65"/><stop offset="0.3" stop-color="#000" stop-opacity="0"/>
        <stop offset="0.7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.65"/>
      </linearGradient>
      <radialGradient id="hubG" cx="0.4" cy="0.35" r="0.75">
        <stop offset="0" stop-color="#34353a"/><stop offset="0.6" stop-color="#0c0c0e"/><stop offset="1" stop-color="#030304"/>
      </radialGradient>
    </defs>
    <rect x="250" y="300" width="1290" height="455" rx="70" fill="#0a0a0b"/>`;

    // ----- bezel + muka -----
    s += bezelFace(RPM) + bezelFace(AUX) + bezelFace(SPD);

    // ----- TACHO -----
    s += `<path class="zone" d="${sector(RPM.cx, RPM.cy, 172, 221, rA(REDLINE), rA(MAX_RPM))}"/>`;
    for (let i = 0; i <= 80; i++) {
        const a = rA(i / 10), major = i % 10 === 0, mid = i % 5 === 0;
        s += tick(RPM.cx, RPM.cy, a, major ? 190 : mid ? 197 : 205, 221, major ? 4.4 : mid ? 3 : 1.8);
    }
    for (let v = 0; v <= MAX_RPM; v++) {
        const [x, y] = pol(RPM.cx, RPM.cy, 156, rA(v));
        s += txt('num', x, y, 40, v);
    }
    s += txt('lbl', RPM.cx, 392, 32, 'RPM') + txt('lbl', RPM.cx, 421, 20, 'x1000');

    // ----- SPEEDO -----
    for (let v = 0; v <= MAX_MPH; v += 2) {
        const a = sA(v), major = v % 20 === 0, mid = v % 10 === 0;
        s += tick(SPD.cx, SPD.cy, a, major ? 232 : mid ? 240 : 248, 264, major ? 5 : mid ? 3.2 : 2);
    }
    for (let v = 0; v <= MAX_MPH; v += 20) {
        const [x, y] = pol(SPD.cx, SPD.cy, 202, sA(v));
        s += txt('num', x, y, 44, v);
    }
    s += `<g class="mph-lbl">${txt('lbl', SPD.cx, 325, 36, 'MPH')}</g>`;

    // ----- GAUGE KANAN: FUEL (kiri) + OIL (kanan) -----
    // fuel: busur + tick + zona merah dekat E
    s += `<path class="arc" d="${arcPath(FUEL.cx, FUEL.cy, FUEL.r, FUEL.a0, FUEL.a0 + FUEL.sweep)}"/>`;
    s += `<path class="arc-red" d="${arcPath(FUEL.cx, FUEL.cy, FUEL.r - 7, FUEL.a0, FUEL.a0 + FUEL.sweep * 0.13)}"/>`;
    for (let i = 0; i <= 8; i++) s += tick(FUEL.cx, FUEL.cy, FUEL.a0 + (i / 8) * FUEL.sweep, FUEL.r, FUEL.r + (i % 4 === 0 ? 16 : 9), i % 4 === 0 ? 4 : 2.2);
    s += txt('num', 1281, 413, 34, 'F') + txt('num', 1294, 596, 34, 'E');
    // oil: busur + tick + angka
    s += `<path class="arc" d="${arcPath(OIL.cx, OIL.cy, OIL.r, OIL.a0, OIL.a0 + OIL.sweep)}"/>`;
    for (let i = 0; i <= 20; i++) s += tick(OIL.cx, OIL.cy, OIL.a0 + (i / 20) * OIL.sweep, OIL.r, OIL.r + (i % 10 === 0 ? 16 : i % 5 === 0 ? 11 : 7), i % 10 === 0 ? 4 : 2.2);
    s += txt('num', 1581, 407, 32, '100') + txt('num', 1597, 508, 32, '50') + txt('num', 1573, 596, 32, '0');
    s += txt('lbl', 1581, 386, 16, 'PSI') + txt('lbl', 1511, 460, 16, 'PSI') + txt('lbl', 1570, 619, 16, 'PSI');

    // ----- bayangan "mesin mati" (di atas muka, di bawah jarum) -----
    s += shade(RPM) + shade(AUX) + shade(SPD);

    // ----- ikon gauge fuel & oil -----
    s += icon('fuel-ico', 'gauge-ico', 1322, 410, 1.5, ICON_FUEL);
    s += icon('oil-ico', 'gauge-ico', 1494, 408, 1.6, ICON_OIL);

    // ----- ikon status + gear (di tengah speedo, di bawah hub) -----
    s += `<text id="gear" class="gear" x="800" y="530">N</text>`;
    s += icon('headlight', 'eng', 840, 511, 1.6, ICON_HEADLIGHT);
    s += icon('seatbelts', 'eng warn', 896, 511, 1.6, ICON_SEATBELT);
    s += icon('door-lock', '', 952, 511, 1.6, ICON_LOCK);

    // ----- ODO: drum angka berputar; 5 digit hitam-putih + digit terakhir (desimal) putih -----
    s += `<g class="odo">
    <circle cx="755" cy="603" r="10" fill="#18181b" stroke="#444" stroke-width="2"/><circle cx="1017" cy="603" r="10" fill="#18181b" stroke="#444" stroke-width="2"/>
    <rect x="788" y="570" width="198" height="66" rx="9" fill="#050506"/>`;
    for (let i = 0; i < ODO_N; i++) {
        const x = ODO_X0 + i * ODO_W, last = i === ODO_N - 1;
        let rows = '';
        for (let r = 0; r <= 10; r++) rows += `<text class="odo-digit${last ? ' odo-last' : ''}" x="${ODO_W / 2}" y="${ODO_ROW / 2 + r * ODO_ROW + 2}">${r % 10}</text>`;
        s += `<svg x="${x}" y="${ODO_Y}" width="${ODO_W}" height="${ODO_ROW}" viewBox="0 0 ${ODO_W} ${ODO_ROW}" overflow="hidden">
          <rect width="${ODO_W}" height="${ODO_ROW}" fill="${last ? '#f2f2f2' : '#050506'}"/>
          <g class="odo-strip snap" id="odo${i}">${rows}</g>
          <rect width="${ODO_W}" height="${ODO_ROW}" fill="url(#drumShade)"/>
          ${i > 0 && !last ? `<line x1="0" y1="0" x2="0" y2="${ODO_ROW}" stroke="rgba(255,255,255,0.16)" stroke-width="1.5"/>` : ''}
        </svg>`;
    }
    s += `</g>` + txt('lbl', 886, 656, 22, 'ODO');

    // ----- jarum + hub (paling atas) -----
    s += needle('nd-fuel', FUEL, 104, 32) + needle('nd-oil', OIL, 108, 32);
    s += needle('nd-rpm', RPM, 196, 41) + needle('nd-spd', SPD, 238, 42);

    svg.innerHTML = s;
}
buildDial();

const ndSpd = $('nd-spd'), ndRpm = $('nd-rpm'), ndFuel = $('nd-fuel'), ndOil = $('nd-oil');
const ang = {};
function setNeedle(el, key, g, a) {
    if (ang[key] !== undefined && Math.abs(ang[key] - a) < 0.04) return;   // tulis hanya kalau jarum benar-benar bergerak
    ang[key] = a;
    el.setAttribute('transform', `translate(${g.cx} ${g.cy}) rotate(${a.toFixed(2)})`);
}
// Helper kelas untuk elemen SVG (className SVG bukan string biasa)
function setCls(el, cls) { if (el.getAttribute('class') !== cls) el.setAttribute('class', cls); }
function setText(el, t) { t = String(t); if (el.textContent !== t) el.textContent = t; }

// ---------- State ----------
const state = {
    mph: 0, mps: 0,
    rpm: 0, health: 1, fuel: 1,
    spdShown: 0, rpmShown: 0, fuelShown: 0, oilShown: 0,
    belted: false, engine: false, lights: 0,
};
const BOOT_MS = 1700;
let bootUntil = 0;

// ---------- Loop animasi (berhenti sendiri kalau semua jarum diam) ----------
const FRAME_MS = 1000 / 60;
let lastFrame = 0, rafId = 0;
function kick() {
    if (rafId) return;
    lastFrame = performance.now() - FRAME_MS;
    rafId = requestAnimationFrame(frame);
}
function frame(now) {
    rafId = 0;
    if (now - lastFrame < FRAME_MS - 2) { rafId = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;

    // Sapuan jarum saat kontak ON: 0 -> max -> 0
    const booting = now < bootUntil;
    let sw = 0;
    if (booting) {
        const t = 1 - (bootUntil - now) / BOOT_MS;
        sw = t < 0.45 ? t / 0.45 : t < 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.45);
    }

    const tSpd = booting ? Math.max(sw, state.mph / MAX_MPH) : state.mph / MAX_MPH;
    const limiter = !booting && state.engine && state.rpm >= LIMITER;
    let tRpm = booting ? sw : state.engine ? state.rpm : 0;
    if (limiter) {   // rev limiter: jarum mental-mental di dekat batas (fuel cut), seperti mobil asli
        const cut = Math.sin((now / 1000) * 2 * Math.PI * 11) > 0;
        tRpm = state.rpm - (cut ? 0.04 + Math.random() * 0.02 : Math.random() * 0.012);
    }
    const tFuel = booting ? Math.max(sw, state.fuel) : state.engine ? state.fuel : 0;
    const tOil = booting ? sw : state.engine ? state.health : 0;

    const kf = booting ? 1 : Math.min(1, dt * (limiter ? 45 : 12)), ks = booting ? 1 : Math.min(1, dt * 4);
    const ease = (cur, tgt, k) => (Math.abs(tgt - cur) < 0.0004 ? tgt : cur + (tgt - cur) * k);
    state.spdShown = ease(state.spdShown, tSpd, kf);
    state.rpmShown = ease(state.rpmShown, tRpm, kf);
    state.fuelShown = ease(state.fuelShown, tFuel, ks);
    state.oilShown = ease(state.oilShown, tOil, ks);

    setNeedle(ndSpd, 'spd', SPD, SPD.a0 + clamp01(state.spdShown) * SPD.sweep);
    setNeedle(ndRpm, 'rpm', RPM, RPM.a0 + clamp01(state.rpmShown) * RPM.sweep);
    setNeedle(ndFuel, 'fuel', FUEL, FUEL.a0 + clamp01(state.fuelShown) * FUEL.sweep);
    setNeedle(ndOil, 'oil', OIL, OIL.a0 + clamp01(state.oilShown) * OIL.sweep);

    if (booting || limiter || state.spdShown !== tSpd || state.rpmShown !== tRpm || state.fuelShown !== tFuel || state.oilShown !== tOil) {
        rafId = requestAnimationFrame(frame);
    }
}

// ---------- 1. Kecepatan (m/s) ----------
window.setSpeed = function (speed) {
    state.mps = Number(speed || 0);
    state.mph = Math.round(state.mps * MPS_TO_MPH);
    kick();
};
// ---------- 2. RPM (0.0 - 1.0) ----------
window.setRPM = function (rpm) {
    const r = clamp01(Number(rpm || 0));
    if (r === state.rpm) return;
    state.rpm = r;
    kick();
};
// ---------- 3. Fuel ----------
window.setFuel = function (fuel) {
    const val = Number(fuel || 0);
    state.fuel = clamp01(val > 1 ? val / 100 : val);
    setCls($('fuel-ico'), state.fuel < 0.2 ? 'ind gauge-ico low' : 'ind gauge-ico');
    kick();
};
// ---------- 4. Engine health -> jarum OIL PSI ----------
window.setHealth = function (health) {
    const val = Number(health || 0);
    const p = clamp01(val > 1 ? val / 1000 : val);
    if (p === state.health) return;
    state.health = p;
    setCls($('oil-ico'), p <= 0.3 ? 'ind gauge-ico crit' : p <= 0.5 ? 'ind gauge-ico low' : 'ind gauge-ico');
    kick();
};
// ---------- 5. Gear ----------
window.setGear = function (gear) {
    let g = String(gear);
    if (gear == 0 || g === '0' || g.toUpperCase() === 'R') g = 'R';
    else if (gear === null || gear === undefined || g === '' || g.toUpperCase() === 'N') g = 'N';
    setText($('gear'), g);
    setCls($('gear'), g === 'R' ? 'gear rev' : 'gear');
};
// ---------- 6. Lock ----------
window.updateLockStatus = function (st) {
    setCls($('door-lock'), isLockedState(st) ? 'ind locked' : 'ind');
};
['setDoors', 'setDoorLock', 'setVehicleLocked', 'setLocked', 'setLock', 'toggleLock'].forEach((n) => { window[n] = window.updateLockStatus; });

// ---------- 7. LAMPU: 0 mati, 1 low, 2 high -> ikon + SEMUA JARUM MENYALA ----------
window.setHeadlights = function (st) {
    const val = Number(st || 0);
    state.lights = val;
    setCls($('headlight'), val === 2 ? 'ind eng high-beam' : val === 1 ? 'ind eng active' : 'ind eng');
    elHud.classList.toggle('lights-on', val > 0);
};
window.setLights = window.setHeadlights;
window.setLeftIndicator = function () {};     // sein dihapus
window.setRightIndicator = function () {};

// ---------- 8. Seatbelt ----------
window.setSeatbelts = function (val) {
    const on = isTrueValue(val);
    state.belted = on;
    setCls($('seatbelts'), on ? 'ind eng active' : 'ind eng warn');
};

// ---------- 9. Odometer (mil) -> 5 digit + 1 digit desimal, drum berputar ----------
let lastOdo = '';
const odoCells = [];
for (let i = 0; i < ODO_N; i++) {
    const el = $('odo' + i), c = { el, row: 0 };
    el.addEventListener('transitionend', () => {          // 9 -> 0: setelah putar ke "0" cadangan, lompat balik ke baris 0 tanpa animasi
        if (c.row === 10) odoMove(c, 0, false);
    });
    odoCells.push(c);
}
function odoMove(c, row, animate) {
    c.row = row;
    if (!animate) c.el.classList.add('snap');
    c.el.style.transform = `translateY(${-row * ODO_ROW}px)`;
    if (!animate) { void c.el.getBoundingClientRect(); c.el.classList.remove('snap'); }
}
window.setOdometer = function (distance) {
    const n = Math.max(0, Math.min(999999, Math.floor(Number(distance || 0) * 10)));
    const s = String(n).padStart(ODO_N, '0');
    if (s === lastOdo) return;
    const animate = lastOdo !== '' && state.engine;      // pertama kali / mesin mati: langsung set tanpa animasi
    lastOdo = s;
    for (let i = 0; i < ODO_N; i++) {
        const c = odoCells[i], d = +s[i];
        if (c.row === 10) odoMove(c, 0, false);
        if (c.row === d) continue;
        if (!animate) odoMove(c, d, false);
        else if (d < c.row && c.row - d > 5) odoMove(c, 10, true);   // lewat 9 -> 0: putar maju terus
        else odoMove(c, d, true);
    }
};

// ---------- 10. MESIN: nyala = dial terang + jarum menyapu ----------
window.setEngine = function (on) {
    const v = isTrueValue(on);
    const was = state.engine;
    state.engine = v;
    elHud.classList.toggle('engine-on', v);
    if (v && !was && performance.now() > bootUntil) bootUntil = performance.now() + BOOT_MS;
    kick();
};

// ---------- Sapuan jarum (tanpa tulisan intro) ----------
window.playIntro = function () {
    if (state.engine) bootUntil = performance.now() + BOOT_MS;
    kick();
};

// ---------- Suara peringatan (Web Audio, tanpa file mp3) ----------
const SND = {
    enabled: true,
    volume: 0.3,
    seatbeltEvery: 2000,
    seatbeltMinSpeed: 1,    // m/s
    fuelBelow: 0.20,
    fuelEvery: 30000,
};
try {
    const q = new URLSearchParams(location.search);
    ['nosound', 'mute', 'silent', 'noalarm', 'noseatbelt', 'nobelt'].forEach((k) => {
        if (q.has(k) && !['0', 'false', 'no', 'off'].includes((q.get(k) || '').toLowerCase())) SND.enabled = false;
    });
    if (q.has('volume') && !isNaN(parseFloat(q.get('volume')))) SND.volume = Math.max(0, Math.min(1, parseFloat(q.get('volume'))));
} catch (e) {}
let audioCtx = null;
function getAudio() {
    if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
}
function tone(freq, start, dur, type, vol) {
    const a = getAudio();
    if (!a) return;
    const t0 = a.currentTime + start;
    const osc = a.createOscillator(), gain = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, SND.volume * vol), t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
}
window.playHudSound = function (kind) {
    if (!SND.enabled) return;
    if (kind === 'seatbelt') {
        tone(1000, 0.00, 0.14, 'triangle', 1);
        tone(1000, 0.22, 0.14, 'triangle', 1);
    } else if (kind === 'fuel') {
        tone(988, 0.00, 0.45, 'sine', 1);
        tone(1976, 0.00, 0.30, 'sine', 0.25);
        tone(740, 0.30, 0.70, 'sine', 1);
        tone(1480, 0.30, 0.45, 'sine', 0.25);
    }
};
window.setHudSound = function (on, volume) {
    SND.enabled = !!on;
    if (volume !== undefined) SND.volume = clamp01(Number(volume));
};
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, getAudio, { once: true }));

let lastSeatBeep = -Infinity, lastFuelChime = -Infinity;
setInterval(() => {
    if (!SND.enabled) return;
    const now = performance.now();
    const seatWarn = state.engine && !state.belted && state.mps > SND.seatbeltMinSpeed;
    if (!seatWarn) lastSeatBeep = -Infinity;
    else if (now - lastSeatBeep >= SND.seatbeltEvery) { lastSeatBeep = now; window.playHudSound('seatbelt'); }

    const fuelWarn = state.engine && state.fuel < SND.fuelBelow;
    if (!fuelWarn) lastFuelChime = -Infinity;
    else if (now - lastFuelChime >= SND.fuelEvery) { lastFuelChime = now; window.playHudSound('fuel'); }
}, 250);

window.setSeatbeltSoundEnabled = (on) => window.setHudSound(!!on);
window.setSeatbeltVolume = (v) => { const n = parseFloat(v); if (!isNaN(n)) window.setHudSound(SND.enabled, n); };

// ---------- Pesan NUI: window.postMessage({ action: 'setEngine', state: true }) ----------
window.addEventListener('message', function (event) {
    const d = event.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'setDoors' || d.action === 'setDoors' || d.type === 'lock') {
        window.updateLockStatus(d.status !== undefined ? d.status : d.state);
    }
    if (d.type === 'playIntro' || d.action === 'playIntro') window.playIntro();
    if (!d.action) return;
    try {
        switch (d.action) {
            case 'setEngine': window.setEngine(d.state); break;
            case 'setSpeed': window.setSpeed(Number(d.speed) || 0); break;
            case 'setRPM': window.setRPM(Number(d.rpm) || 0); break;
            case 'setFuel': window.setFuel(Number(d.fuel) || 0); break;
            case 'setHealth': window.setHealth(Number(d.health) || 0); break;
            case 'setGear': window.setGear(d.gear !== undefined ? d.gear : 'N'); break;
            case 'setHeadlights':
            case 'setLights': window.setHeadlights(Number(d.state !== undefined ? d.state : d.lights) || 0); break;
            case 'setSeatbelts': window.setSeatbelts(!!d.state); break;
            case 'setOdometer': window.setOdometer(Number(d.distance) || 0); break;
            case 'setTheme': window.setTheme(d.theme !== undefined ? d.theme : d.state); break;
            case 'nextTheme': window.nextTheme(); break;
            case 'muteSeatbelt': window.setSeatbeltSoundEnabled(false); break;
            case 'unmuteSeatbelt': window.setSeatbeltSoundEnabled(true); break;
            case 'setSeatbeltSound': window.setSeatbeltSoundEnabled(d.enabled !== undefined ? !!d.enabled : !d.disabled); break;
            case 'setVolume': window.setSeatbeltVolume(d.volume !== undefined ? d.volume : d.value); break;
        }
    } catch (e) { /* abaikan pesan rusak */ }
});

// ---------- Warna jarum (tema) ----------
const THEMES = [['red', 'Merah'], ['blue', 'Biru'], ['amber', 'Amber'], ['green', 'Hijau']];
let themeIdx = 0;
window.setTheme = function (name) {
    let i = typeof name === 'number' ? name : THEMES.findIndex((t) => t[0] === name);
    if (i < 0) i = 0;
    themeIdx = ((i % THEMES.length) + THEMES.length) % THEMES.length;
    document.body.dataset.theme = THEMES[themeIdx][0];
    setText($('theme-name'), THEMES[themeIdx][1]);
    try { localStorage.setItem('hudTheme', THEMES[themeIdx][0]); } catch (e) {}
};
window.nextTheme = () => window.setTheme(themeIdx + 1);
$('theme-btn').addEventListener('click', window.nextTheme);
window.addEventListener('keydown', (e) => { if (e.key === 't' || e.key === 'T') window.nextTheme(); });

// ---------- Nilai awal ----------
window.setSpeed(0);
window.setRPM(0);
window.setFuel(100);
window.setHealth(1000);
window.setGear('N');
window.setHeadlights(0);
window.setSeatbelts(false);
window.setEngine(false);
window.updateLockStatus(false);
window.setOdometer(0);
(function () {
    const q = new URLSearchParams(location.search);
    if (q.has('button')) document.body.classList.add('show-btn');
    let saved = q.get('theme');
    try { saved = saved || localStorage.getItem('hudTheme'); } catch (e) {}
    window.setTheme(saved || 'red');
})();
window.playIntro();

// ---------- Demo (otomatis di preview Netlify atau dengan ?demo) ----------
const params = new URLSearchParams(location.search);
const isPreview = params.has('demo') || (/netlify\.app$/.test(location.hostname) && !params.has('nodemo'));

if (isPreview) {
    document.body.classList.add('preview');
    const btnE = $('dev-engine'), btnL = $('dev-lights');
    const LIGHT_NAMES = ['OFF', 'LOW', 'HIGH'];
    const toggleEngine = () => { setEngine(!state.engine); };
    const cycleLights = () => { setHeadlights((state.lights + 1) % 3); };
    btnE.addEventListener('click', toggleEngine);
    btnL.addEventListener('click', cycleLights);
    window.addEventListener('keydown', (e) => {
        if (e.key === 'e' || e.key === 'E') toggleEngine();
        if (e.key === 'l' || e.key === 'L') cycleLights();
    });

    const GEAR_TOP = [0, 28, 48, 72, 98, 128, 165];
    let mps = 0, gear = 1, throttle = true, odo = 18452.3, health = 1000, fuel = 86;
    setInterval(() => {
        btnE.textContent = 'Mesin: ' + (state.engine ? 'ON' : 'OFF');
        btnE.classList.toggle('on', state.engine);
        btnL.textContent = 'Lampu: ' + LIGHT_NAMES[state.lights];
        btnL.classList.toggle('on', state.lights > 0);

        if (!state.engine || performance.now() < bootUntil) {   // mesin mati / masih menyapu: mobil diam
            mps = 0; gear = 1; throttle = true;
            setSpeed(0); setRPM(0); setGear('N');
            return;
        }
        const mph = mps * MPS_TO_MPH;
        if (throttle) mps += 0.38 / gear; else mps -= 0.55;
        if (mph > 150) throttle = false;
        if (mps <= 0) { mps = 0; throttle = true; }
        while (gear < 6 && mph > GEAR_TOP[gear]) gear++;
        while (gear > 1 && mph < GEAR_TOP[gear - 1] - 6) gear--;
        const lo = GEAR_TOP[gear - 1], hi = GEAR_TOP[gear];
        const rpm = 0.11 + clamp01((mph - lo) / (hi - lo)) * (throttle ? 0.89 : 0.6);
        health = Math.max(180, health - 0.9); if (health <= 180) health = 1000;
        fuel = fuel <= 4 ? 86 : fuel - 0.02;
        odo += (mph * 0.05) / 3600;
        setSpeed(mps); setRPM(rpm); setGear(gear); setHealth(health); setFuel(fuel); setOdometer(odo);
    }, 50);
    setTimeout(() => { setSeatbelts(true); updateLockStatus(false); }, 1500);
}
