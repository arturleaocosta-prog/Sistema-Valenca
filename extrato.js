/* V1.14 — Importação de extrato bancário (OFX) dentro do Financeiro. Carregado depois de ofx.js e caixa.js.
   Fluxo: o síndico escolhe o arquivo → o app lê no navegador → mostra cada movimento para revisão (lançar, conciliar com um
   lançamento já existente ou ignorar) → só então chama importar_extrato, que grava tudo em uma transação e confere o saldo. */
(function () {
  'use strict';
  const APP = window.APP, H = window.CXH, OFX = window.OFX;
  if (!APP || !APP.sb || !H || !OFX) return;
  const $ = id => document.getElementById(id), esc = H.esc, reais = c => H.reais(c);
  const sinalDe = v => v > 0 ? 1 : -1;
  const addDias = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const difDias = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 864e5);
  const ddmm = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7);
  const bytesDe = f => f.arrayBuffer ? f.arrayBuffer() : new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => ko(r.error); r.readAsArrayBuffer(f); });

  /* sugestões prontas (movimentos que se repetem todo mês); as regras salvas pelo síndico têm prioridade */
  const PRONTAS = [
    { memo: 'COB COMPE', sinal: 1, categoria: 'Taxa condominial', descricao: 'Cotas recebidas por boleto — liquidação de {dd/mm}' },
    { memo: 'COB COMPE', sinal: -1, categoria: 'Outras despesas', descricao: m => { const n = Math.abs(m.valor_centavos) / 630; return 'Tarifa de cobrança bancária' + (Number.isInteger(n) ? ' (' + n + ' boleto' + (n > 1 ? 's' : '') + ')' : ''); } },   // R$ 6,30 por boleto liquidado
    { memo: 'TAR PIX', sinal: -1, categoria: 'Outras despesas', descricao: 'Tarifa PIX' },
    { memo: 'AGUA', sinal: -1, categoria: 'Água e esgoto', descricao: 'Copasa — água e esgoto', fornecedor: 'Copasa' },
    { memo: 'LUZ', sinal: -1, categoria: 'Energia das áreas comuns', descricao: 'Cemig — energia das áreas comuns', fornecedor: 'Cemig' }
  ];
  let E = null;   // estado da importação em andamento

  /* ---------------- passo 1: escolher o arquivo ---------------- */
  function importar() {
    E = null;
    H.modal('<div class="cardhead"><h2>Importar extrato (OFX)</h2><button class="linkbtn" id="ex-x">Fechar ×</button></div>' +
      '<p class="smallnote" style="margin-top:0">Baixe o extrato da conta no Internet Banking em formato <b>OFX</b> e envie aqui. Você revisa cada movimento antes de qualquer lançamento ser gravado.</p>' +
      '<label class="full">Arquivo OFX<input class="field" type="file" id="ex-f"></label><p id="ex-msg" class="agerro" role="alert"></p><div id="ex-corpo"></div>');
    $('ex-x').onclick = H.fechar;
    $('ex-f').onchange = async () => { const f = ($('ex-f').files || [])[0]; if (f) await ler(f); };
  }
  async function ler(f) {
    const msg = $('ex-msg'); msg.textContent = ''; $('ex-corpo').innerHTML = '';
    try {
      if (f.size > 2 * 1048576) throw new Error('O arquivo tem mais de 2 MB. Exporte um período menor.');
      const buf = await bytesDe(f), parsed = OFX.parse(OFX.decodificar(buf)), sha = await OFX.sha256(buf);
      msg.textContent = 'Lendo e comparando com o livro-caixa…';
      const ctx = await carregarContexto(parsed, sha);
      msg.textContent = '';
      E = { parsed, sha, nome: f.name, ctx, forcar: false };
      if (ctx.duplicado) { msg.textContent = 'Este arquivo já foi importado em ' + H.fmtData(String(ctx.duplicado.importado_em).slice(0, 10)) + '. Escolha outro extrato.'; return; }
      E.linhas = prepara(parsed, ctx);
      desenha();
    } catch (e) { msg.textContent = H.msg(e); }
  }
  async function carregarContexto(p, sha) {
    const ini = p.periodo_ini, fim = p.periodo_fim, a = addDias(ini, -31), b = addDias(fim, 31);
    const q = async (consulta) => { const r = await consulta; if (r.error) throw r.error; return r.data || []; };
    const [dup, exist, regras, lancs, vinc, saldoRes] = await Promise.all([
      q(APP.sb.from('extratos_importados').select('id,importado_em').eq('arquivo_sha256', sha)),
      q(APP.sb.from('extrato_linhas').select('chave').gte('data_mov', ini).lte('data_mov', fim)),
      q(APP.sb.from('regras_extrato').select('memo_padrao,sinal,valor_centavos,categoria,descricao,fornecedor')),
      q(APP.sb.from('lancamentos').select('id,tipo,data_lancamento,valor_centavos,descricao,estornado_em').gte('data_lancamento', a).lte('data_lancamento', b)),
      q(APP.sb.from('extrato_linhas').select('lancamento_id').gte('data_mov', a).lte('data_mov', b)),
      APP.sb.rpc('saldo_livro_em', { p_data: addDias(ini, -1) })
    ]);
    const existentes = {}; exist.forEach(l => { existentes[l.chave] = (existentes[l.chave] || 0) + 1; });
    const vinculados = new Set(vinc.map(v => v.lancamento_id).filter(Boolean));
    return { duplicado: dup[0] || null, existentes, regras, vinculados, saldoIniLivro: saldoRes.error ? null : Number(saldoRes.data),
      lancamentos: lancs.filter(l => l.tipo !== 'estorno' && !l.estornado_em && !vinculados.has(l.id)) };
  }
  function regraPara(m, ctx) {
    const memo = OFX.normaliza(m.memo), s = sinalDe(m.valor_centavos), v = Math.abs(m.valor_centavos);
    const salvas = ctx.regras.filter(r => r.memo_padrao === memo && Number(r.sinal) === s && (r.valor_centavos === null || Number(r.valor_centavos) === v));
    const r = salvas.find(x => x.valor_centavos !== null) || salvas[0]; if (r) return { categoria: r.categoria, descricao: r.descricao, fornecedor: r.fornecedor || '' };
    const p = PRONTAS.find(x => x.memo === memo && x.sinal === s); return p ? { categoria: p.categoria, descricao: typeof p.descricao === 'function' ? p.descricao(m) : p.descricao.replace('{dd/mm}', ddmm(m.data)), fornecedor: p.fornecedor || '' } : null;
  }
  function prepara(p, ctx) {
    const cont = {}, usados = new Set();
    return p.movimentos.map(m => {
      const k = OFX.chave(m); cont[k] = (cont[k] || 0) + 1;
      const l = { m, ja: cont[k] <= (ctx.existentes[k] || 0), acao: '', categoria: '', descricao: '', fornecedor: '', lancId: '', motivo: '', lembrar: '' };
      if (l.ja) return l;
      const tipo = m.valor_centavos > 0 ? 'receita' : 'despesa';
      l.cands = ctx.lancamentos.filter(x => x.tipo === tipo && Number(x.valor_centavos) === Math.abs(m.valor_centavos) && Math.abs(difDias(String(x.data_lancamento).slice(0, 10), m.data)) <= 31)
        .sort((x, y) => Math.abs(difDias(String(x.data_lancamento).slice(0, 10), m.data)) - Math.abs(difDias(String(y.data_lancamento).slice(0, 10), m.data)));
      const perto = l.cands.find(x => !usados.has(x.id) && Math.abs(difDias(String(x.data_lancamento).slice(0, 10), m.data)) <= 5);
      if (perto) { usados.add(perto.id); l.acao = 'conciliar'; l.lancId = perto.id; return l; }
      const r = regraPara(m, ctx); if (r) Object.assign(l, { acao: 'lancar' }, r);
      return l;
    });
  }
  const pendente = l => !l.ja && (l.acao === '' || (l.acao === 'lancar' && (!l.categoria || !l.descricao.trim())) || (l.acao === 'conciliar' && !l.lancId) || (l.acao === 'ignorar' && l.motivo.trim().length < 5));
  const conta = () => { const c = { ja: 0, lancar: 0, conciliar: 0, ignorar: 0, pend: 0 }; E.linhas.forEach(l => { if (l.ja) c.ja++; else { if (l.acao) c[l.acao]++; if (pendente(l)) c.pend++; } }); return c; };

  /* ---------------- passo 2: revisão ---------------- */
  function cartao(l, i) {
    const m = l.m, pos = m.valor_centavos > 0, cabeca = '<div style="display:flex;justify-content:space-between;gap:8px"><div><b>' + esc(m.memo) + '</b><div class="rowmeta">' + H.fmtData(m.data) + '</div></div><div class="amount ' + (pos ? 'positive' : 'negative') + '"><b>' + (pos ? '+' : '−') + ' ' + reais(Math.abs(m.valor_centavos)) + '</b></div></div>';
    if (l.ja) return '<div class="card" style="margin-bottom:8px;opacity:.55">' + cabeca + '<div class="rowmeta">Já importado antes — será ignorado.</div></div>';
    const cats = H.CATEGORIAS.includes(l.categoria) || !l.categoria ? H.CATEGORIAS : [l.categoria].concat(H.CATEGORIAS);
    let corpo = '<label>O que fazer<select class="field" data-ex="acao" data-i="' + i + '"><option value=""' + (l.acao === '' ? ' selected' : '') + '>Escolha…</option><option value="lancar"' + (l.acao === 'lancar' ? ' selected' : '') + '>Lançar no livro-caixa</option><option value="conciliar"' + (l.acao === 'conciliar' ? ' selected' : '') + '>Já lancei: conciliar</option><option value="ignorar"' + (l.acao === 'ignorar' ? ' selected' : '') + '>Ignorar</option></select></label>';
    if (l.acao === 'lancar') corpo += '<label>Categoria<select class="field" data-ex="categoria" data-i="' + i + '"><option value="">Escolha…</option>' + cats.map(c => '<option' + (c === l.categoria ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></label>' +
      '<label>Descrição<input class="field" maxlength="120" data-ex="descricao" data-i="' + i + '" value="' + esc(l.descricao) + '"></label><label>Fornecedor (opcional)<input class="field" maxlength="120" data-ex="fornecedor" data-i="' + i + '" value="' + esc(l.fornecedor) + '"></label>' +
      '<label>Lembrar para os próximos extratos<select class="field" data-ex="lembrar" data-i="' + i + '"><option value="">Não</option><option value="memo"' + (l.lembrar === 'memo' ? ' selected' : '') + '>Para este texto do banco</option><option value="memo_valor"' + (l.lembrar === 'memo_valor' ? ' selected' : '') + '>Para este texto e este valor</option></select></label>';
    if (l.acao === 'conciliar') corpo += l.cands.length ? '<label>Lançamento existente<select class="field" data-ex="lancId" data-i="' + i + '"><option value="">Escolha…</option>' + l.cands.map(c => '<option value="' + esc(c.id) + '"' + (c.id === l.lancId ? ' selected' : '') + '>' + H.fmtData(String(c.data_lancamento).slice(0, 10)) + ' · ' + esc(c.descricao) + '</option>').join('') + '</select></label>' : '<p class="agerro" style="min-height:0">Não há lançamento com este valor para conciliar. Escolha “Lançar” ou “Ignorar”.</p>';
    if (l.acao === 'ignorar') corpo += '<label>Motivo (5 a 200 caracteres)<input class="field" maxlength="200" data-ex="motivo" data-i="' + i + '" value="' + esc(l.motivo) + '"></label>';
    return '<div class="card" style="margin-bottom:8px;' + (pendente(l) ? 'border-color:var(--amber, #b26a00)' : '') + '">' + cabeca + '<div class="formgrid" style="margin-top:8px">' + corpo + '</div></div>';
  }
  function resumoHtml() {
    const p = E.parsed, c = conta(), ini = E.ctx.saldoIniLivro, ext = p.saldo_inicial_implicito_centavos;
    const bate = ini !== null && ext !== null && ini === ext;
    return '<div class="card" style="margin-bottom:10px"><b>' + esc(E.nome) + '</b><div class="rowmeta">Período ' + H.fmtData(p.periodo_ini) + ' a ' + H.fmtData(p.periodo_fim) + ' · ' + p.movimentos.length + ' movimentos · entradas ' + reais(p.entradas_centavos) + ' · saídas ' + reais(p.saidas_centavos) + '</div>' +
      '<div class="rowmeta">' + (p.saldo_final_centavos !== null ? 'Saldo final do extrato: ' + reais(p.saldo_final_centavos) + ' em ' + H.fmtData(p.saldo_data) + '. ' : 'O arquivo não traz o saldo final. ') +
      (ini !== null && ext !== null ? (bate ? '✔ O saldo do livro-caixa no início do período (' + reais(ini) + ') confere com o do extrato.' : '⚠ No início do período o livro-caixa tem ' + reais(ini) + ' e o extrato indica ' + reais(ext) + '.') : '') + '</div></div>' +
      '<p id="ex-contagem" class="smallnote" style="margin-top:0">' + c.lancar + ' a lançar · ' + c.conciliar + ' a conciliar · ' + c.ignorar + ' a ignorar · ' + c.ja + ' já importados · <b>' + c.pend + ' pendentes</b></p>';
  }
  function desenha() {
    $('ex-corpo').innerHTML = resumoHtml() + '<div id="ex-lista">' + E.linhas.map(cartao).join('') + '</div>' +
      '<div id="ex-forcar" class="hide"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="ex-forcar-cb"> Importar mesmo com a diferença de saldo (ela ficará registrada)</label></div>' +
      '<p id="ex-erro" class="agerro" role="alert"></p><div class="full"><button class="btn" id="ex-ok">Importar movimentos</button></div>';
    atualizaBotao();
    $('ex-lista').onchange = ev => editar(ev, true); $('ex-lista').oninput = ev => editar(ev, false);
    $('ex-ok').onclick = enviar;
    $('ex-forcar-cb').onchange = () => { E.forcar = $('ex-forcar-cb').checked; };
  }
  function atualizaBotao() { const c = conta(); $('ex-contagem').innerHTML = c.lancar + ' a lançar · ' + c.conciliar + ' a conciliar · ' + c.ignorar + ' a ignorar · ' + c.ja + ' já importados · <b>' + c.pend + ' pendentes</b>'; $('ex-ok').disabled = c.pend > 0 || (c.lancar + c.conciliar + c.ignorar) === 0; }
  function editar(ev, redesenha) {
    const el = ev.target, k = el.dataset.ex, i = Number(el.dataset.i); if (!k) return;
    const l = E.linhas[i]; l[k] = el.value;
    if (k === 'acao') { if (l.acao === 'conciliar' && !l.lancId && l.cands.length === 1) l.lancId = l.cands[0].id; if (l.acao === 'lancar' && !l.categoria) { const r = regraPara(l.m, E.ctx); if (r) Object.assign(l, r); } }
    if (redesenha && (k === 'acao')) { const y = $('ex-lista').scrollTop; $('ex-lista').innerHTML = E.linhas.map(cartao).join(''); $('ex-lista').scrollTop = y; } else if (k === 'categoria' || k === 'lancId') { el.closest('.card').style.borderColor = pendente(l) ? 'var(--amber, #b26a00)' : ''; }
    atualizaBotao();
  }

  /* ---------------- passo 3: importar ---------------- */
  async function enviar() {
    const p = E.parsed, erro = $('ex-erro'); erro.textContent = '';
    if (conta().pend > 0) return (erro.textContent = 'Resolva os movimentos pendentes antes de importar.');
    const linhas = E.linhas.map(l => ({ data: l.m.data, valor_centavos: l.m.valor_centavos, memo: l.m.memo, fitid: l.m.fitid || null,
      acao: l.ja ? 'ignorar' : l.acao, categoria: l.categoria, descricao: l.descricao.trim(), fornecedor: l.fornecedor.trim() || null,
      lancamento_id: l.acao === 'conciliar' ? l.lancId : null, motivo: l.ja ? 'já importado' : l.motivo.trim(), lembrar: l.acao === 'lancar' && l.lembrar ? l.lembrar : null }));
    await H.ocupado($('ex-ok'), async () => {
      const r = await APP.sb.rpc('importar_extrato', { p_arquivo_nome: E.nome.slice(0, 200), p_sha256: E.sha, p_periodo_ini: p.periodo_ini, p_periodo_fim: p.periodo_fim,
        p_saldo_final_centavos: p.saldo_final_centavos, p_saldo_data: p.saldo_data, p_linhas: linhas, p_exigir_saldo: !E.forcar });
      if (r.error) { erro.textContent = H.msg(r.error); if (/Nada foi importado/.test(r.error.message || '')) $('ex-forcar').classList.remove('hide'); return; }
      const d = r.data || {};
      H.modal('<div class="cardhead"><h2>Importação concluída</h2></div><p>' + Number(d.lancadas) + ' lançados · ' + Number(d.conciliadas) + ' conciliados · ' + Number(d.ignoradas) + ' ignorados · ' + Number(d.ja_importadas) + ' já importados antes.</p>' +
        (d.diferenca_saldo_centavos === null || d.diferenca_saldo_centavos === undefined ? '' : Number(d.diferenca_saldo_centavos) === 0 ? '<p>✔ O saldo do livro-caixa em ' + H.fmtData(p.saldo_data) + ' (' + reais(d.saldo_livro_centavos) + ') é igual ao do extrato.</p>' : '<p class="agerro" style="min-height:0">⚠ Diferença de ' + reais(d.diferenca_saldo_centavos) + ' entre o extrato e o livro-caixa em ' + H.fmtData(p.saldo_data) + '. Revise os lançamentos.</p>') +
        '<div class="full"><button class="btn" id="ex-fim">Concluir</button></div>');
      $('ex-fim').onclick = () => { H.fechar(); H.setMes(p.periodo_fim.slice(0, 7)); H.recarregar(); };
    });
  }

  /* ---------------- extratos já importados (síndico e conselho) ---------------- */
  async function listar() {
    const q = await APP.sb.from('extratos_importados').select('id,arquivo_nome,periodo_ini,periodo_fim,saldo_final_centavos,diferenca_saldo_centavos,qtd_movimentos,qtd_lancadas,qtd_conciliadas,qtd_ignoradas,qtd_ja_importadas,importado_em').order('importado_em', { ascending: false }).limit(36);
    const L = q.error ? [] : (q.data || []);
    H.modal('<div class="cardhead"><h2>Extratos importados</h2><button class="linkbtn" id="ex-x">Fechar ×</button></div>' + (q.error ? '<p class="agerro">' + esc(H.msg(q.error)) + '</p>' : '') +
      (L.length ? L.map(e => '<div class="card" style="margin-bottom:8px"><b>' + esc(e.arquivo_nome) + '</b><div class="rowmeta">' + H.fmtData(e.periodo_ini) + ' a ' + H.fmtData(e.periodo_fim) + ' · importado em ' + H.fmtData(String(e.importado_em).slice(0, 10)) + '</div><div class="rowmeta">' + e.qtd_movimentos + ' movimentos: ' + e.qtd_lancadas + ' lançados, ' + e.qtd_conciliadas + ' conciliados, ' + e.qtd_ignoradas + ' ignorados, ' + e.qtd_ja_importadas + ' já importados' + (e.saldo_final_centavos !== null ? ' · saldo final ' + reais(e.saldo_final_centavos) : '') + (e.diferenca_saldo_centavos ? ' · <b>diferença ' + reais(e.diferenca_saldo_centavos) + '</b>' : '') + '</div><button class="linkbtn" data-ex-ver="' + esc(e.id) + '">Ver movimentos</button></div>').join('') : '<div class="empty">Nenhum extrato importado ainda.</div>'));
    $('ex-x').onclick = H.fechar;
    document.querySelectorAll('[data-ex-ver]').forEach(b => { b.onclick = () => verMovimentos(L.find(e => e.id === b.dataset.exVer)); });
  }
  async function verMovimentos(e) {
    const q = await APP.sb.from('extrato_linhas').select('ordem,data_mov,valor_centavos,memo,status,lancamento_id,motivo_ignorar').eq('extrato_id', e.id).order('ordem', { ascending: true });
    const L = q.error ? [] : (q.data || []), ids = [...new Set(L.map(x => x.lancamento_id).filter(Boolean))], desc = {};
    for (let i = 0; i < ids.length; i += 50) { const r = await APP.sb.from('lancamentos').select('id,descricao,categoria').in('id', ids.slice(i, i + 50)); (r.data || []).forEach(x => { desc[x.id] = x; }); }
    const ST = { lancada: 'Lançado', conciliada: 'Conciliado', ignorada: 'Ignorado' };
    H.modal('<div class="cardhead"><h2>Movimentos do extrato</h2><button class="linkbtn" id="ex-x">Fechar ×</button></div><p class="smallnote" style="margin-top:0"><b>' + esc(e.arquivo_nome) + '</b></p>' + (q.error ? '<p class="agerro">' + esc(H.msg(q.error)) + '</p>' : '') +
      '<div class="tablewrap"><table><thead><tr><th>Data</th><th>Descrição do banco</th><th class="amount">Valor</th><th>Situação</th></tr></thead><tbody>' + L.map(x => '<tr><td>' + H.fmtData(x.data_mov) + '</td><td>' + esc(x.memo) + (x.lancamento_id && desc[x.lancamento_id] ? '<div class="rowmeta">→ ' + esc(desc[x.lancamento_id].descricao) + ' (' + esc(desc[x.lancamento_id].categoria) + ')</div>' : '') + (x.motivo_ignorar ? '<div class="rowmeta">Motivo: ' + esc(x.motivo_ignorar) + '</div>' : '') + '</td><td class="amount ' + (x.valor_centavos > 0 ? 'positive' : 'negative') + '">' + (x.valor_centavos > 0 ? '+' : '−') + ' ' + reais(Math.abs(x.valor_centavos)) + '</td><td>' + ST[x.status] + '</td></tr>').join('') + '</tbody></table></div>');
    $('ex-x').onclick = H.fechar;
  }
  window.ExtratoUI = { importar, listar };
})();
