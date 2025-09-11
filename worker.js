// Cloudflare Worker: Hybrid Google Drive proxy (with resumable uploads)
// Endpoints:
// - GET  /images?folderId=FOLDER_ID
// - GET  /file/:id
// - POST /upload?folderId=FOLDER_ID         (multipart; small files)
// - POST /upload-stream?folderId=FOLDER_ID   (resumable; large files; streaming)
// - GET  /check-folder?folderId=FOLDER_ID
//
// Secrets (required for legacy SA path if you keep it around):
// - GOOGLE_SERVICE_EMAIL (or GOOGLE_SERVICE_ACCOUNT_EMAIL)
// - GOOGLE_PRIVATE_KEY
//
// Bot OAuth (USED):
// - GOOGLE_OAUTH_CLIENT_ID
// - GOOGLE_OAUTH_CLIENT_SECRET
// - GOOGLE_OAUTH_REFRESH_TOKEN
//
// Optional:
// - CORS_ORIGIN = https://acs-catalogue-app.pages.dev   (or your Pages origin)

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // CORS: allow fixed origin or reflect the request's Origin (if CORS_ORIGIN="*")
    const reqOrigin = req.headers.get("Origin") || "";
    const origin =
      env.CORS_ORIGIN && env.CORS_ORIGIN !== "*"
        ? env.CORS_ORIGIN
        : (reqOrigin || "*");

    // ---------- Preflight ----------
    if (req.method === "OPTIONS") {
      const reqHdrs = req.headers.get("Access-Control-Request-Headers") || "";
      return new Response(null, {
        headers: {
          ...corsHeaders(origin),
          "Access-Control-Allow-Headers":
            reqHdrs ||
            // If you want to keep Authorization allowed, add it back here
            "Content-Type, X-Requested-With, X-File-Name, X-Upload-Content-Length, X-Upload-Meta",
          Vary: "Origin, Access-Control-Request-Headers",
        },
      });
    }

    // ---------- Health ----------
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(
        "Drive proxy is up. Endpoints: GET /images?folderId=.., GET /file/:id, POST /upload, POST /upload-stream, GET /check-folder",
        { headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders(origin) } }
      );
    }

    // ---------- READ: /images ----------
    if (req.method === "GET" && url.pathname === "/images") {
      return handleImagesWithApiKey(req, env, origin);
    }

    // ---------- READ: /file/:id ----------
    const m = url.pathname.match(/^\/file\/([a-zA-Z0-9_-]+)$/);
    if ((req.method === "GET" || req.method === "HEAD") && m) {
      return handleFileProxyWithApiKey(req, env, origin, m[1]);
    }

    // ---------- OAuth helper endpoints (temporary, useful for minting a new refresh_token) ----------
    if (req.method === "GET" && url.pathname === "/oauth2/start") {
      const params = new URLSearchParams({
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: `${url.origin}/oauth2/callback`,
        response_type: "code",
        access_type: "offline",
        prompt: "consent", // force refresh token issuance
        scope: "https://www.googleapis.com/auth/drive", // or narrower: drive.file (+ drive.readonly if you list existing)
      });
      return Response.redirect(
        `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
        302
      );
    }

    if (req.method === "GET" && url.pathname === "/oauth2/callback") {
      const code = url.searchParams.get("code") || "";
      if (!code) return json({ error: "missing_code" }, 400, origin);

      const body = new URLSearchParams({
        code,
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: `${url.origin}/oauth2/callback`,
        grant_type: "authorization_code",
      });

      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const t = await r.json(); // NOTE: refresh_token appears only on the first consent for this client+user
      return json({ status: r.status, token: t }, r.status, origin);
    }
    // ---------- END OAuth helpers ----------

    // ---------- UPLOADS ----------
    if (req.method === "POST" && url.pathname === "/upload-stream") {
      return handleUploadStream(req, env, origin); // resumable + streaming (recommended)
    }
    if (req.method === "POST" && url.pathname === "/upload") {
      return handleUploadWithServiceAccount(req, env, origin); // legacy multipart
    }

    // ---------- DIAGNOSTIC ----------
    if (req.method === "GET" && url.pathname === "/check-folder") {
      return handleCheckFolder(req, env, origin);
    }

    // ---------- whoami ----------
    if (req.method === "GET" && url.pathname === "/whoami") {
      const token = await getAnyAccessToken(req, env);
      const r = await fetch(
        "https://www.googleapis.com/drive/v3/about?fields=user",
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const j = await r.json();
      return json({ status: r.status, user: j.user }, 200, origin);
    }

    // ---------- NEW: Recognition & Vectorize ----------
    if (req.method === "POST" && url.pathname === "/recognition/upsert") {
      return recognitionUpsert(req, env, origin);
    }
    if (req.method === "POST" && url.pathname === "/recognition/query") {
      return recognitionQuery(req, env, origin);
    }
    // ---------- Item-level aggregate query ----------
    if (req.method === "POST" && url.pathname === "/recognition/query-items") {
     try {
      const body = await req.json();
      const topKPhotos = Math.min(Number(body.topKPhotos || 100), 500);
      const topKItems  = Math.min(Number(body.topKItems  || 5), 50);
          // Preflight sanity checks so we return a clear error instead of a generic 500
    if (!env.USE_VERTEX) {
      return corsJson({ ok: false, error: "USE_VERTEX is not set" }, 400, origin);
    }
    // Minimal GCP creds checks (either GCP_SA_JSON, or email+key pair)
    const hasJson = !!env.GCP_SA_JSON;
    const hasPair = !!env.GCP_SA_EMAIL && !!env.GCP_SA_PKEY;
    if (!env.GCP_PROJECT || !(hasJson || hasPair)) {
      return corsJson(
        { ok: false, error: "Vertex credentials not configured (set GCP_PROJECT and either GCP_SA_JSON or GCP_SA_EMAIL + GCP_SA_PKEY)" },
        500,
        origin
      );
    }

      let qvec;
      if (body.fileId) {
        const img = await fetchDriveFileBytesById(env, String(body.fileId));
        qvec = await embedImageVertex(env, img);
      } else if (body.bytesBase64) {
        let bin;
        try {
          const raw = atob(String(body.bytesBase64));
          const arr = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
          bin = arr;
        } catch (_) {
          return corsJson({ ok: false, error: "invalid_base64" }, 400, origin);
        }
        qvec = await embedImageVertex(env, bin);
      } else {
        return corsJson({ ok:false, error:"fileId or bytesBase64 required" }, 400, origin);
      }
  

    const qRes = await vecQueryREST(env, qvec, topKPhotos, undefined); // your boolean returnMetadata path
    const hits = qRes?.matches || qRes?.hits || [];

    const byItem = new Map(); // itemId -> { label, hits:[] }
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const id = h.id || h.vector_id || h.vectorId;
      const score = Number(h.score || h.similarity || 0);
      const md = h.metadata || {};
      const itemId = normalizeItemId(md.itemId || md.item_id || null);
      const label  = md.label || null;
      if (!itemId) continue;
      const cur = byItem.get(itemId) || { label, hits: [] };
      cur.hits.push({ id, score });
      if (!cur.label && label) cur.label = label;
      byItem.set(itemId, cur);
    }

    const items = [];
    for (const [itemId, v] of byItem.entries()) {
      v.hits.sort((a,b) => b.score - a.score);
      const m = Math.min(3, v.hits.length);
      let agg = 0;
      for (let i = 0; i < m; i++) {
        const w = 1 / Math.log2(1 + (i + 2)); // ~1.0, 0.63, 0.5
        agg += v.hits[i].score * w;
      }
      items.push({
        itemId,
        label: v.label || null,
        score: Number(agg.toFixed(5)),
        best: v.hits[0]?.score || 0,
        coverId: v.hits[0]?.id || null,
        hits: v.hits.slice(0, 3),
      });
    }
    items.sort((a,b) => b.score - a.score || b.best - a.best);
    return corsJson({ ok: true, items: items.slice(0, topKItems) }, 200, origin);
  } catch (e) {
    return corsJson({ ok:false, error: String(e?.message || e) }, 500, origin);

  }
}

if (req.method === "POST" && url.pathname === "/recognition/admin/reindex") {
  try { requireAdmin(req, env); } catch (resp) { return withCors(resp, origin); }
  return recognitionBulkReindex(req, env, origin);
}

// GET /recognition/admin/reindex/diag
if (req.method === "GET" && url.pathname === "/recognition/admin/reindex/diag") {
  try { requireAdmin(req, env); } catch (resp) { return withCors(resp, origin); }
  try {
    const rootId = env.TRAINING_ROOT_FOLDER_ID || null;
    let folders = [];
    let err = null;
    if (!rootId) {
      err = "TRAINING_ROOT_FOLDER_ID not set";
    } else {
      try {
        folders = await driveListItemFolders(env);
      } catch (e) {
        err = String(e?.message || e);
      }
    }
    return corsJson({
      ok: true,
      rootId,
      canList: !!folders.length,
      count: folders.length,
      sample: folders.slice(0, 20).map(f => ({ id: f.id, name: f.name }))
    }, 200, origin);
  } catch (e) {
    return corsJson({ ok:false, error:String(e?.message||e) }, 500, origin);
  }
}
    // GET /recognition/admin/reindex/peek?folderId=...
    if (req.method === "GET" && url.pathname === "/recognition/admin/reindex/peek") {
      try { requireAdmin(req, env); } catch (resp) { return withCors(resp, origin); }
      try {
        const urlObj = new URL(req.url);
        const folderId = urlObj.searchParams.get("folderId");
        if (!folderId) return corsJson({ ok:false, error:"folderId required" }, 400, origin);

        const meta  = await readItemJson(env, folderId);
        const files = await driveListImagesWithMeta(env, folderId);

        return corsJson({
          ok: true,
          meta,
          count: files.length,
          sample: files.slice(0, 20).map(f => ({
            id: f.id, name: f.name, mimeType: f.mimeType,
            modifiedTime: f.modifiedTime, md5Checksum: f.md5Checksum
          }))
        }, 200, origin);
      } catch (e) {
        return corsJson({ ok:false, error:String(e?.message||e) }, 500, origin);
      }
    }

        // GET /recognition/admin/reindex/status
        if (req.method === "GET" && url.pathname === "/recognition/admin/reindex/status") {
          try { requireAdmin(req, env); } catch (resp) { return withCors(resp, origin); }
          const status = await kvGetStatus(env);
          return corsJson({ ok: true, status }, 200, origin);
        }
    

    // ---------- health (temporary) ----------
    if (req.method === "GET" && url.pathname === "/recognition/health") {
      return recognitionHealth(req, env, origin);
    }    
        // POST /recognition/admin/reindex/refresh-folders
        if (req.method === "POST" && url.pathname === "/recognition/admin/reindex/refresh-folders") {
          try { requireAdmin(req, env); } catch (resp) { return withCors(resp, origin); }
          try {
            const folders = await driveListItemFolders(env);
            const ids = folders.map(f => f.id);
            await kvSetFolderIds(env, ids);
            // reset cursor to 0 so we start from the beginning of the new list
            const status = await kvGetStatus(env);
            await kvSetStatus(env, { ...(status || {}), cursor: 0, totalFolders: ids.length, lastRefresh: new Date().toISOString() });
            return corsJson({ ok: true, totalFolders: ids.length }, 200, origin);

          } catch (e) {
            return corsJson({ ok:false, error: String(e?.message || e) }, 500, origin);
          }
        }
        // POST /recognition/admin/reindex/run?limitFolders=&maxChanged=&stateless=1&start=0
if (req.method === "POST" && url.pathname === "/recognition/admin/reindex/run") {
  try { requireAdmin(req, env); } catch (resp) { return withCors(resp, origin); }
  try {
    const u = new URL(req.url);
    const limitFolders = Math.max(1, Math.min(Number(u.searchParams.get("limitFolders") || 5), 100));
    const maxChanged   = Math.max(0, Number(u.searchParams.get("maxChanged") || 150));
    const stateless    = u.searchParams.get("stateless") === "0";
    const start        = Math.max(0, Number(u.searchParams.get("start") || 0));

    let counts, cursor, totalFolders, nextStart;

    if (stateless) {
      // Stateless: list once per call, sort for stable order, no KV writes anywhere
      const folders = await driveListItemFolders(env);
      folders.sort((a,b) => String(a.name||"").localeCompare(String(b.name||"")));
      totalFolders = folders.length;

      const toProcess = Math.min(limitFolders, totalFolders);
      const end = Math.min(start + toProcess, totalFolders);
      const slice = folders.slice(start, end);

      counts = { folders: 0, scanned: 0, changed: 0, skipped: 0 };

      for (const f of slice) {
        if (counts.changed >= maxChanged) break;

        // Minimal meta; avoid extra calls if not needed
        let meta = await readItemJson(env, f.id);
        if (!meta || !meta.itemId) meta = { itemId: null, label: null };

        const remaining = Math.max(0, maxChanged - counts.changed);
        const r = await reindexFolderIncremental(env, f.id, meta, {
          maxChanged: remaining,
          writeSeen: maxChanged > 0 ? true : false // never write seen if "dry-run"
        });

        counts.folders++;
        counts.scanned += r.scanned|0;
        counts.changed += r.changed|0;
        counts.skipped += r.skipped ? 1 : 0;

        if (counts.changed >= maxChanged) break;
      }

      nextStart = (start + counts.folders) % Math.max(1, totalFolders);

      // No kvSetStatus here (stateless)
      return corsJson({ ok: true, counts, start, nextStart, totalFolders, mode: "stateless" }, 200, origin);
    } else {
      // Stateful: use your existing reindexNightly, but skip status writes on dry-run
      const res = await reindexNightly(env, {
        limitFolders,
        maxChanged,
        // signal reindexNightly to avoid kvSetStatus on dry-run
        updateStatus: maxChanged > 0
      });
      return corsJson({ ok: true, ...res, mode: "stateful" }, 200, origin);
    }
  } catch (e) {
    return corsJson({ ok:false, error: String(e?.message || e) }, 500, origin);
  }
}

    
    // ---------- Vectorize admin (browser-only management) ----------
    if (req.method === "GET" && url.pathname === "/admin/vectorize/list") {
      return vecList(env, origin);
    }
    if (req.method === "POST" && url.pathname === "/admin/vectorize/create") {
      return vecCreate(req, env, origin);
    }
    if (req.method === "DELETE" && url.pathname === "/admin/vectorize/delete") {
      return vecDelete(req, env, origin);
    }
    if (req.method === "POST" && url.pathname === "/admin/vectorize/create-1408") {
      return createVec1408(req, env, origin);
    }

    return json({ error: "not_found" }, 404, origin);
  },

  // Nightly cron (Cloudflare → Triggers → Cron e.g. "0 9 * * *")
  async scheduled(event, env, ctx) {
    // Do EXACTLY one stateful pass, same as manual:
    // POST /recognition/admin/reindex/run?limitFolders=1&maxChanged=12
    // (We call reindexNightly directly, which is the same stateful path.)
    ctx.waitUntil(
      reindexNightly(env, {
        limitFolders: 1,
        maxChanged: 12,
        forceStatus: true, // advance cursor even if no changes
      })
    );
  },    
};

function requireAdmin(req, env) {
  const token = req.headers.get("x-admin-token") || req.headers.get("X-Admin-Token");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    throw new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json" }
    });
  }
}

// ---------------- READ: /images (API key) ----------------
async function handleImagesWithApiKey(req, env, origin) {
  const url = new URL(req.url);
  const folderId = (url.searchParams.get("folderId") || "").trim();
  if (!folderId) return corsJson({ media: [], view: [], count: 0, folderId: "" }, 200, origin);

  const cache = caches.default;
  const cacheKey = new Request(req.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached, origin);

  const token = await getAnyAccessToken(req, env);

  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and mimeType contains 'image/'`);
  const fields = encodeURIComponent("nextPageToken, files(id,name,mimeType)");
  const orderBy = encodeURIComponent("name");

  let pageToken = "";
  const ids = [];

  for (let safety = 0; safety < 50; safety++) {
    const listUrl =
      `https://www.googleapis.com/drive/v3/files?q=${q}` +
      `&fields=${fields}&orderBy=${orderBy}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");

    const r = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      return corsJson(
        { error: `Drive list error: HTTP ${r.status}`, media: [], view: [], count: 0, folderId },
        502,
        origin
      );
    }
    const data = await r.json();
    (data.files || []).forEach((f) => ids.push(f.id));
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }

  const base = new URL(req.url).origin;
  const media = ids.map((id) => `${base}/file/${id}`);
  const view = ids.map((id) => `https://drive.google.com/uc?export=view&id=${id}`);

  const resp = corsJson(
    { media, view, count: ids.length, folderId },
    200,
    origin,
    { "cache-control": "public, max-age=300, s-maxage=300" }
  );
  await cache.put(cacheKey, resp.clone());
  return resp;
}

// ===== Nightly Reindex: KV + utils =====
const STATUS_KEY = "reindex:status";
const SEEN_PREFIX = "seen:"; // seen:<fileId> -> { md5Checksum, modifiedTime }

function normalizeItemId(raw) {
  const s = String(raw ?? "").replace(/\D+/g, "");
  if (!s) return null;
  return s.padStart(4, "0");
}

async function kvGetSeen(env, fileId) {
  const txt = await env.REINDEX_KV.get(SEEN_PREFIX + fileId);
  return txt ? JSON.parse(txt) : null;
}
async function kvSetSeen(env, fileId, sig) {
  await env.REINDEX_KV.put(SEEN_PREFIX + fileId, JSON.stringify(sig));
}
async function kvGetStatus(env) {
  const txt = await env.REINDEX_KV.get(STATUS_KEY);
  return txt ? JSON.parse(txt) : { lastRun: null, counts: {} };
}
async function kvSetStatus(env, status) {
  await env.REINDEX_KV.put(STATUS_KEY, JSON.stringify(status));
}
// Persisted list of all item folder IDs to avoid re-listing Drive every run
const FOLDER_IDS_KEY = "reindex:folder_ids"; // JSON array of folderId strings

async function kvGetFolderIds(env) {
  if (!env.REINDEX_KV) return [];
  const txt = await env.REINDEX_KV.get(FOLDER_IDS_KEY);
  if (!txt) return [];
  try {
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function kvSetFolderIds(env, ids) {
  if (!env.REINDEX_KV) return;
  await env.REINDEX_KV.put(FOLDER_IDS_KEY, JSON.stringify(Array.isArray(ids) ? ids : []));
}

const SEEN_MAP_PREFIX = "seenmap:"; // seenmap:<folderId> -> { [fileId]: { md5Checksum, modifiedTime } }

async function kvGetFolderSeenMap(env, folderId) {
  if (!env.REINDEX_KV) return {};
  const txt = await env.REINDEX_KV.get(SEEN_MAP_PREFIX + folderId);
  return txt ? JSON.parse(txt) : {};
}
async function kvPutFolderSeenMap(env, folderId, map) {
  if (!env.REINDEX_KV) return;
  await env.REINDEX_KV.put(SEEN_MAP_PREFIX + folderId, JSON.stringify(map));
}


// Use your existing token path (works both in requests & cron)
async function getBackendAccessToken(env) {
  return getAnyAccessToken(new Request("https://backend.local"), env);
}
// List subfolders under TRAINING_ROOT_FOLDER_ID (one folder per item)
async function driveListItemFolders(env) {
  const rootId = env.TRAINING_ROOT_FOLDER_ID;
  if (!rootId) throw new Error("TRAINING_ROOT_FOLDER_ID not set");
  const token = await getBackendAccessToken(env);
  const q = encodeURIComponent(`'${rootId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`);
  const fields = encodeURIComponent("files(id,name,mimeType),nextPageToken");
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`;

  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`drive_list_folders_failed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.files || [];
}

// Read Item####.json from an item folder (fallback: any *.json)
async function readItemJson(env, folderId) {
  const token = await getBackendAccessToken(env);
  // First try: Item*.json
  const q1 = encodeURIComponent(`'${folderId}' in parents and trashed=false and name contains 'Item' and name contains '.json'`);
  const fields = encodeURIComponent("files(id,name),nextPageToken");
  let r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q1}&fields=${fields}&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true`,
  { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  let d = await r.json();
  let f = d.files?.[0];

  // Second try: any .json
  if (!f) {
    const q2 = encodeURIComponent(`'${folderId}' in parents and trashed=false and name contains '.json'`);
    r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q2}&fields=${fields}&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true`,
  { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    d = await r.json(); f = d.files?.[0];
  }
  if (!f) return null;

  const jr = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!jr.ok) return null;
  try { return await jr.json(); } catch { return null; }
}

// Derive item meta from folder name "0001" or "0001-Anything"
function deriveItemMetaFromFolderName(name) {
  const id = normalizeItemId(name);
  return id ? { itemId: id, label: null } : { itemId: null, label: null };
}

// List images in an item folder (+ optional 'sorted' subfolder)
async function driveListImagesWithMeta(env, folderId) {
  const token = await getBackendAccessToken(env);
  const fields = encodeURIComponent("files(id,name,md5Checksum,modifiedTime,mimeType),nextPageToken");
  const list = async (parentId) => {
    const q = encodeURIComponent(`'${parentId}' in parents and trashed=false and (mimeType contains 'image/')`);
    const u = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`drive_list_files_failed ${r.status}: ${await r.text()}`);
    const d = await r.json();
    return d.files || [];
  };
  let files = await list(folderId);

  // include "sorted" subfolder if present
  const qSorted = encodeURIComponent(
    `name='sorted' and '${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const r2 = await fetch(`https://www.googleapis.com/drive/v3/files?q=${qSorted}&fields=${fields}&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`,
  { headers: { Authorization: `Bearer ${token}` } });
  if (r2.ok) {
    const d2 = await r2.json();
    const sortedF = d2.files?.[0];
    if (sortedF) files = files.concat(await list(sortedF.id));
  }
  return files;
}

