const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { generateQRCodeSVG } = require('./lib/qrcode');
const { generateSelfSignedCert } = require('./lib/selfsigned');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3080;
const HTTPS_PORT = process.env.HTTPS_PORT ? Number(process.env.HTTPS_PORT) : 3443;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'estoque_autoeletrica.sqlite');
const CERT_PATH = path.join(DATA_DIR, 'tls_cert.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Inicializa tabelas do banco SQLite
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL,
    barcode TEXT DEFAULT '',
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    brand TEXT DEFAULT '',
    condition TEXT DEFAULT 'novo',
    voltage TEXT DEFAULT '12V',
    amperage TEXT DEFAULT '',
    pins TEXT DEFAULT '',
    equivalent_codes TEXT DEFAULT '[]',
    vehicles TEXT DEFAULT '',
    location TEXT DEFAULT '',
    quantity REAL DEFAULT 0,
    min_quantity REAL DEFAULT 1,
    unit TEXT DEFAULT 'UN',
    cost_price REAL DEFAULT 0,
    sale_price REAL DEFAULT 0,
    markup_percent REAL DEFAULT 0,
    margin_percent REAL DEFAULT 0,
    purchase_links TEXT DEFAULT '[]',
    price_history TEXT DEFAULT '[]',
    notes TEXT DEFAULT '',
    updated_at TEXT NOT NULL,
    deleted INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS movements (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    product_sku TEXT DEFAULT '',
    type TEXT NOT NULL,
    quantity REAL NOT NULL,
    prev_quantity REAL DEFAULT 0,
    new_quantity REAL DEFAULT 0,
    unit_cost REAL DEFAULT 0,
    unit_price REAL DEFAULT 0,
    reason TEXT DEFAULT '',
    vehicle_info TEXT DEFAULT '',
    license_plate TEXT DEFAULT '',
    customer_name TEXT DEFAULT '',
    supplier_info TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    device_name TEXT DEFAULT 'PC Oficina',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS applied_ops (
    op_id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`);

function calcPercentages(cost, sale) {
  const c = Number(cost) || 0;
  const s = Number(sale) || 0;
  const markup = c > 0 ? Number((((s - c) / c) * 100).toFixed(2)) : 0;
  const margin = s > 0 ? Number((((s - c) / s) * 100).toFixed(2)) : 0;
  return { markup, margin };
}

function ensureCleanZeroInitialState() {
  const cleaned = db.prepare(`SELECT value FROM meta WHERE key = 'clean_zero_v1'`).get();
  if (cleaned) return;
  db.exec(`DELETE FROM products; DELETE FROM movements; DELETE FROM applied_ops;`);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('clean_zero_v1', 'true')`).run();
}

ensureCleanZeroInitialState();

function getLocalNetworkAddresses(httpPort, httpsPort) {
  const interfaces = os.networkInterfaces();
  const urls = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const url = `http://${iface.address}:${httpPort}`;
        const httpsUrl = `https://${iface.address}:${httpsPort}`;
        let qrSvg = '';
        let httpsQrSvg = '';
        try {
          qrSvg = generateQRCodeSVG(url);
          httpsQrSvg = generateQRCodeSVG(httpsUrl);
        } catch {}
        urls.push({
          interfaceName: name,
          ip: iface.address,
          url,
          httpsUrl,
          qrSvg,
          httpsQrSvg
        });
      }
    }
  }
  if (urls.length === 0) {
    const fallbackUrl = `http://localhost:${httpPort}`;
    const fallbackHttps = `https://localhost:${httpsPort}`;
    urls.push({
      interfaceName: 'Localhost',
      ip: '127.0.0.1',
      url: fallbackUrl,
      httpsUrl: fallbackHttps,
      qrSvg: generateQRCodeSVG(fallbackUrl),
      httpsQrSvg: generateQRCodeSVG(fallbackHttps)
    });
  }
  return urls;
}

function getOrCreateTlsCredentials() {
  const addresses = getLocalNetworkAddresses(PORT, HTTPS_PORT);
  const ips = addresses.map((a) => a.ip);
  const ipsKey = ips.sort().join(',');

  if (fs.existsSync(CERT_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CERT_PATH, 'utf8'));
      if (cached.ipsKey === ipsKey && cached.keyPem && cached.certPem) {
        return { key: cached.keyPem, cert: cached.certPem };
      }
    } catch {}
  }

  const { keyPem, certPem } = generateSelfSignedCert(ips);
  fs.writeFileSync(CERT_PATH, JSON.stringify({ ipsKey, keyPem, certPem }, null, 2), 'utf8');
  return { key: keyPem, cert: certPem };
}

