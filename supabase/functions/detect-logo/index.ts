import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Finds a business's logo from its public website and hosts a copy in the
// signed-in user's own brand-assets folder. No provider key, no paid API.
// Input:  { website: "https://example.com" }
// Output: 200 { logo_url, source, source_url, alternatives } or 404 { error }
// It does NOT write to the profile. Visual Studio shows the result and the
// owner confirms and saves it.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 1_500_000;
const TIMEOUT_MS = 8000;
const MAX_TRIES = 6;
const UA = "Mozilla/5.0 (compatible; InsightForgeLogoFinder/1.0)";

type Candidate = { url: string; source: string; score: number };

// Refuse private and local addresses so this function cannot be pointed at internal services.
function blockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.includes(":")) return true; // IPv6 literals
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return !h.includes(".");
}

function normalizeWebsite(raw: string): URL | null {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (blockedHost(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function fetchLimited(url: string, max: number, accept: string): Promise<{ bytes: Uint8Array; type: string; finalUrl: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA, Accept: accept } });
    if (!res.ok) return null;
    const finalHost = new URL(res.url).hostname;
    if (blockedHost(finalHost)) return null;
    const bytes = await readLimited(res, max);
    if (!bytes) return null;
    return { bytes, type: (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(), finalUrl: res.url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

function firstSrcset(v: string): string {
  return v.split(",")[0]?.trim().split(/\s+/)[0] ?? "";
}

function findJsonLdLogos(html: string): string[] {
  const out: string[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const walk = (node: any) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== "object") return;
    const l = node.logo;
    if (typeof l === "string") out.push(l);
    else if (l && typeof l === "object" && typeof l.url === "string") out.push(l.url);
    for (const k of Object.keys(node)) if (typeof node[k] === "object") walk(node[k]);
  };
  while ((m = re.exec(html))) {
    try { walk(JSON.parse(m[1])); } catch { /* ignore bad JSON-LD */ }
  }
  return out;
}

function collectCandidates(html: string, base: string): Candidate[] {
  const found: Candidate[] = [];
  const add = (raw: string, source: string, score: number) => {
    if (!raw || raw.startsWith("data:")) return;
    try {
      const u = new URL(raw, base);
      if (u.protocol !== "https:" && u.protocol !== "http:") return;
      found.push({ url: u.toString(), source, score });
    } catch { /* skip bad URL */ }
  };

  for (const l of findJsonLdLogos(html)) add(l, "schema.org logo", 100);

  const headerMatch = html.match(/<header[\s\S]*?<\/header>/i) || html.match(/<nav[\s\S]*?<\/nav>/i);
  const headerHtml = headerMatch ? headerMatch[0] : "";
  const imgRe = /<img\b[^>]*>/gi;
  const scan = (chunk: string, inHeader: boolean) => {
    let m: RegExpExecArray | null;
    imgRe.lastIndex = 0;
    while ((m = imgRe.exec(chunk))) {
      const tag = m[0];
      const src = attr(tag, "src") || attr(tag, "data-src") || firstSrcset(attr(tag, "srcset"));
      const hint = (attr(tag, "class") + " " + attr(tag, "id") + " " + attr(tag, "alt") + " " + src).toLowerCase();
      if (!/logo|brand|wordmark/.test(hint)) continue;
      add(src, inHeader ? "header logo image" : "logo image on page", inHeader ? 90 : 80);
    }
  };
  if (headerHtml) scan(headerHtml, true);
  scan(html, false);

  const linkRe = /<link\b[^>]*>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html))) {
    const tag = lm[0];
    const rel = attr(tag, "rel").toLowerCase();
    const href = attr(tag, "href");
    if (!href) continue;
    if (rel.includes("apple-touch-icon")) add(href, "apple-touch-icon", 60);
    else if (rel.split(/\s+/).includes("icon") && !/\.ico(\?|$)/i.test(href)) {
      const size = parseInt((attr(tag, "sizes").split("x")[0] || "0"), 10) || 0;
      add(href, "site icon", 40 + Math.min(size / 100, 9));
    }
  }

  const metaRe = /<meta\b[^>]*>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = metaRe.exec(html))) {
    const tag = mm[0];
    const key = (attr(tag, "property") || attr(tag, "name")).toLowerCase();
    if (key === "og:image" || key === "og:image:url" || key === "twitter:image") add(attr(tag, "content"), "og:image", 30);
  }

  const seen = new Set<string>();
  return found
    .sort((a, b) => b.score - a.score)
    .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

function sniffType(bytes: Uint8Array, headerType: string): { mime: string; ext: string } | null {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { mime: "image/gif", ext: "gif" };
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { mime: "image/webp", ext: "webp" };
  }
  const head = new TextDecoder().decode(b.slice(0, 2000)).toLowerCase();
  if (headerType === "image/svg+xml" || head.includes("<svg")) {
    const all = new TextDecoder().decode(b).toLowerCase();
    if (all.includes("<script") || /\son[a-z]+\s*=/.test(all) || all.includes("javascript:")) return null;
    return { mime: "image/svg+xml", ext: "svg" };
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Authentication required" }, 401);

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const supabaseAuth = createClient(supabaseUrl, serviceRoleKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) return json({ error: "Invalid or expired authentication token" }, 401);

    const body = await req.json().catch(() => ({}));
    const site = normalizeWebsite(body.website);
    if (!site) return json({ error: "Enter a public website address, for example https://example.com" }, 400);

    const page = await fetchLimited(site.toString(), MAX_HTML_BYTES, "text/html,application/xhtml+xml");
    if (!page) return json({ error: "Could not open that website. Check the address and try again." }, 404);
    const html = new TextDecoder().decode(page.bytes);

    const candidates = collectCandidates(html, page.finalUrl).slice(0, MAX_TRIES);
    // Last resort: the common apple-touch-icon path.
    if (candidates.length === 0) {
      candidates.push({ url: new URL("/apple-touch-icon.png", page.finalUrl).toString(), source: "apple-touch-icon", score: 10 });
    }

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      let cu: URL;
      try { cu = new URL(c.url); } catch { continue; }
      if (blockedHost(cu.hostname)) continue;
      const img = await fetchLimited(c.url, MAX_IMAGE_BYTES, "image/*");
      if (!img || img.bytes.length < 200) continue;
      const kind = sniffType(img.bytes, img.type);
      if (!kind) continue;

      const path = `${user.id}/logo-${Date.now()}.${kind.ext}`;
      const { error: upErr } = await supabase.storage
        .from("brand-assets")
        .upload(path, img.bytes, { contentType: kind.mime, upsert: true });
      if (upErr) return json({ error: "Found a logo but could not save it: " + upErr.message }, 500);
      const { data: pub } = supabase.storage.from("brand-assets").getPublicUrl(path);
      if (!pub?.publicUrl) return json({ error: "Found a logo but could not get a public link for it." }, 500);

      return json({
        logo_url: pub.publicUrl,
        source: c.source,
        source_url: c.url,
        alternatives: candidates.filter((_, j) => j !== i).map((x) => ({ url: x.url, source: x.source })),
      });
    }

    return json({ error: "No logo found on that website. Use Replace to upload one." }, 404);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