// --------------- READ: /file/:id (API key) ---------------
async function handleFileProxyWithApiKey(req, env, origin, id) {
  const cache = caches.default;

  if (req.method === "GET") {
    const cached = await cache.match(req);
    if (cached) return withCors(cached, origin);
  }

  const token = await getAnyAccessToken(req, env);

  const googleUrl = `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
  const upstream = await fetch(googleUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Range: req.headers.get("Range") || undefined,
    },
  });

  const h = new Headers(upstream.headers);
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Timing-Allow-Origin", origin);
  h.set("Cross-Origin-Resource-Policy", "cross-origin");
  h.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
  const cd = h.get("content-disposition") || "";
  if (!cd || /attachment/i.test(cd)) h.set("content-disposition", 'inline; filename="image"');
  if (!h.get("content-type")) h.set("content-type", "image/jpeg");

  const resp = new Response(req.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: h,
  });

  if (req.method === "GET" && upstream.ok) await cache.put(req, resp.clone());
  return resp;
}

// --------------- UPLOAD (legacy multipart) ---------------
async function handleUploadWithServiceAccount(req, env, origin) {
  const url = new URL(req.url);
  const ctype = req.headers.get("Content-Type") || "";
  let form = null;

  if (ctype.includes("multipart/form-data")) {
    form = await req.formData();
  }

  let folderId =
    (url.searchParams.get("folderId") || "").trim() ||
    (form && (form.get("folderId") || "").toString().trim()) ||
    (env.UPLOAD_INBOX_FOLDER || "").trim();

  if (!folderId) return json({ error: "folderId required" }, 400, origin);

  let fileBlob = null;
  if (form) {
    const f = form.get("file");
    if (f && f instanceof File) fileBlob = f;
    else return json({ error: "multipart_missing_file_field" }, 400, origin);
  } else {
    if (!ctype.startsWith("image/")) return json({ error: "unsupported_content_type" }, 415, origin);
    const buf = await req.arrayBuffer();
    const ext = ctype.split("/")[1] || "jpg";
    fileBlob = new File([buf], `upload_${Date.now()}.${ext}`, { type: ctype });
  }

  const token = await getAnyAccessToken(req, env);

  const appProps = form ? tryParseAppMeta(form.get("meta")) : undefined;

  const boundary = "----driveUpload" + Math.random().toString(36).slice(2);
  const meta = {
    name: fileBlob.name,
    parents: [folderId],
    mimeType: fileBlob.type || "application/octet-stream",
    ...(appProps ? { appProperties: appProps } : {}),
  };

  const enc = new TextEncoder();
  const part1 =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(meta)}\r\n`;
  const part2 =
    `--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`;
  const end = `\r\n--${boundary}--\r\n`;

  const body = new Blob([enc.encode(part1), enc.encode(part2), fileBlob, enc.encode(end)], {
    type: `multipart/related; boundary=${boundary}`,
  });

  const upUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true";
  const r = await fetch(upUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!r.ok) {
    const t = await r.text();
    return json({ error: "upload_failed", status: r.status, detail: t }, r.status, origin);
  }

  const uploaded = await r.json();
  const file = {
    id: uploaded.id,
    name: uploaded.name,
    media: `${url.origin}/file/${uploaded.id}`,
    view: `https://drive.google.com/uc?export=view&id=${uploaded.id}`,
  };
  return json({ ok: true, file }, 200, origin);
}

