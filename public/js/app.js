/**
 * Aplicação Principal — AutoElétrica Pro (Estoque Offline & Sincronização Wi-Fi)
 */

const fmtBRL = (val) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(val) || 0);

const fmtPct = (val) => `${(Number(val) || 0).toFixed(1).replace('.0', '')}%`;

const fmtDate = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const escHtml = (str) =>
  String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

class AutoEletricaApp {
  constructor() {
    this.activeTab = 'dashboard';
    this.searchQuery = '';
    this.state = {
      products: [],
      movements: [],
      pendingCount: 0,
      isServerReachable: false,
      lastSyncAt: null,
      deviceName: 'PC Central'
    };
    this.scannerStream = null;
    this.scannerMode = 'search';
    this.scannerTimer = null;
  }

  async init() {
    // Registra Service Worker para funcionamento 100% offline no celular e PC
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    window.store.onChange(() => {
      this.refreshUI();
    });

    await window.store.init();
    await this.refreshUI();
    this.loadWifiQrInfo();
  }

  async refreshUI() {
    this.state = await window.store.getState();

    // Atualiza contadores nos menus
    const totalEl = document.getElementById('badge-total-products');
    if (totalEl) totalEl.textContent = this.state.products.length;

    const lowStockItems = this.state.products.filter((p) => p.quantity <= p.min_quantity);
    const lowBadge = document.getElementById('badge-low-stock');
    if (lowBadge) {
      lowBadge.textContent = lowStockItems.length;
      lowBadge.style.display = lowStockItems.length > 0 ? 'inline-flex' : 'none';
    }

    const coresItems = this.state.products.filter((p) => p.condition !== 'novo');
    const coresBadge = document.getElementById('badge-cores-count');
    if (coresBadge) coresBadge.textContent = coresItems.length;

    // Atualiza indicador Wi-Fi / Offline
    const dot = document.getElementById('sync-dot');
    const statusText = document.getElementById('sync-status-text');
    const metaText = document.getElementById('sync-meta-text');
    const devInput = document.getElementById('device-name-input');
    if (devInput && document.activeElement !== devInput) {
      devInput.value = this.state.deviceName;
    }

    if (this.state.isServerReachable) {
      dot?.classList.remove('offline');
      if (statusText) statusText.textContent = 'Conectado via Wi-Fi';
      if (metaText) {
        metaText.textContent =
          this.state.pendingCount > 0
            ? `Sincronizando ${this.state.pendingCount} alteração(ões)...`
            : `Sincronizado (${this.state.deviceName})`;
      }
    } else {
      dot?.classList.add('offline');
      if (statusText) statusText.textContent = 'Modo Offline Ativo';
      if (metaText) {
        metaText.textContent =
          this.state.pendingCount > 0
            ? `${this.state.pendingCount} alteração(ões) salvas no aparelho`
            : 'Dados salvos na memória deste aparelho';
      }
    }

    this.renderDashboard();
    this.renderInventory();
    this.renderRestock();
    this.renderMovements();
    this.renderCores();
  }

  switchTab(tabName) {
    this.activeTab = tabName;
    document.querySelectorAll('.tab-view').forEach((sec) => {
      sec.style.display = sec.id === `tab-${tabName}` ? 'block' : 'none';
    });
    document.querySelectorAll('.nav-btn, .mob-nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    if (tabName === 'sync') {
      this.loadWifiQrInfo();
    }
  }

  handleGlobalSearch(query) {
    this.searchQuery = (query || '').trim().toLowerCase();
    if (this.searchQuery && this.activeTab !== 'inventory') {
      this.switchTab('inventory');
    } else {
      this.renderInventory();
    }
  }

