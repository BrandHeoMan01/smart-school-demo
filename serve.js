/* خادم محلي بسيط لتجربة الـPWA (تثبيت + service worker يحتاجان http لا file://)
   التشغيل:  node serve.js    ثم افتح:  http://localhost:8080/parent-app.html */
const http = require("http"), fs = require("fs"), path = require("path");
const root = __dirname, port = 8080;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".svg": "image/svg+xml", ".css": "text/css; charset=utf-8", ".webmanifest": "application/manifest+json"
};
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/parent-app.html";
  const fp = path.join(root, p);
  if (!fp.startsWith(root)) { res.writeHead(403); return res.end("403"); }
  fs.readFile(fp, (e, data) => {
    if (e) { res.writeHead(404); return res.end("404"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}).listen(port, () => console.log("EDUVIA PWA → http://localhost:" + port + "/parent-app.html"));