// --------------- UPLOAD (resumable + streaming) ---------------
async function handleUploadStream(req, env, origin) {
  const url = new URL(req.url);
  const folderId =
    (url.searchParams.get("folderId") || "").trim() ||
    (env.UPLOAD_INBOX_FOLDER || "").trim();

  if (!folderId) return json({ error: "folderId required" }, 400, origin);

  const contentType = req.headers.get("Content-Type") || "application/octet-stream";
  const sizeHeader =
    req.headers.get("X-Upload-Content-Length") ||
    req.headers.get("Content-Length") ||
    "";
  const fileSize = Number(sizeHeader) > 0 ? Number(sizeHeader) : undefined;
  const fileNameRaw = req.headers.get("X-File-Name") || `upload_${Date.now()}`;
  const fileName = decodeURIComponent(fileNameRaw);
  const appProps = tryParseAppMeta(req.headers.get("X-Upload-Meta"));

  const token = await getAnyAccessToken(req, env);

  // 1) Create resumable session
  const initUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";
  const initMeta = {
    name: fileName,
    parents: [folderId],
    mimeType: contentType,
    ...(appProps ? { appProperties: appProps } : {}),
  };
  const initHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=UTF-8",
    "X-Upload-Content-Type": contentType,
  };
  if (fileSize) initHeaders["X-Upload-Content-Length"] = String(fileSize);

  const init = await fetch(initUrl, {
    method: "POST",
    headers: initHeaders,
    body: JSON.stringify(initMeta),
  });
  if (!init.ok) {
    const t = await init.text();
    return json({ error: "resumable_init_failed", status: init.status, detail: t }, init.status, origin);
  }
  const session = init.headers.get("Location");
  if (!session) return json({ error: "missing_session_location" }, 502, origin);

  // 2) Stream to Drive in fixed-size chunks using Content-Range
  try {
    const { uploaded } = await uploadResumableInChunks({
      sessionUrl: session,
      stream: req.body,
      totalBytes: fileSize,           // may be undefined; we’ll still finish cleanly
      chunkSize: 1024 * 1024,         // 1 MiB (multiple of 256 KiB, as Drive requires)
      contentType,
    });
    const file = {
      id: uploaded.id,
      name: uploaded.name,
      media: `${url.origin}/file/${uploaded.id}`,
      view: `https://drive.google.com/uc?export=view&id=${uploaded.id}`,
    };
    return json({ ok: true, file }, 200, origin);
  } catch (e) {
    return json({ error: "resumable_upload_failed", detail: String(e) }, 502, origin);
  }
}

