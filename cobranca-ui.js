/* V1.15 — Cobrança por unidade ligada ao Supabase (página "Cobrança mensal").
   Síndico: previsão do mês, itens por unidade, gerar o rascunho, conferir, liberar, registrar pagamentos, ver quem deve.
   Conselho: consulta. Morador: vê só a cobrança da própria unidade, depois de liberada. Valores ocultos por padrão (morador e conselho). */
(function () {
  'use strict';
  const APP = window.APP, H = window.CXH;
  if (!APP || !APP.sb || !H) return;
  const $ = id => document.getElementById(id), esc = H.esc, reais = c => H.reais(c), fmtData = H.fmtData, hoje = () => H.hojeBR();
  const TIPOS_PREV = { gas: 'Gás', parcelada: 'Parcela', compensacao: 'Compensação', desconto: 'Desconto', multa: 'Multa', juros: 'Juros', outro: 'Outro' };
  const TIPOS = Object.assign({ cota_condominial: 'Taxa condominial', fundo_obras: 'Fundo de obras', agua: 'Água', rateio: 'Rateio' }, TIPOS_PREV);
  const FORMAS = { boleto: 'Boleto', pix: 'PIX', transferencia: 'Transferência', dinheiro: 'Dinheiro', outro: 'Outro' };
  const CB = APP.cb = { visivel: null, uid: null, ociosoMs: 120000, timer: null, mes: hoje().slice(0, 7), ok: false, carregando: false, erro: '', seq: 0, aviso: '', unidades: [], ciclo: null, previsao: null, previstos: [], cobrancas: [], itens: [], pagamentos: [], validacao: [], abertos: [] };
  const equipe = () => role === 'sindico' || role === 'conselho';
  const vis = () => CB.visivel === null ? role === 'sindico' : CB.visivel;
  const campo = c => String(Math.floor(Number(c) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + String(Math.abs(Number(c)) % 100).padStart(2, '0');
  const competencia = () => CB.mes + '-01';

  /* ---------------- privacidade (igual ao Financeiro) ---------------- */
  function limpa() { CB.seq++; Object.assign(CB, { ok: false, carregando: false, erro: '', unidades: [], ciclo: null, previsao: null, previstos: [], cobrancas: [], itens: [], pagamentos: [], validacao: [], abertos: [], aviso: '' }); }
  function para() { if (CB.timer) { clearTimeout(CB.timer); CB.timer = null; } }
  function ocultar(redesenha) { CB.visivel = false; para(); limpa(); H.fechar(); if (redesenha && APP.on && page === 'cobranca') render(); }
  function mostrar() { CB.visivel = true; CB.ok = false; arma(); render(); }
  function arma() { para(); if (role !== 'sindico' && CB.visivel) CB.timer = setTimeout(() => ocultar(true), CB.ociosoMs); }
  function sessao() { const uid = APP.perfil && APP.perfil.user_id; if (CB.uid !== uid) { CB.uid = uid; CB.visivel = null; para(); limpa(); } }
  ['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { if (CB.visivel && role !== 'sindico') arma(); }, true));
  document.addEventListener('visibilitychange', () => { if (document.hidden && APP.on && role !== 'sindico' && CB.visivel) ocultar(true); });
  window.addEventListener('pagehide', () => { if (role !== 'sindico') ocultar(false); });

  /* ---------------- carga ---------------- */
  const q = async c => { const r = await c; if (r.error) throw r.error; return r.data || []; };
  async function carregar() {
    if (!vis()) return;
    const seq = ++CB.seq; CB.carregando = true; CB.erro = '';
    try {
      const unidades = await q(APP.sb.from('unidades').select('id,identificacao,fracao_ideal,ativa').order('identificacao', { ascending: true }));
      let ciclo = null, previsao = null, previstos = [], validacao = [], abertos = [], cobrancas;
      if (equipe()) {
        ciclo = (await q(APP.sb.from('ciclos_cobranca').select('id,competencia,vencimento,status,total_centavos,liberado_em').eq('competencia', competencia())))[0] || null;
        previsao = (await q(APP.sb.from('previsoes_mensais').select('id,taxa_por_unidade_centavos,fundo_obras_por_unidade_centavos').eq('competencia', competencia())))[0] || null;
        if (role === 'sindico' && !ciclo) previstos = await q(APP.sb.from('itens_cobranca_previstos').select('id,unidade_id,tipo,descricao,valor_centavos').eq('competencia', competencia()));
        cobrancas = await q(APP.sb.from('cobrancas').select('id,unidade_id,competencia,vencimento,valor_total_centavos,status,pago_em,valor_pago_centavos').eq('competencia', competencia()));
        if (role === 'sindico' && ciclo && ciclo.status === 'gerado') { const v = await APP.sb.rpc('validar_cobranca_mensal', { p_competencia: competencia() }); if (v.error) throw v.error; validacao = v.data || []; }
        const ab = await APP.sb.rpc('cobrancas_em_aberto'); if (ab.error) throw ab.error; abertos = ab.data || [];
      } else {
        cobrancas = await q(APP.sb.from('cobrancas').select('id,unidade_id,competencia,vencimento,valor_total_centavos,status,pago_em,valor_pago_centavos').order('competencia', { ascending: false }));
      }
      const ids = cobrancas.map(c => c.id); let itens = [], pagamentos = [];
      for (let i = 0; i < ids.length; i += 50) {
        itens = itens.concat(await q(APP.sb.from('itens_cobranca').select('cobranca_id,tipo,descricao,valor_centavos').in('cobranca_id', ids.slice(i, i + 50))));
        pagamentos = pagamentos.concat((await q(APP.sb.from('cobranca_pagamentos').select('id,cobranca_id,data_pagamento,valor_centavos,forma,observacao,removido_em,extrato_linha_id').in('cobranca_id', ids.slice(i, i + 50)))).filter(p => !p.removido_em));
      }
      if (seq !== CB.seq) return;
      Object.assign(CB, { unidades, ciclo, previsao, previstos, cobrancas, itens, pagamentos, validacao, abertos, ok: true, carregando: false });
    } catch (e) { if (seq !== CB.seq) return; Object.assign(CB, { erro: H.msg(e), ok: true, carregando: false }); }
    if (page === 'cobranca') render();
  }
  const recarregar = () => { CB.ok = false; render(); };
  const nomeUn = id => (CB.unidades.find(u => u.id === id) || {}).identificacao || '—';
  const pagoDe = id => CB.pagamentos.filter(p => p.cobranca_id === id).reduce((s, p) => s + Number(p.valor_centavos), 0);
  function situacao(c) {
    const saldo = Number(c.valor_total_centavos) - pagoDe(c.id);
    if (c.status === 'paga' || saldo <= 0) return { t: 'Paga', cls: 'green', saldo: 0 };
    if (c.vencimento && String(c.vencimento).slice(0, 10) < hoje()) { const d = Math.round((new Date(hoje() + 'T00:00:00Z') - new Date(String(c.vencimento).slice(0, 10) + 'T00:00:00Z')) / 864e5); return { t: 'Atrasada (' + d + (d === 1 ? ' dia' : ' dias') + ')', cls: 'red', saldo }; }
    return { t: 'Em aberto', cls: 'amber', saldo };
  }
  const composicao = id => CB.itens.filter(i => i.cobranca_id === id).map(i => esc(i.descricao && !TIPOS[i.tipo] ? i.descricao : (TIPOS[i.tipo] || i.tipo)) + ' ' + reais(i.valor_centavos)).join(' · ');

  /* ---------------- telas ---------------- */
  function ocultoPage(titulo) {
    return head(titulo, 'Os valores estão ocultos por privacidade.') + '<div class="card"><div class="empty"><div style="font-size:30px">🔒</div>Os valores da cobrança estão ocultos.<br><br><button class="btn" id="cb-mostrar">Mostrar valores</button>' +
      (role === 'sindico' ? '' : '<p class="smallnote">Voltam a ficar ocultos ao sair desta tela, ao minimizar o aplicativo ou após 2 minutos sem uso.</p>') + '</div></div>';
  }
  const barra = () => '<div class="card" style="margin-bottom:18px"><div class="toolbar">' + (role === 'morador' ? '' : '<label style="font-size:13px;color:var(--muted)">Competência<input class="field" id="cb-mes" type="month" value="' + esc(CB.mes) + '"></label>') + '<button class="linkbtn" id="cb-ocultar">🔒 Ocultar valores</button></div></div>';
  const avisoHtml = () => CB.aviso ? '<div class="card" style="margin-bottom:18px"><p class="agerro" style="min-height:0;margin:0 0 8px" role="alert">⚠ ' + esc(CB.aviso) + '</p><button class="linkbtn" id="cb-aviso-x">Dispensar</button></div>' : '';

  function cobrancaDbPage() {
    sessao();
    const titulo = role === 'morador' ? 'Minha cobrança' : 'Cobrança mensal';
    if (!vis()) return ocultoPage(titulo);
    if (!CB.ok && !CB.carregando) carregar();
    const sub = role === 'sindico' ? 'Prepare, confira e libere a cobrança de cada unidade e registre os pagamentos.' : role === 'conselho' ? 'Consulta da cobrança por unidade e de quem está em aberto.' : 'Cobrança da sua unidade.';
    if (!CB.ok) return head(titulo, sub) + barra() + '<div class="card"><div class="empty">Carregando…</div></div>';
    if (CB.erro) return head(titulo, sub) + barra() + '<div class="card"><div class="empty">' + esc(CB.erro) + '<br><button class="linkbtn" id="cb-retry">Tentar de novo</button></div></div>';
    return head(titulo, sub) + avisoHtml() + barra() + (role === 'morador' ? moradorHtml() : equipeHtml());
  }
  window.cobrancaDbPage = cobrancaDbPage;

  function moradorHtml() {
    if (!CB.cobrancas.length) return '<div class="card"><div class="empty">Ainda não há cobrança liberada para a sua unidade.</div></div>';
    return CB.cobrancas.map(c => {
      const s = situacao(c), pags = CB.pagamentos.filter(p => p.cobranca_id === c.id);
      return '<div class="card" style="margin-bottom:12px"><div class="cardhead"><h2>Unidade ' + esc(nomeUn(c.unidade_id)) + ' · ' + esc(String(c.competencia).slice(5, 7) + '/' + String(c.competencia).slice(0, 4)) + '</h2><span class="pill ' + s.cls + '">' + esc(s.t) + '</span></div>' +
        '<p style="margin:0 0 8px"><b>' + reais(c.valor_total_centavos) + '</b> · vencimento ' + fmtData(String(c.vencimento).slice(0, 10)) + (s.saldo > 0 && s.saldo < Number(c.valor_total_centavos) ? ' · saldo ' + reais(s.saldo) : '') + '</p>' +
        '<div class="tablewrap"><table><tbody>' + CB.itens.filter(i => i.cobranca_id === c.id).map(i => '<tr><td>' + esc(TIPOS[i.tipo] === i.descricao || !i.descricao ? (TIPOS[i.tipo] || i.tipo) : i.descricao) + '</td><td class="amount ' + (Number(i.valor_centavos) < 0 ? 'positive' : '') + '">' + reais(i.valor_centavos) + '</td></tr>').join('') + '</tbody></table></div>' +
        (pags.length ? '<p class="smallnote">Pagamentos: ' + pags.map(p => fmtData(String(p.data_pagamento).slice(0, 10)) + ' ' + reais(p.valor_centavos) + ' (' + esc(FORMAS[p.forma] || p.forma) + ')').join('; ') + '</p>' : '') + '</div>';
    }).join('');
  }

  function equipeHtml() {
    const c = CB.ciclo, adm = role === 'sindico';
    let corpo = '';
    if (!c) {
      corpo = adm ? formsPreparo() : '<div class="card"><div class="empty">A cobrança desta competência ainda não foi gerada.</div></div>';
    } else {
      const total = CB.cobrancas.reduce((s, x) => s + Number(x.valor_total_centavos), 0), pago = CB.cobrancas.reduce((s, x) => s + Math.min(pagoDe(x.id), Number(x.valor_total_centavos)), 0);
      corpo = '<div class="grid stats">' + cardStat('Situação', c.status === 'liberado' ? 'Liberada' : 'Rascunho', 'Vencimento ' + fmtData(String(c.vencimento).slice(0, 10))) + cardStat('Total cobrado', reais(total), CB.cobrancas.length + ' unidades') +
        (c.status === 'liberado' ? cardStat('Recebido', reais(pago), 'Baixas registradas', 'positive') + cardStat('Em aberto', reais(total - pago), 'A receber', total - pago > 0 ? 'negative' : '') : '') + '</div>' + conferencia() + tabelaCobrancas(c, adm);
    }
    return corpo + quemDeve();
  }

  function formsPreparo() {
    const p = CB.previsao, pre = CB.previstos;
    const ant = (() => { const [a, m] = CB.mes.split('-').map(Number); return m === 1 ? (a - 1) + '-12' : a + '-' + String(m - 1).padStart(2, '0'); })();
    return '<div class="card" style="margin-bottom:12px"><div class="cardhead"><h2>1. Previsão do mês</h2></div><p class="smallnote" style="margin-top:0">Valores por unidade, iguais para todos (como na planilha de previsão).</p>' +
      '<form id="cb-fprev" class="formgrid"><label>Taxa condominial por unidade (R$)<input class="field" id="cb-taxa" inputmode="decimal" value="' + (p ? campo(p.taxa_por_unidade_centavos) : '') + '" required></label>' +
      '<label>Fundo de obras por unidade (R$)<input class="field" id="cb-fundo" inputmode="decimal" value="' + (p ? campo(p.fundo_obras_por_unidade_centavos) : '0,00') + '"></label><p id="cb-erro-prev" class="agerro full" role="alert"></p><div class="full"><button class="btn secondary" id="cb-prev-ok">Salvar previsão</button></div></form></div>' +
      '<div class="card" style="margin-bottom:12px"><div class="cardhead"><h2>2. Itens por unidade</h2><button class="linkbtn" id="cb-add-item">＋ Adicionar item</button></div><p class="smallnote" style="margin-top:0">Gás, parcelas, compensações, descontos, multas ou juros que valem só para uma unidade neste mês.</p>' +
      (pre.length ? '<div class="tablewrap"><table><thead><tr><th>Unidade</th><th>Item</th><th class="amount">Valor</th><th></th></tr></thead><tbody>' + pre.map(i => '<tr><td>' + esc(nomeUn(i.unidade_id)) + '</td><td>' + esc(TIPOS_PREV[i.tipo] || i.tipo) + ': ' + esc(i.descricao) + '</td><td class="amount ' + (Number(i.valor_centavos) < 0 ? 'positive' : '') + '">' + reais(i.valor_centavos) + '</td><td><button class="linkbtn" data-cb-delprev="' + esc(i.id) + '">Remover</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">Nenhum item avulso.</div>') + '</div>' +
      '<div class="card" style="margin-bottom:12px"><div class="cardhead"><h2>3. Gerar a cobrança</h2></div><form id="cb-fger" class="formgrid">' +
      '<label>Vencimento<input class="field" type="date" id="cb-venc" required></label><label>Fatura de água (COPASA), R$<input class="field" id="cb-agua" inputmode="decimal" required></label>' +
      '<label>Mês de consumo da água<input class="field" type="month" id="cb-cons" value="' + ant + '"></label><p class="smallnote full">A água é dividida pela fração ideal de cada unidade; a taxa e o fundo, em partes iguais pelo valor informado. O resultado fica como <b>rascunho</b> para você conferir antes de liberar.</p>' +
      '<p id="cb-erro-ger" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="cb-ger-ok">Gerar rascunho</button></div></form></div>';
  }

  function conferencia() {
    if (!CB.validacao.length) return CB.ciclo && CB.ciclo.status === 'gerado' && role === 'sindico' ? '<div class="card" style="margin-bottom:12px"><p style="margin:0">✔ Conferência sem avisos. Confira os valores abaixo e libere.</p></div>' : '';
    return '<div class="card" style="margin-bottom:12px"><div class="cardhead"><h2>Conferência</h2></div>' + CB.validacao.map(v => '<p class="' + (v.nivel === 'erro' ? 'agerro' : 'smallnote') + '" style="min-height:0;margin:0 0 6px">' + (v.nivel === 'erro' ? '✖ ' : '⚠ ') + esc(v.mensagem) + '</p>').join('') + '</div>';
  }

  function tabelaCobrancas(c, adm) {
    const lib = c.status === 'liberado', lista = CB.cobrancas.slice().sort((a, b) => nomeUn(a.unidade_id).localeCompare(nomeUn(b.unidade_id), 'pt-BR', { numeric: true }));
    const temErro = CB.validacao.some(v => v.nivel === 'erro');
    return '<div class="card" style="margin-bottom:12px"><div class="tablewrap"><table><thead><tr><th>Unidade</th><th>Composição</th><th class="amount">Total</th>' + (lib ? '<th class="amount">Pago</th><th>Situação</th>' : '') + (adm && lib ? '<th>Ação</th>' : '') + '</tr></thead><tbody>' +
      lista.map(x => { const s = situacao(x), pg = pagoDe(x.id), npg = CB.pagamentos.filter(p => p.cobranca_id === x.id).length;
        return '<tr><td><b>' + esc(nomeUn(x.unidade_id)) + '</b></td><td class="rowmeta">' + composicao(x.id) + '</td><td class="amount">' + reais(x.valor_total_centavos) + '</td>' +
          (lib ? '<td class="amount positive">' + reais(pg) + '</td><td><span class="pill ' + s.cls + '">' + esc(s.t) + '</span></td>' : '') +
          (adm && lib ? '<td>' + (s.saldo > 0 ? '<button class="linkbtn" data-cb-pagar="' + esc(x.id) + '">Registrar pagamento</button> ' : '') + (npg ? '<button class="linkbtn" data-cb-pags="' + esc(x.id) + '">Pagamentos (' + npg + ')</button>' : '') + '</td>' : '') + '</tr>'; }).join('') + '</tbody></table></div>' +
      (adm ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' + (c.status === 'gerado' ? '<button class="btn" id="cb-liberar"' + (temErro ? ' disabled' : '') + '>Liberar cobrança</button><button class="btn secondary" id="cb-regerar">Gerar de novo (substitui o rascunho)</button>' : '<button class="btn secondary" id="cb-reabrir">Reabrir para correção</button>') + '</div><p id="cb-erro-acao" class="agerro" role="alert"></p>' : '') + '</div>';
  }

  function quemDeve() {
    const a = CB.abertos; if (!a.length && !(CB.ciclo)) return '';
    return '<div class="card"><div class="cardhead"><h2>Quem está em aberto</h2></div>' + (a.length ? '<div class="tablewrap"><table><thead><tr><th>Unidade</th><th>Competência</th><th>Vencimento</th><th class="amount">Saldo</th><th>Atraso</th></tr></thead><tbody>' +
      a.map(x => '<tr><td><b>' + esc(x.unidade) + '</b></td><td>' + esc(String(x.competencia).slice(5, 7) + '/' + String(x.competencia).slice(0, 4)) + '</td><td>' + fmtData(String(x.vencimento).slice(0, 10)) + '</td><td class="amount negative">' + reais(x.saldo_centavos) + '</td><td>' + (Number(x.dias_atraso) > 0 ? '<span class="pill red">' + Number(x.dias_atraso) + ' dia(s)</span>' : '<span class="pill amber">no prazo</span>') + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">Nenhuma cobrança em aberto. 🎉</div>') + '</div>';
  }

  /* ---------------- ações ---------------- */
  const erroEm = (id, m) => { const e = $(id); if (e) e.textContent = m; };
  const executa = (btn, id, fn) => H.ocupado(btn, async () => { try { await fn(); } catch (e) { erroEm(id, H.msg(e)); } });
  async function rpc(nome, args) { const r = await APP.sb.rpc(nome, args); if (r.error) throw r.error; return r.data; }

  function bindPreparo() {
    const f = $('cb-fprev'); if (f) f.onsubmit = ev => { ev.preventDefault(); executa($('cb-prev-ok'), 'cb-erro-prev', async () => {
      const t = window.parseCentavos($('cb-taxa').value), fu = $('cb-fundo').value.trim() === '' ? 0 : window.parseCentavos($('cb-fundo').value);
      if (!t || t <= 0) throw new Error('Informe a taxa por unidade, por exemplo 712,92.'); if (fu === null) throw new Error('Valor do fundo de obras inválido.');
      const dados = { taxa_por_unidade_centavos: t, fundo_obras_por_unidade_centavos: fu };
      const r = CB.previsao ? await APP.sb.from('previsoes_mensais').update(dados).eq('id', CB.previsao.id) : await APP.sb.from('previsoes_mensais').insert(Object.assign({ condominio_id: APP.perfil.condominio_id, competencia: competencia() }, dados));
      if (r.error) throw r.error; CB.aviso = ''; recarregar(); }); };
    const ai = $('cb-add-item'); if (ai) ai.onclick = formItem;
    document.querySelectorAll('[data-cb-delprev]').forEach(b => { b.onclick = async () => { const r = await APP.sb.from('itens_cobranca_previstos').delete().eq('id', b.dataset.cbDelprev); if (r.error) { CB.aviso = H.msg(r.error); } recarregar(); }; });
    const g = $('cb-fger'); if (g) g.onsubmit = ev => { ev.preventDefault(); executa($('cb-ger-ok'), 'cb-erro-ger', async () => { await gerar(false); }); };
  }
  async function gerar(substituir) {
    const venc = $('cb-venc').value, agua = window.parseCentavos($('cb-agua').value), cons = $('cb-cons').value;
    if (!CB.previsao) throw new Error('Salve a previsão do mês (passo 1) antes de gerar.');
    if (!venc) throw new Error('Informe o vencimento.'); if (!agua || agua <= 0) throw new Error('Informe a fatura de água, por exemplo 1.597,01.');
    await rpc('gerar_cobranca_mensal', { p_competencia: competencia(), p_vencimento: venc, p_fatura_agua_centavos: agua, p_competencia_consumo_agua: cons ? cons + '-01' : null, p_substituir_rascunhos: !!substituir });
    CB.aviso = ''; recarregar();
  }
  function formItem() {
    H.modal('<div class="cardhead"><h2>Item por unidade</h2><button class="linkbtn" id="cb-x">Fechar ×</button></div><form id="cb-fi" class="formgrid">' +
      '<label>Unidade<select class="field" id="cb-iu">' + CB.unidades.filter(u => u.ativa !== false).map(u => '<option value="' + esc(u.id) + '">' + esc(u.identificacao) + '</option>').join('') + '</select></label>' +
      '<label>Tipo<select class="field" id="cb-it">' + Object.keys(TIPOS_PREV).map(k => '<option value="' + k + '">' + TIPOS_PREV[k] + '</option>').join('') + '</select></label>' +
      '<label class="full">Descrição<input class="field" id="cb-id" maxlength="120" required></label><label>Valor (R$)<input class="field" id="cb-iv" inputmode="decimal" required></label>' +
      '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="cb-ineg"> É desconto ou crédito (reduz a cobrança)</label><p id="cb-erro-item" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="cb-i-ok">Adicionar</button></div></form>');
    $('cb-x').onclick = H.fechar;
    $('cb-fi').onsubmit = ev => { ev.preventDefault(); executa($('cb-i-ok'), 'cb-erro-item', async () => {
      const v = window.parseCentavos($('cb-iv').value); if (!v || v <= 0) throw new Error('Informe um valor maior que zero.'); if ($('cb-id').value.trim() === '') throw new Error('Informe a descrição.');
      const r = await APP.sb.from('itens_cobranca_previstos').insert({ condominio_id: APP.perfil.condominio_id, competencia: competencia(), unidade_id: $('cb-iu').value, tipo: $('cb-it').value, descricao: $('cb-id').value.trim(), valor_centavos: $('cb-ineg').checked ? -v : v, criado_por: APP.perfil.user_id });
      if (r.error) throw r.error; H.fechar(); recarregar(); }); };
  }
  function bindAcoes() {
    const lib = $('cb-liberar'); if (lib) lib.onclick = () => executa(lib, 'cb-erro-acao', async () => { await rpc('liberar_cobranca_mensal', { p_competencia: competencia() }); recarregar(); });
    const reab = $('cb-reabrir'); if (reab) reab.onclick = () => executa(reab, 'cb-erro-acao', async () => { await rpc('reabrir_cobranca_mensal', { p_competencia: competencia() }); recarregar(); });
    const reg = $('cb-regerar'); if (reg) reg.onclick = () => formRegerar();
    document.querySelectorAll('[data-cb-pagar]').forEach(b => { b.onclick = () => formPagamento(b.dataset.cbPagar); });
    document.querySelectorAll('[data-cb-pags]').forEach(b => { b.onclick = () => modalPagamentos(b.dataset.cbPags); });
  }
  function formRegerar() {
    H.modal('<div class="cardhead"><h2>Gerar de novo</h2><button class="linkbtn" id="cb-x">Fechar ×</button></div><p class="smallnote" style="margin-top:0">O rascunho atual será substituído pelos valores abaixo (a previsão e os itens por unidade continuam os da competência).</p><form id="cb-fger" class="formgrid">' +
      '<label>Vencimento<input class="field" type="date" id="cb-venc" value="' + esc(String(CB.ciclo.vencimento).slice(0, 10)) + '" required></label><label>Fatura de água (COPASA), R$<input class="field" id="cb-agua" inputmode="decimal" required></label>' +
      '<label>Mês de consumo da água<input class="field" type="month" id="cb-cons"></label><p id="cb-erro-ger" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="cb-ger-ok">Substituir o rascunho</button></div></form>');
    $('cb-x').onclick = H.fechar; $('cb-fger').onsubmit = ev => { ev.preventDefault(); executa($('cb-ger-ok'), 'cb-erro-ger', async () => { await gerar(true); H.fechar(); }); };
  }
  async function formPagamento(id) {
    const c = CB.cobrancas.find(x => x.id === id); if (!c) return; const s = situacao(c);
    let creditos = [];
    try {
      const ini = new Date(hoje() + 'T00:00:00Z'); ini.setUTCDate(ini.getUTCDate() - 120);
      const lin = await q(APP.sb.from('extrato_linhas').select('id,data_mov,valor_centavos,memo,status').gte('data_mov', ini.toISOString().slice(0, 10)));
      const ocup = await q(APP.sb.from('cobranca_pagamentos').select('extrato_linha_id,valor_centavos,removido_em').in('extrato_linha_id', lin.map(l => l.id).slice(0, 200)));
      creditos = lin.filter(l => Number(l.valor_centavos) > 0 && l.status !== 'ignorada').map(l => ({ l, livre: Number(l.valor_centavos) - ocup.filter(o => o.extrato_linha_id === l.id && !o.removido_em).reduce((a, o) => a + Number(o.valor_centavos), 0) })).filter(x => x.livre > 0);
    } catch (e) { creditos = []; }
    H.modal('<div class="cardhead"><h2>Registrar pagamento</h2><button class="linkbtn" id="cb-x">Fechar ×</button></div><p class="smallnote" style="margin-top:0">Unidade <b>' + esc(nomeUn(c.unidade_id)) + '</b> · total ' + reais(c.valor_total_centavos) + ' · saldo ' + reais(s.saldo) + '. O pagamento não cria lançamento: a receita já entra no livro-caixa pelo extrato.</p>' +
      '<form id="cb-fp" class="formgrid"><label>Data do pagamento<input class="field" type="date" id="cb-pd" value="' + hoje() + '" max="' + hoje() + '" required></label><label>Valor (R$)<input class="field" id="cb-pv" inputmode="decimal" value="' + campo(s.saldo) + '" required></label>' +
      '<label>Forma<select class="field" id="cb-pf">' + Object.keys(FORMAS).map(k => '<option value="' + k + '">' + FORMAS[k] + '</option>').join('') + '</select></label>' +
      '<label>Crédito do extrato (opcional)<select class="field" id="cb-pl"><option value="">Nenhum</option>' + creditos.map(x => '<option value="' + esc(x.l.id) + '" data-livre="' + x.livre + '">' + fmtData(String(x.l.data_mov).slice(0, 10)) + ' · ' + esc(x.l.memo) + ' · livre ' + reais(x.livre) + '</option>').join('') + '</select></label>' +
      '<label class="full">Observação (opcional)<input class="field" id="cb-po" maxlength="300"></label><p id="cb-erro-pag" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="cb-p-ok">Registrar pagamento</button></div></form>');
    $('cb-x').onclick = H.fechar;
    $('cb-pl').onchange = () => { const o = $('cb-pl').selectedOptions[0]; if (o && o.dataset.livre) $('cb-pv').value = campo(Math.min(s.saldo, Number(o.dataset.livre))); };
    $('cb-fp').onsubmit = ev => { ev.preventDefault(); executa($('cb-p-ok'), 'cb-erro-pag', async () => {
      const v = window.parseCentavos($('cb-pv').value); if (!v || v <= 0) throw new Error('Informe um valor maior que zero.');
      await rpc('registrar_pagamento_cobranca', { p_cobranca_id: id, p_data: $('cb-pd').value, p_valor_centavos: v, p_forma: $('cb-pf').value, p_extrato_linha_id: $('cb-pl').value || null, p_observacao: $('cb-po').value.trim() || null });
      H.fechar(); recarregar(); }); };
  }
  function modalPagamentos(id) {
    const c = CB.cobrancas.find(x => x.id === id); if (!c) return; const lista = CB.pagamentos.filter(p => p.cobranca_id === id).sort((a, b) => String(a.data_pagamento).localeCompare(String(b.data_pagamento)));
    H.modal('<div class="cardhead"><h2>Pagamentos</h2><button class="linkbtn" id="cb-x">Fechar ×</button></div><p class="smallnote" style="margin-top:0">Unidade <b>' + esc(nomeUn(c.unidade_id)) + '</b> · total ' + reais(c.valor_total_centavos) + '</p>' +
      '<div class="tablewrap"><table><tbody>' + lista.map(p => '<tr><td>' + fmtData(String(p.data_pagamento).slice(0, 10)) + '</td><td>' + esc(FORMAS[p.forma] || p.forma) + (p.observacao ? '<div class="rowmeta">' + esc(p.observacao) + '</div>' : '') + '</td><td class="amount positive">' + reais(p.valor_centavos) + '</td><td>' + (role === 'sindico' ? '<button class="linkbtn" data-cb-rem="' + esc(p.id) + '">Remover</button>' : '') + '</td></tr>').join('') + '</tbody></table></div><div id="cb-rem-area"></div>');
    $('cb-x').onclick = H.fechar;
    document.querySelectorAll('[data-cb-rem]').forEach(b => { b.onclick = () => {
      $('cb-rem-area').innerHTML = '<form id="cb-fr" class="formgrid" style="margin-top:10px"><label class="full">Motivo da remoção (5 a 200 caracteres)<input class="field" id="cb-rm" maxlength="200" required></label><p id="cb-erro-rem" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="cb-r-ok">Remover pagamento</button></div></form>';
      $('cb-fr').onsubmit = ev => { ev.preventDefault(); executa($('cb-r-ok'), 'cb-erro-rem', async () => { const m = $('cb-rm').value.trim(); if (m.length < 5) throw new Error('Informe o motivo com pelo menos 5 caracteres.'); await rpc('remover_pagamento_cobranca', { p_pagamento_id: b.dataset.cbRem, p_motivo: m }); H.fechar(); recarregar(); }); };
    }; });
  }

  function bind() {
    const mo = $('cb-mostrar'); if (mo) mo.onclick = mostrar;
    const oc = $('cb-ocultar'); if (oc) oc.onclick = () => ocultar(true);
    const rt = $('cb-retry'); if (rt) rt.onclick = recarregar;
    const ax = $('cb-aviso-x'); if (ax) ax.onclick = () => { CB.aviso = ''; render(); };
    const mes = $('cb-mes'); if (mes) mes.onchange = () => { if (!/^\d{4}-\d{2}$/.test(mes.value)) return; CB.mes = mes.value; recarregar(); };
    bindPreparo(); bindAcoes();
  }
  const renderAnterior = window.render;
  window.render = function () {
    if (APP.on && page !== 'cobranca' && CB.visivel && role !== 'sindico') { CB.visivel = false; para(); limpa(); }
    renderAnterior();
    if (APP.on && page === 'cobranca') bind();
  };
})();
