// Fotos verkleinern: großes Bild (lange Kante 1200 px) + Vorschaubild für die Liste.

const FULL_EDGE = 1200;
const THUMB_EDGE = 360;

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Das Foto konnte nicht gelesen werden.')); };
    img.src = url;
  });
}

function toJpeg(img, maxEdge, quality) {
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => {
      canvas.width = canvas.height = 0; // Speicher auf dem iPhone sofort freigeben
      b ? resolve(b) : reject(new Error('Das Foto konnte nicht verkleinert werden.'));
    }, 'image/jpeg', quality);
  });
}

// Aus Kamera-/Mediathek-Datei: { full, thumb } als JPEG-Blobs
export async function processPhoto(file) {
  const img = await loadImage(file);
  return { full: await toJpeg(img, FULL_EDGE, 0.82), thumb: await toJpeg(img, THUMB_EDGE, 0.75) };
}

// Vorschaubild aus einem vorhandenen Bild erzeugen (z. B. beim Import)
export async function makeThumb(blob) {
  return toJpeg(await loadImage(blob), THUMB_EDGE, 0.75);
}
