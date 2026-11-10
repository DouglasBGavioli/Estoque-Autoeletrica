/**
 * Motor Offline-First (IndexedDB + Sincronização Automática via Wi-Fi com Servidor PC)
 * Funciona 100% desconectado no Celular ou PC e sincroniza automaticamente quando na mesma rede Wi-Fi.
 */

const IDB_NAME = 'AutoEletricaOfflineDB';
const IDB_VERSION = 1;

class LocalFirstStore {
  constructor() {
    this.db = null;
    this.isServerReachable = false;
    this.isSyncing = false;
    this.lastSyncAt = localStorage.getItem('ae_last_sync') || null;
    this.deviceName = localStorage.getItem('ae_device_name') || this.detectDefaultDeviceName();
    this.listeners = new Set();
  }

  detectDefaultDeviceName() {
    const ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) {
      return 'Celular Oficina';
    }
    return 'PC Central';
  }

  setDeviceName(name) {
    this.deviceName = (name || '').trim() || this.detectDefaultDeviceName();
    localStorage.setItem('ae_device_name', this.deviceName);
    this.notify();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(event = {}) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error(err);
      }
    }
  }

  async init() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('products')) {
          db.createObjectStore('products', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('movements')) {
          db.createObjectStore('movements', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('pending_ops')) {
          db.createObjectStore('pending_ops', { keyPath: 'opId' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });

    // Tenta sincronizar imediatamente ao abrir e agenda verificação automática via Wi-Fi
    await this.syncWithServer();
    setInterval(() => {
      this.syncWithServer({ silent: true });
    }, 8000);

    window.addEventListener('online', () => this.syncWithServer());
  }

  tx(storeName, mode = 'readonly') {
    const transaction = this.db.transaction(storeName, mode);
    return transaction.objectStore(storeName);
  }

  getAllFromStore(storeName) {
    return new Promise((resolve, reject) => {
      const store = this.tx(storeName, 'readonly');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  putInStore(storeName, item) {
    return new Promise((resolve, reject) => {
      const store = this.tx(storeName, 'readwrite');
      const req = store.put(item);
      req.onsuccess = () => resolve(item);
      req.onerror = () => reject(req.error);
    });
  }

  deleteFromStore(storeName, key) {
    return new Promise((resolve, reject) => {
      const store = this.tx(storeName, 'readwrite');
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  clearAndBulkPut(storeName, items) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      store.clear();
      for (const item of items) {
        store.put(item);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  static calcPercentages(cost, sale) {
    const c = Number(cost) || 0;
    const s = Number(sale) || 0;
    const markup = c > 0 ? Number((((s - c) / c) * 100).toFixed(2)) : 0;
    const margin = s > 0 ? Number((((s - c) / s) * 100).toFixed(2)) : 0;
    const profit = Number((s - c).toFixed(2));
    return { markup, margin, profit };
  }

  async getState() {
    const [allProducts, allMovements, pendingOps] = await Promise.all([
      this.getAllFromStore('products'),
      this.getAllFromStore('movements'),
      this.getAllFromStore('pending_ops')
    ]);

    const products = allProducts
      .filter((p) => !p.deleted)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const movements = allMovements.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    return {
      products,
      movements,
      pendingCount: pendingOps.length,
      isServerReachable: this.isServerReachable,
      lastSyncAt: this.lastSyncAt,
      deviceName: this.deviceName
    };
  }

  async queueOp(type, payload) {
    const op = {
      opId: `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      payload,
      createdAt: new Date().toISOString()
    };
    await this.putInStore('pending_ops', op);
    return op;
  }

  async saveProduct(data) {
    const now = new Date().toISOString();
    const id = data.id || `prod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const allProducts = await this.getAllFromStore('products');
    const existing = allProducts.find((p) => p.id === id) || null;

    const cost_price = Number(data.cost_price ?? existing?.cost_price ?? 0);
    const sale_price = Number(data.sale_price ?? existing?.sale_price ?? 0);
    const { markup, margin } = LocalFirstStore.calcPercentages(cost_price, sale_price);

    let price_history = Array.isArray(data.price_history)
      ? data.price_history
      : existing?.price_history || [];

    if (!existing || existing.cost_price !== cost_price || existing.sale_price !== sale_price) {
      price_history = [
        ...price_history,
        {
          date: now,
          cost_price,
          sale_price,
          note: data.price_note || (existing ? 'Atualização de preço' : 'Cadastro inicial')
        }
      ].slice(-30);
    }

    const equivalent_codes = Array.isArray(data.equivalent_codes)
      ? data.equivalent_codes
      : typeof data.equivalent_codes === 'string'
        ? data.equivalent_codes.split(',').map((s) => s.trim()).filter(Boolean)
        : existing?.equivalent_codes || [];

    const purchase_links = Array.isArray(data.purchase_links)
      ? data.purchase_links
      : existing?.purchase_links || [];

    const product = {
      id,
      sku: String(data.sku ?? existing?.sku ?? '').trim() || 'SEM-COD',
      barcode: String(data.barcode ?? existing?.barcode ?? '').trim(),
      name: String(data.name ?? existing?.name ?? 'Peça sem nome').trim(),
      category: String(data.category ?? existing?.category ?? 'Diversos').trim(),
      brand: String(data.brand ?? existing?.brand ?? '').trim(),
      condition: String(data.condition ?? existing?.condition ?? 'novo').trim(),
      voltage: String(data.voltage ?? existing?.voltage ?? '12V').trim(),
      amperage: String(data.amperage ?? existing?.amperage ?? '').trim(),
      pins: String(data.pins ?? existing?.pins ?? '').trim(),
      equivalent_codes,
      vehicles: String(data.vehicles ?? existing?.vehicles ?? '').trim(),
      location: String(data.location ?? existing?.location ?? '').trim(),
      quantity: Math.max(0, Math.round(Number(data.quantity ?? existing?.quantity ?? 0))),
      min_quantity: Math.max(0, Math.round(Number(data.min_quantity ?? existing?.min_quantity ?? 1))),
      unit: String(data.unit ?? existing?.unit ?? 'UN').trim(),
      cost_price,
      sale_price,
      markup_percent: markup,
      margin_percent: margin,
      purchase_links,
      price_history,
      notes: String(data.notes ?? existing?.notes ?? '').trim(),
      updated_at: now,
      deleted: false
    };

    // 1. Salva imediatamente no IndexedDB do aparelho
    await this.putInStore('products', product);
    // 2. Coloca na fila de sincronização Wi-Fi
    await this.queueOp('UPSERT_PRODUCT', product);
    this.notify({ type: 'PRODUCT_SAVED', product });

    // 3. Tenta sincronizar com o PC via Wi-Fi em background
    this.syncWithServer({ silent: true });
    return product;
  }

  async deleteProduct(id) {
    const allProducts = await this.getAllFromStore('products');
    const existing = allProducts.find((p) => p.id === id);
    if (existing) {
      existing.deleted = true;
      existing.updated_at = new Date().toISOString();
      await this.putInStore('products', existing);
    }
    await this.queueOp('DELETE_PRODUCT', { id });
    this.notify({ type: 'PRODUCT_DELETED', id });
    this.syncWithServer({ silent: true });
  }

  async recordMovement(movData) {
    const now = new Date().toISOString();
    const movId = movData.id || `mov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const allProducts = await this.getAllFromStore('products');
    const product = allProducts.find((p) => p.id === movData.product_id);
    if (!product) {
      throw new Error('Peça não encontrada no estoque local.');
    }

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

    const unitCost =
      movData.unit_cost !== undefined && movData.unit_cost !== ''
        ? Number(movData.unit_cost)
        : product.cost_price;
    const unitPrice =
      movData.unit_price !== undefined && movData.unit_price !== ''
        ? Number(movData.unit_price)
        : product.sale_price;

    // Atualiza produto localmente
    const updatedProduct = {
      ...product,
      quantity: newQty,
      updated_at: now
    };

    if (movData.type === 'entrada' && movData.update_prices !== false) {
      if (unitCost > 0) updatedProduct.cost_price = unitCost;
      if (unitPrice > 0) updatedProduct.sale_price = unitPrice;
      const { markup, margin } = LocalFirstStore.calcPercentages(
        updatedProduct.cost_price,
        updatedProduct.sale_price
      );
      updatedProduct.markup_percent = markup;
      updatedProduct.margin_percent = margin;
      updatedProduct.price_history = [
        ...(product.price_history || []),
        {
          date: now,
          cost_price: updatedProduct.cost_price,
          sale_price: updatedProduct.sale_price,
          note: `Entrada +${qty} ${product.unit} ${movData.supplier_info ? `(${movData.supplier_info})` : ''}`.trim()
        }
      ].slice(-30);
    }

    await this.putInStore('products', updatedProduct);

    const movement = {
      id: movId,
      product_id: product.id,
      product_name: product.name,
      product_sku: product.sku,
      type: movData.type,
      quantity: qty,
      prev_quantity: prevQty,
      new_quantity: newQty,
      unit_cost: unitCost,
      unit_price: unitPrice,
      reason: movData.reason || (movData.type === 'entrada' ? 'compra_reposicao' : 'venda_balcao'),
      vehicle_info: movData.vehicle_info || '',
      license_plate: (movData.license_plate || '').toUpperCase(),
      customer_name: movData.customer_name || '',
      supplier_info: movData.supplier_info || '',
      notes: movData.notes || '',
      device_name: this.deviceName,
      update_prices: movData.update_prices !== false,
      created_at: now
    };

    await this.putInStore('movements', movement);
    await this.queueOp('RECORD_MOVEMENT', movement);
    this.notify({ type: 'MOVEMENT_RECORDED', movement });

    this.syncWithServer({ silent: true });
    return movement;
  }

  async syncWithServer(options = {}) {
    if (this.isSyncing) return false;
    this.isSyncing = true;

    try {
      const pendingOps = await this.getAllFromStore('pending_ops');
      pendingOps.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);

      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceName: this.deviceName,
          pendingOps
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data && data.ok) {
        // Remove operações já confirmadas pelo servidor
        if (Array.isArray(data.appliedOpIds)) {
          for (const opId of data.appliedOpIds) {
            await this.deleteFromStore('pending_ops', opId);
          }
        }

        // Verifica se não surgiram novas operações durante o request antes de atualizar o cache local
        const remainingOps = await this.getAllFromStore('pending_ops');
        if (remainingOps.length === 0) {
          await this.clearAndBulkPut('products', data.products || []);
          await this.clearAndBulkPut('movements', data.movements || []);
        }

        this.isServerReachable = true;
        this.lastSyncAt = data.serverTime || new Date().toISOString();
        localStorage.setItem('ae_last_sync', this.lastSyncAt);
        this.notify({ type: 'SYNC_SUCCESS' });
        return true;
      }
    } catch (err) {
      this.isServerReachable = false;
      if (!options.silent) {
        this.notify({ type: 'SYNC_OFFLINE' });
      }
    } finally {
      this.isSyncing = false;
    }
    return false;
  }

  async importFullBackup(backupData, replaceAll = false) {
    // Se o servidor estiver acessível via Wi-Fi, envia direto para o servidor SQLite e sincroniza
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: backupData.products || [],
          movements: backupData.movements || [],
          replaceAll
        })
      });
      if (res.ok) {
        const data = await res.json();
        await this.clearAndBulkPut('products', data.products || []);
        await this.clearAndBulkPut('movements', data.movements || []);
        this.notify({ type: 'BACKUP_IMPORTED' });
        return true;
      }
    } catch {}

    // Fallback 100% offline no aparelho
    if (replaceAll) {
      await this.clearAndBulkPut('products', backupData.products || []);
      await this.clearAndBulkPut('movements', backupData.movements || []);
    } else {
      for (const p of backupData.products || []) {
        await this.saveProduct(p);
      }
    }
    this.notify({ type: 'BACKUP_IMPORTED' });
    return true;
  }
}

window.store = new LocalFirstStore();
