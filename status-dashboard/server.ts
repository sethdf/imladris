// Minimal Bun server serving the status dashboard
// Proxies API calls to Windmill on localhost:8000
// Auth injected server-side so browser needs no token

const WINDMILL = "http://127.0.0.1:8000";
const WM_TOKEN = "nPrsox6CPhsQuRBrCUSj2p9BmxgRMdpS";
const PORT = 3100;

const HTML = await Bun.file(import.meta.dir + "/index.html").text();

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Proxy API calls to Windmill with server-side auth
    if (url.pathname.startsWith("/api/")) {
      const target = `${WINDMILL}${url.pathname}${url.search}`;
      const headers = new Headers(req.headers);
      headers.set("Authorization", `Bearer ${WM_TOKEN}`);
      const resp = await fetch(target, {
        method: req.method,
        headers,
        body: req.method !== "GET" ? await req.text() : undefined,
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          "Content-Type": resp.headers.get("Content-Type") || "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Serve dashboard
    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`Status dashboard running on http://127.0.0.1:${PORT}`);
