/* Boleto de TESTE — dígitos verificadores FEBRABAN, linha digitável, código de barras (ITF-25) e ficha em HTML.
   AMBIENTE DE TESTE: o campo livre NÃO segue o layout oficial da CAIXA (depende de convênio e manual) e nenhum
   boleto gerado aqui é registrado no banco nem pode ser pago. Sem dependências de DOM. */
(function (root) {
  'use strict';
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dig = s => String(s == null ? '' : s).replace(/\D/g, '');
  const pad = (s, n) => String(s).padStart(n, '0');
  const brl = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fdate = iso => (iso ? iso.split('-').reverse().join('/') : '');

  function mod10(s) { let sum = 0, w = 2; for (let i = s.length - 1; i >= 0; i--) { const p = (+s[i]) * w; sum += Math.floor(p / 10) + (p % 10); w = w === 2 ? 1 : 2; } return (10 - (sum % 10)) % 10; }
  function mod11(s) { let sum = 0, w = 2; for (let i = s.length - 1; i >= 0; i--) { sum += (+s[i]) * w; w = w === 9 ? 2 : w + 1; } const dv = 11 - (sum % 11); return (dv === 0 || dv === 10 || dv === 11) ? 1 : dv; }

  // Fator de vencimento: 1000 = 03/07/2000; volta a 1000 em 22/02/2025 (ciclo de 9000 dias).
  function fator(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); if (!m) throw new Error('Vencimento inválido');
    const d = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(2000, 6, 3)) / 864e5);
    if (d < 0) throw new Error('Vencimento anterior a 03/07/2000');
    return 1000 + (d % 9000);
  }

  function barcode(banco, moeda, vencimento, centavos, campoLivre) {
    if (!Number.isInteger(centavos) || centavos <= 0 || centavos > 9999999999) throw new Error('Valor fora do limite do boleto');
    if (dig(campoLivre).length !== 25) throw new Error('Campo livre deve ter 25 dígitos');
    const sem = banco + moeda + pad(fator(vencimento), 4) + pad(centavos, 10) + campoLivre;
    return sem.slice(0, 4) + mod11(sem) + sem.slice(4);
  }

  function linhaDigitavel(cb) {
    const cl = cb.slice(19), f1 = cb.slice(0, 4) + cl.slice(0, 5), f2 = cl.slice(5, 15), f3 = cl.slice(15, 25);
    const a = f1 + mod10(f1), b = f2 + mod10(f2), c = f3 + mod10(f3);
    return a.slice(0, 5) + '.' + a.slice(5) + ' ' + b.slice(0, 5) + '.' + b.slice(5) + ' ' + c.slice(0, 5) + '.' + c.slice(5) + ' ' + cb[4] + ' ' + cb.slice(5, 19);
  }
  function barrasDaLinha(linha) {
    const d = dig(linha); if (d.length !== 47) return null;
    return d.slice(0, 4) + d[32] + d.slice(33) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
  }

  const ITF = ['nnwwn', 'wnnnw', 'nwnnw', 'wwnnn', 'nnwnw', 'wnwnn', 'nwwnn', 'nnnww', 'wnnwn', 'nwnwn'];
  function itfSVG(digits, wide) {
    if (!/^\d+$/.test(digits) || digits.length % 2) throw new Error('ITF exige quantidade par de dígitos');
    const W = wide || 3, N = 1; let x = 0, bars = ''; const el = (isBar, w) => { if (isBar) bars += '<rect x="' + x + '" y="0" width="' + w + '" height="50"/>'; x += w; };
    'nnnn'.split('').forEach((c, i) => el(i % 2 === 0, N));
    for (let i = 0; i < digits.length; i += 2) { const a = ITF[+digits[i]], b = ITF[+digits[i + 1]]; for (let k = 0; k < 5; k++) { el(true, a[k] === 'w' ? W : N); el(false, b[k] === 'w' ? W : N); } }
    'wnn'.split('').forEach((c, i) => el(i % 2 === 0, c === 'w' ? W : N));
    return '<svg class="bol-svg" viewBox="0 0 ' + x + ' 50" preserveAspectRatio="none" role="img" aria-label="Código de barras de teste" style="width:103mm;max-width:100%;height:13mm" fill="#000">' + bars + '</svg>';
  }

  function nossoNumero(mes, seq) { return ('99' + mes.replace('-', '') + pad(seq, 3)).padEnd(17, '0'); }

  // ctx: { benef:{nome,cnpj,agencia,codigo}, pagador, seq }
  function build(res, row, ctx) {
    const nn = nossoNumero(res.mes, ctx.seq);
    const campoLivre = (pad(dig(ctx.benef.codigo).slice(-6), 6) + nn).padEnd(25, '0').slice(0, 25);
    const codigoBarras = barcode('104', '9', res.vencimento, row.total, campoLivre);
    return { mes: res.mes, unidade: row.unidade, pagador: ctx.pagador, benef: ctx.benef, vencimento: res.vencimento, valor: row.total,
      nossoNumero: nn, campoLivre, codigoBarras, linhaDigitavel: linhaDigitavel(codigoBarras), itens: row.itens };
  }

  // Conferência interna de um boleto gerado (retorna lista de problemas; vazia = ok).
  function validar(b, totalEsperado) {
    const p = [], cb = b.codigoBarras;
    if (!/^\d{44}$/.test(cb)) p.push('Código de barras não tem 44 dígitos');
    else {
      if (+cb[4] !== mod11(cb.slice(0, 4) + cb.slice(5))) p.push('DV geral inválido');
      if (+cb.slice(5, 9) !== fator(b.vencimento)) p.push('Fator de vencimento não confere');
      if (+cb.slice(9, 19) !== b.valor) p.push('Valor do código difere do valor cobrado');
      if (barrasDaLinha(b.linhaDigitavel) !== cb) p.push('Linha digitável não corresponde ao código de barras');
    }
    if (totalEsperado != null && b.valor !== totalEsperado) p.push('Valor difere do total da cobrança');
    return p;
  }

  function boletoHTML(b) {
    const cel = (t, v, st) => '<div class="bol-cell"' + (st ? ' style="' + st + '"' : '') + '><small>' + t + '</small>' + v + '</div>';
    const row = (cols, cells) => '<div class="bol-row" style="grid-template-columns:' + cols + '">' + cells.join('') + '</div>';
    const itens = b.itens.map(i => '<div style="display:flex;justify-content:space-between;gap:8px"><span>' + E(i.descricao) + '</span><span>' + E(brl(i.centavos)) + '</span></div>').join('');
    return '<div class="bol"><div class="bol-mark">TESTE</div><div class="bol-banner">BOLETO DE TESTE — SEM VALOR — NÃO PAGAR</div>' +
      '<div class="bol-row" style="grid-template-columns:90px 1fr"><div class="bol-cell" style="font-size:16px;font-weight:800">CAIXA<br><small>104-0</small></div><div class="bol-linha">' + E(b.linhaDigitavel) + '</div></div>' +
      row('2fr 1fr', [cel('Local de pagamento', 'SOMENTE PARA TESTE — não pagável'), cel('Vencimento', '<strong>' + E(fdate(b.vencimento)) + '</strong>')]) +
      row('2fr 1fr', [cel('Beneficiário', E(b.benef.nome) + ' — CNPJ ' + E(b.benef.cnpj)), cel('Agência / Código do beneficiário', E(b.benef.agencia) + ' / ' + E(b.benef.codigo))]) +
      row('1fr 1.3fr .6fr .6fr 1.4fr', [cel('Data do documento', E(fdate(b.vencimento))), cel('Nº do documento', E(b.mes.slice(5) + '/' + b.mes.slice(0, 4) + ' · unid. ' + b.unidade)), cel('Espécie', 'DM'), cel('Aceite', 'N'), cel('Nosso número (teste)', E(b.nossoNumero))]) +
      row('1fr 1fr 1fr 1.4fr', [cel('Carteira', 'TESTE'), cel('Espécie moeda', 'R$'), cel('Quantidade', ''), cel('(=) Valor do documento', '<strong>' + E(brl(b.valor)) + '</strong>')]) +
      '<div class="bol-cell" style="border-left:0;border-top:1px solid #000;min-height:90px"><small>Instruções / composição da cobrança ' + E(b.mes.slice(5) + '/' + b.mes.slice(0, 4)) + ' — unidade ' + E(b.unidade) + '</small>' + itens + '</div>' +
      '<div class="bol-cell" style="border-left:0;border-top:1px solid #000"><small>Pagador</small>' + E(b.pagador) + ' — Unidade ' + E(b.unidade) + '</div>' +
      '<div class="bol-barcode">' + itfSVG(b.codigoBarras) + '</div>' +
      '<div class="bol-foot">Campo livre de teste: o layout oficial da CAIXA não foi aplicado. Este documento não é registrado no banco.</div></div>';
  }

  const api = { mod10, mod11, fator, barcode, linhaDigitavel, barrasDaLinha, itfSVG, nossoNumero, build, validar, boletoHTML };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BOL = api;
})(typeof window !== 'undefined' ? window : globalThis);
