const DEFAULT_API_BASE_URL = "https://met.liiiu.cn/meting/api";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Referer": "https://www.kuwo.cn/",
    },
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  const upstream = await fetch(normalized.toString(), init);
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyApiRequest(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void, apiBaseUrl: string = DEFAULT_API_BASE_URL): Promise<Response> {
  const cache = caches.default;

  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s");
  cacheUrl.searchParams.delete("nocache");

  const cacheKey = new Request(cacheUrl.toString(), {
    method: request.method,
    headers: request.headers
  });

  const bypassCache = url.searchParams.get("nocache") === "true";
  if (request.method === "GET" && !bypassCache) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        console.log(`[Cache HIT] ${url.toString()}`);
        const response = new Response(cachedResponse.body, cachedResponse);
        response.headers.set("X-Cache-Status", "HIT");
        response.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
        return response;
      }
    } catch (err) {
      console.warn(`[Cache ERROR] ${url.toString()}`, err);
    }
  }

  console.log(`[Cache MISS] Fetching from upstream: ${url.toString()}`);

  // ---- Solara 参数 -> duanjinglin 参数映射 ----
  const solaraTypes = url.searchParams.get("types") || "";
  const solaraSource = url.searchParams.get("source") || "netease";
  const solaraName = url.searchParams.get("name");
  const solaraId = url.searchParams.get("id");

  const typeMap: Record<string, string> = {
    "search": "search",
    "url": "url",
    "pic": "pic",
    "lyric": "lrc",
    "playlist": "playlist",
    "song": "song",
  };

  // duanjinglin 只支持 netease / tencent，其余源降级到 netease
  const sourceMap: Record<string, string> = {
    "netease": "netease",
    "tencent": "tencent",
    "qq": "tencent",
  };
  const metingServer = sourceMap[solaraSource] || "netease";
  const metingType = typeMap[solaraTypes] || solaraTypes;

  if (metingType === "search" && !solaraName) {
    return new Response("Missing search keyword", { status: 400 });
  }

  // tencent 源不支持 search，直接拦截
  if (metingServer === "tencent" && metingType === "search") {
    return new Response(JSON.stringify({ error: "tencent source does not support search" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const apiUrl = new URL(apiBaseUrl);
  apiUrl.searchParams.set("server", metingServer);
  apiUrl.searchParams.set("type", metingType);
  apiUrl.searchParams.set("id", solaraName || solaraId || "");

  const count = url.searchParams.get("count");
  const pages = url.searchParams.get("pages");
  const br = url.searchParams.get("br");
  const size = url.searchParams.get("size");
  if (count) apiUrl.searchParams.set("count", count);
  if (pages) apiUrl.searchParams.set("pages", pages);
  if (br) apiUrl.searchParams.set("br", br);
  if (size) apiUrl.searchParams.set("size", size);

  if (!apiUrl.searchParams.has("type")) {
    return new Response("Missing types", { status: 400 });
  }

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": "Meting/1.5.0",
      "Accept": "application/json",
    },
  });

  let responseText = await upstream.text();
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  headers.set("X-Cache-Status", "MISS");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");

  // ---- 雷达歌单格式转换：duanjinglin 扁平数组 -> 网易云 {playlist:{tracks:[...]}} ----
  if (metingType === "playlist" && upstream.status === 200) {
    try {
      const parsed = JSON.parse(responseText);
      if (Array.isArray(parsed)) {
        const tracks = parsed.map((item: any, idx: number) => {
          let realId = item.id || item.songmid || "";
          // duanjinglin 的 playlist 项里 url 是完整链接，从 url 解析 id
          if (!realId && typeof item.url === "string") {
            try {
              const u = new URL(item.url);
              realId = u.searchParams.get("id") || "";
            } catch {}
          }
          if (!realId && typeof item.lrc === "string") {
            try {
              const u = new URL(item.lrc);
              realId = u.searchParams.get("id") || "";
            } catch {}
          }
          return {
            id: realId || `radar_${idx}`,
            name: item.name || item.title || "未知歌曲",
            ar: [{ name: item.artist || item.author || "未知艺术家" }],
            al: {
              name: item.album || "",
              picUrl: item.pic || item.cover || "",
              pic_str: item.pic_id || "",
            },
          };
        });
        responseText = JSON.stringify({ playlist: { tracks } });
      }
    } catch (e) {
      console.warn("[Radar] playlist 格式转换失败", e);
    }
  }

  const isSearch = metingType === "search";
  const isEmptyResult = responseText.trim() === "[]" || responseText.trim() === "";
  const isError = responseText.includes('"error"') || responseText.includes('"status":400') || responseText.includes('"status":403');

  let shouldCache = upstream.status === 200 && request.method === "GET" && !isError && !bypassCache;

  if (isSearch && isEmptyResult) {
    shouldCache = false;
  }

  if (shouldCache) {
    headers.set("Cache-Control", "public, s-maxage=300, max-age=300");
  } else {
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  }

  const response = new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  if (shouldCache && waitUntil) {
    waitUntil(cache.put(cacheKey, response.clone()));
    console.log(`[Cache PUT] Saved to cache: ${url.toString()}`);
  }

  return response;
}

export async function onRequest({ request, waitUntil, env }: { request: Request, waitUntil: (promise: Promise<any>) => void, env: any }): Promise<Response> {
  const apiBaseUrl = (typeof env?.API_BASE_URL === "string" && env.API_BASE_URL) ? env.API_BASE_URL : DEFAULT_API_BASE_URL;
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyKuwoAudio(target, request);
  }

  return proxyApiRequest(url, request, waitUntil, apiBaseUrl);
}
