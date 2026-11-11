/* Leitor de extrato OFX (SGML 1.x e XML 2.x) — roda no navegador e no Node (para testes).
   Lê só o necessário: movimentos, período e saldo. NÃO guarda número de conta nem de agência.
   Uso: OFX.parse(OFX.decodificar(arrayBuffer)) -> { periodo_ini, periodo_fim, saldo_final_centavos, saldo_data, movimentos:[...] } */
(function (raiz) {
  'use strict';
  const MAX_MOV = 2000;

  function decodificar(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const cab = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 600)));
    const charset = (/CHARSET:\s*(\S+)/i.exec(cab) || [])[1], enc = (/ENCODING:\s*(\S+)/i.exec(cab) || [])[1], xml = /<\?xml[^>]*encoding=["']([^"']+)/i.exec(cab);
    let label = 'utf-8';
    if (charset && /^(1252|windows-1252|latin1|iso-8859-1)$/i.test(charset)) label = 'windows-1252';
    else if (enc && /^usascii$/i.test(enc)) label = 'windows-1252';
    else if (xml && /iso-8859-1|windows-1252/i.test(xml[1])) label = 'windows-1252';
    try { return new TextDecoder(label, { fatal: label === 'utf-8' }).decode(bytes); }
    catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
  }
  const entidades = s => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }[e]));
  const campo = (bloco, tag) => { const m = new RegExp('<' + tag + '>([^<\\r\\n]*)', 'i').exec(bloco); return m ? entidades(m[1]).trim() : ''; };
  function dataDe(s, rotulo) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(s || '');
    if (!m) throw new Error(rotulo + ' inválida no arquivo OFX: “' + (s || '') + '”.');
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error(rotulo + ' inexistente no arquivo OFX: “' + s + '”.');
    return m[1] + '-' + m[2] + '-' + m[3];
  }
  function centavos(txt, rotulo) {
    let s = String(txt || '').replace(/\s/g, '').replace(/^\+/, '');
    const neg = s.startsWith('-'); if (neg) s = s.slice(1);
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (s.includes(',')) s = s.replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Valor inválido no arquivo OFX (' + rotulo + '): “' + txt + '”.');
    const [i, d = ''] = s.split('.'); const c = Number(i) * 100 + Number((d + '00').slice(0, 2));
    if (!Number.isSafeInteger(c)) throw new Error('Valor grande demais no arquivo OFX (' + rotulo + ').');
    return neg ? -c : c;
  }
  const normaliza = memo => String(memo || '').trim().replace(/\s+/g, ' ').toUpperCase();
  const chave = m => m.data + '|' + m.valor_centavos + '|' + normaliza(m.memo);

  function parse(texto) {
    const t = String(texto || '');
    const ini = t.search(/<OFX>/i);
    if (ini < 0) throw new Error('Este arquivo não parece ser um extrato OFX.');
    const corpo = t.slice(ini);
    if (/<CCSTMTRS>/i.test(corpo)) throw new Error('Extrato de cartão de crédito não é aceito. Envie o extrato da conta corrente.');
    if ((corpo.match(/<STMTRS>/gi) || []).length > 1) throw new Error('O arquivo traz mais de uma conta. Exporte o extrato de uma conta por vez.');
    const moeda = campo(corpo, 'CURDEF'); if (moeda && moeda.toUpperCase() !== 'BRL') throw new Error('Moeda do extrato não é BRL (' + moeda + ').');
    const blocos = corpo.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
    if (!blocos.length) throw new Error('O arquivo OFX não tem nenhum movimento.');
    if (blocos.length > MAX_MOV) throw new Error('O arquivo tem mais de ' + MAX_MOV + ' movimentos. Exporte um período menor.');
    const movimentos = blocos.map((b, i) => {
      const rot = 'movimento ' + (i + 1);
      const memo = (campo(b, 'MEMO') || campo(b, 'NAME')).replace(/\s+/g, ' ').trim();
      return { ordem: i + 1, data: dataDe(campo(b, 'DTPOSTED'), 'Data do ' + rot), valor_centavos: centavos(campo(b, 'TRNAMT'), rot), memo: memo || '(sem descrição)', tipo: campo(b, 'TRNTYPE'), fitid: campo(b, 'FITID') };
    });
    if (movimentos.some(m => m.valor_centavos === 0)) throw new Error('O arquivo tem movimento de valor zero.');
    const datas = movimentos.map(m => m.data).sort();
    const ds = campo(corpo, 'DTSTART'), de = campo(corpo, 'DTEND');
    const bal = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|$)/i.exec(corpo);
    const saldo = bal && campo(bal[1], 'BALAMT') ? centavos(campo(bal[1], 'BALAMT'), 'saldo final') : null;
    const sd = bal && campo(bal[1], 'DTASOF') ? dataDe(campo(bal[1], 'DTASOF'), 'Data do saldo') : null;
    const soma = movimentos.reduce((s, m) => s + m.valor_centavos, 0);
    return {
      periodo_ini: ds ? dataDe(ds, 'Data inicial') : datas[0], periodo_fim: de ? dataDe(de, 'Data final') : datas[datas.length - 1],
      saldo_final_centavos: saldo, saldo_data: sd, movimentos,
      entradas_centavos: movimentos.filter(m => m.valor_centavos > 0).reduce((s, m) => s + m.valor_centavos, 0),
      saidas_centavos: -movimentos.filter(m => m.valor_centavos < 0).reduce((s, m) => s + m.valor_centavos, 0),
      saldo_inicial_implicito_centavos: saldo === null ? null : saldo - soma
    };
  }
  async function sha256(buf) {
    const h = await crypto.subtle.digest('SHA-256', buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  const api = { parse, decodificar, normaliza, chave, sha256, MAX_MOV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else raiz.OFX = api;
})(typeof window !== 'undefined' ? window : globalThis);