// --------------- DIAGNOSTIC: /check-folder ---------------
async function handleCheckFolder(req, env, origin) {
  const url = new URL(req.url);
  const folderId = (url.searchParams.get("folderId") || "").trim();
  if (!folderId) return json({ error: "folderId required" }, 400, origin);

  let token;
  try {
    token = await getAnyAccessToken(req, env);
  } catch (e) {
    return json({ error: "token_error", detail: String(e) }, 500, origin);
  }

  const metaUrl =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}` +
    `?fields=id,name,mimeType,parents&supportsAllDrives=true`;

  const r = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await r.text();
  let body = null;
  try { body = JSON.parse(txt); } catch { body = txt; }

  return json({ status: r.status, result: body }, 200, origin);
}

// -------------------- helpers --------------------
function tryParseAppMeta(v) {
  if (!v) return undefined;
  try { return JSON.parse(String(v)); } catch { return undefined; }
}

// === Token helpers ===

// Bot-user OAuth: exchange GOOGLE_OAUTH_REFRESH_TOKEN -> access_token
async function getBotAccessToken(env) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!r.ok) throw new Error(`bot_refresh_failed_${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (!j.access_token) throw new Error("bot_missing_access_token");
  return j.access_token;
}

// FORCE WORKER-LEVEL AUTH with a single bot user (OAuth refresh)
async function getAnyAccessToken(req, env) {
  return getBotAccessToken(env);
}

