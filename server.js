// Tienda del hackathon: servidor Node sin framework.
// Todo lo que se sirve está en memoria (rápido para "Tiempo de respuesta" y "Black Friday").
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

// ---------- Cabeceras de seguridad (en TODAS las respuestas) ----------
const SEGURIDAD = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

// ---------- Datos ----------
const leer = (f, def = '') => (existsSync(path.join(DIR, f)) ? readFileSync(path.join(DIR, f), 'utf8') : def);
const CATALOGO_TXT = leer('catalogo.json', '[]');

// ---------- Utilidades ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pagina({ titulo, descripcion, h1, cuerpo }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descripcion)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/estilos.css">
</head>
<body>
<header class="cab">
  <a class="logo" href="/">Casa Devoteam</a>
  <nav aria-label="Principal"><a href="/">Inicio</a> <a href="/carrito">Carrito</a></nav>
</header>
<main>
<h1>${esc(h1)}</h1>
${cuerpo}
</main>
<footer class="pie"><p>Envíos a toda España · Pago simulado, sin datos bancarios · Compra como invitado</p></footer>
</body>
</html>`;
}

// Respuesta precalculada (con gzip) para lo estático
function preparar(cuerpo, tipo) {
  const raw = Buffer.from(cuerpo);
  return { raw, gz: gzipSync(raw), tipo };
}

const ESTATICOS = {
  '/': preparar(
    pagina({
      titulo: 'Casa Devoteam · Muebles y decoración online',
      descripcion: 'Tienda online de muebles, iluminación, textil y decoración. Compra como invitado y recibe tu pedido en casa.',
      h1: 'Muebles y decoración para tu casa',
      cuerpo: '<p>Estamos preparando el catálogo. Vuelve en unos minutos.</p>',
    }),
    'text/html; charset=utf-8'
  ),
  '/catalogo.json': preparar(CATALOGO_TXT, 'application/json; charset=utf-8'),
  '/estilos.css': preparar(leer('public/estilos.css'), 'text/css; charset=utf-8'),
  '/favicon.svg': preparar(leer('public/favicon.svg'), 'image/svg+xml'),
  '/favicon.ico': preparar(leer('public/favicon.svg'), 'image/svg+xml'),
  '/robots.txt': preparar('User-agent: *\nAllow: /\n', 'text/plain; charset=utf-8'),
};

const PAGINA_404 = preparar(
  pagina({ titulo: 'Página no encontrada · Casa Devoteam', descripcion: 'La página que buscas no existe en Casa Devoteam.', h1: 'Página no encontrada', cuerpo: '<p><a href="/">Volver a la tienda</a></p>' }),
  'text/html; charset=utf-8'
);
const PAGINA_500 = preparar(
  pagina({ titulo: 'Error · Casa Devoteam', descripcion: 'Ha ocurrido un error inesperado en Casa Devoteam.', h1: 'Algo ha fallado', cuerpo: '<p>Inténtalo de nuevo. <a href="/">Volver a la tienda</a></p>' }),
  'text/html; charset=utf-8'
);

// ---------- Envío ----------
function enviar(req, res, estado, r, extra = {}) {
  const cab = { ...SEGURIDAD, 'content-type': r.tipo, 'cache-control': 'no-store', ...extra };
  // Cookie de sesión: la primera vez que se visita cualquier página
  if (!/(?:^|;\s*)hk_sesion=/.test(req.headers.cookie || '')) {
    cab['set-cookie'] = `hk_sesion=${randomBytes(16).toString('hex')}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`;
  }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && r.raw.length > 512;
  const cuerpo = gz ? r.gz : r.raw;
  if (gz) { cab['content-encoding'] = 'gzip'; cab['vary'] = 'Accept-Encoding'; }
  cab['content-length'] = cuerpo.length;
  res.writeHead(estado, cab);
  res.end(req.method === 'HEAD' ? undefined : cuerpo);
}

function json(req, res, estado, obj) {
  enviar(req, res, estado, { raw: Buffer.from(JSON.stringify(obj)), gz: null, tipo: 'application/json; charset=utf-8' });
}

function leerCuerpo(req, max = 64 * 1024) {
  return new Promise((ok, ko) => {
    let n = 0; const trozos = [];
    req.on('data', (c) => { n += c.length; if (n > max) { ko(new Error('grande')); req.destroy(); } else trozos.push(c); });
    req.on('end', () => ok(Buffer.concat(trozos).toString('utf8')));
    req.on('error', ko);
  });
}

// ---------- Rutas ----------
async function manejar(req, res) {
  const url = new URL(req.url, 'http://x');
  const ruta = url.pathname;

  if ((req.method === 'GET' || req.method === 'HEAD') && ESTATICOS[ruta]) {
    const extra = ruta === '/' || ruta === '/catalogo.json' ? {} : { 'cache-control': 'public, max-age=3600' };
    return enviar(req, res, 200, ESTATICOS[ruta], extra);
  }

  if (req.method === 'POST' && ruta === '/api/asistente') {
    let pregunta = '';
    try { pregunta = String(JSON.parse(await leerCuerpo(req)).pregunta || ''); } catch { /* cuerpo no válido */ }
    if (!pregunta.trim()) return json(req, res, 200, { respuesta: 'Hazme una pregunta sobre nuestros productos, envíos, montaje, devoluciones, garantía o pago.' });
    return json(req, res, 200, { respuesta: 'Soy el asistente de Casa Devoteam. Estamos terminando de cargar el catálogo; vuelve a preguntarme en unos minutos.' });
  }

  return enviar(req, res, 404, PAGINA_404);
}

const servidor = http.createServer((req, res) => {
  manejar(req, res).catch(() => {
    // Nunca enseñamos trazas ni rutas internas
    if (!res.headersSent) enviar(req, res, 500, PAGINA_500);
    else res.destroy();
  });
});
servidor.keepAliveTimeout = 65000;
servidor.listen(PORT, () => console.log(JSON.stringify({ severity: 'INFO', message: `Tienda escuchando en ${PORT}` })));
