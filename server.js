// Wisp tunnel for Nova. The site itself is on Vercel, which can't hold WebSockets,
// so its proxy traffic comes through here. Only pages from ALLOWED_ORIGINS
// (comma-separated, e.g. https://example.com) or localhost may connect.
import { createServer } from "node:http";
import tls from "node:tls";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { startWarp, routeFor, connectVia, warpState } from "./warp.js";

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  dns_servers: ["1.1.1.3", "1.0.0.3"],
});

const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
const isAllowed = (origin) => allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin || "");

// The TCP side of each Wisp stream (replaces wisp-js's own so some hosts can go through
// WARP, see warp.js). wisp-js has already checked the destination is allowed.
class TCPSocket {
  constructor(hostname, port) {
    this.hostname = hostname;
    this.port = port;
    this.socket = null;
    this.chunks = [];
    this.ended = false;
    this.wake = null;
  }

  async connect() {
    const route = routeFor(this.hostname);
    if (route !== "direct") this.socket = await connectVia(route, this.hostname, this.port).catch(() => null);
    this.socket ||= await connectVia("direct", this.hostname, this.port);
    const sock = this.socket;
    const done = () => {
      this.ended = true;
      this.notify();
    };
    sock.on("data", (data) => {
      this.chunks.push(data);
      if (this.chunks.length >= 128) sock.pause(); // the WebSocket side is behind; wait for it
      this.notify();
    });
    sock.on("end", done);
    sock.on("close", done);
    sock.on("error", () => {});
    sock.resume();
  }

  notify() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async recv() {
    while (!this.chunks.length && !this.ended) await new Promise((resolve) => (this.wake = resolve));
    const data = this.chunks.shift() ?? null;
    if (this.chunks.length < 64 && this.socket?.isPaused() && !this.ended) this.socket.resume();
    return data;
  }

  async send(data) {
    const sock = this.socket;
    if (!sock || sock.destroyed || !sock.writable) return;
    await new Promise((resolve) => sock.write(data, resolve));
  }

  async close() {
    this.socket?.end();
  }

  // Flow control is handled above with the chunk count.
  pause() {}
  resume() {}
}

// Asks Cloudflare which network a request through WARP arrives from ("warp=on").
async function warpCheck() {
  if (!warpState().tunnel) return "off";
  const raw = await connectVia("warp6", "www.cloudflare.com", 443);
  return new Promise((resolve) => {
    const sock = tls.connect({ socket: raw, servername: "www.cloudflare.com" }, () =>
      sock.write("GET /cdn-cgi/trace HTTP/1.1\r\nHost: www.cloudflare.com\r\nConnection: close\r\n\r\n"),
    );
    let text = "";
    sock.on("data", (d) => (text += d));
    sock.on("close", () => resolve(text.match(/^warp=(\w+)/m)?.[1] || "unknown"));
    sock.on("error", () => resolve("error"));
    sock.setTimeout(10000, () => sock.destroy());
  });
}

// Plain HTTP answers "ok". Nova fetches it to wake this server early, so let any page read it.
const server = createServer(async (req, res) => {
  const headers = {
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
  };
  if (req.url === "/status") {
    res.writeHead(200, { ...headers, "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, warp: await warpCheck().catch(() => "error"), ...warpState() }));
  }
  res.writeHead(200, { ...headers, "content-type": "text/plain" });
  res.end("ok");
});

server.on("upgrade", (req, socket, head) => {
  if (req.url.endsWith("/wisp/") && isAllowed(req.headers.origin)) wisp.routeRequest(req, socket, head, { TCPSocket });
  else socket.end();
});

server.listen(parseInt(process.env.PORT || "") || 8080, "0.0.0.0", () => console.log("Wisp tunnel is running"));
startWarp().catch((err) => console.log("WARP: failed to start:", err.message));

// Render's free plan puts a service to sleep after 15 minutes without inbound requests,
// and waking it takes 10-50 seconds, which made the first page of every visit crawl.
// Requesting our own public address every 5 minutes counts as inbound traffic. One
// service running all month stays inside the plan's 750 free hours.
const self = process.env.RENDER_EXTERNAL_URL;
if (self) setInterval(() => fetch(self, { signal: AbortSignal.timeout(20000) }).catch(() => {}), 5 * 60 * 1000);