// Legacy helpers below are kept for reference; safe to delete later if you like.

// Pull Bearer token from Authorization header (unused now)
function getBearerFromHeader(req) {
  const auth = req.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

// Read an 'oauth_token' cookie (unused now)
function getCookie(req, name) {
  const raw = req.headers.get("Cookie") || "";
  const parts = raw.split(/; */);
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (k && v && k.trim() === name) return decodeURIComponent(v);
  }
  return null;
}

function getCookieAccessToken(req) {
  return getCookie(req, "oauth_token");
}

// Service Account access (not used in bot mode)
let tokenCache = null;
async function getServiceAccountAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp - 60 > now) return tokenCache.token;

  const iss = env.GOOGLE_SERVICE_EMAIL || env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!iss) throw new Error("Missing GOOGLE_SERVICE_EMAIL");

  let pk = env.GOOGLE_PRIVATE_KEY || "";
  if (pk.includes("\\n")) pk = pk.replace(/\\n/g, "\n");

  const iat = now;
  const exp = now + 3600;
  const scope = "https://www.googleapis.com/auth/drive";

  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = { iss, scope, aud: "https://oauth2.googleapis.com/token", iat, exp };

  const enc = (obj) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${enc(header)}.${enc(claimSet)}`;

  const key = await importPKCS8(pk, "RSASSA-PKCS1-v1_5");
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${b64urlEncode(new Uint8Array(sig))}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" +
      encodeURIComponent(jwt),
  });
  if (!resp.ok) throw new Error(`Token error ${resp.status}: ${await resp.text()}`);
  const tok = await resp.json();
  tokenCache = { token: tok.access_token, exp: now + Number(tok.expires_in || 3600) };
  return tokenCache.token;
}

function b64urlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function importPKCS8(pem, algo) {
  const pemBody = pem
    .replace(/-----BEGIN [\w\s]+-----/g, "")
    .replace(/-----END [\w\s]+-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0)).buffer;
  return crypto.subtle.importKey("pkcs8", der, { name: algo, hash: "SHA-256" }, false, ["sign"]);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS,POST,DELETE",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Requested-With, X-File-Name, X-Upload-Content-Length, X-Upload-Meta, X-Admin-Token",
    "Access-Control-Expose-Headers": "Content-Type, Location",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(resp, origin) {
  const h = new Headers(resp.headers);
  const cors = corsHeaders(origin);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: h });
}

function corsJson(data, status = 200, origin = "*", extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

async function uploadResumableInChunks({ sessionUrl, stream, totalBytes, chunkSize, contentType }) {
  if (!stream || !stream.getReader) throw new Error("ReadableStream body required");
  const reader = stream.getReader();
  let offset = 0;
  let buffer = new Uint8Array(0);

  while (true) {
    // Fill buffer up to chunkSize (or until stream ends)
    while (buffer.length < chunkSize) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = concatBytes(buffer, value);
    }
    if (buffer.length === 0) break;

    const start = offset;
    const end = offset + buffer.length - 1;
    const totalStr = totalBytes ? String(totalBytes) : "*";
    const contentRange = `bytes ${start}-${end}/${totalStr}`;

    const put = await fetch(sessionUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType || "application/octet-stream",
        "Content-Length": String(buffer.length),
        "Content-Range": contentRange,
      },
      body: buffer,
    });

    if (put.status === 308) {
      // Partial accepted; Drive tells us what it has via Range header (bytes=0-n)
      const range = put.headers.get("Range");
      const acknowledgedEnd = range ? parseInt((range.match(/bytes=\d+-(\d+)/) || [,"-1"])[1], 10) : (end);
      offset = acknowledgedEnd + 1;
      buffer = new Uint8Array(0);
      continue;
    }

    if (put.ok) {
      // Upload complete: returns File resource
      const uploaded = await put.json();
      return { uploaded };
    }

    const errText = await put.text();
    throw new Error(`Chunk PUT failed (${put.status}): ${errText}`);
  }

  // If we exited without 200/201 (unknown total), finalize with zero-length PUT
  const finalize = await fetch(sessionUrl, {
    method: "PUT",
    headers: {
      "Content-Length": "0",
      "Content-Range": `bytes */${totalBytes ?? "*"}`,
    },
  });
  if (!finalize.ok) {
    const t = await finalize.text();
    throw new Error(`Finalize failed (${finalize.status}): ${t}`);
  }
  const uploaded = await finalize.json();
  return { uploaded };
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ==== Vectorize v2 REST fallbacks (use when binding isn't available) ====
// Requires env.ACCOUNT_ID (variable), env.CF_API_TOKEN (secret), env.VECTORIZE_INDEX_NAME (variable)
async function vecUpsertREST(env, entries) {
  const accountId = env.ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  const indexName = env.VECTORIZE_INDEX_NAME;
  if (!accountId || !token || !indexName) {
    throw new Error("Vectorize REST missing ACCOUNT_ID / CF_API_TOKEN / VECTORIZE_INDEX_NAME");
  }

  // Vectorize REST prefers NDJSON for upserts: one JSON object per line
  // Example line: {"id":"abc","values":[...],"metadata":{...}}
  const ndjson = entries.map(e => JSON.stringify(e)).join("\n");

  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/indexes/${encodeURIComponent(indexName)}/upsert`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/x-ndjson",
      },
      body: ndjson,
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`vectorize_upsert_rest_failed ${r.status}: ${t}`);
  }
  return r.json();
}


async function vecQueryREST(env, vector, topK = 5, filter = undefined) {
  const accountId = env.ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  const indexName = env.VECTORIZE_INDEX_NAME;
  if (!accountId || !token || !indexName) {
    throw new Error("Vectorize REST missing ACCOUNT_ID / CF_API_TOKEN / VECTORIZE_INDEX_NAME");
  }
  const payload = {
    vector,
    topK,
    returnValues: false,
    returnMetadata: true, // REST expects boolean
  };
  
  if (filter) payload.filter = filter;

  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/indexes/${encodeURIComponent(indexName)}/query`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`vectorize_query_rest_failed ${r.status}: ${t}`);
  }
  const j = await r.json();
  const rows = j?.result?.matches || j?.result?.vectors || j?.result || [];
  return { matches: rows.map(m => ({ id: m.id, score: m.score ?? m.distance ?? null, metadata: m.metadata || {} })) };
}

// ---------- Vectorize admin helpers (list/create/delete) ----------
async function vecList(env, origin) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/vectorize/indexes`, {
    headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` }
  });
  const resp = new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": r.headers.get("content-type") || "application/json" }
  });
  return withCors(resp, origin);
}

// POST /admin/vectorize/create?name=acs-recognition-1408&dims=1408&metric=cosine
async function vecCreate(req, env, origin) {
  const u = new URL(req.url);
  const name = u.searchParams.get("name") || "acs-recognition-1408";
  const dims = Number(u.searchParams.get("dims") || 1408);
  const metric = u.searchParams.get("metric") || "cosine";

  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/vectorize/indexes`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name, config: { dimensions: dims, metric, type: "flat" }, description: `Created from Worker; ${dims}d ${metric}` })
  });

  const resp = new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": r.headers.get("content-type") || "application/json" }
  });
  return withCors(resp, origin);
}

