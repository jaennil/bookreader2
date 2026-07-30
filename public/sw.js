const SHELL_CACHE = "polka-shell-v2";
const STATIC_PATHS = ["/", "/site.webmanifest", "/icon.svg", "/favicon.svg"];

self.addEventListener("install", event => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  const home = await fetch("/", { cache: "no-cache" });
  if (!home.ok) throw new Error("App shell is unavailable");
  const html = await home.clone().text();
  await cache.put("/", home);
  const assets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(match => match[1]);
  await cache.addAll([...STATIC_PATHS.filter(path => path !== "/"), ...new Set(assets)]);
}

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== SHELL_CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/"));
    return;
  }

  if (url.pathname.startsWith("/assets/") || STATIC_PATHS.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirst(request, fallbackPath) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return await cache.match(request) || await cache.match(fallbackPath) || new Response("Offline", { status: 503 });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}
