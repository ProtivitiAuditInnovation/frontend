// Zero-dependency static server for the frontend.  Usage: npm run dev   (PORT=5500 by default)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 5500;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || /server\.js$|package\.json$/.test(file)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
                         "Cache-Control": "no-store" });
    res.end(data);
  });
}).listen(PORT, HOST, () => {
  console.log(`UAR frontend running at http://localhost:${PORT}`);
  console.log("Backend expected at the API_BASE set in config.js (default http://localhost:8000/api)");
});