// DELETE /admin/vectorize/delete?name=acs-recognition
async function vecDelete(req, env, origin) {
  const u = new URL(req.url);
  const name = u.searchParams.get("name");
  if (!name) {
    return corsJson({ success:false, error:"name required" }, 400, origin);
  }
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/vectorize/indexes/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` }
  });
  const resp = new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": r.headers.get("content-type") || "application/json" }
  });
  return withCors(resp, origin);
}

// One-off helper you already invoked earlier (kept for convenience)
async function createVec1408(req, env, origin) {
  try {
    const accountId = env.ACCOUNT_ID;
    const token     = env.CF_API_TOKEN;
    if (!accountId || !token) {
      return corsJson?.({ ok:false, error:"Missing ACCOUNT_ID / CF_API_TOKEN" }, 400, origin)
          || new Response(JSON.stringify({ ok:false, error:"Missing ACCOUNT_ID / CF_API_TOKEN" }), { status:400 });
    }

    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/indexes`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: "acs-recognition-1408",
        config: {
          dimensions: 1408,
          metric: "cosine",
          type: "flat"
        }
      })
    });

    const txt = await r.text();
    return new Response(txt, {
      status: r.status,
      headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return corsJson?.({ ok:false, error:String(e) }, 500, origin)
        || new Response(JSON.stringify({ ok:false, error:String(e) }), { status:500 });
  }
}

// === TEMP: health probe (Vertex-only) ===
async function recognitionHealth(req, env, origin) {
  try {
    const url = new URL(req.url);
    const fileId = url.searchParams.get("fileId");

    if (!env.USE_VERTEX) {
      return corsJson({ ok: false, error: "USE_VERTEX is not set" }, 400, origin);
    }

    // Use a real Drive image if provided; Vertex sometimes rejects synthetic 1x1s
    let bytes;
    if (fileId) {
      bytes = await fetchDriveFileBytesById(env, fileId);
    } else {
      // Known-good minimal JPEG (1x1)
      bytes = Uint8Array.from([
        0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,0x01,0x01,0x00,0x60,0x00,0x60,0x00,0x00,
        0xFF,0xDB,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,0x07,0x07,0x07,0x09,0x09,0x08,0x0A,0x0C,
        0x14,0x0D,0x0C,0x0B,0x0B,0x0C,0x19,0x12,0x13,0x0F,0x14,0x1D,0x1A,0x1F,0x1E,0x1D,0x1A,0x1C,0x1C,0x20,
        0x24,0x2E,0x27,0x20,0x22,0x2C,0x23,0x1C,0x1C,0x28,0x37,0x29,0x2C,0x30,0x31,0x34,0x34,0x34,0x20,0x26,
        0x39,0x3D,0x38,0x32,0x3C,0x2E,0x33,0x34,0x32,0xFF,0xC0,0x00,0x0B,0x08,0x00,0x01,0x00,0x01,0x01,0x01,
        0x11,0x00,0xFF,0xC4,0x00,0x14,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0xFF,0xDA,0x00,0x08,0x01,0x01,0x00,0x00,0x3F,0x00,0xD2,0xCF,0x20,0xFF,0xD9
      ]);
    }

    const vec = await embedImageVertex(env, bytes);
    return corsJson({ ok: true, source: "vertex", dimension: vec.length }, 200, origin);
  } catch (e) {
    return corsJson({ ok: false, error: String(e) }, 500, origin);
  }
}

// === Recognition: low-level fetch helpers ===
async function fetchDriveFileBytesById(env, fileId) {
  const token = await getAnyAccessToken(new Request("http://local"), env);
  const googleUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const r = await fetch(googleUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive fetch failed ${r.status}`);
  const buf = await r.arrayBuffer();
  return new Uint8Array(buf);
}

async function fetchBytesFromUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
  const ab = await r.arrayBuffer();
  return new Uint8Array(ab);
}

// === Recognition: model config + embedding ===
function getEmbedMode(env) {
  const m = (env.EMBED_MODE || "image").toLowerCase();
  return m === "text" ? "text" : "image";
}

function getEmbedModel(env) {
  if (env.EMBED_MODEL) return env.EMBED_MODEL;
  // default safe choices; override via Variables if needed
  return getEmbedMode(env) === "text"
    ? "@cf/baai/bge-base-en-v1.5"
    : "@cf/baai/bge-vision-base";
}

function extractVector(aiResult) {
  if (!aiResult) return null;
  if (Array.isArray(aiResult)) return aiResult;
  if (aiResult.data && Array.isArray(aiResult.data[0]?.embedding)) return aiResult.data[0].embedding;
  if (aiResult.embedding && Array.isArray(aiResult.embedding)) return aiResult.embedding;
  if (aiResult.output && Array.isArray(aiResult.output)) return aiResult.output;
  return null;
}

// Vertex-only embedding (no external/caption branches)
async function embedImage(env, bytes) {
  // Require Vertex to be enabled
  if (env.USE_VERTEX) {
    return await embedImageVertex(env, bytes);
  }
  // Optionally, you can keep a Workers AI fallback if you really have a model bound:
  const model = env.EMBED_MODEL;
  if (model) {
    try {
      const out = await env.AI.run(model, { image: [...bytes] });
      const v =
        Array.isArray(out) ? out :
        (out?.data && Array.isArray(out.data[0]?.embedding)) ? out.data[0].embedding :
        (Array.isArray(out?.embedding) ? out.embedding :
        (Array.isArray(out?.output) ? out.output : null));
      if (v) return v;
    } catch (_) {}
    const out2 = await env.AI.run(model, { input_image: [...bytes] });
    const v2 =
      Array.isArray(out2) ? out2 :
      (out2?.data && Array.isArray(out2.data[0]?.embedding)) ? out2.data[0].embedding :
      (Array.isArray(out2?.embedding) ? out2.embedding :
      (Array.isArray(out2?.output) ? out2.output : null));
    if (v2) return v2;
  }

  // If you don't have a Workers AI image-embed model, bail out with a clear error.
  throw new Error("No image embedding configured. Set USE_VERTEX=1 (recommended).");
}

async function embedText(env, text) {
  const model = getEmbedModel(env);
  const out = await env.AI.run(model, { text });
  const v = extractVector(out);
  if (!v) throw new Error("embed_text_failed");
  return v;
}

// === Recognition: Vectorize wrappers (binding first, REST fallback) ===
async function vecUpsert(env, entries) {
  if (env.RECO_INDEX && typeof env.RECO_INDEX.upsert === "function") {
    // Binding path (v2)
    return env.RECO_INDEX.upsert(entries);
  }
  // REST fallback (v2)
  return vecUpsertREST(env, entries);
}

async function vecQuery(env, vector, topK = 5, filter = undefined) {
  if (env.RECO_INDEX && typeof env.RECO_INDEX.query === "function") {
    // Binding path (v2)
    return env.RECO_INDEX.query(vector, { topK, filter, returnMetadata: "all" });
  }
  // REST fallback (v2)
  return vecQueryREST(env, vector, topK, filter);
}

// === Recognition: utils ===
function shapeMeta(base = {}) {
  const m = { ...base };
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (v === null || v === undefined) delete m[k];
    else if (typeof v === "object") m[k] = JSON.stringify(v);
  }
  return m;
}

async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

async function readBytesOrMultipart(req) {
  const ctype = req.headers.get("content-type") || "";
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData();
    const f = form.get("file");
    if (f && f instanceof File) {
      const ab = await f.arrayBuffer();
      return new Uint8Array(ab);
    }
    throw new Error("multipart_missing_file_field");
  }
  const ab = await req.arrayBuffer();
  if (!ab || ab.byteLength === 0) throw new Error("empty_body");
  return new Uint8Array(ab);
}

// === Recognition: list image fileIds in a Drive folder ===
async function listDriveImagesInFolder(env, folderId) {
  const token = await getAnyAccessToken(new Request("http://local"), env);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and mimeType contains 'image/'`);
  const fields = encodeURIComponent("nextPageToken, files(id,name,mimeType)");
  const orderBy = encodeURIComponent("name");

  let pageToken = "";
  const ids = [];
  for (let safety = 0; safety < 50; safety++) {
    const listUrl =
      `https://www.googleapis.com/drive/v3/files?q=${q}` +
      `&fields=${fields}&orderBy=${orderBy}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");

    const r = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Drive list error ${r.status}`);
    const data = await r.json();
    (data.files || []).forEach(f => ids.push(f.id));
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return ids;
}