  clearFilters() {
    this.searchQuery = '';
    const gs = document.getElementById('global-search');
    if (gs) gs.value = '';
    ['filter-category', 'filter-voltage', 'filter-condition', 'filter-stock-status'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    this.renderInventory();
  }

  // =========================================================================
  // 1. RENDERIZAÇÃO DO DASHBOARD
  // =========================================================================
  renderDashboard() {
    const products = this.state.products;
    const movements = this.state.movements;

    let totalCostValue = 0;
    let totalSaleValue = 0;
    let totalUnits = 0;
    let sumMarkup = 0;

    for (const p of products) {
      const qty = Math.max(0, Number(p.quantity) || 0);
      totalUnits += qty;
      totalCostValue += qty * (Number(p.cost_price) || 0);
      totalSaleValue += qty * (Number(p.sale_price) || 0);
      sumMarkup += Number(p.markup_percent) || 0;
    }

    const potentialProfit = totalSaleValue - totalCostValue;
    const avgMarkup = products.length > 0 ? sumMarkup / products.length : 0;
    const overallMargin = totalSaleValue > 0 ? ((totalSaleValue - totalCostValue) / totalSaleValue) * 100 : 0;
    const lowStock = products.filter((p) => p.quantity <= p.min_quantity);

    const kpiContainer = document.getElementById('dashboard-kpis');
    if (kpiContainer) {
      kpiContainer.innerHTML = `
        <div class="kpi-card">
          <div class="kpi-header">
            <span>CUSTO INVESTIDO (COMPRA)</span>
            <span>💰</span>
          </div>
          <div class="kpi-value">${fmtBRL(totalCostValue)}</div>
          <div class="kpi-sub">${products.length} itens cadastrados (${totalUnits} un. totais)</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-header">
            <span>VALOR TOTAL DE VENDA</span>
            <span>🏷️</span>
          </div>
          <div class="kpi-value" style="color:var(--success);">${fmtBRL(totalSaleValue)}</div>
          <div class="kpi-sub">Markup médio de cadastro: <strong style="color:var(--accent)">+${fmtPct(avgMarkup)}</strong></div>
        </div>

        <div class="kpi-card">
          <div class="kpi-header">
            <span>LUCRO BRUTO ESTIMADO</span>
            <span>📈</span>
          </div>
          <div class="kpi-value" style="color:var(--accent);">${fmtBRL(potentialProfit)}</div>
          <div class="kpi-sub">Margem real sobre vendas: <strong>${fmtPct(overallMargin)}</strong></div>
        </div>

        <div class="kpi-card" style="cursor:pointer;" onclick="app.switchTab('restock')">
          <div class="kpi-header">
            <span>ALERTA DE REPOSIÇÃO</span>
            <span>⚠️</span>
          </div>
          <div class="kpi-value" style="color:${lowStock.length > 0 ? '#f87171' : 'var(--success)'};">
            ${lowStock.length} ${lowStock.length === 1 ? 'peça' : 'peças'}
          </div>
          <div class="kpi-sub">Clique para abrir a Lista de Compras →</div>
        </div>
      `;
    }

    // Lista de estoque baixo no Dashboard
    const lowListEl = document.getElementById('dashboard-low-stock-list');
    if (lowListEl) {
      if (lowStock.length === 0) {
        lowListEl.innerHTML = `<p style="color:var(--text-secondary); font-size:0.86rem; padding:0.75rem 0;">✅ Todas as peças estão acima do estoque mínimo!</p>`;
      } else {
        lowListEl.innerHTML = `
          <div class="dash-list">
            ${lowStock.slice(0, 6).map((p) => {
              const firstLink = (p.purchase_links || [])[0];
              return `
                <div class="dash-list-item">
                  <div class="dash-item-info">
                    <div class="dash-item-title">
                      <span class="badge badge-sku">${escHtml(p.sku)}</span> ${escHtml(p.name)}
                    </div>
                    <div class="dash-item-sub">
                      Saldo: <strong style="color:#f87171">${p.quantity} ${escHtml(p.unit)}</strong> (Mín: ${p.min_quantity}) • Últ. Custo: <strong>${fmtBRL(p.cost_price)}</strong>
                    </div>
                  </div>
                  <div class="dash-item-actions">
                    ${
                      firstLink && firstLink.url
                        ? `<a href="${escHtml(firstLink.url)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" title="Abrir link de compra">🔗 Comprar</a>`
                        : ''
                    }
                    <button class="btn btn-primary btn-sm" onclick="app.openQuickMovementModal('entrada', '${p.id}')">+ Entrada</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }
    }

    // Últimas movimentações no Dashboard
    const recMovEl = document.getElementById('dashboard-recent-movements');
    if (recMovEl) {
      if (movements.length === 0) {
        recMovEl.innerHTML = `<p style="color:var(--text-secondary); font-size:0.86rem; padding:0.75rem 0;">Nenhuma movimentação registrada ainda.</p>`;
      } else {
        recMovEl.innerHTML = `
          <div class="dash-list">
            ${movements.slice(0, 6).map((m) => {
              const isEntry = m.type === 'entrada';
              return `
                <div class="dash-list-item">
                  <div class="dash-item-info">
                    <div class="dash-item-title">
                      <span style="color:${isEntry ? 'var(--success)' : 'var(--accent)'}">
                        ${isEntry ? '📥 +' : '📤 -'}${m.quantity}
                      </span>
                      ${escHtml(m.product_name)}
                    </div>
                    <div class="dash-item-sub">
                      ${fmtDate(m.created_at)}
                      ${m.vehicle_info || m.license_plate ? `• 🚗 <strong>${escHtml(m.vehicle_info)} ${escHtml(m.license_plate)}</strong>` : ''}
                      ${m.customer_name ? `(${escHtml(m.customer_name)})` : ''}
                      ${m.supplier_info ? `• Forn: ${escHtml(m.supplier_info)}` : ''}
                    </div>
                  </div>
                  <div class="dash-item-price">
                    ${isEntry ? fmtBRL(m.unit_cost * m.quantity) : fmtBRL(m.unit_price * m.quantity)}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }
    }
  }

  // =========================================================================
  // 2. RENDERIZAÇÃO DO ESTOQUE DE PEÇAS (CARDS COMPLETOS)
  // =========================================================================
  renderInventory() {
    const grid = document.getElementById('inventory-grid');
    if (!grid) return;

    const catFilter = document.getElementById('filter-category')?.value || '';
    const voltFilter = document.getElementById('filter-voltage')?.value || '';
    const condFilter = document.getElementById('filter-condition')?.value || '';
    const stockFilter = document.getElementById('filter-stock-status')?.value || '';
    const q = this.searchQuery;

    const filtered = this.state.products.filter((p) => {
      if (catFilter && p.category !== catFilter) return false;
      if (voltFilter && p.voltage !== voltFilter) return false;
      if (condFilter && p.condition !== condFilter) return false;
      if (stockFilter === 'low' && p.quantity > p.min_quantity) return false;
      if (stockFilter === 'zero' && p.quantity > 0) return false;
      if (stockFilter === 'ok' && p.quantity <= p.min_quantity) return false;

      if (q) {
        const haystack = [
          p.name,
          p.sku,
          p.barcode,
          p.brand,
          p.category,
          p.vehicles,
          p.location,
          p.amperage,
          p.pins,
          ...(p.equivalent_codes || [])
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `
        <div class="product-card" style="grid-column: 1 / -1; text-align:center; padding:2.5rem;">
          <div style="font-size:2rem; margin-bottom:0.5rem;">🔍</div>
          <h3 style="font-size:1.05rem;">Nenhuma peça encontrada com esses filtros</h3>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin:0.4rem 0 1rem;">
            Tente buscar por outro código equivalente ou cadastre uma nova peça.
          </p>
          <div>
            <button class="btn btn-primary" onclick="app.openProductModal()">➕ Cadastrar Nova Peça</button>
          </div>
        </div>
      `;
      return;
    }

    grid.innerHTML = filtered.map((p) => this.renderProductCardHTML(p)).join('');
  }

  renderProductCardHTML(p) {
    const isLow = p.quantity <= p.min_quantity;
    const profit = (Number(p.sale_price) || 0) - (Number(p.cost_price) || 0);
    const equivs = Array.isArray(p.equivalent_codes) ? p.equivalent_codes : [];
    const links = Array.isArray(p.purchase_links) ? p.purchase_links : [];

    const conditionBadge =
      p.condition === 'recondicionado'
        ? `<span class="badge badge-recond">♻️ Recondicionado</span>`
        : p.condition === 'casco_base_troca'
          ? `<span class="badge badge-recond">🔄 Casco Base Troca</span>`
          : '';

    return `
      <div class="product-card ${isLow ? 'low-stock' : ''}">
        <div class="product-card-header">
          <div>
            <div class="sku-row">
              <span class="badge badge-sku">${escHtml(p.sku)}</span>
              <span class="badge badge-voltage">⚡ ${escHtml(p.voltage)} ${p.amperage ? `• ${escHtml(p.amperage)}` : ''}</span>
              <span class="badge badge-category">${escHtml(p.category)}</span>
              ${conditionBadge}
            </div>
            <div class="product-title">${escHtml(p.name)}</div>
            <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:0.2rem;">
              Marca: <strong>${escHtml(p.brand || 'Geral')}</strong>
              ${p.pins ? `• 🔌 ${escHtml(p.pins)}` : ''}
              ${p.location ? `• 📍 <strong>${escHtml(p.location)}</strong>` : ''}
            </div>
          </div>
        </div>

        <div class="product-specs">
          ${
            p.vehicles
              ? `<div class="spec-line"><span class="spec-label">🚗 Aplicação:</span><span>${escHtml(p.vehicles)}</span></div>`
              : ''
          }
          ${
            equivs.length > 0
              ? `<div class="spec-line">
                  <span class="spec-label">🔄 Equivalentes:</span>
                  <div class="equiv-tags">
                    ${equivs.map((c) => `<span class="equiv-tag">${escHtml(c)}</span>`).join('')}
                  </div>
                </div>`
              : ''
          }
          ${
            p.barcode
              ? `<div class="spec-line"><span class="spec-label">🏷️ Cód. Barras:</span><span style="font-family:monospace">${escHtml(p.barcode)}</span></div>`
              : ''
          }
        </div>

        <!-- Bloco de Preços e Porcentagens -->
        <div class="pricing-box">
          <div class="price-col">
            <span class="price-label">Preço Compra</span>
            <span class="price-val cost">${fmtBRL(p.cost_price)}</span>
            <span class="price-sub-pct">Custo unitário</span>
          </div>
          <div class="price-col">
            <span class="price-label">Preço Venda</span>
            <span class="price-val sale">${fmtBRL(p.sale_price)}</span>
            <span class="price-sub-pct">Lucro: <strong>${fmtBRL(profit)}</strong></span>
          </div>
          <div class="price-col">
            <span class="price-label">Porcentagens</span>
            <span class="price-val pct">+${fmtPct(p.markup_percent)}</span>
            <span class="price-sub-pct">Margem: ${fmtPct(p.margin_percent)}</span>
          </div>
        </div>

        <!-- Links de Compra Salvos e WhatsApp do Fornecedor -->
        ${
          links.length > 0
            ? `<div class="links-strip">
                ${links
                  .map((lnk) => {
                    const waDigits = String(lnk.supplier_whatsapp || '').replace(/\D/g, '');
                    const waText = encodeURIComponent(
                      `Olá! Preciso cotar a peça: ${p.name} (Cód: ${p.sku}). Qual o valor e disponibilidade?`
                    );
                    return `
                      ${
                        lnk.url
                          ? `<a href="${escHtml(lnk.url)}" target="_blank" rel="noopener" class="purchase-link-chip" title="Abrir link de compra salvo">
                              🛒 ${escHtml(lnk.store || 'Link de Compra')} ${lnk.last_price ? `(${fmtBRL(lnk.last_price)})` : ''} ↗
                            </a>`
                          : ''
                      }
                      ${
                        waDigits
                          ? `<a href="https://wa.me/55${waDigits}?text=${waText}" target="_blank" rel="noopener" class="purchase-link-chip whatsapp-chip" title="Cotar no WhatsApp do fornecedor">
                              💬 ${escHtml(lnk.supplier_name || 'WhatsApp')}
                            </a>`
                          : ''
                      }
                    `;
                  })
                  .join('')}
              </div>`
            : `<div style="font-size:0.74rem; color:var(--text-muted);">Nenhum link de compra salvo — clique em Editar para adicionar link.</div>`
        }

        <!-- Saldo e Ações Rápidas -->
        <div class="card-stock-footer">
          <div class="card-stock-top">
            <div class="stock-counter">
              <span class="stock-number ${isLow ? 'low' : ''}">${p.quantity} ${escHtml(p.unit)}</span>
              <div>
                <div style="font-size:0.74rem; font-weight:700; color:${isLow ? '#f87171' : 'var(--text-secondary)'};">
                  ${isLow ? '⚠️ Repor Estoque!' : '✅ Em Estoque'}
                </div>
                <div style="font-size:0.7rem; color:var(--text-muted);">Mín: ${p.min_quantity} ${escHtml(p.unit)}</div>
              </div>
            </div>

            <div class="card-tool-btns">
              <button class="btn btn-secondary btn-sm" onclick="app.openHistoryModal('${p.id}')" title="Ver histórico de preços de compra">
                📈
              </button>
              <button class="btn btn-secondary btn-sm" onclick="app.openProductModal('${p.id}')" title="Editar peça e links de compra">
                ✏️
              </button>
              <button class="btn btn-danger btn-sm" onclick="app.confirmDeleteProduct('${p.id}')" title="Excluir peça do estoque">
                🗑️
              </button>
            </div>
          </div>

          <div class="card-main-actions">
            <button class="btn btn-secondary btn-sm" onclick="app.quickMinusOne('${p.id}')" title="Baixa rápida de 1 unidade no balcão">
              -1 Balcão
            </button>
            <button class="btn btn-secondary btn-sm" onclick="app.openQuickMovementModal('saida', '${p.id}')" title="Aplicar peça em veículo / Ordem de Serviço">
              🔧 OS
            </button>
            <button class="btn btn-success btn-sm" onclick="app.openQuickMovementModal('entrada', '${p.id}')" title="Dar entrada em novas unidades">
              + Entrada
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // 3. LISTA DE REPOSIÇÃO AUTOMÁTICA (COMPRAS)
  // =========================================================================
  renderRestock() {
    const tbody = document.getElementById('restock-table-body');
    const summaryEl = document.getElementById('restock-summary-badge');
    if (!tbody) return;

    const lowProducts = this.state.products.filter((p) => p.quantity <= p.min_quantity);
    let totalEstimatedOrder = 0;

    for (const p of lowProducts) {
      const suggestedQty = Math.max(1, p.min_quantity * 2 - p.quantity);
      totalEstimatedOrder += suggestedQty * (Number(p.cost_price) || 0);
    }

    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="badge badge-sku" style="font-size:0.82rem; padding:0.45rem 0.75rem; white-space:normal; text-align:left;">
          ${lowProducts.length} itens para repor • Custo Estimado: <strong>${fmtBRL(totalEstimatedOrder)}</strong>
        </div>
      `;
    }

    if (lowProducts.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align:center; padding:2rem; color:var(--text-secondary);">
            ✅ Nenhuma peça abaixo do estoque mínimo no momento!
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = lowProducts
      .map((p) => {
        const suggestedQty = Math.max(1, p.min_quantity * 2 - p.quantity);
        const estCost = suggestedQty * (Number(p.cost_price) || 0);
        const links = Array.isArray(p.purchase_links) ? p.purchase_links : [];

        return `
          <tr>
            <td data-label="Peça / Código">
              <div style="font-weight:700;">${escHtml(p.name)}</div>
              <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:0.15rem;">
                <span class="badge badge-sku">${escHtml(p.sku)}</span>
                ${escHtml(p.brand)} • ${escHtml(p.voltage)}
              </div>
            </td>
            <td data-label="Localização">${escHtml(p.location || '-')}</td>
            <td data-label="Saldo / Mín.">
              <span class="badge badge-low">${p.quantity} ${escHtml(p.unit)}</span>
              <span style="font-size:0.75rem; color:var(--text-muted);"> / Mín: ${p.min_quantity}</span>
            </td>
            <td data-label="Sugestão Compra">
              <strong>Comprar +${suggestedQty} ${escHtml(p.unit)}</strong>
              <div style="font-size:0.74rem; color:var(--text-secondary);">Subtotal: ${fmtBRL(estCost)}</div>
            </td>
            <td data-label="Último Preço">
              <strong>${fmtBRL(p.cost_price)}</strong>
              <div style="font-size:0.74rem; color:var(--success);">Venda: ${fmtBRL(p.sale_price)} (+${fmtPct(p.markup_percent)})</div>
            </td>
            <td data-label="Links & Fornecedor">
              <div class="links-strip">
                ${
                  links.length > 0
                    ? links
                        .map((l) => {
                          const waDigits = String(l.supplier_whatsapp || '').replace(/\D/g, '');
                          return `
                            ${
                              l.url
                                ? `<a href="${escHtml(l.url)}" target="_blank" rel="noopener" class="purchase-link-chip">
                                    🛒 ${escHtml(l.store || 'Abrir Link')} ↗
                                  </a>`
                                : ''
                            }
                            ${
                              waDigits
                                ? `<a href="https://wa.me/55${waDigits}?text=${encodeURIComponent(`Olá! Preciso pedir ${suggestedQty}x ${p.name} (${p.sku}).`)}" target="_blank" rel="noopener" class="purchase-link-chip whatsapp-chip">
                                    💬 ${escHtml(l.supplier_name || 'WhatsApp')}
                                  </a>`
                                : ''
                            }
                          `;
                        })
                        .join('')
                    : `<button class="btn btn-secondary btn-sm" onclick="app.openProductModal('${p.id}')">+ Salvar Link</button>`
                }
              </div>
            </td>
            <td data-label="Ação">
              <button class="btn btn-success btn-sm" style="width:100%;" onclick="app.openQuickMovementModal('entrada', '${p.id}', ${suggestedQty})">
                📥 Dar Entrada
              </button>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // =========================================================================
  // 4. HISTÓRICO DE MOVIMENTAÇÕES E ORDENS DE SERVIÇO (OS)
  // =========================================================================
  renderMovements() {
    const tbody = document.getElementById('movements-table-body');
    if (!tbody) return;

    const search = (document.getElementById('movement-search')?.value || '').trim().toLowerCase();
    const typeFilter = document.getElementById('movement-type-filter')?.value || '';

    const filtered = this.state.movements.filter((m) => {
      if (typeFilter && m.type !== typeFilter) return false;
      if (search) {
        const hay = [
          m.product_name,
          m.product_sku,
          m.vehicle_info,
          m.license_plate,
          m.customer_name,
          m.supplier_info,
          m.notes
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align:center; padding:2rem; color:var(--text-secondary);">
            Nenhuma movimentação encontrada para o filtro selecionado.
          </td>
        </tr>
      `;
      return;
    }

    const reasonLabels = {
      compra_reposicao: 'Compra / Reposição',
      ordem_servico: 'Aplicação em OS / Veículo',
      venda_balcao: 'Venda de Balcão',
      recondicionamento: 'Reforma de Bancada',
      garantia_troca: 'Garantia / Troca'
    };

    tbody.innerHTML = filtered
      .map((m) => {
        const isEntry = m.type === 'entrada';
        return `
          <tr>
            <td data-label="Data / Hora">${fmtDate(m.created_at)}</td>
            <td data-label="Tipo">
              <span class="badge ${isEntry ? 'badge-ok' : 'badge-voltage'}">
                ${isEntry ? '📥 ENTRADA' : '📤 SAÍDA'}
              </span>
              <div style="font-size:0.72rem; color:var(--text-secondary); margin-top:0.2rem;">
                ${escHtml(reasonLabels[m.reason] || m.reason)}
              </div>
            </td>
            <td data-label="Peça">
              <strong>${escHtml(m.product_name)}</strong>
              <div><span class="badge badge-sku">${escHtml(m.product_sku)}</span></div>
            </td>
            <td data-label="Quantidade">
              <strong style="font-size:0.98rem; color:${isEntry ? 'var(--success)' : 'var(--accent)'};">
                ${isEntry ? '+' : '-'}${m.quantity}
              </strong>
              <div style="font-size:0.72rem; color:var(--text-muted);">
                Saldo: ${m.prev_quantity} → ${m.new_quantity}
              </div>
            </td>
            <td data-label="Valores">
              <div>Compra: <strong>${fmtBRL(m.unit_cost)}</strong></div>
              <div style="color:var(--success);">Venda: <strong>${fmtBRL(m.unit_price)}</strong></div>
            </td>
            <td data-label="Veículo / Detalhes">
              ${
                m.vehicle_info || m.license_plate
                  ? `<div>🚗 <strong>${escHtml(m.vehicle_info)}</strong> ${m.license_plate ? `<span class="badge badge-sku">${escHtml(m.license_plate)}</span>` : ''}</div>`
                  : ''
              }
              ${m.customer_name ? `<div>👤 ${escHtml(m.customer_name)}</div>` : ''}
              ${m.supplier_info ? `<div>🏢 Forn: ${escHtml(m.supplier_info)}</div>` : ''}
              ${m.notes ? `<div style="font-size:0.76rem; color:var(--text-secondary);">📝 ${escHtml(m.notes)}</div>` : ''}
              ${!m.vehicle_info && !m.license_plate && !m.customer_name && !m.supplier_info && !m.notes ? '-' : ''}
            </td>
            <td data-label="Aparelho"><span class="equiv-tag">${escHtml(m.device_name || 'Oficina')}</span></td>
          </tr>
        `;
      })
      .join('');
  }

  // =========================================================================
  // 5. CASCOS E PEÇAS RECONDICIONADAS
  // =========================================================================
  renderCores() {
    const grid = document.getElementById('cores-grid');
    if (!grid) return;
    const cores = this.state.products.filter((p) => p.condition !== 'novo');
    if (cores.length === 0) {
      grid.innerHTML = `
        <div class="product-card" style="grid-column: 1 / -1; text-align:center; padding:2rem;">
          <p style="color:var(--text-secondary);">Nenhum casco ou peça recondicionada cadastrada.</p>
        </div>
      `;
      return;
    }
    grid.innerHTML = cores.map((p) => this.renderProductCardHTML(p)).join('');
  }

  // =========================================================================
  // 6. MODAL DE CADASTRO DE PEÇA + CÁLCULO DE PORCENTAGEM E LINKS DE COMPRA
  // =========================================================================
  openProductModal(productId = null, defaultCondition = 'novo') {
    const form = document.getElementById('form-product');
    form?.reset();

    const linksContainer = document.getElementById('prod-links-container');
    if (linksContainer) linksContainer.innerHTML = '';

    const existing = productId ? this.state.products.find((p) => p.id === productId) : null;
    const titleEl = document.getElementById('modal-product-title');

    if (existing) {
      if (titleEl) titleEl.textContent = `✏️ Editar Peça: ${existing.sku}`;
      document.getElementById('prod-id').value = existing.id;
      document.getElementById('prod-name').value = existing.name;
      document.getElementById('prod-sku').value = existing.sku;
      document.getElementById('prod-category').value = existing.category;
      document.getElementById('prod-brand').value = existing.brand || '';
      document.getElementById('prod-barcode').value = existing.barcode || '';
      document.getElementById('prod-equivalents').value = (existing.equivalent_codes || []).join(', ');
      document.getElementById('prod-voltage').value = existing.voltage || '12V';
      document.getElementById('prod-amperage').value = existing.amperage || '';
      document.getElementById('prod-pins').value = existing.pins || '';
      document.getElementById('prod-condition').value = existing.condition || 'novo';
      document.getElementById('prod-vehicles').value = existing.vehicles || '';
      document.getElementById('prod-location').value = existing.location || '';
      document.getElementById('prod-cost').value = existing.cost_price;
      document.getElementById('prod-sale').value = existing.sale_price;
      document.getElementById('prod-qty').value = existing.quantity;
      document.getElementById('prod-min-qty').value = existing.min_quantity;
      document.getElementById('prod-unit').value = existing.unit || 'UN';
      document.getElementById('prod-notes').value = existing.notes || '';

      this.onCostOrSaleInput('sale');

      const links = Array.isArray(existing.purchase_links) ? existing.purchase_links : [];
      if (links.length > 0) {
        links.forEach((l) => this.addPurchaseLinkRow(l));
      } else {
        this.addPurchaseLinkRow();
      }
    } else {
      if (titleEl) titleEl.textContent = '➕ Cadastrar Nova Peça na Autoelétrica';
      document.getElementById('prod-id').value = '';
      document.getElementById('prod-condition').value = defaultCondition;
      document.getElementById('prod-qty').value = 1;
      document.getElementById('prod-min-qty').value = 2;
      this.addPurchaseLinkRow();
      this.updateProfitPreview(0, 0);
    }

    document.getElementById('modal-product')?.classList.add('open');
  }

  addPurchaseLinkRow(linkData = {}) {
    const container = document.getElementById('prod-links-container');
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'purchase-link-row';

    row.innerHTML = `
      <input type="text" class="form-input link-store" placeholder="Loja (Ex: Mercado Livre)" value="${escHtml(linkData.store || '')}" />
      <input type="url" class="form-input link-url" placeholder="https://produto.mercadolivre.com.br/..." value="${escHtml(linkData.url || '')}" />
      <input type="number" step="0.01" class="form-input link-price" placeholder="Últ. R$" value="${linkData.last_price || ''}" />
      <input type="text" class="form-input link-supplier" placeholder="Nome Vendedor" value="${escHtml(linkData.supplier_name || '')}" />
      <input type="text" class="form-input link-whatsapp" placeholder="WhatsApp (DDD+Nº)" value="${escHtml(linkData.supplier_whatsapp || '')}" />
      <button type="button" class="btn btn-danger btn-sm link-remove-btn" onclick="this.parentElement.remove()" title="Remover link">✕</button>
    `;
    container.appendChild(row);
  }

  onCostOrSaleInput(source) {
    const cost = Number(document.getElementById('prod-cost')?.value) || 0;
    const sale = Number(document.getElementById('prod-sale')?.value) || 0;
    const markupInput = document.getElementById('prod-markup');

    if (cost > 0 && sale > 0) {
      const { markup } = LocalFirstStore.calcPercentages(cost, sale);
      if (markupInput && source !== 'markup') {
        markupInput.value = markup;
      }
    }
    this.updateProfitPreview(cost, sale);
  }

  onMarkupInput() {
    const cost = Number(document.getElementById('prod-cost')?.value) || 0;
    const markup = Number(document.getElementById('prod-markup')?.value) || 0;
    const saleInput = document.getElementById('prod-sale');

    if (cost > 0) {
      const suggestedSale = Number((cost * (1 + markup / 100)).toFixed(2));
      if (saleInput) saleInput.value = suggestedSale;
      this.updateProfitPreview(cost, suggestedSale);
    }
  }

  applyPresetMarkup(pct) {
    const markupInput = document.getElementById('prod-markup');
    if (markupInput) {
      markupInput.value = pct;
      this.onMarkupInput();
    }
  }

  updateProfitPreview(cost, sale) {
    const preview = document.getElementById('prod-profit-preview');
    if (!preview) return;
    const { margin, profit } = LocalFirstStore.calcPercentages(cost, sale);
    preview.textContent = `${fmtBRL(profit)} (Margem: ${fmtPct(margin)})`;
    preview.style.color = profit >= 0 ? 'var(--success)' : '#f87171';
  }

  buildAutoSku(category) {
    const prefixes = {
      'Alternador': 'ALT',
      'Motor de Partida': 'PAR',
      'Relés e Fusíveis': 'REL',
      'Iluminação e Lâmpadas': 'ILU',
      'Baterias e Cabos': 'BAT',
      'Injeção e Ignição': 'INJ',
      'Chicotes e Conectores': 'CHI',
      'Sensores e Atuadores': 'SEN',
      'Insumos e Diversos': 'DIV'
    };
    const prefix = prefixes[category] || 'PEC';
    const nextNum = String(this.state.products.length + 1).padStart(3, '0');
    const rand = Math.floor(10 + Math.random() * 90);
    return `${prefix}-${nextNum}${rand}`;
  }

  generateAutoSku() {
    const category = document.getElementById('prod-category')?.value || 'Diversos';
    const skuInput = document.getElementById('prod-sku');
    if (skuInput) {
      skuInput.value = this.buildAutoSku(category);
    }
  }

  async handleSaveProduct(e) {
    e.preventDefault();

    const linkRows = document.querySelectorAll('#prod-links-container .purchase-link-row');
    const purchase_links = [];
    linkRows.forEach((row, idx) => {
      const store = row.querySelector('.link-store')?.value.trim() || '';
      const url = row.querySelector('.link-url')?.value.trim() || '';
      const last_price = Number(row.querySelector('.link-price')?.value) || 0;
      const supplier_name = row.querySelector('.link-supplier')?.value.trim() || '';
      const supplier_whatsapp = row.querySelector('.link-whatsapp')?.value.trim() || '';

      if (store || url || supplier_name || supplier_whatsapp) {
        purchase_links.push({
          id: `lnk-${Date.now()}-${idx}`,
          store: store || 'Fornecedor',
          url,
          last_price: last_price || Number(document.getElementById('prod-cost')?.value) || 0,
          supplier_name,
          supplier_whatsapp
        });
      }
    });

    const categoryVal = document.getElementById('prod-category').value;
    const rawSku = (document.getElementById('prod-sku').value || '').trim();

    const payload = {
      id: document.getElementById('prod-id').value || undefined,
      name: document.getElementById('prod-name').value,
      sku: rawSku || this.buildAutoSku(categoryVal),
      category: categoryVal,
      brand: document.getElementById('prod-brand').value,
      barcode: document.getElementById('prod-barcode').value,
      equivalent_codes: document.getElementById('prod-equivalents').value,
      voltage: document.getElementById('prod-voltage').value,
      amperage: document.getElementById('prod-amperage').value,
      pins: document.getElementById('prod-pins').value,
      condition: document.getElementById('prod-condition').value,
      vehicles: document.getElementById('prod-vehicles').value,
      location: document.getElementById('prod-location').value,
      cost_price: Number(document.getElementById('prod-cost').value) || 0,
      sale_price: Number(document.getElementById('prod-sale').value) || 0,
      quantity: Math.max(0, Math.round(Number(document.getElementById('prod-qty').value) || 0)),
      min_quantity: Math.max(0, Math.round(Number(document.getElementById('prod-min-qty').value) || 1)),
      unit: document.getElementById('prod-unit').value,
      purchase_links,
      notes: document.getElementById('prod-notes').value
    };

    await window.store.saveProduct(payload);
    this.closeModal('modal-product');
    this.showToast('✅ Peça salva com sucesso!');
  }

  // =========================================================================
  // 7. MOVIMENTAÇÕES DE ESTOQUE (ENTRADA, BAIXA RÁPIDA -1 E APLICAÇÃO EM OS)
  // =========================================================================
  async quickMinusOne(productId) {
    const product = this.state.products.find((p) => p.id === productId);
    if (!product) return;
    if (product.quantity <= 0) {
      this.showToast('⚠️ Estoque desta peça já está zerado!');
      return;
    }

    await window.store.recordMovement({
      product_id: productId,
      type: 'saida',
      quantity: 1,
      reason: 'venda_balcao',
      notes: 'Baixa rápida (-1) no balcão'
    });
    this.showToast(`📤 Baixa de 1x ${product.sku} registrada! (Restam: ${product.quantity - 1})`);
  }

  openQuickMovementModal(type = 'entrada', preselectedProductId = null, suggestedQty = 1) {
    const select = document.getElementById('mov-product-id');
    if (!select) return;

    select.innerHTML = this.state.products
      .map(
        (p) =>
          `<option value="${p.id}">[${escHtml(p.sku)}] ${escHtml(p.name)} (Saldo: ${p.quantity} ${p.unit})</option>`
      )
      .join('');

    if (preselectedProductId) {
      select.value = preselectedProductId;
    }

    document.getElementById('mov-type').value = type;
    document.getElementById('mov-qty').value = Math.max(1, Math.round(Number(suggestedQty) || 1));
    document.getElementById('mov-vehicle').value = '';
    document.getElementById('mov-plate').value = '';
    document.getElementById('mov-customer').value = '';
    document.getElementById('mov-supplier').value = '';
    document.getElementById('mov-notes').value = '';

    const titleEl = document.getElementById('modal-movement-title');
    const reasonEl = document.getElementById('mov-reason');
    const pricingBox = document.getElementById('mov-pricing-fields');
    const vehicleBox = document.getElementById('mov-vehicle-fields');

    if (type === 'entrada') {
      if (titleEl) titleEl.textContent = '📥 Entrada de Mercadoria / Reposição';
      if (reasonEl) reasonEl.value = 'compra_reposicao';
      if (pricingBox) pricingBox.style.display = 'block';
      if (vehicleBox) vehicleBox.style.display = 'none';
    } else {
      if (titleEl) titleEl.textContent = '📤 Saída de Peça / Aplicação em OS';
      if (reasonEl) reasonEl.value = 'ordem_servico';
      if (pricingBox) pricingBox.style.display = 'none';
      if (vehicleBox) vehicleBox.style.display = 'flex';
    }

    this.onMovementProductChange();
    document.getElementById('modal-movement')?.classList.add('open');
  }

  onMovementProductChange() {
    const prodId = document.getElementById('mov-product-id')?.value;
    const prod = this.state.products.find((p) => p.id === prodId);
    if (!prod) return;

    document.getElementById('mov-unit-cost').value = prod.cost_price;
    document.getElementById('mov-unit-price').value = prod.sale_price;
    document.getElementById('mov-markup').value = prod.markup_percent;

    const firstLink = (prod.purchase_links || [])[0];
    if (firstLink && document.getElementById('mov-type').value === 'entrada') {
      document.getElementById('mov-supplier').value = firstLink.store || firstLink.supplier_name || '';
    }
  }

  onMovPriceInput(source) {
    const cost = Number(document.getElementById('mov-unit-cost')?.value) || 0;
    const markup = Number(document.getElementById('mov-markup')?.value) || 0;
    const sale = Number(document.getElementById('mov-unit-price')?.value) || 0;

    if (source === 'cost' || source === 'markup') {
      if (cost > 0) {
        document.getElementById('mov-unit-price').value = Number((cost * (1 + markup / 100)).toFixed(2));
      }
    } else if (source === 'sale') {
      if (cost > 0 && sale > 0) {
        const { markup: calcM } = LocalFirstStore.calcPercentages(cost, sale);
        document.getElementById('mov-markup').value = calcM;
      }
    }
  }

  async handleSaveMovement(e) {
    e.preventDefault();
    const type = document.getElementById('mov-type').value;
    const product_id = document.getElementById('mov-product-id').value;
    const quantity = Math.max(1, Math.round(Number(document.getElementById('mov-qty').value) || 1));
    const reason = document.getElementById('mov-reason').value;

    await window.store.recordMovement({
      product_id,
      type,
      quantity,
      reason,
      unit_cost: Number(document.getElementById('mov-unit-cost').value) || 0,
      unit_price: Number(document.getElementById('mov-unit-price').value) || 0,
      vehicle_info: document.getElementById('mov-vehicle').value,
      license_plate: document.getElementById('mov-plate').value,
      customer_name: document.getElementById('mov-customer').value,
      supplier_info: document.getElementById('mov-supplier').value,
      notes: document.getElementById('mov-notes').value
    });

    this.closeModal('modal-movement');
    this.showToast(type === 'entrada' ? '📥 Entrada registrada e estoque atualizado!' : '📤 Saída / OS registrada!');
  }

  // =========================================================================
  // 8. HISTÓRICO DE PREÇOS E LINKS DA PEÇA
  // =========================================================================
  openHistoryModal(productId) {
    const p = this.state.products.find((item) => item.id === productId);
    if (!p) return;

    const titleEl = document.getElementById('modal-history-title');
    const bodyEl = document.getElementById('modal-history-body');
    if (titleEl) titleEl.textContent = `📈 Histórico: ${p.sku}`;

    const history = Array.isArray(p.price_history) ? [...p.price_history].reverse() : [];
    const links = Array.isArray(p.purchase_links) ? p.purchase_links : [];

    if (bodyEl) {
      bodyEl.innerHTML = `
        <div>
          <h4 style="font-size:0.95rem; font-weight:800;">${escHtml(p.name)}</h4>
          <p style="font-size:0.8rem; color:var(--text-secondary);">
            Compra Atual: <strong>${fmtBRL(p.cost_price)}</strong> • Venda Atual: <strong style="color:var(--success)">${fmtBRL(p.sale_price)}</strong>
            (Markup: +${fmtPct(p.markup_percent)} / Margem: ${fmtPct(p.margin_percent)})
          </p>
        </div>

        <div class="form-section-title">Links de Compra Salvos</div>
        ${
          links.length === 0
            ? `<p style="font-size:0.82rem; color:var(--text-secondary);">Nenhum link cadastrado.</p>`
            : `<div style="display:flex; flex-direction:column; gap:0.45rem;">
                ${links
                  .map(
                    (l) => `
                  <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-input); padding:0.6rem; border-radius:6px; border:1px solid var(--border-color);">
                    <div>
                      <div style="font-weight:700; font-size:0.84rem;">${escHtml(l.store)}</div>
                      <div style="font-size:0.75rem; color:var(--text-secondary);">
                        Último preço: ${fmtBRL(l.last_price)} ${l.supplier_name ? `• ${escHtml(l.supplier_name)}` : ''}
                      </div>
                    </div>
                    ${
                      l.url
                        ? `<a href="${escHtml(l.url)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">Abrir Link ↗</a>`
                        : ''
                    }
                  </div>
                `
                  )
                  .join('')}
              </div>`
        }

        <div class="form-section-title">Histórico de Variação de Preços</div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Compra</th>
                <th>Venda</th>
                <th>Observação</th>
              </tr>
            </thead>
            <tbody>
              ${
                history.length === 0
                  ? `<tr><td colspan="4">Sem registros anteriores.</td></tr>`
                  : history
                      .map(
                        (h) => `
                    <tr>
                      <td>${fmtDate(h.date)}</td>
                      <td><strong>${fmtBRL(h.cost_price)}</strong></td>
                      <td style="color:var(--success);">${fmtBRL(h.sale_price)}</td>
                      <td>${escHtml(h.note || '-')}</td>
                    </tr>
                  `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>

        <div style="display:flex; justify-content:flex-end; margin-top:0.5rem;">
          <button class="btn btn-secondary btn-sm" onclick="app.closeModal('modal-history'); app.openProductModal('${p.id}')">✏️ Editar Peça</button>
        </div>
      `;
    }

    document.getElementById('modal-history')?.classList.add('open');
  }

  async confirmDeleteProduct(id) {
    if (!confirm('Tem certeza que deseja excluir esta peça do estoque?')) return;
    await window.store.deleteProduct(id);
    this.closeModal('modal-history');
    this.showToast('🗑️ Peça removida do estoque.');
  }

  // =========================================================================
  // 9. SINCRONIZAÇÃO WI-FI (QR CODE) E BACKUP / RESTAURAÇÃO
  // =========================================================================
  async manualSync() {
    const ok = await window.store.syncWithServer();
    if (ok) {
      this.showToast('📡 Sincronizado com sucesso via Wi-Fi!');
    } else {
      this.showToast('⚡ Modo Offline: Dados salvos neste aparelho (sincronizará quando conectar no Wi-Fi da oficina).');
    }
  }

  async loadWifiQrInfo() {
    const tabList = document.getElementById('sync-tab-qr-list');
    const modalBody = document.getElementById('modal-qr-body');

    try {
      const res = await fetch('/api/info');
      if (!res.ok) throw new Error('Offline');
      const info = await res.json();

      const html = (info.addresses || [])
        .map(
          (addr) => `
          <div class="qr-container">
            <div style="font-size:0.84rem; font-weight:800; color:var(--success);">
              🔒 Modo HTTPS (Recomendado — Libera Câmera Ao Vivo no Celular)
            </div>
            ${addr.httpsQrSvg || addr.qrSvg || ''}
            <a href="${escHtml(addr.httpsUrl || addr.url)}" style="font-family:monospace; font-size:1.02rem; font-weight:900; color:var(--success); background:var(--bg-surface); padding:0.45rem 0.8rem; border-radius:6px; border:1px solid var(--border-color); text-decoration:none;">
              ${escHtml(addr.httpsUrl || addr.url)}
            </a>
            <div style="font-size:0.75rem; color:var(--text-secondary);">
              No 1º acesso HTTPS no celular, toque em <strong>"Avançado" → "Ir para ${escHtml(addr.ip)}"</strong> para ativar a permissão da câmera ao vivo.
            </div>
            <div style="margin-top:0.4rem; padding-top:0.5rem; border-top:1px solid var(--border-color); width:100%; font-size:0.76rem; color:var(--text-muted);">
              Link HTTP Alternativo (Foto Nativa): <strong style="color:var(--accent)">${escHtml(addr.url)}</strong>
            </div>
          </div>
        `
        )
        .join('');

      if (tabList) tabList.innerHTML = html;
      if (modalBody) modalBody.innerHTML = html;
    } catch {
      const fallbackMsg = `
        <div class="qr-container">
          <p style="font-size:0.88rem; color:var(--accent); font-weight:700;">
            ⚡ Você está operando em Modo Offline Independente neste aparelho.
          </p>
          <p style="font-size:0.8rem; color:var(--text-secondary);">
            Quando estiver no computador da oficina com o servidor aberto, o QR Code da rede Wi-Fi aparecerá aqui automaticamente.
          </p>
        </div>
      `;
      if (tabList) tabList.innerHTML = fallbackMsg;
      if (modalBody) modalBody.innerHTML = fallbackMsg;
    }
  }

  openQrModal() {
    this.loadWifiQrInfo();
    document.getElementById('modal-qr')?.classList.add('open');
  }

  saveDeviceName() {
    const val = document.getElementById('device-name-input')?.value;
    window.store.setDeviceName(val);
    this.showToast(`✅ Nome do aparelho salvo: ${window.store.deviceName}`);
  }

  exportBackupJson() {
    const payload = {
      app: 'EletrocarDoGuiGui',
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      deviceName: this.state.deviceName,
      products: this.state.products,
      movements: this.state.movements
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `backup_eletrocardoguigui_${dateStr}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('💾 Backup .JSON gerado com sucesso!');
  }

  exportInventoryCsv() {
    const headers = [
      'Codigo_SKU',
      'Codigo_Barras',
      'Nome_Peca',
      'Categoria',
      'Marca',
      'Voltagem',
      'Amperagem',
      'Condicao',
      'Localizacao',
      'Qtd_Atual',
      'Estoque_Minimo',
      'Preco_Compra_R$',
      'Preco_Venda_R$',
      'Markup_%',
      'Margem_%',
      'Codigos_Equivalentes',
      'Link_Principal'
    ];

    const rows = this.state.products.map((p) => {
      const firstLink = (p.purchase_links || [])[0]?.url || '';
      return [
        p.sku,
        p.barcode,
        p.name,
        p.category,
        p.brand,
        p.voltage,
        p.amperage,
        p.condition,
        p.location,
        String(p.quantity).replace('.', ','),
        String(p.min_quantity).replace('.', ','),
        String(p.cost_price.toFixed(2)).replace('.', ','),
        String(p.sale_price.toFixed(2)).replace('.', ','),
        String(p.markup_percent).replace('.', ','),
        String(p.margin_percent).replace('.', ','),
        (p.equivalent_codes || []).join(' / '),
        firstLink
      ]
        .map((val) => `"${String(val ?? '').replace(/"/g, '""')}"`)
        .join(';');
    });

    const csvContent = '\uFEFF' + [headers.join(';'), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `planilha_estoque_autoeletrica_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('📊 Planilha .CSV exportada para Excel!');
  }

  async handleImportBackup(replaceAll = false) {
    const fileInput = document.getElementById('import-backup-file');
    const file = fileInput?.files?.[0];
    if (!file) {
      this.showToast('⚠️ Selecione um arquivo .json de backup primeiro.');
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.products)) {
        throw new Error('Formato de backup inválido');
      }
      await window.store.importFullBackup(parsed, replaceAll);
      fileInput.value = '';
      this.showToast('✅ Backup importado e estoque atualizado!');
    } catch (err) {
      this.showToast('❌ Erro ao ler arquivo de backup: ' + err.message);
    }
  }

  // =========================================================================
  // 10. LEITOR DE CÓDIGO DE BARRAS PELA CÂMERA (CELULAR / WEBCAM + FOTO NATIVA)
  // =========================================================================
  async openBarcodeScanner(mode = 'search') {
    this.scannerMode = mode;
    document.getElementById('scanner-manual-input').value = '';
    const photoInput = document.getElementById('scanner-photo-input');
    if (photoInput) photoInput.value = '';
    document.getElementById('modal-scanner')?.classList.add('open');

    const video = document.getElementById('scanner-video');
    const videoBox = document.getElementById('scanner-video-box');
    const statusMsg = document.getElementById('scanner-status-msg');
    const httpsAlert = document.getElementById('scanner-https-alert');
    const httpsLink = document.getElementById('scanner-https-link');

    // Verifica se o navegador bloqueou getUserMedia por estar em HTTP na rede local
    const isSecure = window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

    if (!isSecure || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (httpsAlert) httpsAlert.style.display = 'block';
      if (httpsLink) {
        httpsLink.href = `https://${location.hostname}:3443`;
      }
      if (videoBox) videoBox.style.display = 'none';
      if (statusMsg) {
        statusMsg.innerHTML =
          '👆 Toque em <strong>"📸 Abrir Câmera do Celular"</strong> acima para tirar foto do código de barras (funciona direto sem HTTPS!), ou mude para o link HTTPS para vídeo ao vivo.';
      }
      return;
    }

    if (httpsAlert) httpsAlert.style.display = 'none';
    if (videoBox) videoBox.style.display = 'flex';

    try {
      this.scannerStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      if (video) {
        video.srcObject = this.scannerStream;
        await video.play();
      }

      if (statusMsg) {
        statusMsg.textContent = 'Câmera ativa! Aponte para o código de barras da peça...';
      }

      const detector =
        'BarcodeDetector' in window
          ? new window.BarcodeDetector({
              formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'qr_code']
            })
          : null;

      this.scannerTimer = setInterval(async () => {
        if (!video || video.readyState < 2) return;
        try {
          if (detector) {
            const barcodes = await detector.detect(video);
            if (barcodes.length > 0 && barcodes[0].rawValue) {
              this.onBarcodeDetected(barcodes[0].rawValue);
              return;
            }
          }
          // Fallback em JS puro para EAN-13 / EAN-8 no frame de vídeo
          const decoded = this.decodeEANFromSource(video, video.videoWidth, video.videoHeight);
          if (decoded) {
            this.onBarcodeDetected(decoded);
          }
        } catch {}
      }, 350);
    } catch (err) {
      if (videoBox) videoBox.style.display = 'none';
      if (statusMsg) {
        statusMsg.innerHTML =
          'Permissão de vídeo negada ou indisponível. Use o botão laranja <strong>"📸 Abrir Câmera do Celular (Foto)"</strong> acima ou digite abaixo:';
      }
    }
  }

