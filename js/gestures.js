// Wischgesten per Touch: Das Element folgt dem Finger, beim Loslassen entscheiden Strecke und Tempo.

const SLOP = 6;           // ab so vielen Punkten Bewegung steht die Richtung fest
const CROSS = .8;         // quer dazu höchstens so viel – sonst hat das normale Scrollen Vorrang
const SAMPLE_MS = 40;     // Tempo aus den letzten 40 ms (zieht der Finger zuletzt zurück, zählt das)

// Beobachtet Wischbewegungen auf el in eine Richtung: axis 'x' = nach rechts, 'y' = nach unten.
// begin(e, touch) prüft beim Aufsetzen, ob die Geste hier in Frage kommt, und liefert dann einen Kontext.
// start(ctx) läuft, sobald die Richtung feststeht, move(ctx, strecke) folgt dem Finger,
// end(ctx, strecke, tempo, abgebrochen) entscheidet beim Loslassen (Tempo in Punkten pro ms).
export function dragGesture(el, { axis, begin, start, move, end }) {
  let g = null;
  const along = t => (axis === 'x' ? t.clientX : t.clientY);
  const across = t => (axis === 'x' ? t.clientY : t.clientX);
  const stop = (cancelled, now) => {
    const s = g;
    g = null;
    if (s?.active) end(s.ctx, s.d, speed(s.samples, now), cancelled);
  };

  el.addEventListener('touchstart', e => {
    stop(true, e.timeStamp); // zweiter Finger: laufende Geste abbrechen
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const ctx = begin(e, t);
    if (ctx) g = { ctx, a0: along(t), c0: across(t), d: 0, active: false, samples: [] };
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!g) return;
    const t = e.touches[0];
    const d = along(t) - g.a0;
    if (!g.active) {
      const c = Math.abs(across(t) - g.c0);
      if (Math.max(Math.abs(d), c) < SLOP) return;
      // falsche Richtung, zu schräg oder der Browser scrollt schon: Finger gehört dem Scrollen
      if (d <= 0 || c > d * CROSS || !e.cancelable) {
        g = null;
        return;
      }
      g.active = true;
      start?.(g.ctx);
    }
    e.preventDefault();
    g.d = Math.max(0, d);
    g.samples.push([e.timeStamp, g.d]);
    while (e.timeStamp - g.samples[0][0] > SAMPLE_MS) g.samples.shift();
    move(g.ctx, g.d);
  }, { passive: false });

  el.addEventListener('touchend', e => stop(false, e.timeStamp));
  el.addEventListener('touchcancel', e => stop(true, e.timeStamp));
}

function speed(samples, now) {
  const first = samples[0];
  const last = samples.at(-1);
  if (!last || now - last[0] > SAMPLE_MS || last === first) return 0; // vor dem Loslassen angehalten
  return (last[1] - first[1]) / (last[0] - first[0]);
}

// Geste ausführen? Weit genug gezogen (Anteil `share` von `size`) oder kräftig geschnippt – nicht beim Zurückziehen
export const passed = (d, v, size, share) => (v > .4 && d > 24) || (d > size * share && v > -.2);
