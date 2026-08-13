#!/usr/bin/env node
/* Minimal static server for FORGE experiments: serves ~/openagi/forge and
   ~/openagi/node_modules (for the three.js module import). */
const http = require("http");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
               ".json": "application/json", ".png": "image/png", ".css": "text/css" };
const PORT = 45210;
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.startsWith("/node_modules/")) p = path.join(ROOT, "..", p);
  else p = path.join(ROOT, p === "/" ? "harness.html" : p);
  const REPO_ROOT = path.join(ROOT, "..");
  if (!p.startsWith(REPO_ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, "127.0.0.1", () => console.log("FORGE static server on", PORT));
