// Fills in missing images for the Lookbook Index.
//  - drops.json: each drop without a "cover" gets the preview image (og:image) of its source article (a lookbook photo).
//  - brands.json: each brand without a "logo" gets its logo:
//      1. Wikidata's logo image (P154, a Wikimedia Commons file), matched by the brand's website or a fashion description;
//      2. otherwise the logo on the brand's homepage (an <img> or inline <svg> marked "logo").
//    Logos are trimmed, light ones are darkened so they read on white, and saved as WebP in covers/logos/.
// Run: npm install --no-save sharp && node scripts/fetch-images.mjs
import fs from "node:fs/promises";
import sharp from "sharp";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BOT = "LookbookIndex/1.0 (https://jere-mee-as.github.io/lookbookindex/)";
const FASHION = /fashion|clothing|apparel|luxury|couture|menswear|womenswear|designer|denim|footwear|streetwear|outerwear|knitwear|tailor|sportswear|garment|textile|leather goods|jeans/i;
const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function get(url, kind, ua = UA) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { "user-agent": ua, "accept-language": "en" }, redirect: "follow", signal: ac.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    if (kind === "json") return await r.json();
    if (kind === "text") return { html: await r.text(), url: r.url };
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(timer); }
}

// ---------- lookbook covers ----------
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
async function cover(page, file) {
  const { html, url } = await get(page, "text");
  const img = previewImage(html, url);
  if (!img) throw new Error("no preview image");
  const buf = await get(img);
  const meta = await sharp(buf).metadata();
  if ((meta.width || 0) < 400 || (meta.height || 0) < 300) throw new Error("image too small");
  const out = await sharp(buf).rotate().resize({ width: 900, withoutEnlargement: true }).webp({ quality: 78 }).toFile(file);
  return Math.round((out.width / out.height) * 100) / 100;
}

// ---------- logos ----------
// Trim, check it's a real mark, darken it if it would vanish on white, save.
async function saveLogo(buf, file) {
  const isSvg = /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg/i.test(buf.toString("utf8", 0, 600));
  const base = await sharp(buf, isSvg ? { density: 300 } : {}).ensureAlpha().trim({ threshold: 12 })
    .resize({ width: 800, height: 400, fit: "inside", withoutEnlargement: !isSvg }).png().toBuffer();
  const { data, info } = await sharp(base).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, lum = 0, r0 = -1, g0 = -1, b0 = -1, varied = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    n++; lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (r0 < 0) { r0 = data[i]; g0 = data[i + 1]; b0 = data[i + 2]; }
    else if (Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0) > 60) varied++;
  }
  const px = info.width * info.height;
  if (info.width < 48 || info.height < 12) throw new Error("logo too small");
  if (n < px * 0.01) throw new Error("logo empty");
  if (n === px && varied / n > 0.35) throw new Error("looks like a photo, not a logo");
  let img = sharp(base);
  if (lum / n > 215) img = img.negate({ alpha: false }); // white logo → dark
  const out = await img.webp({ quality: 92, alphaQuality: 100 }).toFile(file);
  return Math.round((out.width / out.height) * 100) / 100;
}

