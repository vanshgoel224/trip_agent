// Client-side image compression: resize + re-encode on the phone before upload, so a
// 4 MB camera photo becomes ~100–150 KB (fast on 2G/3G, small to encrypt and store).
// Re-encoding through a canvas also strips EXIF metadata (including the photo's own
// GPS tag); the SOS already carries your location explicitly.
export async function compressImage(file, { maxDim = 1280, maxBytes = 150_000, minQuality = 0.4 } = {}) {
  if (!file || !/^image\//.test(file.type)) throw new Error("Not an image");
  const bmp = await (window.createImageBitmap ? createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file)) : loadViaImg(file));
  let { width: w, height: h } = bmp;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const webp = await toBlob(canvas, "image/webp", 0.8);
  const type = webp && webp.type === "image/webp" ? "image/webp" : "image/jpeg"; // old Safari: no WebP encoder
  let q = 0.8, blob = type === "image/webp" ? webp : await toBlob(canvas, type, q);
  // Lower quality until it fits; if quality alone isn't enough, shrink the image.
  while (blob.size > maxBytes && q > minQuality) blob = await toBlob(canvas, type, (q = Math.round((q - 0.1) * 10) / 10));
  if (blob.size > maxBytes && Math.max(w, h) > 480) return compressImage(new File([blob], "x", { type }), { maxDim: Math.round(Math.max(w, h) * 0.7), maxBytes, minQuality });
  return { blob, type, width: w, height: h, bytes: blob.size, originalBytes: file.size, dataUrl: await toDataUrl(blob) };
}
const toBlob = (c, type, q) => new Promise((res) => c.toBlob((b) => res(b), type, q));
const toDataUrl = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
function loadViaImg(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}