  async handleCameraPhotoCapture(event) {
    const file = event.target?.files?.[0];
    if (!file) return;

    const statusMsg = document.getElementById('scanner-status-msg');
    if (statusMsg) {
      statusMsg.innerHTML = '⏳ <strong>Analisando foto do código de barras...</strong>';
    }

    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = URL.createObjectURL(file);
      });

      // 1. Tenta com BarcodeDetector nativo do Android/Chrome se existir
      if ('BarcodeDetector' in window) {
        try {
          const detector = new window.BarcodeDetector({
            formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'qr_code']
          });
          const barcodes = await detector.detect(img);
          if (barcodes.length > 0 && barcodes[0].rawValue) {
            URL.revokeObjectURL(img.src);
            this.onBarcodeDetected(barcodes[0].rawValue);
            return;
          }
        } catch {}
      }

      // 2. Decodificador 1D (EAN-13 / EAN-8 / UPC) em JavaScript puro via Canvas
      const code = this.decodeEANFromSource(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
      URL.revokeObjectURL(img.src);

      if (code) {
        this.onBarcodeDetected(code);
      } else {
        if (statusMsg) {
          statusMsg.innerHTML =
            '⚠️ Não foi possível focar o código na foto. Tente aproximar bem das barras pretas com boa luz ou digite abaixo:';
        }
        this.showToast('⚠️ Tente tirar a foto mais de perto do código de barras.');
      }
    } catch {
      if (statusMsg) {
        statusMsg.textContent = 'Erro ao processar a foto. Tente novamente ou digite o código abaixo.';
      }
    }
  }

  // Decodificador EAN-13 / UPC-A em JS puro (varre múltiplas linhas horizontais da imagem)
  decodeEANFromSource(source, width, height) {
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    const targetW = Math.min(1200, width);
    const scale = targetW / width;
    const targetH = Math.max(100, Math.floor(height * scale));
    canvas.width = targetW;
    canvas.height = targetH;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, targetW, targetH);

    const L_CODES = {
      '0001101': 0, '0011001': 1, '0010011': 2, '0111101': 3, '0100011': 4,
      '0110001': 5, '0101111': 6, '0111011': 7, '0110111': 8, '0001011': 9
    };
    const G_CODES = {
      '0100111': 0, '0110011': 1, '0011011': 2, '0100001': 3, '0011101': 4,
      '0111001': 5, '0000101': 6, '0010001': 7, '0001001': 8, '0010111': 9
    };
    const R_CODES = {
      '1110010': 0, '1100110': 1, '1101100': 2, '1000010': 3, '1011100': 4,
      '1001110': 5, '1010000': 6, '1000100': 7, '1001000': 8, '1110100': 9
    };
    const PARITY_MAP = {
      'LLLLLL': 0, 'LLGLGG': 1, 'LLGGLG': 2, 'LLGGGL': 3, 'LGLLGG': 4,
      'LGGLLG': 5, 'LGGGLL': 6, 'LGLGLG': 7, 'LGLGGL': 8, 'LGGLGL': 9
    };

    const scanRatios = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7];
    const candidates = {};

    for (const ratio of scanRatios) {
      const y = Math.floor(targetH * ratio);
      const rowData = ctx.getImageData(0, y, targetW, 1).data;
      const gray = new Uint8Array(targetW);
      let sum = 0;
      for (let x = 0; x < targetW; x++) {
        const idx = x * 4;
        const lum = (rowData[idx] * 299 + rowData[idx + 1] * 587 + rowData[idx + 2] * 114) / 1000;
        gray[x] = lum;
        sum += lum;
      }

      const avg = sum / targetW;
      for (const threshFactor of [0.85, 0.95, 1.05]) {
        const thresh = avg * threshFactor;
        const bin = new Uint8Array(targetW);
        for (let x = 0; x < targetW; x++) {
          bin[x] = gray[x] < thresh ? 1 : 0;
        }

        // Extrai runs de barras claras/escuras
        const runs = [];
        let cur = bin[0];
        let len = 1;
        for (let x = 1; x < targetW; x++) {
          if (bin[x] === cur) {
            len++;
          } else {
            runs.push({ val: cur, len });
            cur = bin[x];
            len = 1;
          }
        }
        runs.push({ val: cur, len });

        // Procura padrão de guarda inicial (101) com larguras próximas
        for (let i = 0; i < runs.length - 59; i++) {
          if (runs[i].val !== 1) continue;
          const r1 = runs[i].len;
          const r2 = runs[i + 1].len;
          const r3 = runs[i + 2].len;
          const unit = (r1 + r2 + r3) / 3;
          if (unit < 1 || Math.abs(r1 - unit) > unit * 0.7 || Math.abs(r2 - unit) > unit * 0.7 || Math.abs(r3 - unit) > unit * 0.7) {
            continue;
          }

          // Reconstrói os 95 módulos do EAN-13 a partir da barra inicial
          let startX = 0;
          for (let k = 0; k < i; k++) startX += runs[k].len;
          let endX = startX;
          for (let k = i; k < i + 59; k++) endX += runs[k].len;
          const totalWidth = endX - startX;
          const modW = totalWidth / 95;
          if (modW < 0.8) continue;

          let bits = '';
          for (let m = 0; m < 95; m++) {
            const sampleX = Math.min(targetW - 1, Math.floor(startX + (m + 0.5) * modW));
            bits += bin[sampleX] ? '1' : '0';
          }

          if (!bits.startsWith('101') || bits.slice(45, 50) !== '01010' || !bits.endsWith('101')) {
            continue;
          }

          let parity = '';
          let digits = '';
          let valid = true;

          for (let d = 0; d < 6; d++) {
            const seg = bits.slice(3 + d * 7, 3 + (d + 1) * 7);
            if (L_CODES[seg] !== undefined) {
              parity += 'L';
              digits += L_CODES[seg];
            } else if (G_CODES[seg] !== undefined) {
              parity += 'G';
              digits += G_CODES[seg];
            } else {
              valid = false;
              break;
            }
          }
          if (!valid || PARITY_MAP[parity] === undefined) continue;
          const firstDigit = PARITY_MAP[parity];

          for (let d = 0; d < 6; d++) {
            const seg = bits.slice(50 + d * 7, 50 + (d + 1) * 7);
            if (R_CODES[seg] !== undefined) {
              digits += R_CODES[seg];
            } else {
              valid = false;
              break;
            }
          }
          if (!valid) continue;

          const fullCode = String(firstDigit) + digits;
          // Valida dígito verificador EAN-13
          let checkSum = 0;
          for (let c = 0; c < 12; c++) {
            checkSum += Number(fullCode[c]) * (c % 2 === 0 ? 1 : 3);
          }
          const checkDigit = (10 - (checkSum % 10)) % 10;
          if (checkDigit === Number(fullCode[12])) {
            candidates[fullCode] = (candidates[fullCode] || 0) + 1;
            if (candidates[fullCode] >= 2) return fullCode;
          }
        }
      }
    }

    const best = Object.entries(candidates).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  }

  closeBarcodeScanner() {
    if (this.scannerTimer) {
      clearInterval(this.scannerTimer);
      this.scannerTimer = null;
    }
    if (this.scannerStream) {
      this.scannerStream.getTracks().forEach((t) => t.stop());
      this.scannerStream = null;
    }
    document.getElementById('modal-scanner')?.classList.remove('open');
  }

  submitManualBarcode() {
    const code = document.getElementById('scanner-manual-input')?.value.trim();
    if (code) {
      this.onBarcodeDetected(code);
    }
  }

  onBarcodeDetected(code) {
    this.closeBarcodeScanner();
    if (this.scannerMode === 'fill-product') {
      const input = document.getElementById('prod-barcode');
      if (input) input.value = code;
      this.showToast(`📷 Código lido: ${code}`);
    } else {
      const gs = document.getElementById('global-search');
      if (gs) gs.value = code;
      this.handleGlobalSearch(code);
      this.showToast(`🔍 Buscando código: ${code}`);
    }
  }

  closeModal(id) {
    document.getElementById(id)?.classList.remove('open');
  }

  showToast(msg) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3600);
  }
}

window.app = new AutoEletricaApp();
window.addEventListener('DOMContentLoaded', () => {
  window.app.init();
});
