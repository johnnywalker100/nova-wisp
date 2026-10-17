// Downloads the two WARP helpers used by warp.js into bin/, pinned by version and SHA-256.
// Runs after npm install. It never fails the install: without them the tunnel just goes direct.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILES = [
  {
    name: "wgcf", // registers a free WARP device: https://github.com/ViRb3/wgcf
    url: "https://github.com/ViRb3/wgcf/releases/download/v2.3.1/wgcf_2.3.1_linux_amd64",
    sha256: "4fb7a136aa470ece11d17949c7db07b040ec9c604742dc8680bcf1889f85d0c8",
  },
  {
    name: "wireproxy", // WireGuard as a local SOCKS5 proxy: https://github.com/whyvl/wireproxy
    url: "https://github.com/whyvl/wireproxy/releases/download/v1.1.3/wireproxy_linux_amd64.tar.gz",
    sha256: "e88c1d090740373fc606c1bafd81d9a5eadc642cce5667616e20e9d7a444f51c",
    tar: true,
  },
];

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin");

if (process.platform !== "linux" || process.arch !== "x64") {
  console.log(`fetch-warp: skipped on ${process.platform}-${process.arch} (the server runs on linux-x64)`);
  process.exit(0);
}

try {
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) {
    const res = await fetch(f.url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`${f.name}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    const hash = createHash("sha256").update(body).digest("hex");
    if (hash !== f.sha256) throw new Error(`${f.name}: checksum mismatch (${hash})`);
    if (f.tar) {
      const archive = path.join(dir, `${f.name}.tar.gz`);
      writeFileSync(archive, body);
      execFileSync("tar", ["xzf", archive, "-C", dir, f.name]);
      rmSync(archive);
    } else {
      writeFileSync(path.join(dir, f.name), body);
    }
    chmodSync(path.join(dir, f.name), 0o755);
    console.log(`fetch-warp: ${f.name} ready`);
  }
} catch (err) {
  console.log("fetch-warp: failed, the tunnel will run without WARP:", err.message);
}
