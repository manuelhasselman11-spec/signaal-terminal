const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};
// 13-10c: never let the browser keep an old page or engine (that showed version 11-10c after an upload)
const NO_CACHE = { 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' };

function send(res, file, status){
  fs.readFile(file, (err, data) => {
    if (err){ res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, NO_CACHE)).end('Niet gevonden'); return; }
    res.writeHead(status || 200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }, NO_CACHE)).end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
  fs.stat(filePath, (err, st) => {
    if (!err && st.isFile()) return send(res, filePath);
    // /mission → mission.html
    if (!path.extname(filePath) && fs.existsSync(filePath + '.html')) return send(res, filePath + '.html');
    // a missing file WITH an extension (e.g. /mission.html before the upload) is a real 404, never the home page in disguise
    if (path.extname(filePath)) return send(res, path.join(ROOT, '__missing__'), 404);
    send(res, path.join(ROOT, 'index.html'));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Signaal Terminal web op poort', PORT);
});
