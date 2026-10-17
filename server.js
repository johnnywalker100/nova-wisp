// Wisp tunnel for Nova. The site itself is on Vercel, which can't hold WebSockets,
// so its proxy traffic comes through here. Only pages from ALLOWED_ORIGINS
// (comma-separated, e.g. https://example.com) or localhost may connect.
import { createServer } from "node:http";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  dns_servers: ["1.1.1.3", "1.0.0.3"],
});

const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
const isAllowed = (origin) => allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin || "");

// Plain HTTP answers "ok". Nova fetches it to wake this server early, so let any page read it.
const server = createServer((req, res) => {
  res.writeHead(200, {
    "content-type": "text/plain",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
  });
  res.end("ok");
});

server.on("upgrade", (req, socket, head) => {
  if (req.url.endsWith("/wisp/") && isAllowed(req.headers.origin)) wisp.routeRequest(req, socket, head);
  else socket.end();
});

server.listen(parseInt(process.env.PORT || "") || 8080, "0.0.0.0", () => console.log("Wisp tunnel is running"));

// Render's free plan puts a service to sleep after 15 minutes without inbound requests,
// and waking it takes 10-50 seconds, which made the first page of every visit crawl.
// Requesting our own public address every 5 minutes counts as inbound traffic. One
// service running all month stays inside the plan's 750 free hours.
const self = process.env.RENDER_EXTERNAL_URL;
if (self) setInterval(() => fetch(self, { signal: AbortSignal.timeout(20000) }).catch(() => {}), 5 * 60 * 1000);