// === POST /recognition/upsert ===
async function recognitionUpsert(req, env, origin) {
  try {
    const url = new URL(req.url);
    const ctype = req.headers.get("content-type") || "";
    let body = {};
    if (ctype.includes("application/json")) body = await readJson(req);

    const itemId = url.searchParams.get("itemId") || body.itemId || undefined;
    const label  = url.searchParams.get("label")  || body.label  || undefined;
    const metaIn = body.meta || {};

    // Bulk mode via folderId
    const folderId = url.searchParams.get("folderId") || body.folderId || undefined;
    if (folderId) {
      const ids = await listDriveImagesInFolder(env, folderId);
      const entries = [];
      for (const fid of ids) {
        const bytes = await fetchDriveFileBytesById(env, fid);
        const vec = await (getEmbedMode(env) === "text" ? embedText(env, `image ${fid}`) : embedImage(env, bytes));
        entries.push({ id: fid, values: vec, metadata: shapeMeta({ kind:"drive", fileId: fid, folderId, itemId, label, ...metaIn }) });
      }
      if (entries.length) await vecUpsert(env, entries);
      return corsJson({ ok: true, indexed: entries.length }, 200, origin);
    }

    // Single item: Drive fileId OR raw bytes
    const fileId = url.searchParams.get("fileId") || body.fileId || undefined;
    let id, vec, meta;
    if (fileId) {
      const bytes = await fetchDriveFileBytesById(env, fileId);
      vec = await (getEmbedMode(env) === "text" ? embedText(env, `image ${fileId}`) : embedImage(env, bytes));
      id = fileId;
      meta = shapeMeta({ kind:"drive", fileId, itemId, label, ...metaIn });
    } else {
      const bytes = await readBytesOrMultipart(req);
      vec = await embedImage(env, bytes);
      id = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      meta = shapeMeta({ kind:"upload", itemId, label, ...metaIn });
    }

    await vecUpsert(env, [{ id, values: vec, metadata: meta }]);
    return corsJson({ ok: true, id, meta }, 200, origin);
  } catch (e) {
    return corsJson({ ok: false, error: String(e) }, 500, origin);
  }
}

// === POST /recognition/query ===
async function recognitionQuery(req, env, origin) {
  try {
    const url = new URL(req.url);
    const ctype = req.headers.get("content-type") || "";
    let topK = Number(url.searchParams.get("topK") || 5);
    if (!Number.isFinite(topK) || topK <= 0) topK = 5;

    let filter, vector;

    if (ctype.includes("application/json")) {
      const body = await readJson(req);
      if (body.filter) filter = body.filter;
      if (body.topK) topK = Number(body.topK) || topK;

      if (body.fileId) {
        const bytes = await fetchDriveFileBytesById(env, body.fileId);
        vector = await embedImage(env, bytes);
      } else if (body.url) {
        const bytes = await fetchBytesFromUrl(body.url);
        vector = await embedImage(env, bytes);
      } else if (body.text && getEmbedMode(env) === "text") {
        vector = await embedText(env, body.text);
      } else {
        throw new Error("missing_input: provide fileId | url | (multipart file) | text (when EMBED_MODE=text)");
      }
    } else if (ctype.includes("multipart/form-data")) {
      const bytes = await readBytesOrMultipart(req);
      vector = await embedImage(env, bytes);
    } else {
      const ab = await req.arrayBuffer();
      if (!ab || ab.byteLength === 0) throw new Error("empty_body");
      vector = await embedImage(env, new Uint8Array(ab));
    }

    const result = await vecQuery(env, vector, topK, filter);
    const hits = (result.matches || result.results || result)?.map?.(m => ({
      id: m.id,
      score: m.score ?? m.distance ?? m.similarity ?? null,
      metadata: m.metadata || {},
    })) || [];

    return corsJson({ ok: true, topK, hits }, 200, origin);
  } catch (e) {
    return corsJson({ ok: false, error: String(e) }, 500, origin);
  }
}

// === POST /recognition/admin/reindex ===
async function recognitionBulkReindex(req, env, origin) {
  try {
    const body = await readJson(req);
    const folderId = body.folderId;
    if (!folderId) return corsJson({ ok: false, error: "folderId required" }, 400, origin);

    const itemId = body.itemId;
    const label = body.label;
    const metaIn = body.meta || {};

    const ids = await listDriveImagesInFolder(env, folderId);
    const entries = [];
    for (const fid of ids) {
      const bytes = await fetchDriveFileBytesById(env, fid);
      const vec = await (getEmbedMode(env) === "text" ? embedText(env, `image ${fid}`) : embedImage(env, bytes));
      entries.push({ id: fid, values: vec, metadata: shapeMeta({ kind:"drive", fileId: fid, folderId, itemId, label, ...metaIn }) });
    }
    if (entries.length) await vecUpsert(env, entries);
    return corsJson({ ok: true, indexed: entries.length }, 200, origin);
  } catch (e) {
    return corsJson({ ok: false, error: String(e) }, 500, origin);
  }
}

