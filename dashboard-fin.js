/* V1.16 — Dashboard financeiro (conciliação bancária por exercício), no modelo da planilha "Dashboard".
   Síndico: cria, edita e exclui o dashboard e informa o saldo do extrato de cada mês. Conselho e morador: só visualizam
   (o morador vê apenas os dashboards marcados como visíveis). Regras no banco: migração 20261113_011.
   Sem login (modo demonstração) usa os dados das planilhas (data/financeiro.js), só para leitura.
   Privacidade igual ao Financeiro: para conselho e morador os valores abrem ocultos e voltam a ocultar após 2 minutos sem uso. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reais = c => brl(Number(c) / 100);
  const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const rotMes = ym => MESES[Number(ym.slice(5, 7)) - 1] + '-' + ym.slice(0, 4);
  const rotCurto = ym => MESES[Number(ym.slice(5, 7)) - 1] + '/' + ym.slice(2, 4);
  const hojeYM = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
  const ligado = () => !!(window.APP && APP.on && APP.sb);
  const STATUS = { conciliado: ['✔', 'Conciliado', 'green'], pendente: ['⚠', 'Pendente', 'amber'], divergente: ['✖', 'Divergente', 'red'] };

  labels.dashboard = 'Dashboard financeiro';

  const DB = window.DASHFIN = { visivel: null, uid: null, ociosoMs: 120000, timer: null, ok: false, carregando: false, erro: '', seq: 0,
    lista: [], sel: null, dados: null, aviso: '' };

  /* ---------------- privacidade ---------------- */
  const vis = () => DB.visivel === null ? (role === 'sindico' || !ligado()) : DB.visivel;
  function limpa() { DB.seq++; Object.assign(DB, { ok: false, carregando: false, erro: '', lista: [], dados: null, aviso: '' }); }
  function para() { if (DB.timer) { clearTimeout(DB.timer); DB.timer = null; } }
  function fecharModal() { if (window.CXH) CXH.fechar(); }
  function ocultar(redesenha) { DB.visivel = false; para(); limpa(); fecharModal(); if (redesenha && page === 'dashboard') render(); }
  function arma() { para(); if (ligado() && role !== 'sindico' && DB.visivel) DB.timer = setTimeout(() => ocultar(true), DB.ociosoMs); }
  function sessao() { const uid = ligado() && APP.perfil ? APP.perfil.user_id : 'demo:' + role; if (DB.uid !== uid) { DB.uid = uid; DB.visivel = null; DB.sel = null; para(); limpa(); } }
  ['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { if (DB.visivel && role !== 'sindico') arma(); }, true));
  document.addEventListener('visibilitychange', () => { if (document.hidden && ligado() && role !== 'sindico' && DB.visivel) ocultar(page === 'dashboard'); });
  window.addEventListener('pagehide', () => { if (ligado() && role !== 'sindico') ocultar(false); });

  /* ---------------- dados ---------------- */
  function demoDados() {
    const F = window.FINANCEIRO_DATA; if (!F || !F.meses || !F.meses.length) return null;
    const c = v => Math.round(Number(v || 0) * 100);
    const meses = F.meses.map(m => {
      const k = m.conciliacao || {}, st = k.status === 'conciliado' ? 'conciliado' : 'pendente';
      return { mes: m.id, saldo_inicial_centavos: c(k.saldo_inicial), entradas_centavos: c(k.total_creditos), saidas_centavos: c(k.total_debitos),
        saldo_final_centavos: c(k.saldo_calculado), saldo_extrato_centavos: k.saldo_extrato == null ? null : c(k.saldo_extrato), status: st, quantidade: (k.movimentos || []).length };
    });
    const ini = meses[0].mes, fim = meses[meses.length - 1].mes;
    const soma = f => meses.reduce((s, m) => s + m[f], 0);
    return { id: 'demo', titulo: 'Conciliação bancária – Edifício Valença – ' + rotCurto(ini).replace('/', '/20') + ' a ' + rotCurto(fim).replace('/', '/20'),
      mes_inicio: ini, mes_fim: fim, visivel_moradores: true, meses,
      totais: { entradas_centavos: soma('entradas_centavos'), saidas_centavos: soma('saidas_centavos'), resultado_centavos: soma('entradas_centavos') - soma('saidas_centavos'),
        conciliados: meses.filter(m => m.status === 'conciliado').length, meses: meses.length } };
  }
  function escolhePadrao(lista) {
    const h = hojeYM(); const atual = lista.find(d => String(d.mes_inicio).slice(0, 7) <= h && String(d.mes_fim).slice(0, 7) >= h);
    return (atual || lista[0] || {}).id || null;
  }
  async function carregar() {
    if (!vis()) return;
    const seq = ++DB.seq; DB.carregando = true; DB.erro = '';
    try {
      if (!ligado()) {
        const d = demoDados(); if (seq !== DB.seq) return;
        Object.assign(DB, { lista: d ? [d] : [], sel: d ? d.id : null, dados: d, ok: true, carregando: false });
      } else {
        const r = await APP.sb.from('dashboards_financeiros').select('id,titulo,mes_inicio,mes_fim,visivel_moradores,observacao,atualizado_em').order('mes_inicio', { ascending: false });
        if (r.error) throw r.error;
        const lista = r.data || [];
        let sel = lista.some(d => d.id === DB.sel) ? DB.sel : escolhePadrao(lista), dados = null;
        if (sel) { const q = await APP.sb.rpc('dashboard_financeiro', { p_id: sel }); if (q.error) throw q.error; dados = q.data; }
        if (seq !== DB.seq) return;
        Object.assign(DB, { lista, sel, dados, ok: true, carregando: false });
      }
    } catch (e) {
      if (seq !== DB.seq) return;
      Object.assign(DB, { erro: window.CXH ? CXH.msg(e) : String((e && e.message) || e), ok: true, carregando: false });
    }
    if (page === 'dashboard') render();
  }
  const recarregar = () => { DB.ok = false; render(); };

  /* ---------------- gráficos (SVG, sem bibliotecas) ---------------- */
  const COR_E = '#2a78d6', COR_S = '#eb6834';     // paleta categórica validada (slots 1 e 2): entradas, saídas
  const curto = c => { const v = Math.abs(c) / 100; return (c < 0 ? '−' : '') + 'R$ ' + (v >= 1000 ? (v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil' : v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })); };
  function escala(max) {
    const bruto = Math.max(max, 100) / 4, p = Math.pow(10, Math.floor(Math.log10(bruto))), n = bruto / p;
    const passo = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
    return { passo, topo: Math.ceil(Math.max(max, 1) / passo) * passo };
  }
  let W = 760; const H = 260, M = { l: 64, r: 12, t: 12, b: 36 };
  const estreito = () => (window.innerWidth || 1000) < 650;
  function eixos(topo, passo, lo) {
    lo = lo || 0;
    const pw = W - M.l - M.r, ph = H - M.t - M.b, y = v => M.t + ph - (v - lo) / (topo - lo) * ph;
    let g = '';
    for (let v = lo; v <= topo + 1; v += passo) g += '<line x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#e3eae8" stroke-width="1"/><text x="' + (M.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="11" fill="#627477">' + esc(curto(v)) + '</text>';
    return { g, y, pw, ph };
  }
  function rotulosX(meses, x) {
    const pula = W < 500 && meses.length > 6;   // celular: um rótulo sim, outro não
    return meses.map((m, i) => pula && i % 2 ? '' : '<text x="' + x(i) + '" y="' + (H - M.b + 18) + '" text-anchor="middle" font-size="11" fill="#627477">' + esc(rotCurto(m.mes)) + '</text>').join('');
  }
  function barra(x0, w, y0, y1, cor) {          // topo arredondado (4px), base reta na linha de base
    const h = y0 - y1; if (h <= 0) return ''; const r = Math.min(4, w / 2, h);
    return '<path d="M' + x0 + ' ' + y0 + 'V' + (y1 + r) + 'Q' + x0 + ' ' + y1 + ' ' + (x0 + r) + ' ' + y1 + 'H' + (x0 + w - r) + 'Q' + (x0 + w) + ' ' + y1 + ' ' + (x0 + w) + ' ' + (y1 + r) + 'V' + y0 + 'Z" fill="' + cor + '"/>';
  }
  function graficoBarras(meses) {
    const max = Math.max(...meses.map(m => Math.max(m.entradas_centavos, m.saidas_centavos)), 0), { passo, topo } = escala(max);
    const n = meses.length, slot = (W - M.l - M.r) / n, x = i => M.l + slot * (i + .5);
    const { g, y } = eixos(topo, passo, 0), bw = Math.max(4, Math.min(22, slot * .32)), base = y(0);
    let marcas = '', alvos = '';
    meses.forEach((m, i) => {
      marcas += barra(x(i) - bw - 1, bw, base, y(m.entradas_centavos), COR_E) + barra(x(i) + 1, bw, base, y(m.saidas_centavos), COR_S);
      alvos += '<rect class="df-alvo" data-i="' + i + '" x="' + (M.l + slot * i) + '" y="' + M.t + '" width="' + slot + '" height="' + (H - M.t - M.b) + '" fill="transparent"/>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Entradas e saídas por mês" style="width:100%;height:auto;display:block">' + g +
      '<line x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + base + '" y2="' + base + '" stroke="#9fb0ae" stroke-width="1"/>' + marcas + rotulosX(meses, x) +
      '<line class="df-cruz" x1="0" x2="0" y1="' + M.t + '" y2="' + base + '" stroke="#17282b" stroke-opacity=".25" stroke-width="1" visibility="hidden"/>' + alvos + '</svg>';
  }
  function graficoLinha(meses) {
    const hoje = hojeYM(), vals = meses.map(m => m.saldo_final_centavos), max = Math.max(...vals, 0), min = Math.min(...vals, 0);
    const { passo, topo } = escala(max - min), n = meses.length, slot = (W - M.l - M.r) / n, x = i => M.l + slot * (i + .5);
    const lo = min < 0 ? -Math.ceil(-min / passo) * passo : 0, alto = Math.max(Math.ceil(max / passo) * passo, lo + passo);
    const { g, y } = eixos(alto, passo, lo);
    const pts = meses.map((m, i) => [x(i), y(m.saldo_final_centavos)]);
    const ult = meses.reduce((k, m, i) => m.mes <= hoje ? i : k, -1);   // meses depois do atual repetem o saldo: tracejado
    const caminho = arr => arr.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    let linhas = '';
    if (ult >= 0) linhas += '<path d="' + caminho(pts.slice(0, ult + 1)) + '" fill="none" stroke="' + COR_E + '" stroke-width="2" stroke-linejoin="round"/>';
    if (ult < n - 1) linhas += '<path d="' + caminho(pts.slice(Math.max(ult, 0))) + '" fill="none" stroke="' + COR_E + '" stroke-width="2" stroke-dasharray="4 4" opacity=".55"/>';
    const marcas = pts.map((p, i) => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="' + (i <= ult ? COR_E : '#fff') + '" stroke="' + COR_E + '" stroke-width="2"/>').join('');
    const alvos = meses.map((m, i) => '<rect class="df-alvo" data-i="' + i + '" x="' + (M.l + slot * i) + '" y="' + M.t + '" width="' + slot + '" height="' + (H - M.t - M.b) + '" fill="transparent"/>').join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Evolução do saldo final por mês" style="width:100%;height:auto;display:block">' + g +
      '<line class="df-cruz" x1="0" x2="0" y1="' + M.t + '" y2="' + (H - M.b) + '" stroke="#17282b" stroke-opacity=".25" stroke-width="1" visibility="hidden"/>' +
      linhas + marcas + rotulosX(meses, x) + alvos + '</svg>';
  }
  const legenda = itens => '<div class="df-leg">' + itens.map(([cor, t, tracejado]) => '<span><i style="background:' + (tracejado ? 'transparent;border-top:2px dashed ' + cor + ';height:0;border-radius:0' : cor) + '"></i>' + esc(t) + '</span>').join('') + '</div>';

  /* ---------------- tela ---------------- */
  function statusPill(s) { const st = STATUS[s] || STATUS.pendente; return '<span class="pill ' + st[2] + '">' + st[0] + ' ' + st[1] + '</span>'; }
  const vazio = c => Number(c) === 0 ? '<span class="muted">—</span>' : reais(c);
  function tabela(d, adm) {
    const t = d.totais, hoje = hojeYM();
    const linhas = d.meses.map(m => '<tr><td class="df-mes"><b>' + esc(rotMes(m.mes)) + '</b></td><td class="amount">' + reais(m.saldo_inicial_centavos) + '</td>' +
      '<td class="amount df-e">' + vazio(m.entradas_centavos) + '</td><td class="amount df-s">' + vazio(m.saidas_centavos) + '</td>' +
      '<td class="amount"><b>' + reais(m.saldo_final_centavos) + '</b>' + (m.status === 'divergente' && m.saldo_extrato_centavos != null ? '<div class="rowmeta">extrato ' + reais(m.saldo_extrato_centavos) + '</div>' : '') + '</td>' +
      '<td>' + statusPill(m.status) + '</td>' +
      (adm ? '<td>' + (m.mes <= hoje ? '<button class="linkbtn" data-df-extrato="' + esc(m.mes) + '">' + (m.saldo_extrato_centavos == null ? 'Informar extrato' : 'Alterar extrato') + '</button>' : '<span class="muted">—</span>') + '</td>' : '') + '</tr>').join('');
    const res = Number(t.resultado_centavos);
    return '<div class="card df-tabela"><div class="tablewrap"><table><thead><tr><th class="df-mes">Mês</th><th class="amount">Saldo inicial</th><th class="amount">Total entradas<br><small>(créditos)</small></th>' +
      '<th class="amount">Total saídas<br><small>(débitos)</small></th><th class="amount">Saldo final<br><small>calculado</small></th><th>Status conciliação</th>' + (adm ? '<th>Ação</th>' : '') + '</tr></thead><tbody>' + linhas + '</tbody>' +
      '<tfoot><tr><td class="df-mes"><b>Total</b><div class="rowmeta">' + esc(rotCurto(d.mes_inicio)) + ' – ' + esc(rotCurto(d.mes_fim)) + '</div></td><td></td>' +
      '<td class="amount df-e"><b>' + reais(t.entradas_centavos) + '</b></td><td class="amount df-s"><b>' + reais(t.saidas_centavos) + '</b></td>' +
      '<td class="amount ' + (res < 0 ? 'negative' : 'positive') + '"><b>' + (res < 0 ? '(' + reais(-res) + ')' : reais(res)) + '</b><div class="rowmeta">resultado</div></td>' +
      '<td><b>' + Number(t.conciliados) + ' de ' + Number(t.meses) + '</b> meses conciliados</td>' + (adm ? '<td></td>' : '') + '</tr></tfoot></table></div></div>';
  }
  function corpo(d) {
    const adm = ligado() && role === 'sindico', t = d.totais, res = Number(t.resultado_centavos);
    W = estreito() ? 360 : 760;
    return '<div class="df-faixa">' + esc(d.titulo) + '</div>' +
      (d.observacao ? '<p class="smallnote" style="margin:-6px 0 14px">' + esc(d.observacao) + '</p>' : '') +
      '<div class="grid stats">' + cardStat('Total de entradas', reais(t.entradas_centavos), 'Créditos no período', 'positive') + cardStat('Total de saídas', reais(t.saidas_centavos), 'Débitos no período', 'negative') +
      cardStat('Resultado do período', (res < 0 ? '−' : '') + reais(Math.abs(res)), 'Entradas menos saídas', res < 0 ? 'negative' : 'positive') +
      cardStat('Meses conciliados', Number(t.conciliados) + ' de ' + Number(t.meses), 'Saldo do extrato igual ao calculado') + '</div>' +
      (estreito() ? '<p class="smallnote" style="margin:14px 0 -10px">↔ Deslize a tabela para o lado para ver todas as colunas.</p>' : '') + tabela(d, adm) +
      '<div class="grid df-graficos"><section class="card df-graf" data-df-graf="barras"><div class="cardhead"><h2>Entradas vs. saídas mensais</h2></div>' + legenda([[COR_E, 'Total entradas (créditos)'], [COR_S, 'Total saídas (débitos)']]) +
      '<div class="df-plot">' + graficoBarras(d.meses) + '<div class="df-tip" hidden></div></div></section>' +
      '<section class="card df-graf" data-df-graf="saldo"><div class="cardhead"><h2>Evolução do saldo mensal</h2></div>' +
      (d.meses.some(m => m.mes > hojeYM()) ? legenda([[COR_E, 'Saldo final calculado'], [COR_E, 'Meses futuros (repete o último saldo)', true]]) : '') +
      '<div class="df-plot">' + graficoLinha(d.meses) + '<div class="df-tip" hidden></div></div></section></div>' +
      '<p class="smallnote">Valores do livro-caixa (lançamentos da conta corrente). Um mês fica <b>conciliado</b> quando o saldo do extrato bancário informado pelo síndico é igual ao saldo calculado; se um lançamento for incluído depois, o mês volta a ser conferido automaticamente.</p>';
  }

  function dashboardPage() {
    sessao();
    const adm = ligado() && role === 'sindico';
    const sub = adm ? 'Crie e acompanhe a conciliação bancária do exercício.' : 'Acompanhe a conciliação bancária do exercício (somente leitura).';
    const novo = adm ? '<button class="btn" id="df-novo">＋ Novo dashboard</button>' : '';
    if (!vis()) return head('Dashboard financeiro', sub, novo) + '<div class="card"><div class="empty"><div style="font-size:30px">🔒</div>Os valores do dashboard estão ocultos.<br><br><button class="btn" id="df-mostrar">Mostrar valores</button><p class="smallnote">Voltam a ficar ocultos ao sair desta tela, ao minimizar o aplicativo ou após 2 minutos sem uso.</p></div></div>';
    if (!DB.ok && !DB.carregando) carregar();
    if (!DB.ok) return head('Dashboard financeiro', sub, novo) + '<div class="card"><div class="empty">Carregando…</div></div>';
    if (DB.erro) return head('Dashboard financeiro', sub, novo) + '<div class="card"><div class="empty">' + esc(DB.erro) + '<br><button class="linkbtn" id="df-retry">Tentar de novo</button></div></div>';
    const itensBarra = (
      (DB.lista.length > 1 ? '<label style="font-size:13px;color:var(--muted)">Período<select class="field" id="df-sel">' + DB.lista.map(d => '<option value="' + esc(d.id) + '"' + (d.id === DB.sel ? ' selected' : '') + '>' + esc(rotCurto(String(d.mes_inicio).slice(0, 7)) + ' – ' + rotCurto(String(d.mes_fim).slice(0, 7)) + ' · ' + d.titulo) + '</option>').join('') + '</select></label>' : '') +
      (adm && DB.dados ? '<button class="btn secondary" id="df-editar">Editar</button><button class="linkbtn" id="df-excluir">Excluir</button>' + (DB.dados.visivel_moradores ? '<span class="pill green">Visível aos moradores</span>' : '<span class="pill">Oculto aos moradores</span>') : '') +
      (ligado() ? '<button class="linkbtn" id="df-ocultar" style="margin-left:auto">🔒 Ocultar valores</button>' : ''));
    const barra = itensBarra ? '<div class="card" style="margin-bottom:18px"><div class="toolbar">' + itensBarra + '</div></div>' : '';
    const aviso = DB.aviso ? '<div class="card" style="margin-bottom:18px"><p class="agerro" style="min-height:0;margin:0 0 8px" role="alert">⚠ ' + esc(DB.aviso) + '</p><button class="linkbtn" id="df-aviso-x">Dispensar</button></div>' : '';
    const demo = ligado() ? '' : '<div class="notice">Demonstração com os dados das planilhas. Na versão conectada, só o síndico cria e edita o dashboard; conselho e moradores apenas visualizam.</div>';
    if (!DB.dados) return head('Dashboard financeiro', sub, novo) + demo + aviso + '<div class="card"><div class="empty">' + (adm ? 'Nenhum dashboard criado ainda. Use “Novo dashboard” para escolher o período (por exemplo, julho a junho).' : 'O síndico ainda não publicou o dashboard financeiro.') + '</div></div>';
    return head('Dashboard financeiro', sub, novo) + demo + aviso + barra + corpo(DB.dados);
  }
  window.dashboardFinPage = dashboardPage;

  /* ---------------- interação ---------------- */
  function bindGraficos() {
    const d = DB.dados; if (!d) return;
    document.querySelectorAll('.df-graf').forEach(sec => {
      const tipo = sec.dataset.dfGraf, tip = sec.querySelector('.df-tip'), svg = sec.querySelector('svg'), cruz = svg.querySelector('.df-cruz');
      const mostra = (el) => {
        const i = Number(el.dataset.i), m = d.meses[i]; if (!m) return;
        const linhas = tipo === 'barras'
          ? '<div><i style="background:' + COR_E + '"></i>Entradas <b>' + reais(m.entradas_centavos) + '</b></div><div><i style="background:' + COR_S + '"></i>Saídas <b>' + reais(m.saidas_centavos) + '</b></div>'
          : '<div><i style="background:' + COR_E + '"></i>Saldo final <b>' + reais(m.saldo_final_centavos) + '</b></div>';
        tip.innerHTML = '<div class="df-tip-t">' + esc(rotMes(m.mes)) + ' · ' + esc((STATUS[m.status] || STATUS.pendente)[1]) + '</div>' + linhas; tip.hidden = false;
        const r = el.getBoundingClientRect(), box = svg.getBoundingClientRect(), cx = r.left + r.width / 2 - box.left;
        const esq = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), box.width - tip.offsetWidth);
        tip.style.left = esq + 'px'; tip.style.top = '4px';
        const vx = Number(el.getAttribute('x')) + Number(el.getAttribute('width')) / 2; cruz.setAttribute('x1', vx); cruz.setAttribute('x2', vx); cruz.setAttribute('visibility', 'visible');
      };
      const esconde = () => { tip.hidden = true; cruz.setAttribute('visibility', 'hidden'); };
      svg.querySelectorAll('.df-alvo').forEach(el => { el.addEventListener('mouseenter', () => mostra(el)); el.addEventListener('click', () => mostra(el)); });
      svg.addEventListener('mouseleave', esconde);
    });
  }
  function formDashboard(atual) {
    const H = window.CXH, hoje = hojeYM(), [a, m] = hoje.split('-').map(Number);
    const iniPad = (m >= 7 ? a : a - 1) + '-07', fimPad = (m >= 7 ? a + 1 : a) + '-06';
    const ini = atual ? String(atual.mes_inicio).slice(0, 7) : iniPad, fim = atual ? String(atual.mes_fim).slice(0, 7) : fimPad;
    H.modal('<div class="cardhead"><h2>' + (atual ? 'Editar dashboard' : 'Novo dashboard') + '</h2><button class="linkbtn" id="df-x">Fechar ×</button></div><form id="df-f" class="formgrid">' +
      '<label class="full">Título<input class="field" id="df-tit" maxlength="120" required value="' + esc(atual ? atual.titulo : 'Conciliação bancária – ' + rotCurto(ini).replace('/', '/20') + ' a ' + rotCurto(fim).replace('/', '/20')) + '"></label>' +
      '<label>Mês inicial<input class="field" type="month" id="df-ini" required value="' + esc(ini) + '"></label><label>Mês final<input class="field" type="month" id="df-fim" required value="' + esc(fim) + '"></label>' +
      '<label class="full" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="df-vis"' + (!atual || atual.visivel_moradores ? ' checked' : '') + '> Visível para os moradores (o conselho sempre vê)</label>' +
      '<label class="full">Observação (opcional)<textarea class="field" id="df-obs" maxlength="500" rows="2">' + esc(atual && atual.observacao || '') + '</textarea></label>' +
      '<p class="smallnote full">Os valores vêm do livro-caixa; o período pode ter até 24 meses.</p><p id="df-erro" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="df-ok">Salvar</button></div></form>');
    $('df-x').onclick = H.fechar;
    $('df-f').onsubmit = ev => { ev.preventDefault(); H.ocupado($('df-ok'), async () => {
      try {
        const r = await APP.sb.rpc('salvar_dashboard_financeiro', { p_id: atual ? atual.id : null, p_titulo: $('df-tit').value.trim(), p_mes_inicio: $('df-ini').value + '-01',
          p_mes_fim: $('df-fim').value + '-01', p_visivel_moradores: $('df-vis').checked, p_observacao: $('df-obs').value.trim() || null });
        if (r.error) throw r.error; DB.sel = r.data; H.fechar(); recarregar();
      } catch (e) { $('df-erro').textContent = H.msg(e); }
    }); };
  }
  function formExtrato(mes) {
    const H = window.CXH, m = DB.dados.meses.find(x => x.mes === mes); if (!m) return;
    const campo = c => (Number(c) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    H.modal('<div class="cardhead"><h2>Extrato de ' + esc(rotMes(mes)) + '</h2><button class="linkbtn" id="df-x">Fechar ×</button></div>' +
      '<p style="margin-top:0">Saldo calculado pelo livro-caixa: <b>' + reais(m.saldo_final_centavos) + '</b></p><form id="df-fx" class="formgrid">' +
      '<label class="full">Saldo final do extrato bancário (R$)<input class="field" id="df-sx" inputmode="decimal" required value="' + (m.saldo_extrato_centavos == null ? '' : campo(m.saldo_extrato_centavos)) + '"></label>' +
      '<p class="smallnote full">Se for igual ao saldo calculado, o mês fica <b>conciliado</b>; se for diferente, fica <b>divergente</b> até a correção.</p>' +
      '<p id="df-erro" class="agerro full" role="alert"></p><div class="full" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="df-okx">Salvar</button>' +
      (m.saldo_extrato_centavos == null ? '' : '<button type="button" class="btn secondary" id="df-limpa">Remover saldo informado</button>') + '</div></form>');
    $('df-x').onclick = H.fechar;
    const envia = async (valor) => {
      const r = await APP.sb.rpc('registrar_saldo_extrato', { p_competencia: mes + '-01', p_saldo_extrato_centavos: valor });
      if (r.error) throw r.error;
      DB.aviso = r.data && r.data.status === 'divergente' ? 'O extrato de ' + rotMes(mes) + ' difere do saldo calculado em ' + reais(Math.abs(r.data.diferenca_centavos)) + '. Confira os lançamentos do mês.' : '';
      H.fechar(); recarregar();
    };
    $('df-fx').onsubmit = ev => { ev.preventDefault(); H.ocupado($('df-okx'), async () => {
      try { const v = window.parseCentavos($('df-sx').value); if (v === null) throw new Error('Valor inválido. Exemplo: 4.009,70'); await envia(v); }
      catch (e) { $('df-erro').textContent = H.msg(e); }
    }); };
    const lp = $('df-limpa'); if (lp) lp.onclick = () => H.ocupado(lp, async () => { try { await envia(null); } catch (e) { $('df-erro').textContent = H.msg(e); } });
  }
  function bindDashboard() {
    const mo = $('df-mostrar'); if (mo) mo.onclick = () => { DB.visivel = true; DB.ok = false; arma(); render(); };
    const oc = $('df-ocultar'); if (oc) oc.onclick = () => ocultar(true);
    const rt = $('df-retry'); if (rt) rt.onclick = recarregar;
    const ax = $('df-aviso-x'); if (ax) ax.onclick = () => { DB.aviso = ''; render(); };
    const se = $('df-sel'); if (se) se.onchange = () => { DB.sel = se.value; recarregar(); };
    if (ligado() && role === 'sindico') {
      const nv = $('df-novo'); if (nv) nv.onclick = () => formDashboard(null);
      const ed = $('df-editar'); if (ed) ed.onclick = () => formDashboard(DB.lista.find(d => d.id === DB.sel) || DB.dados);
      const ex = $('df-excluir'); if (ex) ex.onclick = async () => {
        if (!confirm('Excluir o dashboard "' + DB.dados.titulo + '"? Os lançamentos e os saldos de extrato informados não são apagados.')) return;
        const r = await APP.sb.rpc('excluir_dashboard_financeiro', { p_id: DB.sel });
        DB.aviso = r.error ? CXH.msg(r.error) : ''; if (!r.error) DB.sel = null; recarregar();
      };
      document.querySelectorAll('[data-df-extrato]').forEach(b => { b.onclick = () => formExtrato(b.dataset.dfExtrato); });
    }
    bindGraficos();
  }

  /* ---------------- encaixe no app: rota, menu, atalho da tela inicial ---------------- */
  const cardDash = () => navCard('▤', 'Dashboard financeiro', 'Conciliação bancária do exercício', 'dashboard');
  const genericBaseDash = genericPage;
  genericPage = function () {
    if (page === 'dashboard') return dashboardPage();
    const h = genericBaseDash();
    return page === 'menu' ? h.replace(/<\/div>\s*$/, cardDash() + '</div>') : h;
  };
  const inicioBase = dashboard;
  dashboard = function () {
    const h = inicioBase(), alvo = navCard('◫', 'Financeiro', 'Consultar movimentações', 'financeiro');
    return h.includes(alvo) ? h.replace(alvo, alvo + cardDash()) : h;
  };
  const bindBaseDash = bindPage;
  bindPage = function () { bindBaseDash(); if (page === 'dashboard') bindDashboard(); };

  const css = document.createElement('style');
  css.textContent = '.df-faixa{background:var(--brand);color:#fff;font-weight:800;letter-spacing:.3px;text-transform:uppercase;text-align:center;border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:15px}' +
    '.df-tabela{margin:18px 0}.df-tabela table{min-width:640px}.df-tabela th{font-size:12px;line-height:1.25;vertical-align:bottom}.df-tabela th small{font-weight:500;color:var(--muted)}' +
    '.df-tabela td,.df-tabela th{padding:8px 10px;white-space:nowrap}.df-tabela tfoot td{border-top:2px solid var(--line);background:#f4f8f7}.df-tabela .df-mes{position:sticky;left:0;background:var(--card);z-index:1}.df-tabela tfoot .df-mes{background:#f4f8f7}' +
    '.df-tabela .df-e{color:#1d5fae}.df-tabela .df-s{color:#b4471b}.muted{color:var(--muted)}' +
    '.df-graficos{grid-template-columns:1fr;gap:18px;margin-bottom:12px}.df-plot svg{max-width:980px;margin:0 auto}' +
    '.df-leg{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--muted);margin:-4px 0 8px}.df-leg span{display:inline-flex;align-items:center;gap:6px}.df-leg i,.df-tip i{display:inline-block;width:12px;height:12px;border-radius:3px}' +
    '.df-plot{position:relative}.df-tip{position:absolute;pointer-events:none;background:#fff;border:1px solid var(--line);box-shadow:var(--shadow);border-radius:9px;padding:8px 10px;font-size:12px;color:var(--ink);white-space:nowrap;z-index:2}' +
    '.df-tip i{width:9px;height:9px;margin-right:6px}.df-tip-t{font-weight:800;margin-bottom:4px}@media(max-width:650px){.df-faixa{font-size:13px;padding:12px}}';
  document.head.appendChild(css);
  // botão na barra lateral (computador), logo depois do Financeiro
  const fin = document.querySelector('.side [data-page="financeiro"]');
  if (fin && !document.querySelector('.side [data-page="dashboard"]')) {
    const b = document.createElement('button'); b.className = 'nav'; b.dataset.page = 'dashboard'; b.innerHTML = '<span class="ico">▤</span>Dashboard financeiro';
    b.addEventListener('click', () => go('dashboard')); fin.after(b);
  }
  let largo = estreito();   // girar o celular ou redimensionar a janela redesenha os gráficos no tamanho certo
  window.addEventListener('resize', () => { if (estreito() !== largo) { largo = estreito(); if (page === 'dashboard' && DB.dados && vis()) render(); } });
  if (page === 'inicio' || page === 'menu') render();
})();
