/* V1.10 — Livro-caixa ligado ao Supabase (página Financeiro).
   Carregado depois do auth.js. Sem login ligado (modo demonstração) este arquivo não faz nada.
   Regras (decididas no banco, migração 006): valores em centavos; lançamentos nunca são editados nem apagados,
   só estornados; síndico registra e estorna; conselho consulta o detalhe; morador vê apenas os totais do mês. */
(function () {
  'use strict';
  const APP = window.APP;
  if (!APP || !APP.sb) return;

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hojeBR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const fmtData = d => String(d).slice(0, 10).split('-').reverse().join('/');
  const reais = c => brl(Number(c) / 100);
  const CATEGORIAS = ['Água e esgoto', 'Energia das áreas comuns', 'Manutenção e reparos', 'Limpeza', 'Gás', 'Seguro', 'Taxas e impostos',
    'Honorários', 'Obras', 'Taxa condominial', 'Fundo de reserva', 'Outras receitas', 'Outras despesas'];
  const COLS = 'id,tipo,data_lancamento,valor_centavos,categoria,descricao,fornecedor,numero_documento,observacao,lancamento_original_id,estornado_em,motivo_estorno,criado_em';

  const CX = APP.cx = { visivel: null, uid: null, ociosoMs: 120000, timer: null, mes: hojeBR().slice(0, 7), ok: false, carregando: false, erro: '', seq: 0, rows: [], tipoOrig: {}, resumo: null, rel: null, filtro: 'todos', busca: '' };
  const detalhe = () => role === 'sindico' || role === 'conselho';
  /* Privacidade: morador e conselho abrem o Financeiro com os valores OCULTOS (nem são pedidos ao banco).
     Voltam a ocultar ao sair da tela, ao minimizar o app e após 2 minutos sem uso. O síndico vê direto e pode ocultar. */
  const vis = () => CX.visivel === null ? role === 'sindico' : CX.visivel;
  function limpa() { CX.seq++; Object.assign(CX, { ok: false, carregando: false, erro: '', rows: [], tipoOrig: {}, resumo: null, rel: null, busca: '', filtro: 'todos' }); }
  function para() { if (CX.timer) { clearTimeout(CX.timer); CX.timer = null; } }
  function ocultar(redesenha) { CX.visivel = false; para(); limpa(); fechar(); if (redesenha && APP.on && page === 'financeiro') render(); }
  function mostrar() { CX.visivel = true; CX.ok = false; arma(); render(); }
  function arma() { para(); if (role !== 'sindico' && CX.visivel) CX.timer = setTimeout(() => ocultar(true), CX.ociosoMs); }
  function sessao() { const uid = APP.perfil && APP.perfil.user_id; if (CX.uid !== uid) { CX.uid = uid; CX.visivel = null; para(); limpa(); } }
  ['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { if (CX.visivel && role !== 'sindico') arma(); }, true));
  document.addEventListener('visibilitychange', () => { if (document.hidden && APP.on && role !== 'sindico' && CX.visivel) ocultar(true); });
  window.addEventListener('pagehide', () => { if (role !== 'sindico') ocultar(false); });

  function msg(e) {
    const m = (e && e.message) || String(e || '');
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
    if (/row-level security|permission denied/i.test(m)) return 'Você não tem permissão para esta ação.';
    return m || 'Erro inesperado.';
  }
  async function ocupado(btn, fn) { if (btn) btn.disabled = true; try { return await fn(); } finally { if (btn) btn.disabled = false; } }

  /* "1.234,56" / "1234,56" / "12.5" → centavos inteiros (sem ponto flutuante); null se inválido */
  function parseCentavos(txt) {
    let s = String(txt == null ? '' : txt).replace(/R\$/gi, '').replace(/\s/g, '');
    if (!s) return null;
    if (s.includes(',')) { if (!/^\d{1,3}(\.\d{3})*,\d{1,2}$|^\d+,\d{1,2}$/.test(s)) return null; s = s.replace(/\./g, '').replace(',', '.'); }
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    else if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const [i, d = ''] = s.split('.');
    if (i.length > 9) return null;
    return Number(i) * 100 + Number((d + '00').slice(0, 2));
  }
  window.parseCentavos = parseCentavos;

  /* ---------------- carga ---------------- */
  async function carregar() {
    if (!vis()) return;
    const seq = ++CX.seq; CX.carregando = true; CX.erro = '';
    const [ano, mes] = CX.mes.split('-').map(Number);
    const ini = CX.mes + '-01', fim = mes === 12 ? (ano + 1) + '-01-01' : ano + '-' + String(mes + 1).padStart(2, '0') + '-01';
    try {
      const rs = await APP.sb.rpc('resumo_financeiro', { p_ano: ano, p_mes: mes }); if (rs.error) throw rs.error;
      const resumo = Array.isArray(rs.data) ? rs.data[0] : rs.data;
      let rel = null, rows = [], tipoOrig = {};
      if (detalhe()) {
        const rl = await APP.sb.rpc('relatorio_mensal', { p_ano: ano, p_mes: mes }); if (rl.error) throw rl.error; rel = rl.data;
        const lc = await APP.sb.from('lancamentos').select(COLS).gte('data_lancamento', ini).lt('data_lancamento', fim)
          .order('data_lancamento', { ascending: false }).order('criado_em', { ascending: false }); if (lc.error) throw lc.error;
        rows = lc.data || [];
        const ids = [...new Set(rows.filter(r => r.tipo === 'estorno').map(r => r.lancamento_original_id))];
        if (ids.length) { const og = await APP.sb.from('lancamentos').select('id,tipo').in('id', ids); if (og.error) throw og.error; (og.data || []).forEach(o => { tipoOrig[o.id] = o.tipo; }); }
      }
      if (seq !== CX.seq) return;                       // o usuário trocou de mês durante a carga
      Object.assign(CX, { resumo, rel, rows, tipoOrig, ok: true, carregando: false });
    } catch (e) {
      if (seq !== CX.seq) return;
      Object.assign(CX, { erro: msg(e), ok: true, carregando: false, rows: [], rel: null, resumo: null });
    }
    if (page === 'financeiro') render();
  }

  /* ---------------- tela ---------------- */
  const sinal = r => r.tipo === 'receita' ? 1 : r.tipo === 'despesa' ? -1 : (CX.tipoOrig[r.lancamento_original_id] === 'despesa' ? 1 : -1);
  function linhas() {
    const q = CX.busca.trim().toLowerCase();
    return CX.rows.filter(r => (CX.filtro === 'todos' || r.tipo === CX.filtro) &&
      (!q || (r.descricao + ' ' + r.categoria + ' ' + (r.numero_documento || '') + ' ' + (r.fornecedor || '')).toLowerCase().includes(q)));
  }
  function tabela() {
    const lista = linhas();
    if (!lista.length) return '<div class="empty">Nenhum lançamento encontrado para os filtros selecionados.</div>';
    const adm = role === 'sindico';
    return '<div class="tablewrap"><table><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th class="amount">Valor</th>' + (adm ? '<th>Ação</th>' : '') + '</tr></thead><tbody>' +
      lista.map(r => {
        const s = sinal(r), est = r.tipo === 'estorno';
        const pill = est ? '<span class="pill amber">Estorno</span>' : '<span class="pill ' + (r.tipo === 'receita' ? 'green' : 'red') + '">' + (r.tipo === 'receita' ? 'Receita' : 'Despesa') + '</span>';
        const meta = (r.numero_documento ? '<div class="rowmeta">Documento: ' + esc(r.numero_documento) + '</div>' : '') +
          (est && r.observacao ? '<div class="rowmeta">Motivo: ' + esc(r.observacao) + '</div>' : '') +
          (r.estornado_em ? '<div class="rowmeta">Estornado em ' + fmtData(String(r.estornado_em).slice(0, 10)) + ': ' + esc(r.motivo_estorno) + '</div>' : '');
        const acao = adm ? '<td>' + (!est && !r.estornado_em ? '<button class="linkbtn" data-cx-est="' + esc(r.id) + '">Estornar</button>' : '') + '</td>' : '';
        return '<tr' + (r.estornado_em ? ' style="opacity:.6"' : '') + '><td>' + fmtData(r.data_lancamento) + '</td><td><strong>' + esc(r.descricao) + '</strong>' + meta + '</td><td>' + esc(r.categoria) + '</td><td>' + pill + '</td>' +
          '<td class="amount ' + (s > 0 ? 'positive' : 'negative') + '">' + (s > 0 ? '+' : '−') + ' ' + reais(r.valor_centavos) + '</td>' + acao + '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  function categorias() {
    const c = (CX.rel && CX.rel.por_categoria) || [];
    if (!c.length) return '';
    return '<div class="card" style="margin-top:18px"><div class="cardhead"><h2>Resultado por categoria</h2></div><div class="tablewrap"><table><thead><tr><th>Categoria</th><th class="amount">Entradas</th><th class="amount">Saídas</th></tr></thead><tbody>' +
      c.map(x => '<tr><td>' + esc(x.categoria) + '</td><td class="amount positive">' + reais(x.entradas_centavos) + '</td><td class="amount negative">' + reais(x.saidas_centavos) + '</td></tr>').join('') + '</tbody></table></div></div>';
  }
  function ocultoPage() {
    return head('Financeiro', 'Os valores estão ocultos por privacidade.') + '<div class="card"><div class="empty"><div style="font-size:30px">🔒</div>Os valores financeiros estão ocultos.<br><br><button class="btn" id="cx-mostrar">Mostrar valores</button>' +
      (role === 'sindico' ? '' : '<p class="smallnote">Eles voltam a ficar ocultos ao sair desta tela, ao minimizar o aplicativo ou após 2 minutos sem uso.</p>') + '</div></div>';
  }
  function financeiroPage() {
    sessao();
    if (!vis()) return ocultoPage();
    if (!CX.ok && !CX.carregando) carregar();
    const adm = role === 'sindico';
    const acoes = adm ? '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="cx-novo">＋ Novo lançamento</button><button class="btn secondary" id="cx-print">Imprimir relatório</button></div>' : '';
    const sub = detalhe() ? 'Livro-caixa detalhado. Correções são feitas por estorno, nunca por edição.' : 'Resumo da prestação de contas do condomínio.';
    let corpo;
    if (!CX.ok) corpo = '<div class="card"><div class="empty">Carregando…</div></div>';
    else if (CX.erro) corpo = '<div class="card"><div class="empty">' + esc(CX.erro) + '<br><button class="linkbtn" id="cx-retry">Tentar de novo</button></div></div>';
    else {
      const r = CX.resumo || {}, rel = CX.rel;
      const stats = detalhe() && rel
        ? cardStat('Entradas do mês', reais(rel.entradas_centavos), 'Receitas e estornos de despesas', 'positive') + cardStat('Saídas do mês', reais(rel.saidas_centavos), 'Despesas e estornos de receitas', 'negative') +
          cardStat('Saldo do mês', reais(rel.saldo_mes_centavos), 'Entradas menos saídas') + cardStat('Saldo acumulado', reais(rel.saldo_final_centavos), rel.saldo_abertura_data ? 'Inclui saldo de abertura de ' + reais(rel.saldo_abertura_centavos) + ' em ' + fmtData(rel.saldo_abertura_data) : 'Soma dos lançamentos, sem saldo de abertura')
        : cardStat('Receitas do mês', reais(r.receitas_centavos || 0), 'Total do período', 'positive') + cardStat('Despesas do mês', reais(r.despesas_centavos || 0), 'Total do período', 'negative') +
          cardStat('Saldo do mês', reais(r.saldo_centavos || 0), 'Receitas menos despesas');
      corpo = '<div class="grid stats">' + stats + '</div>' + (detalhe()
        ? '<div class="card"><div class="toolbar"><input class="field grow" id="cx-busca" placeholder="Pesquisar descrição, categoria ou documento" value="' + esc(CX.busca) + '"><select class="field" id="cx-tipo">' +
          [['todos', 'Todas as movimentações'], ['receita', 'Receitas'], ['despesa', 'Despesas'], ['estorno', 'Estornos']].map(o => '<option value="' + o[0] + '"' + (CX.filtro === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') +
          '</select></div><div id="cx-tabela">' + tabela() + '</div><div class="smallnote">' + (adm ? 'Lançamentos registrados não podem ser alterados ou apagados.' : 'Conselho: consulta detalhada dentro do aplicativo, sem edição, exportação ou download.') + '</div></div>' + categorias()
        : '<p class="muted">O perfil de morador não exibe lançamentos individuais nem comprovantes.</p>');
    }
    return head('Financeiro', sub, acoes) +
      '<div class="card" style="margin-bottom:18px"><div class="toolbar"><label style="font-size:13px;color:var(--muted)">Mês<input class="field" id="cx-mes" type="month" value="' + esc(CX.mes) + '" max="' + hojeBR().slice(0, 7) + '"></label><button class="linkbtn" id="cx-ocultar">🔒 Ocultar valores</button></div></div>' + corpo;
  }
  window.financeiroPage = financeiroPage;

  /* ---------------- ações ---------------- */
  function modal(html) {
    fechar(); const m = document.createElement('div'); m.className = 'modal'; m.id = 'cxmodal';
    m.innerHTML = '<div class="card modalcard">' + html + '</div>'; document.body.appendChild(m);
  }
  function fechar() { const m = $('cxmodal'); if (m) m.remove(); }
  function recarregar() { CX.ok = false; render(); }

  function formNovo() {
    const hoje = hojeBR();
    modal('<div class="cardhead"><h2>Novo lançamento</h2><button class="linkbtn" id="cx-x">Fechar ×</button></div>' +
      '<form id="cx-f" class="formgrid"><label>Tipo<select class="field" id="cx-ft"><option value="despesa">Despesa</option><option value="receita">Receita</option></select></label>' +
      '<label>Data<input class="field" type="date" id="cx-fd" value="' + hoje + '" max="' + hoje + '" required></label>' +
      '<label class="full">Descrição ou fornecedor<input class="field" id="cx-fx" maxlength="120" required></label>' +
      '<label>Categoria<select class="field" id="cx-fc">' + CATEGORIAS.map(c => '<option>' + esc(c) + '</option>').join('') + '</select></label>' +
      '<label>Valor (R$)<input class="field" id="cx-fv" inputmode="decimal" placeholder="0,00" required></label>' +
      '<label>Número do documento (opcional)<input class="field" id="cx-fn" maxlength="60"></label>' +
      '<label class="full">Observação (opcional)<input class="field" id="cx-fo" maxlength="300"></label>' +
      '<p id="cx-erro" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="cx-ok">Salvar lançamento</button></div></form>');
    $('cx-x').onclick = fechar;
    $('cx-f').onsubmit = async ev => {
      ev.preventDefault();
      const erro = m => { $('cx-erro').textContent = m; };
      const c = parseCentavos($('cx-fv').value);
      if (!c || c <= 0) return erro('Informe um valor válido maior que zero, por exemplo 1.234,56.');
      if ($('cx-fx').value.trim() === '') return erro('Informe a descrição.');
      const dataLanc = $('cx-fd').value;           // lida antes de fechar o formulário
      await ocupado($('cx-ok'), async () => {
        const r = await APP.sb.rpc('registrar_lancamento', {
          p_tipo: $('cx-ft').value, p_data: dataLanc, p_valor_centavos: c, p_categoria: $('cx-fc').value, p_descricao: $('cx-fx').value.trim(),
          p_fornecedor: null, p_numero_documento: $('cx-fn').value.trim() || null, p_observacao: $('cx-fo').value.trim() || null, p_competencia: null
        });
        if (r.error) return erro(msg(r.error));
        fechar(); CX.mes = dataLanc.slice(0, 7); recarregar();
      });
    };
  }
  function formEstorno(id) {
    const l = CX.rows.find(r => r.id === id); if (!l) return;
    modal('<div class="cardhead"><h2>Estornar lançamento</h2><button class="linkbtn" id="cx-x">Fechar ×</button></div>' +
      '<p class="smallnote" style="margin-top:0"><b>' + esc(l.descricao) + '</b> · ' + reais(l.valor_centavos) + ' · ' + fmtData(l.data_lancamento) + '<br>O lançamento original é mantido e um estorno é registrado com a data de hoje.</p>' +
      '<form id="cx-f" class="formgrid"><label class="full">Motivo do estorno (5 a 200 caracteres)<input class="field" id="cx-fm" maxlength="200" required></label>' +
      '<p id="cx-erro" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="cx-ok">Confirmar estorno</button></div></form>');
    $('cx-x').onclick = fechar;
    $('cx-f').onsubmit = async ev => {
      ev.preventDefault();
      const motivo = $('cx-fm').value.trim();
      if (motivo.length < 5) return ($('cx-erro').textContent = 'Informe o motivo com pelo menos 5 caracteres.');
      await ocupado($('cx-ok'), async () => {
        const r = await APP.sb.rpc('estornar_lancamento', { p_id: id, p_motivo: motivo });
        if (r.error) return ($('cx-erro').textContent = msg(r.error));
        fechar(); recarregar();
      });
    };
  }
  function imprimir() {
    if (!CX.rel) return;
    const [ano, mes] = CX.mes.split('-'), rel = CX.rel;
    const lista = CX.rows.slice().reverse();
    const html = '<div class="relmes" style="font:13px/1.45 Arial,sans-serif;color:#000;padding:18px"><h1 style="font-size:20px;margin:0 0 4px">Relatório mensal — ' + mes + '/' + ano + '</h1>' +
      '<p style="margin:0 0 14px">Gerado em ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ' por ' + esc(APP.perfil.nome) + '</p>' +
      '<table style="border-collapse:collapse;width:100%;margin-bottom:14px">' + [['Saldo anterior', rel.saldo_anterior_centavos], ['Entradas do mês', rel.entradas_centavos], ['Saídas do mês', rel.saidas_centavos], ['Saldo do mês', rel.saldo_mes_centavos], ['Saldo final', rel.saldo_final_centavos]]
        .map(x => '<tr><td style="border:1px solid #999;padding:5px 8px">' + x[0] + '</td><td style="border:1px solid #999;padding:5px 8px;text-align:right">' + reais(x[1]) + '</td></tr>').join('') + '</table>' +
      '<h2 style="font-size:15px">Por categoria</h2><table style="border-collapse:collapse;width:100%;margin-bottom:14px"><tr><th style="border:1px solid #999;padding:4px 8px;text-align:left">Categoria</th><th style="border:1px solid #999;padding:4px 8px;text-align:right">Entradas</th><th style="border:1px solid #999;padding:4px 8px;text-align:right">Saídas</th></tr>' +
      (rel.por_categoria || []).map(x => '<tr><td style="border:1px solid #999;padding:4px 8px">' + esc(x.categoria) + '</td><td style="border:1px solid #999;padding:4px 8px;text-align:right">' + reais(x.entradas_centavos) + '</td><td style="border:1px solid #999;padding:4px 8px;text-align:right">' + reais(x.saidas_centavos) + '</td></tr>').join('') + '</table>' +
      '<h2 style="font-size:15px">Lançamentos</h2><table style="border-collapse:collapse;width:100%"><tr><th style="border:1px solid #999;padding:4px 6px;text-align:left">Data</th><th style="border:1px solid #999;padding:4px 6px;text-align:left">Descrição</th><th style="border:1px solid #999;padding:4px 6px;text-align:left">Doc.</th><th style="border:1px solid #999;padding:4px 6px;text-align:left">Categoria</th><th style="border:1px solid #999;padding:4px 6px;text-align:right">Valor</th></tr>' +
      lista.map(r => '<tr><td style="border:1px solid #999;padding:4px 6px">' + fmtData(r.data_lancamento) + '</td><td style="border:1px solid #999;padding:4px 6px">' + (r.tipo === 'estorno' ? '[ESTORNO] ' : '') + esc(r.descricao) + '</td><td style="border:1px solid #999;padding:4px 6px">' + esc(r.numero_documento || '') + '</td><td style="border:1px solid #999;padding:4px 6px">' + esc(r.categoria) + '</td><td style="border:1px solid #999;padding:4px 6px;text-align:right">' + (sinal(r) > 0 ? '+' : '−') + ' ' + reais(r.valor_centavos) + '</td></tr>').join('') + '</table></div>';
    bolPrintHTML([html]);
  }

  function bind() {
    const mo = $('cx-mostrar'); if (mo) mo.onclick = mostrar;
    const oc = $('cx-ocultar'); if (oc) oc.onclick = () => ocultar(true);
    const mes = $('cx-mes'); if (mes) mes.onchange = () => { if (!/^\d{4}-\d{2}$/.test(mes.value)) return; CX.mes = mes.value; recarregar(); };
    const rt = $('cx-retry'); if (rt) rt.onclick = recarregar;
    const nv = $('cx-novo'); if (nv) nv.onclick = formNovo;
    const pr = $('cx-print'); if (pr) pr.onclick = imprimir;
    const bindEst = () => document.querySelectorAll('[data-cx-est]').forEach(b => { b.onclick = () => formEstorno(b.dataset.cxEst); });
    bindEst();
    const refaz = () => { $('cx-tabela').innerHTML = tabela(); bindEst(); };
    const bs = $('cx-busca'); if (bs) bs.oninput = () => { CX.busca = bs.value; refaz(); };
    const tp = $('cx-tipo'); if (tp) tp.onchange = () => { CX.filtro = tp.value; refaz(); };
  }

  const renderAnterior = window.render;
  window.render = function () {
    if (APP.on && page !== 'financeiro' && CX.visivel && role !== 'sindico') { CX.visivel = false; para(); limpa(); }   // saiu da tela: oculta de novo
    renderAnterior();
    if (APP.on && page === 'financeiro') bind();
  };
})();