// --- GCP OAuth (Service Account) for Vertex ---
async function getGcpAccessToken(env) {
  let email = env.GCP_SA_EMAIL;
  let pkPem = env.GCP_SA_PKEY;

  // If a full JSON key is provided, prefer it
  if (env.GCP_SA_JSON) {
    try {
      const j = JSON.parse(env.GCP_SA_JSON);
      email = j.client_email;
      pkPem = j.private_key;
    } catch (e) {
      throw new Error("GCP_SA_JSON is not valid JSON");
    }
  }

  if (!email || !pkPem) throw new Error("Missing GCP_SA_EMAIL / GCP_SA_PKEY (or GCP_SA_JSON)");

  // Must be PKCS#8 ("-----BEGIN PRIVATE KEY-----")
  if (!/BEGIN PRIVATE KEY/.test(pkPem) && /BEGIN RSA PRIVATE KEY/.test(pkPem)) {
    throw new Error("Provided key is PKCS#1 (RSA). Create a new Service Account JSON key (PKCS#8).");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };

  const enc = (obj) => base64url(JSON.stringify(obj));
  const unsigned = `${enc(header)}.${enc(claims)}`;
  const key = await importPkcs8(pkPem, "RSASSA-PKCS1-v1_5");

  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(sigBuf)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error(`gcp_token_fail ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

function base64url(input) {
  let b64;
  if (input instanceof ArrayBuffer) {
    b64 = btoa(String.fromCharCode(...new Uint8Array(input)));
  } else {
    b64 = btoa(unescape(encodeURIComponent(input)));
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// Normalize PEM: handle JSON-escaped \n, strip headers, collapse whitespace, and fix padding
function normalizePemToBase64(pem) {
  let s = pem.trim();

  if (s.includes("\\n")) s = s.replace(/\\n/g, "\n");
  s = s.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "");
  s = s.replace(/\s+/g, "");

  const rem = s.length % 4;
  if (rem === 2) s += "==";
  else if (rem === 3) s += "=";
  else if (rem === 1) throw new Error("Invalid base64 length in PEM");

  return s;
}

function b64ToBytes(b64) {
  const str = atob(b64);
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

async function importPkcs8(pem, alg = "RSASSA-PKCS1-v1_5") {
  const b64 = normalizePemToBase64(pem);
  const raw = b64ToBytes(b64);
  return crypto.subtle.importKey(
    "pkcs8",
    raw.buffer,
    { name: alg, hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function reindexFolderIncremental(env, folderId, itemMeta, opts = {}) {
  // itemMeta from Item####.json or folder name
  const itemId4 = normalizeItemId(itemMeta?.itemId);
  const label = itemMeta?.label || null;
  if (!itemId4) return { scanned: 0, changed: 0, skipped: true };

  const maxChanged = Number.isFinite(opts.maxChanged) ? Number(opts.maxChanged) : Infinity;

  const files = await driveListImagesWithMeta(env, folderId);

  // one KV GET for the whole folder
  const seenMap = await kvGetFolderSeenMap(env, folderId);

  let toUpsert = [];
  let scanned = 0, changed = 0;

  for (const f of files) {
    scanned++;
    const sig = { md5Checksum: f.md5Checksum || null, modifiedTime: f.modifiedTime || null };
    const prev = seenMap[f.id];
    const isChanged = !prev || prev.md5Checksum !== sig.md5Checksum || prev.modifiedTime !== sig.modifiedTime;
    if (!isChanged) continue;

    // stop early if we’ve hit this run’s cap
    if (changed >= maxChanged) break;

    const img = await fetchDriveFileBytesById(env, f.id);
    const vec = await embedImageVertex(env, img);

    toUpsert.push({
      id: f.id,
      values: vec,
      metadata: { kind: "drive", fileId: f.id, folderId, itemId: itemId4, label }
    });

    // update local map; we’ll persist once at the end
    seenMap[f.id] = sig;
    changed++;

    if (toUpsert.length >= 50) {
      await vecUpsertREST(env, toUpsert);
      toUpsert = [];
    }
  }
  if (toUpsert.length) await vecUpsertREST(env, toUpsert);

    // persist updated seen map (skip if disabled)
    if (opts.writeSeen !== false) {
      await kvPutFolderSeenMap(env, folderId, seenMap);
    }
    return { scanned, changed, skipped: changed === 0 };
  }
  


async function reindexNightly(env, opts = {}) {
  const counts = { folders: 0, scanned: 0, changed: 0, skipped: 0 };

  // caps to avoid Cloudflare subrequest limits
  const defaultMax = Number(env.REINDEX_MAX_CHANGED_PER_RUN || 10);
  const maxChanged = Number.isFinite(opts.maxChanged) ? Number(opts.maxChanged) : defaultMax;

  // load persisted folder id list; if missing, hydrate once
  let folderIds = await kvGetFolderIds(env);
  if (!Array.isArray(folderIds) || folderIds.length === 0) {
    const folders = await driveListItemFolders(env);
    folderIds = folders.map(f => f.id);
    await kvSetFolderIds(env, folderIds);
  }

  let limitFolders = Number.isFinite(opts.limitFolders) ? Number(opts.limitFolders) : folderIds.length;
  if (limitFolders <= 0) limitFolders = folderIds.length;

  if (!folderIds.length) {
    if (opts.updateStatus !== false) {
      await kvSetStatus(env, {
        lastRun: new Date().toISOString(),
        counts,
        cursor: 0,
        totalFolders: 0
      });
    }
    return { ok: true, counts, cursor: 0, totalFolders: 0 };
  }
  
  
  // Round-robin using a persisted cursor into the fixed folder list
  const status = await kvGetStatus(env);
  const total = folderIds.length;
  const cursor0Raw = Number(status && status.cursor);
  const cursor0 = Number.isFinite(cursor0Raw) ? (cursor0Raw % total) : 0;
  
  // Track the next cursor position - start with current position
  let nextCursor = cursor0;

  const toProcess = Math.min(limitFolders, total);
  for (let i = 0; i < toProcess; i++) {
    const idx = (cursor0 + i) % total;
    const folderId = folderIds[idx];

    // Update nextCursor to the position AFTER this folder, regardless of processing outcome
    nextCursor = (idx + 1) % total;

    // Check if we've hit our change limit before processing
    if (counts.changed >= maxChanged) {
      break;
    }

    // fetch lightweight meta (avoid re-listing folders)
    let meta = await readItemJson(env, folderId);
    if (!meta || !meta.itemId) {
      // fall back to folder name only if you must; otherwise keep label null
      const nameFromId = null; // optional: resolve name lazily if you have a cache
      meta = deriveItemMetaFromFolderName(nameFromId || "");
    }

    const remaining = Math.max(0, maxChanged - counts.changed);
    const r = await reindexFolderIncremental(env, folderId, meta, { maxChanged: remaining });

    counts.folders++;
    counts.scanned += r.scanned|0;
    counts.changed += r.changed|0;
    counts.skipped += r.skipped ? 1 : 0;

    // If we've hit our change limit after processing, break
    if (counts.changed >= maxChanged) {
      break;
    }
  }

    // Always persist the next cursor position
    await kvSetStatus(env, {
      lastRun: new Date().toISOString(),
      counts,
      cursor: nextCursor,
      totalFolders: folderIds.length,
    });
  
    return { ok: true, counts, cursor: nextCursor, totalFolders: folderIds.length };
  }
  


// --- Vertex AI Multimodal Embeddings (image) ---
async function embedImageVertex(env, bytes) {
  const token  = await getGcpAccessToken(env);
  const project = env.GCP_PROJECT;
  const region  = env.GCP_REGION || "us-central1";
  const model   = env.GCP_VERTEX_MODEL || "multimodalembedding@001";
  if (!project) throw new Error("GCP_PROJECT not set");

  // base64-encode Uint8Array safely
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:predict`;

  const payload = {
    instances: [{ image: { bytesBase64Encoded: b64 } }],
    parameters: {} // can add { outputDimensionality: 1408|512|256|128 } if you want to override
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`vertex_predict_fail ${r.status}: ${await r.text()}`);
  const j = await r.json();

  const pred = j?.predictions?.[0];
  let vec =
    (Array.isArray(pred?.imageEmbedding) && pred.imageEmbedding) ||
    (pred?.embeddings?.imageEmbedding?.values) ||
    (Array.isArray(pred?.embeddings?.imageEmbedding) && pred.embeddings.imageEmbedding) ||
    (Array.isArray(pred?.embedding) && pred.embedding) ||
    (Array.isArray(pred?.output) && pred.output) ||
    null;

  if (!Array.isArray(vec)) throw new Error("vertex_bad_vector_shape");
  return vec;
}