function formatProductRow(row) {
  if (!row) return null;
  let equivalent_codes = [];
  let purchase_links = [];
  let price_history = [];
  try { equivalent_codes = JSON.parse(row.equivalent_codes || '[]'); } catch {}
  try { purchase_links = JSON.parse(row.purchase_links || '[]'); } catch {}
  try { price_history = JSON.parse(row.price_history || '[]'); } catch {}
  return {
    ...row,
    quantity: Number(row.quantity) || 0,
    min_quantity: Number(row.min_quantity) || 0,
    cost_price: Number(row.cost_price) || 0,
    sale_price: Number(row.sale_price) || 0,
    markup_percent: Number(row.markup_percent) || 0,
    margin_percent: Number(row.margin_percent) || 0,
    deleted: Boolean(row.deleted),
    equivalent_codes,
    purchase_links,
    price_history
  };
}

function getAllState() {
  const rawProducts = db.prepare(`SELECT * FROM products WHERE deleted = 0 ORDER BY name ASC`).all();
  const products = rawProducts.map(formatProductRow);
  const movements = db.prepare(`SELECT * FROM movements ORDER BY created_at DESC LIMIT 500`).all();
  return {
    products,
    movements,
    serverTime: new Date().toISOString()
  };
}

function upsertProduct(data) {
  const id = data.id || `prod-${crypto.randomUUID().slice(0, 8)}`;
  const existingRow = db.prepare(`SELECT * FROM products WHERE id = ?`).get(id);
  const existing = existingRow ? formatProductRow(existingRow) : null;

  const cost_price = Number(data.cost_price ?? existing?.cost_price ?? 0);
  const sale_price = Number(data.sale_price ?? existing?.sale_price ?? 0);
  const { markup, margin } = calcPercentages(cost_price, sale_price);

  const now = data.updated_at || new Date().toISOString();
  let price_history = Array.isArray(data.price_history)
    ? data.price_history
    : existing?.price_history || [];

  if (!existing || existing.cost_price !== cost_price || existing.sale_price !== sale_price) {
    const lastEntry = price_history[price_history.length - 1];
    if (!lastEntry || lastEntry.cost_price !== cost_price || lastEntry.sale_price !== sale_price) {
      price_history = [
        ...price_history,
        {
          date: now,
          cost_price,
          sale_price,
          note: data.price_note || (existing ? 'Atualização de cadastro/preço' : 'Cadastro inicial')
        }
      ].slice(-30);
    }
  }

  const equivalent_codes = Array.isArray(data.equivalent_codes)
    ? data.equivalent_codes
    : typeof data.equivalent_codes === 'string'
      ? data.equivalent_codes.split(',').map(s => s.trim()).filter(Boolean)
      : existing?.equivalent_codes || [];

  const purchase_links = Array.isArray(data.purchase_links)
    ? data.purchase_links
    : existing?.purchase_links || [];

  const stmt = db.prepare(`
    INSERT INTO products (
      id, sku, barcode, name, category, brand, condition, voltage, amperage, pins,
      equivalent_codes, vehicles, location, quantity, min_quantity, unit,
      cost_price, sale_price, markup_percent, margin_percent,
      purchase_links, price_history, notes, updated_at, deleted
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, 0
    )
    ON CONFLICT(id) DO UPDATE SET
      sku = excluded.sku,
      barcode = excluded.barcode,
      name = excluded.name,
      category = excluded.category,
      brand = excluded.brand,
      condition = excluded.condition,
      voltage = excluded.voltage,
      amperage = excluded.amperage,
      pins = excluded.pins,
      equivalent_codes = excluded.equivalent_codes,
      vehicles = excluded.vehicles,
      location = excluded.location,
      quantity = excluded.quantity,
      min_quantity = excluded.min_quantity,
      unit = excluded.unit,
      cost_price = excluded.cost_price,
      sale_price = excluded.sale_price,
      markup_percent = excluded.markup_percent,
      margin_percent = excluded.margin_percent,
      purchase_links = excluded.purchase_links,
      price_history = excluded.price_history,
      notes = excluded.notes,
      updated_at = excluded.updated_at,
      deleted = 0
  `);

  stmt.run(
    id,
    String(data.sku ?? existing?.sku ?? '').trim() || 'SEM-COD',
    String(data.barcode ?? existing?.barcode ?? '').trim(),
    String(data.name ?? existing?.name ?? 'Peça sem nome').trim(),
    String(data.category ?? existing?.category ?? 'Diversos').trim(),
    String(data.brand ?? existing?.brand ?? '').trim(),
    String(data.condition ?? existing?.condition ?? 'novo').trim(),
    String(data.voltage ?? existing?.voltage ?? '12V').trim(),
    String(data.amperage ?? existing?.amperage ?? '').trim(),
    String(data.pins ?? existing?.pins ?? '').trim(),
    JSON.stringify(equivalent_codes),
    String(data.vehicles ?? existing?.vehicles ?? '').trim(),
    String(data.location ?? existing?.location ?? '').trim(),
    Math.max(0, Math.round(Number(data.quantity ?? existing?.quantity ?? 0))),
    Math.max(0, Math.round(Number(data.min_quantity ?? existing?.min_quantity ?? 1))),
    String(data.unit ?? existing?.unit ?? 'UN').trim(),
    cost_price,
    sale_price,
    markup,
    margin,
    JSON.stringify(purchase_links),
    JSON.stringify(price_history),
    String(data.notes ?? existing?.notes ?? '').trim(),
    now
  );

  return formatProductRow(db.prepare(`SELECT * FROM products WHERE id = ?`).get(id));
}

