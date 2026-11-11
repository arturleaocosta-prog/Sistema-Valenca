/* Service worker do app. V1.12.1: REDE PRIMEIRO (sempre a versão publicada; o cache só serve offline) e instalação que ignora o cache HTTP
   (o GitHub Pages guarda arquivos por até 10 min; sem 'reload' o cache novo nascia com arquivos velhos). */
const CACHE='condominio-shell-v1-15-0';
const ASSETS=['./','./index.html','./cobranca.js','./boleto.js','./auth.js','./caixa.js','./ofx.js','./extrato.js','./cobranca-ui.js','./config.js','./vendor/supabase.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS.map(u=>new Request(u,{cache:'reload'})))).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const req=event.request,url=new URL(req.url);
  /* só o próprio app: chamadas ao Supabase (outro domínio), dados financeiros (/data/) e gravações nunca passam pelo cache */
  if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.includes('/data/'))return;
  event.respondWith(fetch(req,{cache:'no-cache'}).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(req,copy));}
    return response;
  }).catch(()=>caches.match(req).then(hit=>hit||caches.match('./index.html'))));
});