const sameSite = (url, domain) => {
  try { const h = new URL(url).hostname.replace(/^www\./, ""); const d = domain.replace(/^www\./, ""); return h === d || h.endsWith("." + d) || d.endsWith("." + h); }
  catch (e) { return false; }
};
async function wikidataLogo(b) {
  const s = await get("https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=7&search=" + encodeURIComponent(b.n), "json", BOT);
  const ids = (s.search || []).map((x) => x.id);
  if (!ids.length) throw new Error("not on Wikidata");
  const e = await get("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&languages=en&props=claims|descriptions&ids=" + ids.join("|"), "json", BOT);
  const cands = ids.map((id) => e.entities[id]).filter((x) => x && x.claims && x.claims.P154);
  const site = (x) => (x.claims.P856 || []).some((c) => sameSite(c.mainsnak.datavalue && c.mainsnak.datavalue.value, b.u || ""));
  const pick = cands.find(site) || cands.find((x) => FASHION.test((x.descriptions.en || {}).value || ""));
  if (!pick) throw new Error("no Wikidata logo");
  const fileName = pick.claims.P154[0].mainsnak.datavalue.value;
  return get("https://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(fileName), "buf", BOT);
}

function logoCandidates(html, base) {
  const out = [];
  const header = (/<header\b[\s\S]*?<\/header>/i.exec(html) || [html])[0];
  for (const scope of [header, html]) {
    for (const m of scope.matchAll(/<img\b[^>]*>/gi)) {
      const tag = m[0];
      if (!/logo/i.test(tag)) continue;
      const src = (/\s(?:data-src|src)=["']([^"']+)["']/i.exec(tag) || /\ssrcset=["']([^"'\s,]+)/i.exec(tag) || [])[1];
      if (src) out.push({ src: src.replace(/&amp;/g, "&") });
    }
    const svg = /<svg\b[^>]*(?:logo|brand)[^>]*>[\s\S]*?<\/svg>/i.exec(scope)
      || /<[a-z]+\b[^>]*\blogo[^>]*>\s*(?:<[^>]+>\s*){0,3}(<svg\b[\s\S]*?<\/svg>)/i.exec(scope);
    if (svg) out.push({ svg: svg[1] || svg[0] });
  }
  return out.map((c) => c.src ? { src: c.src.startsWith("data:") ? c.src : new URL(c.src, base).href } : c);
}
async function homepageLogo(b, file) {
  const { html, url } = await get("https://" + b.u, "text");
  const cands = logoCandidates(html, url);
  if (!cands.length) throw new Error("no logo on homepage");
  let last;
  for (const c of cands.slice(0, 6)) {
    try {
      let buf;
      if (c.svg) {
        let s = c.svg;
        if (!/xmlns=/.test(s)) s = s.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
        buf = Buffer.from(s);
      } else if (c.src.startsWith("data:")) {
        const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(c.src);
        if (!m) continue;
        buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
      } else buf = await get(c.src);
      return await saveLogo(buf, file);
    } catch (e) { last = e; }
  }
  throw last || new Error("no usable logo on homepage");
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}
const writeList = (p, list) => fs.writeFile(p, "[\n" + list.map((x) => JSON.stringify(x)).join(",\n") + "\n]\n");

const drops = JSON.parse(await fs.readFile("drops.json", "utf8"));
const brands = JSON.parse(await fs.readFile("brands.json", "utf8"));
await fs.mkdir("covers/logos", { recursive: true });
const misses = [];
let got = 0;

await pool(drops.filter((d) => !d.cover && /^https:\/\//.test(d.url || "")), 4, async (d) => {
  const rel = "covers/" + slug(d.id || d.brand + "-" + d.date) + ".webp";
  try { d.ia = await cover(d.url, rel); d.cover = rel; got++; } catch (e) { misses.push(`drop  ${d.brand}: ${e.message}`); }
});

await pool(brands.filter((b) => !b.logo), 4, async (b) => {
  const rel = "covers/logos/" + slug(b.n) + ".webp";
  const why = [];
  try { b.la = await saveLogo(await wikidataLogo(b), rel); b.logo = rel; got++; return; } catch (e) { why.push("wikidata: " + e.message); }
  if (b.u) { try { b.la = await homepageLogo(b, rel); b.logo = rel; got++; return; } catch (e) { why.push("site: " + e.message); } }
  misses.push(`logo  ${b.n} (${b.u || "no site"}): ${why.join("; ")}`);
});

await fs.writeFile("drops.json", JSON.stringify(drops, null, 2) + "\n");
await writeList("brands.json", brands);
await fs.writeFile("covers/logos/MISSING.txt", misses.filter((m) => m.startsWith("logo")).sort().join("\n") + "\n");

const report = `Fetched ${got} images. ${misses.length} misses.\n\n` + misses.sort().join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, "```\n" + report + "\n```\n");
