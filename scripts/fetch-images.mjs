// Fills in missing images for the Lookbook Index.
//  - drops.json: each drop without a "cover" gets the preview image (og:image) of its source article.
//  - brands.json: each brand without an "img" gets the preview image of its homepage.
// Images are resized to 900px wide WebP and saved in covers/ so the site never hotlinks.
// Run: npm install --no-save sharp && node scripts/fetch-images.mjs
import fs from "node:fs/promises";
import sharp from "sharp";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function get(url, text) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" }, redirect: "follow", signal: ac.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return text ? { html: await r.text(), url: r.url } : Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(timer); }
}

function previewImage(html, base) {
  const pats = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image/i,
  ];
  for (const p of pats) { const m = p.exec(html); if (m) return new URL(m[1].replace(/&amp;/g, "&"), base).href; }
  return null;
}

async function grab(page, file) {
  const { html, url } = await get(page, true);
  const img = previewImage(html, url);
  if (!img) throw new Error("no preview image");
  const buf = await get(img, false);
  const meta = await sharp(buf).metadata();
  if ((meta.width || 0) < 400 || (meta.height || 0) < 300) throw new Error("image too small (likely a logo)");
  const out = await sharp(buf).rotate().resize({ width: 900, withoutEnlargement: true }).webp({ quality: 78 }).toFile(file);
  return Math.round((out.width / out.height) * 100) / 100; // aspect ratio; wide images (> 1.25) are shown whole, not cropped
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const writeList = (p, list) => fs.writeFile(p, "[\n" + list.map((x) => JSON.stringify(x)).join(",\n") + "\n]\n");

const drops = JSON.parse(await fs.readFile("drops.json", "utf8"));
const brands = JSON.parse(await fs.readFile("brands.json", "utf8"));
await fs.mkdir("covers/brands", { recursive: true });
const misses = [];
let got = 0;

await pool(drops.filter((d) => !d.cover && /^https:\/\//.test(d.url || "")), 4, async (d) => {
  const rel = "covers/" + slug(d.id || d.brand + "-" + d.date) + ".webp";
  try { d.ia = await grab(d.url, rel); d.cover = rel; got++; } catch (e) { misses.push(`drop  ${d.brand}: ${e.message}`); }
});

await pool(brands.filter((b) => !b.img && b.u), 6, async (b) => {
  const rel = "covers/brands/" + slug(b.n) + ".webp";
  try { b.ia = await grab("https://" + b.u, rel); b.img = rel; got++; } catch (e) { misses.push(`brand ${b.n}: ${e.message}`); }
});

await fs.writeFile("drops.json", JSON.stringify(drops, null, 2) + "\n");
await writeList("brands.json", brands);

const report = `Fetched ${got} images. ${misses.length} misses.\n\n` + misses.sort().join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, "```\n" + report + "\n```\n");
