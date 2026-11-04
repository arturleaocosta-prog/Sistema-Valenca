/* Cobrança mensal — cálculo, conferência, CSV e demonstrativo (sem DOM; usado pelo app e por testes).
   Regras espelham a função SQL gerar_cobranca_mensal (migração 20261021_004):
   cota condominial + fundo de obras iguais por unidade; água rateada pela fração ideal CADASTRADA (maior resto,
   fechando exatamente na fatura); gás, parcelas e compensações vêm da previsão do mês. Valores em centavos inteiros. */
(function (root) {
  'use strict';
  const C = v => Math.round(Number(v || 0) * 100);
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brlc = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const num2 = c => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const mmYYYY = id => id.slice(5, 7) + '/' + id.slice(0, 4);
  const fdate = iso => (iso ? iso.split('-').reverse().join('/') : '');
  const f7 = f => Math.round(f * 1e7);
  const fracTxt = f => f.toFixed(7).replace('.', ',');
  const validISO = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s + 'T12:00:00Z')) && new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s;

  // Água: piso em centavos + 1 centavo para os maiores restos (empate: identificação da unidade).
  function ratear(faturaC, unidades) {
    const rows = unidades.map(u => { const n = faturaC * u.f7; return { id: u.id, base: Math.floor(n / 1e7), resto: n % 1e7 }; });
    let falta = faturaC - rows.reduce((s, r) => s + r.base, 0);
    rows.slice().sort((a, b) => b.resto - a.resto || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).forEach(r => { if (falta > 0) { r.base += 1; falta -= 1; } });
    return Object.fromEntries(rows.map(r => [r.id, r.base]));
  }

  function build(FIN, monthId, opts) {
    opts = opts || {};
    const idx = FIN.meses.findIndex(x => x.id === monthId);
    if (idx < 0) throw new Error('Mês inexistente: ' + monthId);
    const m = FIN.meses[idx], p = m.previsao, prev = idx > 0 ? FIN.meses[idx - 1] : null;
    const venc = opts.vencimento || '';
    const unidades = FIN.unidades.map(u => ({ id: u.id, fracao: u.fracao_ideal, f7: f7(u.fracao_ideal), ant: u.fracao_anterior }));
    const faturaC = C(p.agua.fatura);
    const aguaRateio = ratear(faturaC, unidades);
    const gasDet = Object.fromEntries((p.gas.itens || []).map(i => [i.unidade, i]));
    const plan = Object.fromEntries(p.cobranca.map(c => [c.unidade, c]));
    const rows = unidades.map(u => {
      const pl = plan[u.id] || {}, itens = [];
      if (C(p.taxa_por_unidade) > 0) itens.push({ tipo: 'cota_condominial', descricao: 'Cota condominial ' + mmYYYY(monthId), centavos: C(p.taxa_por_unidade) });
      if (C(p.fundo_obras_por_unidade) > 0) itens.push({ tipo: 'fundo_obras', descricao: 'Fundo de obras ' + mmYYYY(monthId), centavos: C(p.fundo_obras_por_unidade) });
      if (aguaRateio[u.id] !== 0) itens.push({ tipo: 'agua', descricao: 'Água (rateio pela fração ideal ' + fracTxt(u.fracao) + ')', centavos: aguaRateio[u.id], detalhe: 'Fatura de ' + brlc(faturaC) + (p.agua.competencia ? ' · consumo ' + p.agua.competencia : '') });
      const g = gasDet[u.id];
      if (C(pl.gas) > 0) itens.push({ tipo: 'gas', descricao: 'Gás' + (g ? ' ' + String(g.consumo_m3).replace('.', ',') + ' m³' : ''), centavos: C(pl.gas), detalhe: g ? 'Leitura ' + String(g.leitura_anterior).replace('.', ',') + ' → ' + String(g.leitura_atual).replace('.', ',') + ' · ' + brlc(C(p.gas.preco_m3)) + '/m³' : '' });
      if (C(pl.parceladas) > 0) itens.push({ tipo: 'parcelada', descricao: 'Despesas parceladas', centavos: C(pl.parceladas) });
      if (C(pl.compensacao) !== 0) itens.push({ tipo: 'compensacao', descricao: 'Compensação', centavos: C(pl.compensacao) });
      const total = itens.reduce((s, i) => s + i.centavos, 0);
      return { unidade: u.id, fracao: u.fracao, itens, total, planilha: pl.total != null ? C(pl.total) : null };
    });

    // ---- Conferência (mesma lógica de validar_cobranca_mensal + comparações com a planilha) ----
    const checks = [];
    const somaF = unidades.reduce((s, u) => s + u.f7, 0);
    checks.push(somaF === 1e7 ? { nivel: 'ok', codigo: 'fracoes', msg: 'Frações ideais somam 1,0000000.' } : { nivel: 'erro', codigo: 'fracoes', msg: 'As frações ideais somam ' + (somaF / 1e7).toFixed(7).replace('.', ',') + ' (deve ser 1,0000000).' });
    const somaAgua = Object.values(aguaRateio).reduce((s, v) => s + v, 0);
    checks.push(somaAgua === faturaC ? { nivel: 'ok', codigo: 'agua', msg: 'Água rateada fecha exatamente na fatura (' + brlc(faturaC) + ').' } : { nivel: 'erro', codigo: 'agua', msg: 'Água rateada (' + brlc(somaAgua) + ') difere da fatura.' });
    const neg = rows.filter(r => r.total <= 0);
    checks.push(neg.length ? { nivel: 'erro', codigo: 'total', msg: 'Unidade(s) com total não positivo: ' + neg.map(r => r.unidade).join(', ') + '.' } : { nivel: 'ok', codigo: 'total', msg: 'Todas as unidades com valor a cobrar positivo.' });
    if (!venc) checks.push({ nivel: 'erro', codigo: 'vencimento', msg: 'Informe o vencimento do boleto (as planilhas não trazem essa data).' });
    else if (!validISO(venc)) checks.push({ nivel: 'erro', codigo: 'vencimento', msg: 'Vencimento inválido.' });
    else if (venc < monthId + '-01') checks.push({ nivel: 'aviso', codigo: 'vencimento_anterior', msg: 'Vencimento anterior ao mês de competência.' });
    else checks.push({ nivel: 'ok', codigo: 'vencimento', msg: 'Vencimento: ' + fdate(venc) + '.' });
    const dif = rows.filter(r => r.planilha != null && Math.abs(r.total - r.planilha) > 2);
    if (dif.length) {
      const maxd = Math.max.apply(null, dif.map(r => Math.abs(r.total - r.planilha)));
      const antigas = (p.agua.itens || []).filter(i => { const u = unidades.find(x => x.id === i.unidade); return u && Math.abs(i.fracao_ideal - u.fracao) > 1e-9; }).length;
      checks.push({ nivel: 'aviso', codigo: 'planilha', msg: dif.length + ' unidade(s) diferem da planilha (maior diferença ' + brlc(maxd) + ')' + (antigas ? ': a planilha rateia a água com fração anterior em ' + antigas + ' unidade(s); o sistema usa a fração cadastrada.' : '.') });
    } else checks.push({ nivel: 'ok', codigo: 'planilha', msg: 'Totais conferem com a planilha (tolerância de 2 centavos).' });
    if (prev) {
      const pp = Object.fromEntries(prev.previsao.cobranca.map(c => [c.unidade, c]));
      const iguais = p.cobranca.length > 0 && p.cobranca.every(c => pp[c.unidade] && ['taxa', 'fundo_obras', 'agua', 'gas', 'parceladas', 'compensacao', 'total'].every(k => pp[c.unidade][k] === c[k]));
      if (iguais) checks.push({ nivel: 'aviso', codigo: 'repetido', msg: 'Os valores deste mês são idênticos aos de ' + prev.rotulo + ' (inclusive gás e água). Confirme se a planilha do mês foi atualizada antes de liberar.' });
    }
    const totalC = rows.reduce((s, r) => s + r.total, 0);
    if (p.total_previsto != null && Math.abs(totalC - C(p.total_previsto)) > 5) checks.push({ nivel: 'aviso', codigo: 'total_previsto', msg: 'Total gerado (' + brlc(totalC) + ') difere do total previsto na planilha (' + brlc(C(p.total_previsto)) + ').' });
    return { mes: monthId, rotulo: m.rotulo, vencimento: venc, faturaAguaCentavos: faturaC, rows, totalCentavos: totalC, checks, temErro: checks.some(c => c.nivel === 'erro') };
  }

  const COLS = ['cota_condominial', 'fundo_obras', 'agua', 'gas', 'parcelada', 'compensacao'];
  const sumTipo = (row, t) => row.itens.filter(i => i.tipo === t).reduce((s, i) => s + i.centavos, 0);

  // CSV (separador ';', decimal com vírgula, UTF-8 com BOM) para conferir/emitir os boletos fora do app.
  function toCSV(res) {
    const head = ['competencia', 'unidade', 'vencimento', 'valor_total', 'cota_condominial', 'fundo_obras', 'agua', 'gas', 'parcelada', 'compensacao'];
    const lines = [head.join(';')].concat(res.rows.map(r => [mmYYYY(res.mes), r.unidade, fdate(res.vencimento), num2(r.total)].concat(COLS.map(t => num2(sumTipo(r, t)))).join(';')));
    lines.push(['', 'TOTAL', '', num2(res.totalCentavos)].concat(COLS.map(t => num2(res.rows.reduce((s, r) => s + sumTipo(r, t), 0)))).join(';'));
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  // Demonstrativo da unidade (HTML). Não é boleto bancário.
  function statementHTML(res, row, nomeCondominio) {
    return '<section class="demo"><h2>' + E(nomeCondominio || 'Condomínio') + '</h2><h3>Demonstrativo de cobrança · ' + E(mmYYYY(res.mes)) + '</h3>' +
      '<p><strong>Unidade ' + E(row.unidade) + '</strong> · Vencimento ' + E(fdate(res.vencimento) || '—') + '</p>' +
      '<table><thead><tr><th>Descrição</th><th class="amount">Valor</th></tr></thead><tbody>' +
      row.itens.map(i => '<tr><td>' + E(i.descricao) + (i.detalhe ? '<br><small>' + E(i.detalhe) + '</small>' : '') + '</td><td class="amount">' + E(brlc(i.centavos)) + '</td></tr>').join('') +
      '</tbody><tfoot><tr><td><strong>Total a pagar</strong></td><td class="amount"><strong>' + E(brlc(row.total)) + '</strong></td></tr></tfoot></table>' +
      '<p class="demonote">Este demonstrativo não é boleto bancário. O boleto é emitido pela CAIXA; confira o valor e o vencimento acima antes de pagar.</p></section>';
  }

  const api = { build, ratear, toCSV, statementHTML, brlc, mmYYYY, fdate, validISO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.COB = api;
})(typeof window !== 'undefined' ? window : globalThis);
