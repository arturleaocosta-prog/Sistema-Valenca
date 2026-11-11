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
  const COLS = 'id,tipo,data_lancamento,valor_centavos,categoria,descricao,fornecedor,numero_documento,observacao,lancamento_original_id,estornado_em,motivo_estorno,criado_em,versao,editado_em';

  const CX = APP.cx = { visivel: null, uid: null, ociosoMs: 120000, timer: null, mes: hojeBR().slice(0, 7), ok: false, carregando: false, erro: '', seq: 0, rows: [], tipoOrig: {}, anexos: {}, aviso: '', resumo: null, rel: null, filtro: 'todos', busca: '' };
  const detalhe = () => role === 'sindico' || role === 'conselho';
  /* Privacidade: morador e conselho abrem o Financeiro com os valores OCULTOS (nem são pedidos ao banco).
     Voltam a ocultar ao sair da tela, ao minimizar o app e após 2 minutos sem uso. O síndico vê direto e pode ocultar. */
  const vis = () => CX.visivel === null ? role === 'sindico' : CX.visivel;
  function limpa() { CX.seq++; Object.assign(CX, { ok: false, carregando: false, erro: '', rows: [], tipoOrig: {}, anexos: {}, aviso: '', resumo: null, rel: null, busca: '', filtro: 'todos' }); }
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
      const anexos = {};
      const idsAnx = rows.filter(r => r.tipo !== 'estorno').map(r => r.id);
      for (let i = 0; i < idsAnx.length; i += 50) {
        const an = await APP.sb.from('comprovantes_financeiros').select('id,lancamento_id,removido_em').in('lancamento_id', idsAnx.slice(i, i + 50)); if (an.error) throw an.error;
        (an.data || []).filter(a => !a.removido_em).forEach(a => { anexos[a.lancamento_id] = (anexos[a.lancamento_id] || 0) + 1; });
      }
      if (seq !== CX.seq) return;                       // o usuário trocou de mês durante a carga
      Object.assign(CX, { resumo, rel, rows, tipoOrig, anexos, ok: true, carregando: false });
    } catch (e) {
      if (seq !== CX.seq) return;
      Object.assign(CX, { erro: msg(e), ok: true, carregando: false, rows: [], anexos: {}, rel: null, resumo: null });
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
    return '<div class="tablewrap"><table><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th class="amount">Valor</th><th>Anexos</th>' + (adm ? '<th>Ação</th>' : '') + '</tr></thead><tbody>' +
      lista.map(r => {
        const s = sinal(r), est = r.tipo === 'estorno';
        const pill = est ? '<span class="pill amber">Estorno</span>' : '<span class="pill ' + (r.tipo === 'receita' ? 'green' : 'red') + '">' + (r.tipo === 'receita' ? 'Receita' : 'Despesa') + '</span>';
        const meta = (r.numero_documento ? '<div class="rowmeta">Documento: ' + esc(r.numero_documento) + '</div>' : '') +
          (est && r.observacao ? '<div class="rowmeta">Motivo: ' + esc(r.observacao) + '</div>' : '') +
          (Number(r.versao) > 1 ? '<div class="rowmeta">✎ editado em ' + fmtData(String(r.editado_em).slice(0, 10)) + ' (versão ' + Number(r.versao) + ') · <button class="linkbtn" data-cx-hist="' + esc(r.id) + '">ver histórico</button></div>' : '') +
          (r.estornado_em ? '<div class="rowmeta">Estornado em ' + fmtData(String(r.estornado_em).slice(0, 10)) + ': ' + esc(r.motivo_estorno) + '</div>' : '');
        const nA = CX.anexos[r.id] || 0;
        const anx = est ? '<td>—</td>' : (nA || adm) ? '<td><button class="linkbtn" data-cx-anx="' + esc(r.id) + '">📎 ' + (nA || (adm ? 'Anexar' : '')) + '</button></td>' : '<td>—</td>';
        const acao = adm ? '<td>' + (!est && !r.estornado_em ? '<button class="linkbtn" data-cx-edit="' + esc(r.id) + '">Editar</button> <button class="linkbtn" data-cx-est="' + esc(r.id) + '">Estornar</button>' : '') + '</td>' : '';
        return '<tr' + (r.estornado_em ? ' style="opacity:.6"' : '') + '><td>' + fmtData(r.data_lancamento) + '</td><td><strong>' + esc(r.descricao) + '</strong>' + meta + '</td><td>' + esc(r.categoria) + '</td><td>' + pill + '</td>' +
          '<td class="amount ' + (s > 0 ? 'positive' : 'negative') + '">' + (s > 0 ? '+' : '−') + ' ' + reais(r.valor_centavos) + '</td>' + anx + acao + '</tr>';
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
    const acoes = adm ? '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="cx-novo">＋ Novo lançamento</button><button class="btn secondary" id="cx-print">Imprimir relatório</button><button class="btn secondary" id="cx-ofx">Importar extrato (OFX)</button></div>' : '';
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
    const avisoHtml = CX.aviso ? '<div class="card" style="margin-bottom:18px"><p class="agerro" style="min-height:0;margin:0 0 8px" role="alert">⚠ ' + esc(CX.aviso) + '</p><button class="linkbtn" id="cx-aviso-x">Dispensar</button></div>' : '';
    return head('Financeiro', sub, acoes) + avisoHtml +
      '<div class="card" style="margin-bottom:18px"><div class="toolbar"><label style="font-size:13px;color:var(--muted)">Mês<input class="field" id="cx-mes" type="month" value="' + esc(CX.mes) + '" max="' + hojeBR().slice(0, 7) + '"></label>' + (detalhe() ? '<button class="linkbtn" id="cx-extratos">Extratos importados</button>' : '') + '<button class="linkbtn" id="cx-ocultar">🔒 Ocultar valores</button></div></div>' + corpo;
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
      '<label class="full">Descrição<input class="field" id="cx-fx" maxlength="120" required></label>' +
      '<label class="full">Fornecedor (opcional)<input class="field" id="cx-ff" maxlength="120"></label>' +
      '<label>Categoria<select class="field" id="cx-fc">' + CATEGORIAS.map(c => '<option>' + esc(c) + '</option>').join('') + '</select></label>' +
      '<label>Valor (R$)<input class="field" id="cx-fv" inputmode="decimal" placeholder="0,00" required></label>' +
      '<label>Número do documento (opcional)<input class="field" id="cx-fn" maxlength="60"></label>' +
      '<label class="full">Observação (opcional)<input class="field" id="cx-fo" maxlength="300"></label>' +
      '<label class="full">Nota fiscal ou documento (opcional)<input class="field" type="file" id="cx-fa" multiple accept="application/pdf,image/jpeg,image/png,image/webp"></label>' +
      '<p class="smallnote full" id="cx-fa-info">PDF, JPG, PNG ou WEBP, até 10 MB cada, no máximo 8 arquivos. No celular você pode tirar a foto na hora.</p>' +
      '<p id="cx-erro" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="cx-ok">Salvar lançamento</button></div></form>');
    $('cx-x').onclick = fechar;
    $('cx-fa').onchange = () => { const fs = [...($('cx-fa').files || [])]; $('cx-fa-info').textContent = fs.length ? fs.length + ' arquivo(s): ' + fs.map(f => f.name + ' (' + tamanho(f.size) + ')').join(', ') : 'PDF, JPG, PNG ou WEBP, até 10 MB cada, no máximo 8 arquivos. No celular você pode tirar a foto na hora.'; };
    $('cx-f').onsubmit = async ev => {
      ev.preventDefault();
      const erro = m => { $('cx-erro').textContent = m; };
      const c = parseCentavos($('cx-fv').value);
      if (!c || c <= 0) return erro('Informe um valor válido maior que zero, por exemplo 1.234,56.');
      if ($('cx-fx').value.trim() === '') return erro('Informe a descrição.');
      const dataLanc = $('cx-fd').value;           // lida antes de fechar o formulário
      const arquivos = [...($('cx-fa').files || [])];
      const eA = validaArquivos(arquivos, 0); if (eA) return erro(eA);   // valida ANTES de gravar o lançamento
      await ocupado($('cx-ok'), async () => {
        const r = await APP.sb.rpc('registrar_lancamento', {
          p_tipo: $('cx-ft').value, p_data: dataLanc, p_valor_centavos: c, p_categoria: $('cx-fc').value, p_descricao: $('cx-fx').value.trim(),
          p_fornecedor: $('cx-ff').value.trim() || null, p_numero_documento: $('cx-fn').value.trim() || null, p_observacao: $('cx-fo').value.trim() || null, p_competencia: null
        });
        if (r.error) return erro(msg(r.error));
        const falhas = [];
        for (let i = 0; i < arquivos.length; i++) {
          $('cx-ok').textContent = 'Enviando anexo ' + (i + 1) + ' de ' + arquivos.length + '…';
          try { await anexa(r.data, arquivos[i]); } catch (e) { falhas.push(arquivos[i].name + ': ' + msg(e)); }
        }
        CX.aviso = falhas.length ? 'Lançamento salvo, mas ' + falhas.length + ' anexo(s) não foram enviados (' + falhas.join('; ') + '). Use o botão 📎 da linha para anexar de novo.' : '';
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

  /* ---------------- anexos (nota fiscal e documentos) ---------------- */
  const MIMES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const EXT2MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const MAX_BYTES = 10485760, MAX_ANEXOS = 8;
  const tamanho = b => b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  function mimeDe(f) { if (MIMES[f.type]) return f.type; return EXT2MIME[(String(f.name).split('.').pop() || '').toLowerCase()] || null; }
  function validaArquivos(fs, jaTem) {
    if (jaTem + fs.length > MAX_ANEXOS) return 'Cada lançamento aceita no máximo ' + MAX_ANEXOS + ' anexos.';
    for (const f of fs) {
      if (!mimeDe(f)) return '“' + f.name + '”: formato não aceito. Use PDF, JPG, PNG ou WEBP.';
      if (f.size < 1) return '“' + f.name + '” está vazio.';
      if (f.size > MAX_BYTES) return '“' + f.name + '” tem ' + tamanho(f.size) + ': o limite é 10 MB.';
    }
    return '';
  }
  const bytesDe = f => f.arrayBuffer ? f.arrayBuffer() : new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => ko(r.error); r.readAsArrayBuffer(f); });
  async function sha256(f) { const h = await crypto.subtle.digest('SHA-256', await bytesDe(f)); return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join(''); }
  async function anexa(lancId, file) {
    const mime = mimeDe(file), eV = validaArquivos([file], 0); if (eV) throw new Error(eV);
    const sha = await sha256(file);
    const caminho = APP.perfil.condominio_id + '/' + lancId + '/' + crypto.randomUUID() + '.' + MIMES[mime];
    const up = await APP.sb.storage.from('comprovantes').upload(caminho, file, { contentType: mime, upsert: false }); if (up.error) throw up.error;
    const nome = String(file.name).length > 120 ? String(file.name).slice(-120) : String(file.name);
    const r = await APP.sb.rpc('registrar_comprovante', { p_lancamento_id: lancId, p_caminho: caminho, p_nome: nome, p_mime: mime, p_tamanho: file.size, p_sha256: sha }); if (r.error) throw r.error;
  }
  async function abrirArquivo(c, msgEl) {
    const jan = window.open('about:blank', '_blank');                // abre antes do await para o celular não bloquear
    const r = await APP.sb.storage.from('comprovantes').createSignedUrl(c.caminho_storage, 60);
    if (r.error || !r.data) { if (jan && jan.close) jan.close(); msgEl.textContent = msg(r.error || 'Não foi possível abrir o arquivo.'); return; }
    if (jan) { try { jan.opener = null; } catch (e) { /* ignora */ } jan.location.href = r.data.signedUrl; }
    msgEl.innerHTML = 'Se o arquivo não abriu, <a href="' + esc(r.data.signedUrl) + '" target="_blank" rel="noopener">toque aqui</a> (o link vale por 1 minuto).';
  }
  async function modalAnexos(lancId) {
    const l = CX.rows.find(r => r.id === lancId); if (!l) return;
    const adm = role === 'sindico';
    async function desenha() {
      const q = await APP.sb.from('comprovantes_financeiros').select('id,nome_arquivo,mime_type,tamanho_bytes,sha256,created_at,removido_em,caminho_storage').eq('lancamento_id', lancId).order('created_at', { ascending: true });
      const lista = q.error ? [] : (q.data || []).filter(a => !a.removido_em);
      CX.anexos[lancId] = lista.length; if (page === 'financeiro') render();
      modal('<div class="cardhead"><h2>Anexos</h2><button class="linkbtn" id="cx-x">Fechar ×</button></div><p class="smallnote" style="margin-top:0"><b>' + esc(l.descricao) + '</b> · ' + reais(l.valor_centavos) + ' · ' + fmtData(l.data_lancamento) + '</p>' +
        (q.error ? '<p class="agerro">' + esc(msg(q.error)) + '</p>' : '') +
        (lista.length ? '<div class="tablewrap"><table><thead><tr><th>Arquivo</th><th></th></tr></thead><tbody>' + lista.map(a => '<tr><td><strong>' + esc(a.nome_arquivo) + '</strong><div class="rowmeta">' + tamanho(a.tamanho_bytes) + ' · enviado em ' + fmtData(String(a.created_at).slice(0, 10)) + '<br>Impressão digital: ' + esc(String(a.sha256).slice(0, 12)) + '…</div></td><td><button class="linkbtn" data-cx-abrir="' + esc(a.id) + '">Abrir</button>' + (adm ? ' <button class="linkbtn" data-cx-rem="' + esc(a.id) + '">Remover</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">Nenhum anexo neste lançamento.</div>') +
        (adm ? '<form id="cx-fanx" class="formgrid" style="margin-top:12px"><label class="full">Anexar nota fiscal ou documento<input class="field" type="file" id="cx-anx-f" multiple accept="application/pdf,image/jpeg,image/png,image/webp"></label><div class="full"><button class="btn" id="cx-anx-env">Enviar anexo(s)</button></div></form>' : '') +
        '<p id="cx-anx-msg" class="agerro" role="alert"></p>');
      const msgEl = $('cx-anx-msg');
      $('cx-x').onclick = fechar;
      document.querySelectorAll('[data-cx-abrir]').forEach(b => { b.onclick = () => abrirArquivo(lista.find(a => a.id === b.dataset.cxAbrir), msgEl); });
      document.querySelectorAll('[data-cx-rem]').forEach(b => { b.onclick = () => formRemover(lista.find(a => a.id === b.dataset.cxRem), desenha); });
      const fa = $('cx-fanx'); if (fa) fa.onsubmit = async ev => {
        ev.preventDefault();
        const fs = [...($('cx-anx-f').files || [])]; if (!fs.length) return (msgEl.textContent = 'Escolha pelo menos um arquivo.');
        const e = validaArquivos(fs, lista.length); if (e) return (msgEl.textContent = e);
        await ocupado($('cx-anx-env'), async () => {
          const falhas = [];
          for (let i = 0; i < fs.length; i++) { msgEl.textContent = 'Enviando ' + (i + 1) + ' de ' + fs.length + '…'; try { await anexa(lancId, fs[i]); } catch (er) { falhas.push(fs[i].name + ': ' + msg(er)); } }
          await desenha(); if (falhas.length) $('cx-anx-msg').textContent = 'Não foi possível enviar: ' + falhas.join('; ');
        });
      };
    }
    await desenha();
  }
  function formRemover(a, aposRemover) {
    modal('<div class="cardhead"><h2>Remover anexo</h2><button class="linkbtn" id="cx-x">Fechar ×</button></div><p class="smallnote" style="margin-top:0"><b>' + esc(a.nome_arquivo) + '</b><br>O anexo sai da lista, mas o arquivo e o motivo ficam guardados como evidência.</p>' +
      '<form id="cx-f" class="formgrid"><label class="full">Motivo (5 a 200 caracteres)<input class="field" id="cx-fm" maxlength="200" required></label><p id="cx-erro" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="cx-ok">Remover anexo</button></div></form>');
    $('cx-x').onclick = aposRemover;
    $('cx-f').onsubmit = async ev => {
      ev.preventDefault(); const motivo = $('cx-fm').value.trim();
      if (motivo.length < 5) return ($('cx-erro').textContent = 'Informe o motivo com pelo menos 5 caracteres.');
      await ocupado($('cx-ok'), async () => {
        const r = await APP.sb.rpc('remover_comprovante', { p_id: a.id, p_motivo: motivo }); if (r.error) return ($('cx-erro').textContent = msg(r.error));
        await aposRemover();
      });
    };
  }

  /* ---------------- edição e histórico ---------------- */
  const centParaCampo = c => String(Math.floor(Number(c) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + String(Number(c) % 100).padStart(2, '0');
  const mesAno = d => String(d).slice(5, 7) + '/' + String(d).slice(0, 4);
  function formEditar(id) {
    const l = CX.rows.find(r => r.id === id); if (!l) return;
    const hoje = hojeBR(), cats = CATEGORIAS.includes(l.categoria) ? CATEGORIAS : [l.categoria].concat(CATEGORIAS);
    modal('<div class="cardhead"><h2>Editar lançamento</h2><button class="linkbtn" id="cx-x">Fechar ×</button></div>' +
      '<p class="smallnote" style="margin-top:0">Tipo: <b>' + (l.tipo === 'receita' ? 'Receita' : 'Despesa') + '</b> (não muda por edição; para trocar o tipo, estorne e lance de novo). Toda edição exige motivo e fica registrada no histórico.</p>' +
      '<form id="cx-f" class="formgrid"><label>Data<input class="field" type="date" id="cx-fd" value="' + esc(String(l.data_lancamento).slice(0, 10)) + '" max="' + hoje + '" required></label>' +
      '<label>Valor (R$)<input class="field" id="cx-fv" inputmode="decimal" value="' + centParaCampo(l.valor_centavos) + '" required></label>' +
      '<label class="full">Descrição<input class="field" id="cx-fx" maxlength="120" value="' + esc(l.descricao) + '" required></label>' +
      '<label class="full">Fornecedor (opcional)<input class="field" id="cx-ff" maxlength="120" value="' + esc(l.fornecedor || '') + '"></label>' +
      '<label>Categoria<select class="field" id="cx-fc">' + cats.map(c => '<option' + (c === l.categoria ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></label>' +
      '<label>Número do documento (opcional)<input class="field" id="cx-fn" maxlength="60" value="' + esc(l.numero_documento || '') + '"></label>' +
      '<label class="full">Observação (opcional)<input class="field" id="cx-fo" maxlength="300" value="' + esc(l.observacao || '') + '"></label>' +
      '<label class="full">Motivo da edição (5 a 200 caracteres)<input class="field" id="cx-fm" maxlength="200" required></label>' +
      '<p id="cx-aviso-ed" class="smallnote full"></p>' +
      '<p id="cx-erro" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="cx-ok">Salvar edição</button></div></form>');
    $('cx-x').onclick = fechar;
    const aviso = () => {
      const c = parseCentavos($('cx-fv').value), d = $('cx-fd').value, meses = new Set();
      if (c !== null && c !== Number(l.valor_centavos)) meses.add(mesAno(l.data_lancamento));
      if (d && d !== String(l.data_lancamento).slice(0, 10)) { meses.add(mesAno(l.data_lancamento)); meses.add(mesAno(d)); }
      $('cx-aviso-ed').textContent = meses.size ? 'Atenção: esta edição altera o saldo de ' + [...meses].join(' e de ') + '. Relatórios já impressos ou enviados não mudam.' : '';
    };
    ['input', 'change'].forEach(ev => { $('cx-fv').addEventListener(ev, aviso); $('cx-fd').addEventListener(ev, aviso); });
    $('cx-f').onsubmit = async ev => {
      ev.preventDefault();
      const erro = m => { $('cx-erro').textContent = m; };
      const c = parseCentavos($('cx-fv').value);
      if (!c || c <= 0) return erro('Informe um valor válido maior que zero, por exemplo 1.234,56.');
      if ($('cx-fx').value.trim() === '') return erro('Informe a descrição.');
      const motivo = $('cx-fm').value.trim();
      if (motivo.length < 5) return erro('Informe o motivo da edição com pelo menos 5 caracteres.');
      const novo = { d: $('cx-fd').value, c, cat: $('cx-fc').value, x: $('cx-fx').value.trim(), f: $('cx-ff').value.trim() || null, n: $('cx-fn').value.trim() || null, o: $('cx-fo').value.trim() || null };
      if (novo.d === String(l.data_lancamento).slice(0, 10) && novo.c === Number(l.valor_centavos) && novo.cat === l.categoria && novo.x === l.descricao && novo.f === (l.fornecedor || null) && novo.n === (l.numero_documento || null) && novo.o === (l.observacao || null)) return erro('Nada foi alterado.');
      await ocupado($('cx-ok'), async () => {
        const r = await APP.sb.rpc('editar_lancamento', { p_id: id, p_data: novo.d, p_valor_centavos: novo.c, p_categoria: novo.cat, p_descricao: novo.x, p_fornecedor: novo.f, p_numero_documento: novo.n, p_observacao: novo.o, p_motivo: motivo });
        if (r.error) return erro(msg(r.error));
        fechar(); recarregar();
      });
    };
  }
  const ROTULOS = { data_lancamento: 'Data', valor_centavos: 'Valor', categoria: 'Categoria', descricao: 'Descrição', fornecedor: 'Fornecedor', numero_documento: 'Documento', observacao: 'Observação' };
  const fmtCampo = (k, v) => v === null || v === undefined || v === '' ? '(vazio)' : k === 'valor_centavos' ? reais(v) : k === 'data_lancamento' ? fmtData(v) : String(v);
  async function modalHistorico(id) {
    const l = CX.rows.find(r => r.id === id); if (!l) return;
    const q = await APP.sb.from('lancamentos_historico').select('versao,motivo,antes,depois,editado_em').eq('lancamento_id', id).order('versao', { ascending: false });
    const h = q.error ? [] : (q.data || []);
    modal('<div class="cardhead"><h2>Histórico de edições</h2><button class="linkbtn" id="cx-x">Fechar ×</button></div><p class="smallnote" style="margin-top:0"><b>' + esc(l.descricao) + '</b></p>' +
      (q.error ? '<p class="agerro">' + esc(msg(q.error)) + '</p>' : '') +
      (h.length ? h.map(e => '<div class="card" style="margin-bottom:10px"><b>Versão ' + Number(e.versao) + '</b> · ' + fmtData(String(e.editado_em).slice(0, 10)) + '<div class="rowmeta">Motivo: ' + esc(e.motivo) + '</div>' +
        Object.keys(e.depois || {}).map(k => '<div class="rowmeta">' + esc(ROTULOS[k] || k) + ': ' + esc(fmtCampo(k, (e.antes || {})[k])) + ' → <b>' + esc(fmtCampo(k, e.depois[k])) + '</b></div>').join('') + '</div>').join('') : '<div class="empty">Sem edições registradas.</div>'));
    $('cx-x').onclick = fechar;
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
      lista.map(r => '<tr><td style="border:1px solid #999;padding:4px 6px">' + fmtData(r.data_lancamento) + '</td><td style="border:1px solid #999;padding:4px 6px">' + (r.tipo === 'estorno' ? '[ESTORNO] ' : '') + esc(r.descricao) + (CX.anexos[r.id] ? ' [' + CX.anexos[r.id] + ' anexo(s)]' : '') + '</td><td style="border:1px solid #999;padding:4px 6px">' + esc(r.numero_documento || '') + '</td><td style="border:1px solid #999;padding:4px 6px">' + esc(r.categoria) + '</td><td style="border:1px solid #999;padding:4px 6px;text-align:right">' + (sinal(r) > 0 ? '+' : '−') + ' ' + reais(r.valor_centavos) + '</td></tr>').join('') + '</table></div>';
    bolPrintHTML([html]);
  }

  function bind() {
    const mo = $('cx-mostrar'); if (mo) mo.onclick = mostrar;
    const of = $('cx-ofx'); if (of) of.onclick = () => { if (window.ExtratoUI) window.ExtratoUI.importar(); };
    const ex = $('cx-extratos'); if (ex) ex.onclick = () => { if (window.ExtratoUI) window.ExtratoUI.listar(); };
    const oc = $('cx-ocultar'); if (oc) oc.onclick = () => ocultar(true);
    const mes = $('cx-mes'); if (mes) mes.onchange = () => { if (!/^\d{4}-\d{2}$/.test(mes.value)) return; CX.mes = mes.value; recarregar(); };
    const rt = $('cx-retry'); if (rt) rt.onclick = recarregar;
    const nv = $('cx-novo'); if (nv) nv.onclick = formNovo;
    const pr = $('cx-print'); if (pr) pr.onclick = imprimir;
    const bindEst = () => {
      document.querySelectorAll('[data-cx-est]').forEach(b => { b.onclick = () => formEstorno(b.dataset.cxEst); });
      document.querySelectorAll('[data-cx-edit]').forEach(b => { b.onclick = () => formEditar(b.dataset.cxEdit); });
      document.querySelectorAll('[data-cx-hist]').forEach(b => { b.onclick = () => modalHistorico(b.dataset.cxHist); });
      document.querySelectorAll('[data-cx-anx]').forEach(b => { b.onclick = () => modalAnexos(b.dataset.cxAnx); });
    };
    const ax = $('cx-aviso-x'); if (ax) ax.onclick = () => { CX.aviso = ''; render(); };
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
  window.CXH = { esc, reais, fmtData, CATEGORIAS, modal, fechar, ocupado, msg, hojeBR, setMes: m => { CX.mes = m; }, recarregar };
})();