function recordMovement(movData) {
  const movId = movData.id || `mov-${crypto.randomUUID().slice(0, 8)}`;

  const alreadyExists = db.prepare(`SELECT id FROM movements WHERE id = ?`).get(movId);
  if (alreadyExists) {
    return db.prepare(`SELECT * FROM movements WHERE id = ?`).get(movId);
  }

  const prodRow = db.prepare(`SELECT * FROM products WHERE id = ?`).get(movData.product_id);
  if (!prodRow) {
    throw new Error('Peça não encontrada para registrar movimentação');
  }
  const product = formatProductRow(prodRow);
  const qty = Math.max(1, Math.round(Math.abs(Number(movData.quantity) || 1)));
  const prevQty = Math.round(Number(product.quantity) || 0);
  let newQty = prevQty;

  if (movData.type === 'entrada') {
    newQty = prevQty + qty;
  } else if (movData.type === 'saida') {
    newQty = Math.max(0, prevQty - qty);
  } else if (movData.type === 'ajuste') {
    newQty = Math.max(0, Math.round(Number(movData.quantity) || 0));
  }

  const now = movData.created_at || new Date().toISOString();
  const unitCost = movData.unit_cost !== undefined && movData.unit_cost !== ''
    ? Number(movData.unit_cost)
    : product.cost_price;
  const unitPrice = movData.unit_price !== undefined && movData.unit_price !== ''
    ? Number(movData.unit_price)
    : product.sale_price;

  const updatedProductData = {
    ...product,
    quantity: newQty,
    updated_at: now
  };

  if (movData.type === 'entrada' && movData.update_prices !== false) {
    if (unitCost > 0) updatedProductData.cost_price = unitCost;
    if (unitPrice > 0) updatedProductData.sale_price = unitPrice;
    updatedProductData.price_note = `Entrada de ${qty} ${product.unit} ${movData.supplier_info ? `(${movData.supplier_info})` : ''}`.trim();
  }

  upsertProduct(updatedProductData);

  db.prepare(`
    INSERT INTO movements (
      id, product_id, product_name, product_sku, type, quantity, prev_quantity, new_quantity,
      unit_cost, unit_price, reason, vehicle_info, license_plate, customer_name, supplier_info, notes, device_name, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    movId,
    product.id,
    product.name,
    product.sku,
    movData.type,
    qty,
    prevQty,
    newQty,
    unitCost,
    unitPrice,
    String(movData.reason || (movData.type === 'entrada' ? 'compra_reposicao' : 'venda_balcao')),
    String(movData.vehicle_info || ''),
    String(movData.license_plate || '').toUpperCase(),
    String(movData.customer_name || ''),
    String(movData.supplier_info || ''),
    String(movData.notes || ''),
    String(movData.device_name || 'App'),
    now
  );

  return db.prepare(`SELECT * FROM movements WHERE id = ?`).get(movId);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function filenameIsSW(fp) {
  return path.basename(fp) === 'sw.js';
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  try {
    if (pathname === '/api/info' && req.method === 'GET') {
      const addresses = getLocalNetworkAddresses(PORT, HTTPS_PORT);
      const countRow = db.prepare(`SELECT COUNT(*) as total FROM products WHERE deleted = 0`).get();
      return sendJson(res, 200, {
        ok: true,
        port: PORT,
        httpsPort: HTTPS_PORT,
        hostname: os.hostname(),
        addresses,
        totalProducts: countRow.total,
        serverTime: new Date().toISOString()
      });
    }

    if (pathname === '/api/qr' && req.method === 'GET') {
      const text = parsedUrl.searchParams.get('text') || `http://localhost:${PORT}`;
      const svg = generateQRCodeSVG(text);
      return sendJson(res, 200, { ok: true, text, svg });
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...getAllState() });
    }

    if (pathname === '/api/products' && req.method === 'POST') {
      const body = await parseBody(req);
      const saved = upsertProduct(body);
      return sendJson(res, 200, { ok: true, product: saved, ...getAllState() });
    }

    if (pathname.startsWith('/api/products/') && req.method === 'DELETE') {
      const id = decodeURIComponent(pathname.replace('/api/products/', ''));
      const now = new Date().toISOString();
      db.prepare(`UPDATE products SET deleted = 1, updated_at = ? WHERE id = ?`).run(now, id);
      return sendJson(res, 200, { ok: true, deletedId: id, ...getAllState() });
    }

    if (pathname === '/api/movements' && req.method === 'POST') {
      const body = await parseBody(req);
      const movement = recordMovement(body);
      return sendJson(res, 200, { ok: true, movement, ...getAllState() });
    }

    if (pathname === '/api/sync' && req.method === 'POST') {
      const body = await parseBody(req);
      const pendingOps = Array.isArray(body.pendingOps) ? body.pendingOps : [];
      const appliedIds = [];

      for (const op of pendingOps) {
        if (!op || !op.opId) continue;
        const alreadyApplied = db.prepare(`SELECT op_id FROM applied_ops WHERE op_id = ?`).get(op.opId);
        if (alreadyApplied) {
          appliedIds.push(op.opId);
          continue;
        }

        if (op.type === 'UPSERT_PRODUCT' && op.payload) {
          upsertProduct(op.payload);
        } else if (op.type === 'DELETE_PRODUCT' && op.payload?.id) {
          db.prepare(`UPDATE products SET deleted = 1, updated_at = ? WHERE id = ?`).run(
            op.createdAt || new Date().toISOString(),
            op.payload.id
          );
        } else if (op.type === 'RECORD_MOVEMENT' && op.payload) {
          try {
            recordMovement(op.payload);
          } catch {}
        }

        db.prepare(`INSERT OR IGNORE INTO applied_ops (op_id, applied_at) VALUES (?, ?)`).run(
          op.opId,
          new Date().toISOString()
        );
        appliedIds.push(op.opId);
      }

      return sendJson(res, 200, {
        ok: true,
        appliedOpIds: appliedIds,
        ...getAllState()
      });
    }

    if (pathname === '/api/import' && req.method === 'POST') {
      const body = await parseBody(req);
      const products = Array.isArray(body.products) ? body.products : [];
      const movements = Array.isArray(body.movements) ? body.movements : [];

      if (body.replaceAll) {
        db.exec(`DELETE FROM products; DELETE FROM movements;`);
      }

      for (const p of products) {
        upsertProduct(p);
      }

      const insertMov = db.prepare(`
        INSERT OR IGNORE INTO movements (
          id, product_id, product_name, product_sku, type, quantity, prev_quantity, new_quantity,
          unit_cost, unit_price, reason, vehicle_info, license_plate, customer_name, supplier_info, notes, device_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const m of movements) {
        insertMov.run(
          m.id || `mov-${crypto.randomUUID().slice(0, 8)}`,
          m.product_id || '',
          m.product_name || '',
          m.product_sku || '',
          m.type || 'entrada',
          Number(m.quantity) || 0,
          Number(m.prev_quantity) || 0,
          Number(m.new_quantity) || 0,
          Number(m.unit_cost) || 0,
          Number(m.unit_price) || 0,
          m.reason || '',
          m.vehicle_info || '',
          m.license_plate || '',
          m.customer_name || '',
          m.supplier_info || '',
          m.notes || '',
          m.device_name || 'Backup',
          m.created_at || new Date().toISOString()
        );
      }

      return sendJson(res, 200, { ok: true, ...getAllState() });
    }

    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Acesso negado');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': ext === '.html' || filenameIsSW(filePath) ? 'no-cache' : 'public, max-age=3600'
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    const indexHtml = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(indexHtml).pipe(res);
    }

    res.writeHead(404);
    res.end('Não encontrado');
  } catch (err) {
    console.error('Erro na requisição:', err);
    sendJson(res, 500, { ok: false, error: err.message || 'Erro interno no servidor' });
  }
}

const httpServer = http.createServer(handleRequest);
httpServer.listen(PORT, '0.0.0.0', () => {
  const addresses = getLocalNetworkAddresses(PORT, HTTPS_PORT);
  console.log('============================================================');
  console.log('⚡ SISTEMA DE ESTOQUE AUTOELÉTRICA (OFFLINE + WI-FI SYNC) ⚡');
  console.log('============================================================');
  console.log(`💻 Acesso neste PC:               http://localhost:${PORT}`);
  for (const addr of addresses) {
    console.log(`📱 Celular Wi-Fi (${addr.interfaceName}):      ${addr.url}`);
    console.log(`🔒 Celular HTTPS (Câmera Ao Vivo): ${addr.httpsUrl}`);
  }
  console.log('============================================================');
});

try {
  const tlsCreds = getOrCreateTlsCredentials();
  const httpsServer = https.createServer(tlsCreds, handleRequest);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0');
} catch (err) {
  console.warn('Aviso: Servidor HTTPS opcional não pôde ser iniciado:', err.message);
}
