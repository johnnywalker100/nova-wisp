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

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

server.on("upgrade", (req, socket, head) => {
  if (req.url.endsWith("/wisp/") && isAllowed(req.headers.origin)) wisp.routeRequest(req, socket, head);
  else socket.end();
});

server.listen(parseInt(process.env.PORT || "") || 8080, "0.0.0.0", () => console.log("Wisp tunnel is running"));
