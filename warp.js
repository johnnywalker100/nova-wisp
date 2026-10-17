// Routes YouTube (and a few sites that refuse this server) through Cloudflare WARP.
// YouTube answers this server's data-center address with "Sign in to confirm you're not
// a bot", but usually not WARP's. wgcf registers a free WARP device and wireproxy turns it
// into a local SOCKS5 proxy. Which way works can change, so the server keeps test-loading
// YouTube videos and sends YouTube whichever way they actually play.
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import { promises as dns } from "node:dns";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const match = (list) => (host) => list.some((d) => host === d || host.endsWith("." + d));
// Everything a YouTube video needs. Its stream URLs only work from the address that asked
// for them, so all of these must leave the same way.
const isYouTube = match(["youtube.com", "youtu.be", "youtube-nocookie.com", "googlevideo.com", "ytimg.com", "ggpht.com", "youtubei.googleapis.com", "accounts.google.com"]);
// Sites that drop this server's connections outright but take WARP's.
const isRefused = match(["duckduckgo.com"]);

const ROUTES = ["warp6", "warp4", "direct"]; // warp6: WARP picks the address (usually IPv6)
let ytRoute = "direct";
let socksPort = 0;
let healthy = false; // the WARP tunnel answers
let lastRotate = 0;
let rotate = null;

// How to reach host: "warp6", "warp4" or "direct".
export function routeFor(host) {
  if (!healthy) return "direct";
  if (isYouTube(host)) return ytRoute;
  if (isRefused(host)) return "warp6";
  return "direct";
}
export const warpState = () => ({ tunnel: healthy, youtube: ytRoute });

const bin = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), "bin", name);

export async function startWarp() {
  if (process.env.WARP_SOCKS) {
    socksPort = Number(process.env.WARP_SOCKS.split(":")[1]); // already running (local testing)
  } else {
    if (!existsSync(bin("wgcf")) || !existsSync(bin("wireproxy"))) return console.log("WARP: binaries missing, going direct");
    const conf = path.join(mkdtempSync(path.join(tmpdir(), "warp-")), "wireproxy.conf");
    socksPort = 40000;
    // A fresh WARP device gets a new address; used when YouTube refuses the current one.
    const register = async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "wgcf-"));
      const run = (args) => promisify(execFile)(bin("wgcf"), args, { cwd: dir, timeout: 30000 });
      await run(["register", "--accept-tos"]);
      await run(["generate"]);
      writeFileSync(conf, `WGConfig = ${path.join(dir, "wgcf-profile.conf")}\n\n[Socks5]\nBindAddress = 127.0.0.1:${socksPort}\n`);
    };
    try {
      await register();
    } catch (err) {
      return console.log("WARP: registration failed, going direct:", err.message);
    }
    let child;
    const launch = () => {
      child = spawn(bin("wireproxy"), ["-c", conf], { stdio: "ignore" });
      child.on("exit", () => {
        healthy = false;
        setTimeout(launch, 2000);
      });
    };
    launch();
    rotate = async () => {
      await register();
      child.kill(); // relaunches with the new device
      console.log("WARP: switched to a new device");
    };
  }

  // Keep checking the tunnel; while it's down every site goes direct instead of waiting.
  const checkTunnel = async () => {
    const ok = await connectVia("warp6", "www.cloudflare.com", 443, 5000).then((s) => (s.destroy(), true), () => false);
    if (ok !== healthy) console.log(`WARP: tunnel ${ok ? "up" : "down"}`);
    healthy = ok;
    setTimeout(checkTunnel, ok ? 60000 : 5000);
  };
  // Pick the way YouTube videos actually play.
  const checkYouTube = async () => {
    if (healthy) {
      let pick = null;
      for (const route of [ytRoute, ...ROUTES.filter((r) => r !== ytRoute)]) {
        if (await youtubePlays(route)) {
          pick = route;
          break;
        }
      }
      if (pick && pick !== ytRoute) console.log(`WARP: YouTube now goes ${pick}`);
      if (pick) ytRoute = pick;
      else if (rotate && Date.now() - lastRotate > 30 * 60000) {
        lastRotate = Date.now();
        await rotate().catch((err) => console.log("WARP: new device failed:", err.message));
        return setTimeout(checkYouTube, 20000);
      }
    }
    setTimeout(checkYouTube, healthy ? 20 * 60000 : 10000);
  };
  setTimeout(checkTunnel, 1500);
  setTimeout(checkYouTube, 4000);
}

// Loads two YouTube watch pages the given way; true if both videos are playable.
async function youtubePlays(route) {
  for (const id of ["jNQXAC9IVRw", "kJQP7kiw5Fk"]) {
    const html = await fetchVia(route, "www.youtube.com", `/watch?v=${id}`).catch(() => "");
    if (!/"playabilityStatus":\{"status":"OK"/.test(html)) return false;
  }
  return true;
}

function fetchVia(route, host, pathname) {
  return connectVia(route, host, 443, 8000).then(
    (raw) =>
      new Promise((resolve, reject) => {
        const sock = tls.connect({ socket: raw, servername: host, ALPNProtocols: ["http/1.1"] }, () =>
          sock.write(
            `GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36\r\n` +
              "Accept-Language: en-US,en;q=0.9\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
          ),
        );
        let text = "";
        sock.setEncoding("utf8");
        sock.on("data", (d) => (text += d));
        sock.on("close", () => resolve(text));
        sock.on("error", reject);
        sock.setTimeout(20000, () => sock.destroy());
      }),
  );
}

// A paused TCP socket to host:port, opened the given way.
export async function connectVia(route, host, port, timeout = 8000) {
  if (route === "direct") {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      sock.setNoDelay(true);
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.removeListener("error", reject);
        sock.pause();
        resolve(sock);
      });
    });
  }
  // warp4: resolve the IPv4 address here so WARP has to leave over IPv4.
  const target = route === "warp4" ? (await dns.resolve4(host))[0] : host;
  return socks5(target, port, timeout);
}

function socks5(target, port, timeout) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socksPort, "127.0.0.1");
    sock.setNoDelay(true);
    const fail = (err) => {
      sock.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    sock.setTimeout(timeout, () => fail("socks timeout"));
    sock.once("error", fail);
    let stage = 0;
    let buf = Buffer.alloc(0);
    sock.once("connect", () => sock.write(Buffer.from([5, 1, 0])));
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail("socks auth refused");
        buf = buf.subarray(2);
        const addr = net.isIPv4(target)
          ? Buffer.from([1, ...target.split(".").map(Number)])
          : Buffer.concat([Buffer.from([3, Buffer.byteLength(target)]), Buffer.from(target)]);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
        stage = 1;
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return fail(`socks connect failed (${buf[1]})`);
        const len = buf[3] === 1 ? 4 : buf[3] === 4 ? 16 : 1 + buf[4];
        if (buf.length < 4 + len + 2) return;
        // Hand over a paused socket so no early bytes are lost before the caller listens.
        sock.pause();
        sock.removeListener("data", onData);
        sock.removeListener("error", fail);
        sock.setTimeout(0);
        const rest = buf.subarray(4 + len + 2);
        if (rest.length) sock.unshift(rest);
        resolve(sock);
      }
    };
    sock.on("data", onData);
  });
}
