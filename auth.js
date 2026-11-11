/* V1.9 — Login por convite, convites do síndico e aviso da vaga de visitante, ligados ao Supabase.
   Carregado depois do script principal do index.html (usa role, page, render, head, navCard).
   Sem configuração (config.js vazio) o app continua em modo demonstração. */
(function () {
  'use strict';
  const cfg = window.APP_CONFIG || {};
  const APP = window.APP = {
    on: false, sb: null, uid: null, perfil: null, unidades: [], minhas: [],
    avisos: [], avisosOk: false, avisosCarregando: false, avisosErro: '',
    convites: [], convitesOk: false, convitesCarregando: false, convitesErro: '', ultimoConvite: null,
    bootando: false, recuperando: false, recarregar: () => location.reload()
  };
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hojeBR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const agoraBR = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Sao_Paulo', hour12: false }).slice(0, 5);
  const fmtData = d => String(d).slice(0, 10).split('-').reverse().join('/');
  const hhmm = t => String(t).slice(0, 5);
  const gateEl = () => $('authgate');

  if (!(cfg.SUPABASE_URL && cfg.SUPABASE_KEY && window.supabase && window.supabase.createClient)) {
    if (gateEl()) gateEl().classList.add('hide');     // modo demonstração
    return;
  }

  function msgErro(e) {
    const m = (e && e.message) || String(e || '');
    if (/Invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/Email not confirmed/i.test(m)) return 'Confirme seu e-mail pelo link que enviamos antes de entrar.';
    if (/row-level security|permission denied/i.test(m)) return 'Você não tem permissão para esta ação.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
    if (/rate limit|too many|security purposes/i.test(m)) return 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.';
    if (/same password/i.test(m)) return 'Escolha uma senha diferente da anterior.';
    return m || 'Erro inesperado.';
  }
  async function ocupado(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } finally { if (btn) btn.disabled = false; }
  }

  /* ---------------- tela de acesso (gate) ---------------- */
  function gate(html) { const g = gateEl(); g.classList.remove('hide'); g.innerHTML = '<div class="authcard">' + html + '</div>'; }
  function erroGate(msg) { const el = $('ag-erro'); if (el) el.textContent = msg || ''; }
  function telaMsg(titulo, texto, botoes) {
    gate('<h1>' + esc(titulo) + '</h1><p>' + esc(texto) + '</p><div class="agbtns">' + botoes.map((b, i) => '<button class="btn ' + (i ? 'secondary' : '') + '" data-ag="' + i + '">' + esc(b[0]) + '</button>').join('') + '</div>');
    botoes.forEach((b, i) => { const el = document.querySelector('[data-ag="' + i + '"]'); if (el) el.onclick = b[1]; });
  }
  function telaEntrar(msgInicial) {
    gate('<h1>Entrar</h1><p class="agsub">Acesso para moradores, conselho e síndico.</p>' +
      '<form id="ag-f"><label>E-mail<input class="field" type="email" id="ag-email" autocomplete="username" required></label>' +
      '<label>Senha<input class="field" type="password" id="ag-senha" autocomplete="current-password" required></label>' +
      '<p id="ag-erro" class="agerro" role="alert"></p><button class="btn" id="ag-ok">Entrar</button></form>' +
      '<div class="aglinks"><button class="linkbtn" id="ag-criar">Recebi um convite — criar conta</button><button class="linkbtn" id="ag-rec">Esqueci a senha</button></div>');
    if (msgInicial) erroGate(msgInicial);
    $('ag-criar').onclick = telaCriar; $('ag-rec').onclick = telaRecuperar;
    $('ag-f').onsubmit = async ev => {
      ev.preventDefault();
      await ocupado($('ag-ok'), async () => {
        const { error } = await APP.sb.auth.signInWithPassword({ email: $('ag-email').value.trim(), password: $('ag-senha').value });
        if (error) return erroGate(msgErro(error));
        await boot();
      });
    };
  }
  function telaCriar() {
    gate('<h1>Criar conta</h1><p class="agsub">Use o <b>mesmo e-mail</b> para o qual o síndico enviou o convite.</p>' +
      '<form id="ag-f"><label>E-mail<input class="field" type="email" id="ag-email" autocomplete="username" required></label>' +
      '<label>Senha (mínimo 8 caracteres)<input class="field" type="password" id="ag-senha" minlength="8" autocomplete="new-password" required></label>' +
      '<p id="ag-erro" class="agerro" role="alert"></p><button class="btn" id="ag-ok">Criar conta</button></form>' +
      '<div class="aglinks"><button class="linkbtn" id="ag-voltar">Já tenho conta — entrar</button></div>');
    $('ag-voltar').onclick = () => telaEntrar();
    $('ag-f').onsubmit = async ev => {
      ev.preventDefault();
      const email = $('ag-email').value.trim(), senha = $('ag-senha').value;
      if (senha.length < 8) return erroGate('A senha precisa ter pelo menos 8 caracteres.');
      await ocupado($('ag-ok'), async () => {
        const { data, error } = await APP.sb.auth.signUp({ email, password: senha, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) return erroGate(msgErro(error));
        if (data && data.session) return boot();
        telaMsg('Confirme seu e-mail', 'Enviamos um link de confirmação para ' + email + '. Abra o e-mail, toque no link e depois volte aqui para entrar e informar o código do convite.', [['Ir para o login', () => telaEntrar()]]);
      });
    };
  }
  function telaRecuperar() {
    gate('<h1>Recuperar senha</h1><p class="agsub">Enviaremos um link para redefinir a senha.</p>' +
      '<form id="ag-f"><label>E-mail<input class="field" type="email" id="ag-email" autocomplete="username" required></label>' +
      '<p id="ag-erro" class="agerro" role="alert"></p><button class="btn" id="ag-ok">Enviar link</button></form>' +
      '<div class="aglinks"><button class="linkbtn" id="ag-voltar">Voltar</button></div>');
    $('ag-voltar').onclick = () => telaEntrar();
    $('ag-f').onsubmit = async ev => {
      ev.preventDefault();
      await ocupado($('ag-ok'), async () => {
        const { error } = await APP.sb.auth.resetPasswordForEmail($('ag-email').value.trim(), { redirectTo: location.origin + location.pathname });
        if (error) return erroGate(msgErro(error));
        telaMsg('Verifique seu e-mail', 'Se o e-mail estiver cadastrado, você receberá um link para criar uma nova senha.', [['Voltar ao login', () => telaEntrar()]]);
      });
    };
  }
  function telaNovaSenha() {
    gate('<h1>Nova senha</h1><p class="agsub">Defina a nova senha de acesso.</p>' +
      '<form id="ag-f"><label>Nova senha (mínimo 8 caracteres)<input class="field" type="password" id="ag-senha" minlength="8" autocomplete="new-password" required></label>' +
      '<p id="ag-erro" class="agerro" role="alert"></p><button class="btn" id="ag-ok">Salvar senha</button></form>');
    $('ag-f').onsubmit = async ev => {
      ev.preventDefault();
      const senha = $('ag-senha').value;
      if (senha.length < 8) return erroGate('A senha precisa ter pelo menos 8 caracteres.');
      await ocupado($('ag-ok'), async () => {
        const { error } = await APP.sb.auth.updateUser({ password: senha });
        if (error) return erroGate(msgErro(error));
        APP.recuperando = false;
        try { history.replaceState(null, '', location.pathname); } catch (_) {}
        await boot();
      });
    };
  }
  function telaConvite() {
    gate('<h1>Código do convite</h1><p class="agsub">Conta ' + esc(APP.email || '') + ' ativa. Informe o código que o síndico enviou para liberar o acesso.</p>' +
      '<form id="ag-f"><label>Código do convite<input class="field" id="ag-token" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>' +
      '<p id="ag-erro" class="agerro" role="alert"></p><button class="btn" id="ag-ok">Validar convite</button></form>' +
      '<div class="aglinks"><button class="linkbtn" id="ag-sair">Sair</button></div>');
    $('ag-sair').onclick = sair;
    $('ag-f').onsubmit = async ev => {
      ev.preventDefault();
      await ocupado($('ag-ok'), async () => {
        const { error } = await APP.sb.rpc('aceitar_convite', { p_token: $('ag-token').value.trim() });
        if (error) return erroGate(msgErro(error));
        await boot();
      });
    };
  }
  async function sair() {
    try { await APP.sb.auth.signOut(); } catch (_) {}
    APP.recarregar();
  }

  /* ---------------- inicialização / sessão ---------------- */
  async function boot() {
    if (APP.bootando) return;
    APP.bootando = true;
    try {
      if (/type=recovery/.test(location.hash) && !APP.recuperando) { APP.recuperando = true; return telaNovaSenha(); }
      if (APP.recuperando) return;
      const { data, error } = await APP.sb.auth.getSession();
      if (error) throw error;
      const session = data && data.session;
      if (!session) return telaEntrar();
      APP.uid = session.user.id; APP.email = session.user.email;
      const r = await APP.sb.from('perfis').select('user_id,condominio_id,nome,email,papel,ativo').eq('user_id', APP.uid).maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) return telaConvite();
      if (!r.data.ativo) return telaMsg('Acesso desativado', 'Seu acesso foi desativado. Fale com o síndico.', [['Sair', sair]]);
      APP.perfil = r.data;
      const [u, v] = await Promise.all([
        APP.sb.from('unidades').select('id,identificacao').order('identificacao'),
        APP.sb.from('vinculos_unidades').select('unidade_id').eq('user_id', APP.uid).eq('ativo', true)
      ]);
      if (u.error) throw u.error; if (v.error) throw v.error;
      APP.unidades = u.data || [];
      APP.minhas = (v.data || []).map(x => x.unidade_id);
      entrarNoApp();
    } catch (e) {
      telaMsg('Não foi possível carregar', msgErro(e), [['Tentar de novo', () => { APP.bootando = false; boot(); }], ['Sair', sair]]);
    } finally { APP.bootando = false; }
  }

  function entrarNoApp() {
    APP.on = true; APP.avisosOk = false; APP.convitesOk = false;
    role = APP.perfil.papel; page = 'inicio';
    gateEl().classList.add('hide'); gateEl().innerHTML = '';
    const sel = $('role'); if (sel) sel.classList.add('hide');
    const lab = document.querySelector('label[for="role"]'); if (lab) lab.classList.add('hide');
    if (!$('btnsair')) {
      const b = document.createElement('button');
      b.id = 'btnsair'; b.className = 'btn secondary'; b.textContent = 'Sair'; b.onclick = sair;
      $('avatar').parentNode.insertBefore(b, $('avatar'));
    }
    const nc = $('navconvites'); if (nc) nc.classList.toggle('hide', role !== 'sindico');
    document.querySelectorAll('[data-page="boletos"]').forEach(b => b.classList.toggle('hide', role !== 'sindico'));   // boletos (teste): só o síndico; a cobrança por unidade é de todos (cada perfil vê o que lhe cabe)
    const sf = document.querySelector('.sidefoot');
    if (sf) sf.innerHTML = esc(APP.perfil.nome) + '<br>Versão 1.15.0 · fase de testes';
    render();
  }

  /* ---------------- render: avisos de módulos em demonstração ---------------- */
  const renderOrig = window.render;
  window.render = function () {
    if (APP.on && role !== 'sindico' && ['boletos'].includes(page)) page = 'inicio';   // rota protegida (cobrança/boletos)
    renderOrig();
    if (!APP.on) return;
    if (role !== 'sindico') document.querySelectorAll('[data-go="boletos"]').forEach(e => e.remove());
    if (page !== 'convites') APP.ultimoConvite = null;
    const c = $('content');
    if (!['reservas', 'convites', 'menu', 'financeiro'].includes(page)) {
      c.insertAdjacentHTML('afterbegin', '<div class="notice">Este módulo ainda é uma demonstração: os dados são fictícios e não são salvos.</div>');
    }
    if (page === 'reservas') bindVaga();
    if (page === 'convites') bindConvites();
  };

  /* ---------------- vaga de visitante (aviso, não reserva) ---------------- */
  async function carregarAvisos() {
    APP.avisosCarregando = true; APP.avisosErro = '';
    const r = await APP.sb.from('avisos_vaga_visitante')
      .select('id,unidade_id,criado_por,data_uso,hora_inicio,hora_fim,observacao,status')
      .gte('data_uso', hojeBR()).order('data_uso', { ascending: true }).order('hora_inicio', { ascending: true });
    APP.avisosCarregando = false; APP.avisosOk = true;
    if (r.error) { APP.avisosErro = msgErro(r.error); APP.avisos = []; } else APP.avisos = r.data || [];
    if (page === 'reservas') render();
  }
  const nomeUnidade = id => { const u = APP.unidades.find(x => x.id === id); return u ? 'Unidade ' + esc(u.identificacao) : 'Unidade'; };
  function estadoAviso(a) {
    if (a.status === 'cancelado') return { txt: 'Cancelado', cls: '', ativo: false };
    const hoje = hojeBR();
    if (a.data_uso < hoje || (a.data_uso === hoje && hhmm(a.hora_fim) <= agoraBR())) return { txt: 'Encerrado', cls: '', ativo: false };
    return { txt: 'Aviso ativo', cls: 'green', ativo: true };
  }
  function vagaPage() {
    if (!APP.avisosOk && !APP.avisosCarregando) carregarAvisos();
    const podeAvisar = role === 'sindico' || APP.minhas.length > 0;
    let corpo;
    if (!APP.avisosOk) corpo = '<div class="empty">Carregando avisos…</div>';
    else if (APP.avisosErro) corpo = '<div class="empty">' + esc(APP.avisosErro) + '<br><button class="linkbtn" id="vaga-retry">Tentar de novo</button></div>';
    else corpo = APP.avisos.map(a => {
      const st = estadoAviso(a);
      const pode = st.ativo && (role === 'sindico' || a.criado_por === APP.uid);
      return '<div class="listrow"><div class="doticon">🚗</div><div><div class="rowtitle">Uso previsto da vaga de visitante</div>' +
        '<div class="rowmeta">' + fmtData(a.data_uso) + ' · ' + hhmm(a.hora_inicio) + '–' + hhmm(a.hora_fim) + '</div>' +
        '<div class="rowmeta">Responsável: ' + nomeUnidade(a.unidade_id) + (a.observacao ? ' · ' + esc(a.observacao) : '') + '</div></div>' +
        '<div class="rowright"><span class="pill ' + st.cls + '">' + st.txt + '</span>' + (pode ? '<div><button class="linkbtn" data-vaga-cancel="' + esc(a.id) + '">Cancelar aviso</button></div>' : '') + '</div></div>';
    }).join('') || '<div class="empty">Ainda não há avisos de uso da vaga.</div>';
    return head('Vaga de visitante', 'Mural de avisos para informar os demais moradores sobre a utilização da única vaga.',
      podeAvisar ? '<button class="btn" id="newvisitor">' + (role === 'sindico' ? '＋ Publicar aviso' : '＋ Avisar uso') + '</button>' : '') +
      '<div class="notice">Este módulo não realiza reservas nem garante a disponibilidade da vaga. É apenas um aviso de intenção de uso para os moradores.</div>' +
      (podeAvisar ? '' : '<div class="notice">Seu perfil ainda não está vinculado a uma unidade. Peça ao síndico para vincular você a uma unidade para poder publicar avisos.</div>') +
      '<div class="card"><div class="cardhead"><h2>Avisos de utilização</h2></div><div class="list">' + corpo + '</div></div>';
  }
  function bindVaga() {
    const nv = $('newvisitor'); if (nv) nv.onclick = formAviso;
    const rt = $('vaga-retry'); if (rt) rt.onclick = () => { APP.avisosOk = false; render(); };
    document.querySelectorAll('[data-vaga-cancel]').forEach(b => b.onclick = async () => {
      if (!confirm('Cancelar este aviso de uso da vaga?')) return;
      await ocupado(b, async () => {
        const r = await APP.sb.from('avisos_vaga_visitante').update({ status: 'cancelado' }).eq('id', b.dataset.vagaCancel).select('id');
        if (r.error) return alert(msgErro(r.error));
        if (!r.data || !r.data.length) return alert('Não foi possível cancelar este aviso.');
        APP.avisosOk = false; render();
      });
    });
  }
  function modal(html) {
    fechaModal();
    const m = document.createElement('div'); m.className = 'modal'; m.id = 'avmodal';
    m.innerHTML = '<div class="card modalcard">' + html + '</div>'; document.body.appendChild(m);
  }
  function fechaModal() { const m = $('avmodal'); if (m) m.remove(); }
  function formAviso() {
    const unids = role === 'sindico' ? APP.unidades : APP.unidades.filter(u => APP.minhas.includes(u.id));
    if (!unids.length) return alert('Seu perfil não está vinculado a uma unidade.');
    const hoje = hojeBR(); const max = new Date(Date.now() + 90 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    modal('<div class="cardhead"><h2>Avisar uso da vaga</h2><button class="linkbtn" id="av-x">Fechar ×</button></div>' +
      '<p class="smallnote" style="margin-top:0">Isto é um aviso aos demais moradores. Não reserva nem garante a vaga.</p>' +
      '<form id="av-f" class="formgrid"><label class="full">Unidade responsável<select class="field" id="av-un">' + unids.map(u => '<option value="' + esc(u.id) + '">Unidade ' + esc(u.identificacao) + '</option>').join('') + '</select></label>' +
      '<label class="full">Data<input class="field" type="date" id="av-d" value="' + hoje + '" min="' + hoje + '" max="' + max + '" required></label>' +
      '<label>Início<input class="field" type="time" id="av-i" value="14:00" required></label><label>Fim<input class="field" type="time" id="av-t" value="18:00" required></label>' +
      '<label class="full">Observação (opcional)<input class="field" id="av-o" maxlength="200"></label>' +
      '<p id="av-erro" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="av-ok">Publicar aviso</button></div></form>');
    $('av-x').onclick = fechaModal;
    $('av-f').onsubmit = async ev => {
      ev.preventDefault();
      const erro = m => { $('av-erro').textContent = m; };
      const d = $('av-d').value, i = $('av-i').value, t = $('av-t').value, o = $('av-o').value.trim();
      if (t <= i) return erro('O horário final deve ser depois do inicial.');
      await ocupado($('av-ok'), async () => {
        const r = await APP.sb.from('avisos_vaga_visitante').insert({
          condominio_id: APP.perfil.condominio_id, unidade_id: $('av-un').value, criado_por: APP.uid,
          data_uso: d, hora_inicio: i, hora_fim: t, observacao: o || null
        });
        if (r.error) return erro(msgErro(r.error));
        fechaModal(); APP.avisosOk = false; render();
      });
    };
  }

  /* ---------------- convites (somente síndico) ---------------- */
  async function carregarConvites() {
    APP.convitesCarregando = true; APP.convitesErro = '';
    const r = await APP.sb.from('convites').select('id,email,papel,unidade_id,expira_em,aceito_em,created_at').order('created_at', { ascending: false }).limit(50);
    APP.convitesCarregando = false; APP.convitesOk = true;
    if (r.error) { APP.convitesErro = msgErro(r.error); APP.convites = []; } else APP.convites = r.data || [];
    if (page === 'convites') render();
  }
  function textoConvite(c) {
    return 'Olá! Você foi convidado(a) para o aplicativo do condomínio.\n1) Acesse ' + location.origin + location.pathname + ' e crie sua conta usando este e-mail: ' + c.email +
      '\n2) Confirme o e-mail pelo link que você vai receber.\n3) Entre no app e informe este código do convite: ' + c.token + '\nO convite vale até ' + fmtData(c.expira) + '.';
  }
  function convitesPage() {
    if (role !== 'sindico') return head('Convites', 'Acesso restrito ao síndico.');
    if (!APP.convitesOk && !APP.convitesCarregando) carregarConvites();
    const novo = APP.ultimoConvite;
    const cardNovo = novo ? '<div class="card" style="margin-bottom:18px"><div class="cardhead"><h2>Convite gerado</h2></div>' +
      '<p class="smallnote" style="margin-top:0"><b>Copie agora:</b> o código aparece só desta vez. Se perder, gere outro convite (o anterior deixa de valer).</p>' +
      '<textarea class="field" id="cv-texto" rows="7" readonly style="width:100%">' + esc(textoConvite(novo)) + '</textarea>' +
      '<div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap"><button class="btn" id="cv-copiar">Copiar mensagem</button>' +
      '<a class="btn secondary" style="text-decoration:none" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(textoConvite(novo)) + '">Enviar pelo WhatsApp</a></div></div>' : '';
    let lista;
    if (!APP.convitesOk) lista = '<div class="empty">Carregando convites…</div>';
    else if (APP.convitesErro) lista = '<div class="empty">' + esc(APP.convitesErro) + '</div>';
    else lista = APP.convites.map(c => {
      const aceito = !!c.aceito_em, pend = !aceito && new Date(c.expira_em) > new Date();
      const un = c.unidade_id ? ' · ' + nomeUnidade(c.unidade_id) : '';
      return '<div class="listrow"><div class="doticon">✉</div><div><div class="rowtitle">' + esc(c.email) + '</div><div class="rowmeta">' + esc(c.papel) + un + '</div></div>' +
        '<div class="rowright"><span class="pill ' + (aceito ? 'green' : pend ? 'amber' : '') + '">' + (aceito ? 'Aceito' : pend ? 'Pendente · até ' + fmtData(c.expira_em) : 'Expirado/cancelado') + '</span>' +
        (pend ? '<div><button class="linkbtn" data-cv-cancel="' + esc(c.id) + '">Cancelar</button></div>' : '') + '</div></div>';
    }).join('') || '<div class="empty">Nenhum convite criado ainda.</div>';
    return head('Convites', 'Convide moradores e conselheiros. Cada convite vale para um único e-mail.') + cardNovo +
      '<div class="card" style="margin-bottom:18px"><div class="cardhead"><h2>Novo convite</h2></div><form id="cv-f" class="formgrid">' +
      '<label class="full">E-mail da pessoa<input class="field" type="email" id="cv-email" required></label>' +
      '<label>Perfil<select class="field" id="cv-papel"><option value="morador">Morador</option><option value="conselho">Conselho</option></select></label>' +
      '<label>Unidade<select class="field" id="cv-un"><option value="">— sem unidade —</option>' + APP.unidades.map(u => '<option value="' + esc(u.id) + '">Unidade ' + esc(u.identificacao) + '</option>').join('') + '</select></label>' +
      '<label>Validade<select class="field" id="cv-dias"><option value="3">3 dias</option><option value="7" selected>7 dias</option><option value="15">15 dias</option><option value="30">30 dias</option></select></label>' +
      '<p id="cv-erro" class="agerro full" role="alert"></p><div class="full"><button class="btn" id="cv-ok">Gerar convite</button></div></form></div>' +
      '<div class="card"><div class="cardhead"><h2>Convites enviados</h2></div><div class="list">' + lista + '</div></div>';
  }
  function bindConvites() {
    const f = $('cv-f');
    if (f) f.onsubmit = async ev => {
      ev.preventDefault();
      const erro = m => { $('cv-erro').textContent = m; };
      const email = $('cv-email').value.trim(), papel = $('cv-papel').value, un = $('cv-un').value || null, dias = parseInt($('cv-dias').value, 10);
      if (papel === 'morador' && !un) return erro('Escolha a unidade do morador.');
      await ocupado($('cv-ok'), async () => {
        const r = await APP.sb.rpc('criar_convite', { p_email: email, p_papel: papel, p_unidade_id: un, p_validade_dias: dias });
        if (r.error) return erro(msgErro(r.error));
        APP.ultimoConvite = { email: email.toLowerCase(), token: r.data, expira: new Date(Date.now() + dias * 864e5).toISOString() };
        APP.convitesOk = false; render();
      });
    };
    const cp = $('cv-copiar');
    if (cp) cp.onclick = async () => {
      const t = $('cv-texto'); t.select();
      try { await navigator.clipboard.writeText(t.value); cp.textContent = 'Copiado ✓'; } catch (_) { document.execCommand && document.execCommand('copy'); cp.textContent = 'Copiado ✓'; }
    };
    document.querySelectorAll('[data-cv-cancel]').forEach(b => b.onclick = async () => {
      if (!confirm('Cancelar este convite?')) return;
      await ocupado(b, async () => {
        const r = await APP.sb.rpc('cancelar_convite', { p_convite_id: b.dataset.cvCancel });
        if (r.error) return alert(msgErro(r.error));
        APP.convitesOk = false; render();
      });
    });
  }

  window.vagaPage = vagaPage; window.convitesPage = convitesPage;

  /* ---------------- start ---------------- */
  APP.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
  APP.sb.auth.onAuthStateChange(ev => {
    if (ev === 'PASSWORD_RECOVERY') { APP.recuperando = true; setTimeout(telaNovaSenha, 0); }
    else if (ev === 'SIGNED_OUT' && APP.on) setTimeout(() => APP.recarregar(), 0);
    else if (ev === 'SIGNED_IN' && !APP.on && !APP.recuperando) setTimeout(boot, 0);
  });
  boot();
})();
