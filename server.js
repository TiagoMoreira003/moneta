// Moneta: servidor local (Node 18+)
// Corre só em 127.0.0.1: os teus dados e a tua chave da Trading 212 nunca saem do teu PC,
// exceto para os pedidos de leitura à própria Trading 212.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3210;
// Os dados ficam na pasta de dados da app do sistema, fora da pasta do código
// (que pode estar no OneDrive ou num repositório git). MONETA_DATA escolhe outra pasta.
function defaultDataDir() {
  const home = require('os').homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Moneta');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Moneta');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'moneta');
}
const DATA_DIR = process.env.MONETA_DATA ? path.resolve(process.env.MONETA_DATA) : defaultDataDir();
const DATA_FILE = path.join(DATA_DIR, 'patrimonio.json');
const INSTR_FILE = path.join(DATA_DIR, 'instrumentos-cache.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BASE_CCY = 'EUR';

fs.mkdirSync(DATA_DIR, { recursive: true });

// Migração: versões antigas guardavam em ./data. Copia uma vez; a pasta antiga não é apagada.
const LEGACY_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_FILE) && fs.existsSync(path.join(LEGACY_DIR, 'patrimonio.json'))) {
  fs.cpSync(LEGACY_DIR, DATA_DIR, { recursive: true });
  console.log(`Dados copiados de ${LEGACY_DIR} para ${DATA_DIR}. Podes apagar a pasta antiga.`);
}
console.log(`Dados em ${DATA_DIR}`);

// ---------- Persistência ----------
const DEFAULT_DATA = {
  settings: { t212: { key: '', secret: '', env: 'live' }, birthYear: null },
  assets: [],
  history: [],
};

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { ...DEFAULT_DATA, ...d, settings: { ...DEFAULT_DATA.settings, ...d.settings, t212: { ...DEFAULT_DATA.settings.t212, ...(d.settings || {}).t212 } } };
  } catch {
    return structuredClone(DEFAULT_DATA);
  }
}
let data = load();

// ---------- Chaves API (várias por plataforma) ----------
// data.keys = [{ id, platform, label, env, key, secret, createdAt, updatedAt }]
// data.activeKeys = { trading212: id }  → a chave que a app usa
const PLATFORMS = { trading212: 'Trading 212', ibkr: 'Interactive Brokers', anthropic: 'Anthropic (Claude)', gemini: 'Google Gemini' };
const AI_PROVIDERS = ['anthropic', 'gemini'];
// Qual dos modelos responde no assistente: o último escolhido, desde que tenha chave
function aiProvider() {
  const pref = data.settings.aiProvider;
  if (AI_PROVIDERS.includes(pref) && activeKey(pref)) return pref;
  return AI_PROVIDERS.find((p) => activeKey(p)) || null;
}
const BROKERS = ['trading212', 'ibkr'];
data.keys ||= [];
data.goals ||= []; // [{ id, name, kind, target, saved, monthly, deadline 'AAAA-MM', note, primary, alloc }]
// alloc: euros de cada fonte de dinheiro postos neste objetivo. Fontes: "t212" (dinheiro livre na Trading 212)
// e "a:<id>" (uma conta ou depósito registado em Poupança). Os investimentos não entram.
// Quanto há em cada fonte agora: dinheiro livre da Trading 212 (última leitura) e contas/depósitos de Poupança
function cashAvailable() {
  const out = {};
  const br = brokerCache?.value;
  if (br) out.t212 = Math.max(0, br.freeEUR ?? br.free ?? 0);
  const ib = ibkrCache?.value;
  if (ib && ib.freeEUR != null) out.ibkr = Math.max(0, ib.freeEUR);
  for (const a of enriched()) if (a.type === 'conta') out['a:' + a.id] = Math.max(0, a.value || 0);
  return out;
}
// Recusa repartições que põem numa fonte mais dinheiro do que ela tem. Só bloqueia quando o total dessa fonte
// SOBE acima do saldo: se o saldo desceu depois (compraste ações), podes sempre baixar ou mexer noutros campos.
// changes: { goalId: alloc novo } ("__novo" para um objetivo ainda por criar)
function allocError(changes) {
  const avail = cashAvailable(), before = {}, after = {};
  const names = { t212: 'Trading 212', ibkr: 'IBKR' };
  for (const a of enriched()) names['a:' + a.id] = a.name;
  for (const g of data.goals) for (const [k, v] of Object.entries(g.alloc || {})) before[k] = (before[k] || 0) + v;
  const goals = [...data.goals.map((g) => ({ id: g.id, alloc: changes[g.id] ?? g.alloc ?? {} })), ...(changes.__novo ? [{ alloc: changes.__novo }] : [])];
  for (const g of goals) for (const [k, v] of Object.entries(g.alloc)) after[k] = (after[k] || 0) + v;
  for (const [k, total] of Object.entries(after)) {
    if (!(k in avail)) continue; // saldo ainda desconhecido (a Trading 212 não foi lida): a página já bloqueia
    if (total > avail[k] + 0.005 && total > (before[k] || 0) + 0.005) {
      const f = (n) => Math.round(n).toLocaleString('pt-PT') + ' €';
      return `Não tens dinheiro suficiente em ${names[k] || k}: estás a atribuir ${f(total)}, mas só tens ${f(avail[k])}. Nada foi alterado.`;
    }
  }
  return null;
}
// ---------- Histórico dos objetivos ----------
// g.hist = [{ d: 'AAAA-MM-DD', v: euros }] uma entrada por dia; g.log = [{ at, t }] as alterações, mais recentes primeiro.
const fmtC = (n) => (Math.round(n * 100) / 100).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
function srcName(k) {
  if (k === 't212') return 'Trading 212';
  if (k === 'ibkr') return 'IBKR';
  const a = data.assets.find((x) => 'a:' + x.id === k);
  return a ? a.name : 'conta apagada';
}
// "Já tens" de cada objetivo, como a página o calcula (dinheiro atribuído com corte proporcional + outro dinheiro; PPR à parte).
// Devolve null para um objetivo cujo saldo ainda não se conhece (ex.: a Trading 212 ainda não foi lida).
function goalValues() {
  const avail = cashAvailable(), assigned = {}, out = {};
  for (const g of data.goals) for (const [k, v] of Object.entries(g.alloc || {})) assigned[k] = (assigned[k] || 0) + v;
  const year = new Date().getFullYear();
  for (const g of data.goals) {
    if (g.kind === 'ppr') {
      out[g.id] = enriched().filter((a) => a.type === 'ppr').reduce((s, a) => s + (a.computed ? (a.contribByYear?.[year] || 0) : (a.contribYear || 0)), 0);
      continue;
    }
    let v = g.saved || 0, known = true;
    for (const [k, amt] of Object.entries(g.alloc || {})) {
      if (!(k in avail)) { known = false; break; }
      v += amt * (assigned[k] > avail[k] ? avail[k] / assigned[k] : 1);
    }
    out[g.id] = known ? Math.round(v * 100) / 100 : null;
  }
  return out;
}
function recordGoalHistory() {
  const today = new Date().toISOString().slice(0, 10), vals = goalValues();
  for (const g of data.goals) {
    if (vals[g.id] == null) continue;
    g.hist ||= [];
    const last = g.hist[g.hist.length - 1];
    if (last && last.d === today) last.v = vals[g.id]; else g.hist.push({ d: today, v: vals[g.id] });
    if (g.hist.length > 1500) g.hist.splice(0, g.hist.length - 1500);
  }
}
function logGoal(g, t) {
  g.log ||= [];
  g.log.unshift({ at: new Date().toISOString(), t });
  if (g.log.length > 60) g.log.length = 60;
}
// Frases curtas para o que mudou num objetivo
function describeGoalChange(before, after) {
  const out = [];
  const ym = (s) => s ? `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}` : 'sem prazo';
  if (before.name !== after.name) out.push(`Nome: "${before.name}" → "${after.name}"`);
  if ((before.target || 0) !== (after.target || 0)) out.push(`Valor a juntar: ${fmtC(before.target || 0)} → ${fmtC(after.target || 0)}`);
  if ((before.deadline || '') !== (after.deadline || '')) out.push(`Prazo: ${ym(before.deadline)} → ${ym(after.deadline)}`);
  if ((before.monthly || 0) !== (after.monthly || 0)) out.push(`Poupança por mês: ${fmtC(before.monthly || 0)} → ${fmtC(after.monthly || 0)}`);
  if ((before.saved || 0) !== (after.saved || 0)) out.push(`Outro dinheiro: ${fmtC(before.saved || 0)} → ${fmtC(after.saved || 0)}`);
  out.push(...describeAlloc(before.alloc, after.alloc));
  return out;
}
function describeAlloc(a = {}, b = {}) {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = a?.[k] || 0, y = b?.[k] || 0;
    if (Math.abs(x - y) < 0.005) continue;
    out.push(y > x ? `${srcName(k)}: +${fmtC(y - x)} (agora ${fmtC(y)})` : `${srcName(k)}: −${fmtC(x - y)} (agora ${fmtC(y)})`);
  }
  return out;
}
function cleanAlloc(a) {
  const out = {};
  if (a && typeof a === 'object') for (const [k, v] of Object.entries(a)) {
    const n = Number(v);
    if (/^(t212|ibkr|a:[\w-]{1,64})$/.test(k) && Number.isFinite(n) && n > 0) out[k] = Math.round(n * 100) / 100;
  }
  return out;
}
data.activeKeys ||= {};
if (!data.keys.length && data.settings.t212.key) {
  // Migra a chave antiga (uma só) para a lista
  const now = new Date().toISOString();
  const k = { id: crypto.randomUUID(), platform: 'trading212', label: 'Principal', env: data.settings.t212.env || 'live',
    key: data.settings.t212.key, secret: data.settings.t212.secret || '', createdAt: now, updatedAt: now };
  data.keys.push(k);
  data.activeKeys.trading212 = k.id;
  data.settings.t212.key = ''; data.settings.t212.secret = ''; // a chave passa a viver só na lista
}
function activeKey(platform) {
  const list = data.keys.filter((k) => k.platform === platform);
  return list.find((k) => k.id === data.activeKeys[platform]) || list[0] || null;
}

// ---------- Recursos (links, livros, dicas) ----------
const DEFAULT_RESOURCES = [
  { title: 'Portal das Finanças', url: 'https://www.portaldasfinancas.gov.pt', category: 'Oficial', note: 'IRS, simulador, deduções (PPR) e anexo J.' },
  { title: 'Todos Contam', url: 'https://www.todoscontam.pt', category: 'Oficial', note: 'Plano Nacional de Formação Financeira: guias simples de finanças pessoais.' },
  { title: 'Portal do Cliente Bancário (Banco de Portugal)', url: 'https://clientebancario.bportugal.pt', category: 'Oficial', note: 'Depósitos, créditos, comissões e direitos do cliente bancário.' },
  { title: 'CMVM: Investidor', url: 'https://www.cmvm.pt', category: 'Oficial', note: 'Regulador dos mercados: alertas, fundos (incl. PPR) e educação do investidor.' },
  { title: 'Save & Grow PPR: o fundo', url: 'https://www.saveandgrow.casadeinvestimentos.pt/fundo', category: 'Os meus investimentos', note: 'Cotação (valor da UP), carteira e documentos do teu PPR.' },
  { title: 'Doutor Finanças', url: 'https://www.doutorfinancas.pt', category: 'Blog', note: 'Artigos práticos sobre IRS, PPR, crédito e poupança em Portugal.' },
  { title: 'DECO Proteste Investe', url: 'https://www.deco.proteste.pt/investe', category: 'Blog', note: 'Análises de fundos, PPR e impostos sobre investimentos.' },
  { title: 'justETF', url: 'https://www.justetf.com', category: 'Ferramenta', note: 'Pesquisar e comparar ETFs europeus (custos, acumulação vs. distribuição).' },
  { title: 'Morningstar', url: 'https://www.morningstar.com', category: 'Ferramenta', note: 'Dados e análises de ações, fundos e ETFs.' },
  { title: 'Bogleheads Wiki', url: 'https://www.bogleheads.org/wiki/Main_Page', category: 'Guia', note: 'Investimento passivo a longo prazo, diversificação, custos baixos (em inglês).' },
  { title: 'Investopedia', url: 'https://www.investopedia.com', category: 'Guia', note: 'Dicionário e explicações de conceitos financeiros (em inglês).' },
  { title: 'The Psychology of Money: Morgan Housel', url: '', category: 'Livro', note: 'Comportamento e dinheiro: porque é que paciência ganha a inteligência.' },
  { title: 'O Investidor Inteligente: Benjamin Graham', url: '', category: 'Livro', note: 'O clássico do value investing (a filosofia do Save & Grow).' },
  { title: 'A Random Walk Down Wall Street: Burton Malkiel', url: '', category: 'Livro', note: 'Porque é que fundos de índice baratos são difíceis de bater.' },
];
if (!Array.isArray(data.resources)) {
  const now = new Date().toISOString();
  data.resources = DEFAULT_RESOURCES.map((r) => ({ id: crypto.randomUUID(), ...r, createdAt: now }));
  data.resourcesSeed = 1;
}
// v2: foco em Portugal e na Europa (acrescenta sem duplicar e sem mexer no que adicionaste)
const RESOURCES_V2 = [
  { title: 'IGCP: Certificados de Aforro e do Tesouro', url: 'https://www.igcp.pt', category: 'Poupança', note: 'Poupança garantida pelo Estado português; taxas atuais dos Certificados (alternativa ao dinheiro parado).' },
  { title: 'Fundo de Garantia de Depósitos', url: 'https://www.fgd.pt', category: 'Poupança', note: 'Os depósitos bancários estão garantidos até 100 000 € por pessoa e por banco.' },
  { title: 'INE: Inflação em Portugal', url: 'https://www.ine.pt', category: 'Portugal', note: 'Índice de preços: se a poupança rende menos que a inflação, estás a perder poder de compra.' },
  { title: 'BCE: Taxas de juro', url: 'https://www.ecb.europa.eu/home/html/index.pt.html', category: 'Europa', note: 'As decisões do BCE mexem nos juros da Trading 212, dos depósitos e dos créditos.' },
  { title: 'Eurostat: Inflação na zona euro', url: 'https://ec.europa.eu/eurostat', category: 'Europa', note: 'Inflação (HICP) e estatísticas europeias para comparar com os teus rendimentos.' },
  { title: 'ESMA: Regulador europeu dos mercados', url: 'https://www.esma.europa.eu', category: 'Europa', note: 'Regras dos fundos UCITS/ETFs europeus e avisos aos investidores.' },
  { title: 'A sua Europa: Dinheiro e impostos', url: 'https://europa.eu/youreurope/citizens/index_pt.htm', category: 'Europa', note: 'Direitos e impostos quando investes, trabalhas ou tens contas noutro país da UE.' },
  { title: 'Curvo', url: 'https://curvo.eu', category: 'Ferramenta', note: 'Simulações e comparação de ETFs pensadas para investidores europeus.' },
  { title: 'Trading 212: Centro de ajuda', url: 'https://helpcentre.trading212.com', category: 'Os meus investimentos', note: 'Juros do dinheiro parado, dividendos, extratos anuais para o IRS.' },
  { title: 'r/literaciafinanceira', url: 'https://www.reddit.com/r/literaciafinanceira/', category: 'Comunidade', note: 'Comunidade portuguesa: PPR, ETFs, IRS, corretoras: dúvidas de quem está em Portugal.' },
  { title: 'r/eupersonalfinance', url: 'https://www.reddit.com/r/eupersonalfinance/', category: 'Comunidade', note: 'Finanças pessoais e investimento do ponto de vista europeu (em inglês).' },
];
if ((data.resourcesSeed || 1) < 2) {
  const have = new Set(data.resources.map((r) => r.url).filter(Boolean));
  for (const r of data.resources) if (r.category === 'Oficial') r.category = 'Portugal';
  const now = new Date().toISOString();
  for (const r of RESOURCES_V2) if (!have.has(r.url)) data.resources.push({ id: crypto.randomUUID(), ...r, createdAt: now });
  data.resourcesSeed = 2;
}
// v3: os títulos sugeridos pela app deixam de usar travessão (regra antislop R-02).
// Só mexe nos títulos que a própria app criou; os que escreveste ficam como estão.
if ((data.resourcesSeed || 1) < 3) {
  const fixed = new Map([...DEFAULT_RESOURCES, ...RESOURCES_V2].map((r) => [r.title.replace(': ', ' — '), r.title]));
  for (const r of data.resources) if (fixed.has(r.title)) r.title = fixed.get(r.title);
  data.resourcesSeed = 3;
}
// v4: primeiro artigo escrito pela app (lê-se dentro da Moneta; "body" são blocos {h}, {p} ou {li: []}).
const ARTICLE_TAX_LOSS = {
  title: 'Vender com prejuízo e voltar a comprar: o que muda no IRS',
  url: '',
  category: 'Guia',
  note: 'Como funciona realizar uma perda para compensar mais-valias, o que acontece ao custo de compra e o que confirmar antes.',
  body: [
    { p: 'Uma perda só conta para o IRS quando vendes. Enquanto tens a posição, o prejuízo é apenas latente e não entra em lado nenhum. Há quem venda uma posição em perda e volte a comprá-la logo a seguir, para que essa perda passe a contar sem ficar de fora do investimento.' },
    { h: 'Como funciona' },
    { p: 'No anexo J, as mais-valias e as menos-valias do mesmo ano somam-se e o saldo paga 28%. Se tens 500 € de ganhos realizados e realizas uma perda de 305 €, pagas imposto sobre 195 € em vez de 500 €: cerca de 85 € a menos.' },
    { h: 'O que acontece à posição' },
    { li: [
      'Continuas com o mesmo ativo; o património só desce pelas comissões e pelo câmbio.',
      'O custo de compra passa a ser o preço da recompra. A posição mostra lucro zero a partir daí.',
      'O prejuízo não desapareceu: passou de "em aberto" para "realizado" este ano.',
      'Se o preço recuperar, o ganho futuro é maior, porque o custo agora é mais baixo. O imposto é adiado, não eliminado.',
    ] },
    { h: 'Exemplo' },
    { p: 'Compraste por 1 086 € e hoje vale 781 €. Vendes (perda realizada de 305 €) e recompras por 781 €. Se um dia voltar a valer 1 086 € e venderes, tens uma mais-valia de 305 € a declarar nesse ano. Ganhaste tempo e o uso do dinheiro poupado entretanto.' },
    { h: 'Antes de fazer, confirma' },
    { li: [
      'Só compensa se tiveres mais-valias realizadas no mesmo ano. Sem ganhos para abater, a perda não poupa nada.',
      'Levar a perda para os 5 anos seguintes exige optar pelo englobamento, que junta os rendimentos de capitais ao salário e os tributa à taxa marginal. Com rendimentos médios, isso costuma sair mais caro que os 28%.',
      'Regra FIFO: se compraste em várias vezes, considera-se que vendeste primeiro as unidades mais antigas. É esse lote que decide se a venda dá perda ou ganho.',
      'Custos: comissão de câmbio da Trading 212 (0,15% em ativos fora do euro) e o spread, pagos na venda e na recompra.',
      'Não encontrámos no Código do IRS uma regra específica contra vender e recomprar logo a seguir (Espanha tem uma janela de 2 meses). Existe, no entanto, a cláusula geral antiabuso da Lei Geral Tributária. Para valores relevantes, pede uma informação vinculativa à AT ou fala com um contabilista.',
    ] },
    { h: 'O que vais ver na corretora' },
    { p: 'Depois da recompra, a Trading 212 mostra a posição com o novo custo e lucro perto de zero. A perda fica no extrato anual de operações, que é o que usas para preencher o anexo J.' },
    { p: 'Isto é uma explicação de como as regras funcionam, não uma recomendação de compra ou venda.' },
  ],
};
if ((data.resourcesSeed || 1) < 4) {
  data.resources.unshift({ id: crypto.randomUUID(), ...ARTICLE_TAX_LOSS, createdAt: new Date().toISOString() });
  data.resourcesSeed = 4;
}
const isHttpUrl = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- Câmbios (BCE via frankfurter.app, sem chave) ----------
let fx = { rates: { EUR: 1 }, at: 0, ok: false };
async function getRates() {
  if (fx.ok && Date.now() - fx.at < 3600_000) return fx.rates;
  try {
    const r = await fetch('https://api.frankfurter.app/latest?base=EUR');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    fx = { rates: { ...j.rates, EUR: 1 }, at: Date.now(), ok: true, date: j.date || null };
  } catch (e) {
    console.warn('[câmbios] falhou:', e.message);
  }
  return fx.rates;
}
// Converte um valor de `from` para `to`. GBX (pence) é tratado como GBP/100.
function convert(amount, from, to, rates) {
  if (amount == null || isNaN(amount)) return null;
  if (from === 'GBX') { amount = amount / 100; from = 'GBP'; }
  if (from === to) return amount;
  const rf = rates[from], rt = rates[to];
  if (!rf || !rt) return null;
  return (amount / rf) * rt;
}

// ---------- Trading 212 (só leitura) ----------
function t212Configured() { return Boolean(activeKey('trading212')); }

async function t212(endpoint) {
  const k = activeKey('trading212');
  if (!k) throw new Error('Sem chave da Trading 212');
  return t212With(k, endpoint);
}
async function t212With({ key, secret, env }, endpoint) {
  const base = env === 'demo' ? 'https://demo.trading212.com/api/v0' : 'https://live.trading212.com/api/v0';
  // Chaves novas usam chave + segredo (Basic auth); chaves antigas só a chave.
  const auth = secret ? 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64') : key;
  const r = await fetch(base + endpoint, { headers: { Authorization: auth } });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    const hint = r.status === 401 ? ' (chave/segredo inválidos)'
      : r.status === 403 ? ' (a chave não tem a permissão de leitura necessária)'
      : r.status === 429 ? ' (limite de pedidos, tenta daqui a pouco)' : '';
    throw new Error(`Trading 212 ${endpoint}: HTTP ${r.status}${hint} ${txt.slice(0, 160)}`.trim());
  }
  return r.json();
}

// ---------- Ligações: testar uma corretora antes de guardar ----------
// O teste corre no servidor com a chave colada; só uma ligação testada com sucesso pode ser guardada.
const connTests = new Map(); // testId -> { cred, result, at }
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (m, e) => e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENT[e.toLowerCase()]);
const xmlAttrs = (tag) => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], xmlText(m[2])]));

async function testTrading212(cred) {
  const [cash, portfolio] = [await t212With(cred, '/equity/account/cash'), await t212With(cred, '/equity/portfolio')];
  return { positions: portfolio.length, value: cash.total ?? null, cash: cash.free ?? null, currency: null, account: null };
}

async function testIbkr(cred) {
  const xml = await ibkrFlex(cred);
  const pos = [...xml.matchAll(/<OpenPosition\s[^>]*>/g)].map((m) => xmlAttrs(m[0]));
  const value = pos.reduce((s, p) => s + (Number(p.positionValue) || 0) * (Number(p.fxRateToBase) || 1), 0);
  const cashTag = [...xml.matchAll(/<CashReportCurrency\s[^>]*>/g)].map((m) => xmlAttrs(m[0])).find((c) => c.currency === 'BASE_SUMMARY');
  const stmt = (xml.match(/<FlexStatement\s[^>]*>/) || [])[0];
  const acc = stmt ? xmlAttrs(stmt).accountId : null;
  return { positions: pos.length, value: Math.round(value * 100) / 100, cash: cashTag ? Number(cashTag.endingCash) : null,
    currency: null, account: acc ? acc.slice(0, 1) + '****' + acc.slice(-4) : null };
}

// Flex Web Service: o token só corre relatórios já criados no Client Portal; não consegue fazer ordens.
async function ibkrFlex(cred) {
  const base = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
  const q = (u) => fetch(u, { headers: { 'User-Agent': 'Moneta/1.0' } }).then((r) => r.text());
  const sent = await q(`${base}/SendRequest?t=${encodeURIComponent(cred.key)}&q=${encodeURIComponent(cred.secret)}&v=3`);
  if (!/<Status>Success<\/Status>/.test(sent)) {
    const msg = (sent.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/) || [])[1];
    throw new Error(msg ? `IBKR: ${msg}` : 'A IBKR não aceitou o token ou o ID do relatório.');
  }
  const ref = (sent.match(/<ReferenceCode>([^<]*)<\/ReferenceCode>/) || [])[1];
  let xml = '';
  for (let i = 0; i < 6; i++) { // o relatório demora uns segundos a ficar pronto
    xml = await q(`${base}/GetStatement?t=${encodeURIComponent(cred.key)}&q=${encodeURIComponent(ref)}&v=3`);
    if (/<FlexQueryResponse/.test(xml)) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (!/<FlexQueryResponse/.test(xml)) throw new Error('A IBKR ainda está a preparar o relatório. Tenta outra vez dentro de um minuto.');
  return xml;
}

const CONN_TESTS = { trading212: testTrading212, ibkr: testIbkr };

let accountInfo = null;
let instruments = null; // ticker -> { name, currencyCode, type }
async function getInstruments() {
  if (instruments) return instruments;
  try {
    const c = JSON.parse(fs.readFileSync(INSTR_FILE, 'utf8'));
    if (Date.now() - c.at < 24 * 3600_000) return (instruments = c.map);
  } catch {}
  try {
    const list = await t212('/equity/metadata/instruments');
    const map = {};
    for (const i of list) map[i.ticker] = { name: i.name || i.shortName, short: i.shortName, currencyCode: i.currencyCode, type: i.type, isin: i.isin || null };
    fs.writeFileSync(INSTR_FILE, JSON.stringify({ at: Date.now(), map }));
    return (instruments = map);
  } catch (e) {
    console.warn('[instrumentos]', e.message);
    return {};
  }
}

// ---------- Dados de cada ticker (setor, dividendos, logótipo, nome curto) ----------
// A API da Trading 212 não dá setor nem dividendos. tickers.json (no repositório) traz valores para
// tickers comuns; um tickers.json na pasta de dados acrescenta ou substitui os teus. Cada entrada:
// { "sector": "...", "dividend": { status, freq, months, note }, "domain": "...", "logo": ["commons:File:..."], "alias": "..." }
function readTickers(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
const TICKERS = { ...readTickers(path.join(__dirname, 'tickers.json')), ...readTickers(path.join(DATA_DIR, 'tickers.json')) };
delete TICKERS.$comment;
const tickerInfo = (short) => TICKERS[short] || {};

// O setor escolhido na app (data.sectors) ganha sempre
const sectorOf = (ticker, short) => (data.sectors || {})[ticker] || tickerInfo(short).sector || null;

// ---------- Logótipos das empresas ----------
// Domínio de cada empresa/ETF → ícone do site. O servidor vai buscá-lo uma vez e guarda-o na pasta
// de dados, por isso o browser nunca contacta serviços externos para isto.
const LOGO_DIR = path.join(DATA_DIR, 'logos');
const LOGO_VERSION = 'v2'; // muda quando as fontes mudam, para não servir logótipos antigos da cache
// "logo" em tickers.json: fontes melhores para quem não tem um ícone nítido no site (logótipos
// oficiais no Wikimedia Commons com "commons:File:...", ou outro domínio com "site:...").
const MIN_LOGO_PX = 32; // abaixo disto fica desfocado: a app mostra as iniciais

// Largura em píxeis de um PNG ou ICO (0 se não souber)
function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return buf.readUInt32BE(16);
  if (buf[0] === 0 && buf[2] === 1) { let m = 0; for (let i = 0; i < buf.readUInt16LE(4); i++) m = Math.max(m, buf[6 + 16 * i] || 256); return m; }
  return 0;
}
async function fetchImage(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'moneta-local/0.1' } });
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !type.startsWith('image/')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return { buf, type, px: imageSize(buf) };
  } catch { return null; }
}
async function logoCandidates(short) {
  const out = [];
  for (const src of tickerInfo(short).logo || []) {
    if (src.startsWith('commons:')) {
      try {
        const q = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(src.slice(8))}&prop=imageinfo&iiprop=url&iiurlwidth=256&format=json`;
        const j = await (await fetch(q, { headers: { 'User-Agent': 'moneta-local/0.1' } })).json();
        const ii = Object.values(j.query.pages)[0].imageinfo?.[0];
        if (ii?.thumburl) out.push(ii.thumburl);
      } catch {}
    } else if (src.startsWith('site:')) out.push(`https://www.google.com/s2/favicons?domain=${src.slice(5)}&sz=256`);
  }
  const d = tickerInfo(short).domain;
  if (d) out.push(`https://www.google.com/s2/favicons?domain=www.${d}&sz=256`, `https://www.google.com/s2/favicons?domain=${d}&sz=256`, `https://icons.duckduckgo.com/ip3/${d}.ico`);
  return out;
}
async function getLogo(short) {
  if (!tickerInfo(short).domain && !tickerInfo(short).logo) return null;
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  const file = path.join(LOGO_DIR, `${short.replace(/[^\w]/g, '')}.${LOGO_VERSION}.img`);
  const meta = file + '.type';
  if (fs.existsSync(meta)) {
    const type = fs.readFileSync(meta, 'utf8');
    return type === 'none' ? null : { buf: fs.readFileSync(file), type };
  }
  // Escolhe a imagem mais nítida entre as fontes (as oficiais primeiro)
  let best = null;
  for (const url of await logoCandidates(short)) {
    const img = await fetchImage(url);
    if (!img) continue;
    if (url.includes('wikimedia.org')) { best = { ...img, px: 256 }; break; }
    if (!best || img.px > best.px) best = img;
  }
  if (!best || best.px < MIN_LOGO_PX) { fs.writeFileSync(meta, 'none'); return null; }
  fs.writeFileSync(file, best.buf); fs.writeFileSync(meta, best.type);
  return best;
}

// ---------- Dividendos ----------
// A API da Trading 212 não dá informação de dividendos. Vem de tickers.json (paga / não paga /
// acumula e meses habituais); sem entrada, os ETFs reconhecem-se pelo nome: "(Acc)" acumula, "(Dist)" distribui.
function dividendOf(ticker, short, name) {
  if (tickerInfo(short).dividend) return tickerInfo(short).dividend;
  if (/\(Acc\)/i.test(name || '')) return { status: 'acumula' };
  if (/\(Dist\)/i.test(name || '')) return { status: 'paga' };
  return { status: 'desconhecido' };
}

let brokerCache = null; // { at, value }
async function getBroker(force = false) {
  if (!t212Configured()) return null;
  if (!force && brokerCache && Date.now() - brokerCache.at < 30_000) return brokerCache.value;
  try {
    // A moeda da conta não muda: guarda-a para não gastar pedidos (o limite deste endpoint é apertado)
    if (!accountInfo && data.settings.t212.currency) accountInfo = { currencyCode: data.settings.t212.currency };
    if (!accountInfo) {
      accountInfo = await t212('/equity/account/info');
      data.settings.t212.currency = accountInfo.currencyCode;
      save();
    }
    const acct = accountInfo.currencyCode || 'EUR';
    const cash = await t212('/equity/account/cash');
    const portfolio = await t212('/equity/portfolio');
    const [instr, rates] = await Promise.all([getInstruments(), getRates()]);

    const positions = portfolio.map((p) => {
      const meta = instr[p.ticker] || {};
      const ccy = meta.currencyCode || acct;
      const value = convert(p.quantity * p.currentPrice, ccy, acct, rates);
      const ppl = (p.ppl || 0) + (p.fxPpl || 0);
      const short = meta.short || p.ticker.replace(/_.*$/, '');
      return {
        ticker: p.ticker,
        broker: 't212',
        isin: meta.isin || null,
        sector: sectorOf(p.ticker, short),
        dividend: dividendOf(p.ticker, short, meta.name),
        logo: tickerInfo(short).domain || tickerInfo(short).logo ? '/api/logo/' + encodeURIComponent(short) : null,
        alias: tickerInfo(short).alias || null,
        name: meta.name || p.ticker.replace(/_.*$/, ''),
        short: meta.short || p.ticker.replace(/_.*$/, ''),
        type: meta.type || '',
        quantity: p.quantity,
        averagePrice: p.averagePrice,
        currentPrice: p.currentPrice,
        priceCcy: ccy,
        value,                         // na moeda da conta
        ppl,                           // na moeda da conta
        pplPct: value != null && value - ppl > 0 ? (ppl / (value - ppl)) * 100 : null,
        since: p.initialFillDate,
      };
    }).sort((a, b) => (b.value || 0) - (a.value || 0));

    const value = {
      currency: acct,
      total: cash.total,
      free: cash.free,
      invested: cash.invested,
      ppl: cash.ppl,
      result: cash.result,
      pieCash: cash.pieCash,
      blocked: cash.blocked,
      totalEUR: convert(cash.total, acct, BASE_CCY, rates),
      freeEUR: convert(cash.free, acct, BASE_CCY, rates),
      positions,
      fetchedAt: new Date().toISOString(),
    };
    brokerCache = { at: Date.now(), value };
    return value;
  } catch (e) {
    if (brokerCache) return { ...brokerCache.value, stale: true, error: e.message };
    return { error: e.message };
  }
}

// ---------- Interactive Brokers (Flex, só leitura) ----------
// O relatório Flex é um extrato diário: preços do fecho anterior. Guardado em ibkr-cache.json durante 6 horas
// (a IBKR limita os pedidos e cada relatório demora uns segundos a ficar pronto).
const IBKR_FILE = path.join(DATA_DIR, 'ibkr-cache.json');
const IBKR_TTL = 6 * 3600_000;
let ibkrCache = null; // { at, value }
try { ibkrCache = JSON.parse(fs.readFileSync(IBKR_FILE, 'utf8')); } catch {}
let ibkrLoading = null;
const ymdIso = (s) => /^\d{8}/.test(s || '') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : (s || '').slice(0, 10) || null;

function parseIbkr(xml, rates) {
  const attrs = (re) => [...xml.matchAll(re)].map((m) => xmlAttrs(m[0]));
  const stmt = attrs(/<FlexStatement\s[^>]*>/g)[0] || {};
  const info = attrs(/<AccountInformation\s[^>]*>/g)[0] || {};
  let pos = attrs(/<OpenPosition\s[^>]*>/g).filter((p) => p.assetCategory !== 'CASH');
  if (pos.some((p) => p.levelOfDetail)) pos = pos.filter((p) => !p.levelOfDetail || p.levelOfDetail === 'SUMMARY');
  // Moeda base da conta: a do AccountInformation, ou a de uma posição com câmbio 1
  const baseCcy = info.currency || (pos.find((p) => Number(p.fxRateToBase) === 1) || {}).currency || 'EUR';
  const toEUR = (n, ccy) => convert(n, ccy, BASE_CCY, rates);
  const positions = pos.map((p) => {
    const qty = Number(p.position) || 0, fx = Number(p.fxRateToBase) || 1, ccy = p.currency || baseCcy;
    const price = Number(p.markPrice) || 0, avg = Number(p.costBasisPrice) || null;
    const pnlLocal = p.fifoPnlUnrealized != null && p.fifoPnlUnrealized !== '' ? Number(p.fifoPnlUnrealized) : avg != null ? (price - avg) * qty : 0;
    const value = toEUR((Number(p.positionValue) || qty * price) * fx, baseCcy);
    const ppl = toEUR(pnlLocal * fx, baseCcy) || 0;
    const short = p.symbol || p.isin || '?';
    const type = p.assetCategory === 'STK' ? (/ETF/i.test(p.subCategory || '') ? 'ETF' : 'STOCK') : p.assetCategory === 'FUND' ? 'ETF' : p.assetCategory || '';
    return {
      ticker: 'ibkr:' + (p.conid || short),
      broker: 'ibkr',
      isin: p.isin || null,
      sector: sectorOf('ibkr:' + (p.conid || short), short),
      dividend: dividendOf(short, short, p.description),
      logo: tickerInfo(short).domain || tickerInfo(short).logo ? '/api/logo/' + encodeURIComponent(short) : null,
      alias: tickerInfo(short).alias || null,
      name: p.description || short,
      short,
      type,
      quantity: qty,
      averagePrice: avg,
      currentPrice: price,
      priceCcy: ccy,
      value,
      ppl,
      pplPct: value != null && value - ppl > 0 ? (ppl / (value - ppl)) * 100 : null,
      since: p.openDateTime || null,
    };
  }).sort((a, b) => (b.value || 0) - (a.value || 0));
  // Dinheiro por moeda (a IBKR pode ter euros e dólares ao mesmo tempo)
  const cashRows = attrs(/<CashReportCurrency\s[^>]*>/g);
  const cash = cashRows.filter((c) => c.currency && c.currency !== 'BASE_SUMMARY' && Math.abs(Number(c.endingCash) || 0) >= 0.005)
    .map((c) => ({ ccy: c.currency, amount: round(Number(c.endingCash)), eur: round(toEUR(Number(c.endingCash), c.currency) || 0) }));
  const baseSum = cashRows.find((c) => c.currency === 'BASE_SUMMARY');
  const freeEUR = cash.length ? cash.reduce((s, c) => s + c.eur, 0) : baseSum ? toEUR(Number(baseSum.endingCash), baseCcy) || 0 : 0;
  const posEUR = positions.reduce((s, p) => s + (p.value || 0), 0), ppl = positions.reduce((s, p) => s + (p.ppl || 0), 0);
  return {
    broker: 'ibkr',
    currency: BASE_CCY,
    total: round(posEUR + freeEUR), totalEUR: round(posEUR + freeEUR),
    free: round(freeEUR), freeEUR: round(freeEUR),
    invested: round(posEUR - ppl), ppl: round(ppl),
    cash,
    positions,
    statementDate: ymdIso(stmt.toDate || (pos[0] || {}).reportDate || stmt.whenGenerated),
    fxDate: fx.date || null, // dia dos câmbios do BCE usados para converter o dinheiro em dólares
    fetchedAt: new Date().toISOString(),
  };
}

// Depois de uma falha, espera 15 min antes de pedir outra vez (a IBKR limita os pedidos por minuto)
const IBKR_RETRY = 15 * 60_000;
let ibkrErr = null; // { at, keyId, message }
async function getIbkr(force = false) {
  const k = activeKey('ibkr');
  if (!k) return null;
  const mine = () => (ibkrCache && ibkrCache.keyId === k.id ? ibkrCache.value : null);
  const failed = () => (ibkrErr && ibkrErr.keyId === k.id ? ibkrErr : null);
  // Extrato guardado marcado como antigo, ou só o erro quando ainda não há nenhum
  const fallback = () => {
    const c = mine(), e = failed();
    return c ? { ...c, stale: true, ...(e ? { error: e.message } : {}) } : e ? { broker: 'ibkr', error: e.message } : null;
  };
  const cached = mine();
  if (!force && cached && Date.now() - ibkrCache.at < IBKR_TTL) return cached;
  if (!force && failed() && Date.now() - ibkrErr.at < IBKR_RETRY) return fallback();
  // Um pedido de cada vez: o relatório demora e a página pede o resumo várias vezes
  ibkrLoading ||= (async () => {
    try {
      const value = parseIbkr(await ibkrFlex(k), await getRates());
      ibkrCache = { at: Date.now(), keyId: k.id, value };
      ibkrErr = null;
      try { fs.writeFileSync(IBKR_FILE, JSON.stringify(ibkrCache)); } catch {}
      return value;
    } catch (e) {
      ibkrErr = { at: Date.now(), keyId: k.id, message: e.message };
      return fallback();
    } finally { ibkrLoading = null; }
  })();
  // Com um extrato antigo guardado, responde já com ele e atualiza em segundo plano
  return cached && !force ? cached : ibkrLoading;
}

// ---------- PPR / fundos: entregas + cotação ----------
// Um ativo com `movements` (entregas) e `unitPrice` (valor da UP) tem o valor calculado:
// unidades × cotação. Sem entregas, usa os campos manuais (value, contribYear, contribTotal).
function enrich(a) {
  const mv = Array.isArray(a.movements) ? a.movements : [];
  if (!mv.length) return { ...a, computed: false };
  const year = String(new Date().getFullYear());
  let units = 0, invested = 0;
  const byYear = {};
  for (const m of mv) {
    units += Number(m.units) || 0;
    invested += Number(m.amount) || 0;
    const y = m.date.slice(0, 4);
    byYear[y] = (byYear[y] || 0) + (Number(m.amount) || 0);
  }
  const price = Number(a.unitPrice) || null;
  return {
    ...a,
    computed: true,
    units,
    value: price ? round(units * price) : round(invested), // sem cotação, assume o valor investido
    noPrice: !price,
    contribTotal: round(invested),
    contribYear: round(byYear[year] || 0),
    contribByYear: mapRound(byYear),
    avgPrice: units ? invested / units : null,
  };
}
const enriched = () => data.assets.map(enrich);

// ---------- Resumo do património ----------
const LIABILITY = new Set(['divida']);

async function summary() {
  const [broker, ibkr] = await Promise.all([getBroker(), getIbkr()]);
  const byCat = {};
  let assetsTotal = 0, liabilities = 0;
  for (const a of enriched()) {
    const v = Number(a.value) || 0;
    if (LIABILITY.has(a.type)) liabilities += v;
    else { assetsTotal += v; byCat[a.type] = (byCat[a.type] || 0) + v; }
  }
  for (const b of [broker, ibkr]) {
    const ok = b && (!b.error || b.stale);
    const bEUR = ok ? b.totalEUR || 0 : 0;
    if (!bEUR) continue;
    // O dinheiro livre de cada corretora conta como "Dinheiro livre"; o resto como investimentos.
    const freeEUR = Math.min(bEUR, b.freeEUR || 0);
    if (freeEUR > 0) byCat.emergencia = (byCat.emergencia || 0) + freeEUR;
    // O investido divide-se pelo tipo de cada posição (ações, ETFs, …), ajustado para somar o total real.
    const investedEUR = bEUR - freeEUR;
    if (investedEUR > 0) {
      const rates = await getRates();
      const byType = {};
      for (const p of b.positions || []) {
        const cat = p.type === 'STOCK' ? 'acoes' : p.type === 'ETF' ? 'etf' : 'investimento';
        byType[cat] = (byType[cat] || 0) + (convert(p.value, b.currency, BASE_CCY, rates) || 0);
      }
      const sum = Object.values(byType).reduce((s, v) => s + v, 0);
      if (!sum) byType.investimento = investedEUR;
      for (const [k, v] of Object.entries(byType)) byCat[k] = (byCat[k] || 0) + (sum ? (v / sum) * investedEUR : v);
    }
    assetsTotal += bEUR;
  }
  const net = assetsTotal - liabilities;

  // Guarda uma fotografia diária (substitui a de hoje)
  const today = new Date().toISOString().slice(0, 10);
  const snap = { date: today, net: round(net), assets: round(assetsTotal), liabilities: round(liabilities), byCat: mapRound(byCat) };
  const last = data.history[data.history.length - 1];
  if (last && last.date === today) data.history[data.history.length - 1] = snap;
  else data.history.push(snap);
  recordGoalHistory(); // e o valor de cada objetivo nesse dia
  save();

  return { currency: BASE_CCY, net, assetsTotal, liabilities, byCat, broker, ibkr, history: data.history };
}
const round = (n) => Math.round(n * 100) / 100;
const mapRound = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));

function publicState() {
  const t = activeKey('trading212');
  return {
    assets: enriched(),
    resources: data.resources,
    goals: data.goals,
    platforms: PLATFORMS,
    // Nunca enviar a chave/segredo completos para o browser: só os últimos 4 caracteres
    keys: data.keys.map((k) => ({ id: k.id, platform: k.platform, label: k.label, env: k.env, hint: '••••' + k.key.slice(-4),
      hasSecret: Boolean(k.secret), createdAt: k.createdAt, updatedAt: k.updatedAt, active: activeKey(k.platform)?.id === k.id,
      summary: k.summary || null })),
    brokers: BROKERS,
    aiProviders: AI_PROVIDERS,
    aiProvider: aiProvider(),
    settings: {
      birthYear: data.settings.birthYear,
      birthDate: data.settings.birthDate || null,
      tax: data.tax || {},
      t212: { env: t?.env || 'live', configured: Boolean(t), keyHint: t ? '••••' + t.key.slice(-4) : '', hasSecret: Boolean(t?.secret) },
    },
  };
}
function resetBroker() {
  accountInfo = null; brokerCache = null; instruments = null; hist = null;
  ibkrCache = null; ibkrErr = null; try { fs.unlinkSync(IBKR_FILE); } catch {}
}

// ---------- Histórico da Trading 212: vendas, dividendos e juros (para estimar o IRS) ----------
// Precisa das permissões history:orders, history:dividends e history:transactions na chave (só leitura).
// Guardado em data/historico-cache.json durante 6 horas: os pedidos de histórico têm limite de 20 por minuto.
const HIST_FILE = path.join(DATA_DIR, 'historico-cache.json');
const HIST_KINDS = {
  orders: { path: '/equity/history/orders', scope: 'history:orders' },
  dividends: { path: '/equity/history/dividends', scope: 'history:dividends' },
  transactions: { path: '/equity/history/transactions', scope: 'history:transactions' },
};
let hist = null;
try { hist = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function t212AllPages(k, first) {
  const host = k.env === 'demo' ? 'https://demo.trading212.com' : 'https://live.trading212.com';
  const auth = k.secret ? 'Basic ' + Buffer.from(`${k.key}:${k.secret}`).toString('base64') : k.key;
  let next = `/api/v0${first}?limit=50`;
  const items = [];
  for (let page = 0; next && page < 400; page++) {
    const r = await fetch(host + next, { headers: { Authorization: auth } });
    if (r.status === 429) { // espera até o limite reabrir e repete a mesma página
      const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
      await sleep(Math.min(65_000, Math.max(1500, reset ? reset - Date.now() + 500 : 5000)));
      page--; continue;
    }
    if (!r.ok) { const e = new Error(`Trading 212 ${first}: HTTP ${r.status}`); e.status = r.status; throw e; }
    const j = await r.json();
    items.push(...(j.items || []));
    next = j.nextPagePath || null; // já traz /api/v0 e o cursor
    if (next && Number(r.headers.get('x-ratelimit-remaining')) <= 1) await sleep(3200);
  }
  return items;
}

// Só guardamos o que interessa ao IRS: vendas com resultado, dividendos e juros
const slim = {
  orders: (list) => list
    .filter((x) => x.order?.side === 'SELL' && (x.fill?.type || 'TRADE') === 'TRADE' && x.fill?.walletImpact)
    .map((x) => ({
      date: x.fill.filledAt, ticker: x.order.ticker, name: x.order.instrument?.name || x.order.ticker,
      qty: Math.abs(x.fill.quantity), price: x.fill.price, ccy: x.order.instrument?.currency || x.order.currency,
      pnl: x.fill.walletImpact.realisedProfitLoss, pnlCcy: x.fill.walletImpact.currency,
      fees: (x.fill.walletImpact.taxes || []).filter((t) => t.currency === x.fill.walletImpact.currency).reduce((s, t) => s + Math.abs(t.quantity || 0), 0),
    })),
  dividends: (list) => list.map((d) => ({
    date: d.paidOn, ticker: d.ticker, name: d.instrument?.name || d.ticker, type: d.type,
    amount: d.amount, ccy: d.currency, amountEUR: d.amountInEuro, qty: d.quantity, grossPerShare: d.grossAmountPerShare,
    tickerCcy: d.tickerCurrency || d.instrument?.currency, isin: d.instrument?.isin,
  })),
  transactions: (list) => list
    .filter((t) => t.type === 'INTEREST_ON_FREE_CASH' || t.type === 'LENDING_INTEREST')
    .map((t) => ({ date: t.dateTime, amount: t.amount, ccy: t.currency, type: t.type })),
};

let histLoading = null;
async function getHistory(force = false) {
  const k = activeKey('trading212');
  if (!k) return null;
  if (!force && hist && hist.keyId === k.id && Date.now() - hist.at < 6 * 3600_000) return hist;
  if (histLoading) return histLoading;
  histLoading = (async () => {
    const out = { at: Date.now(), keyId: k.id, missing: [], errors: [] };
    for (const [kind, def] of Object.entries(HIST_KINDS)) {
      try { out[kind] = slim[kind](await t212AllPages(k, def.path)); }
      catch (e) {
        out[kind] = (hist && hist.keyId === k.id && hist[kind]) || [];
        if (e.status === 403) out.missing.push(def.scope); else out.errors.push(e.message);
      }
    }
    hist = out;
    try { fs.writeFileSync(HIST_FILE, JSON.stringify(out)); } catch {}
    return out;
  })().finally(() => { histLoading = null; });
  return histLoading;
}

// Estimativa do IRS dos investimentos num ano (anexo J, taxa autónoma de 28%)
async function taxEstimate(year, force) {
  const h = await getHistory(force);
  if (!h) return { configured: false };
  const rates = await getRates();
  const inYear = (d) => d && new Date(d).getFullYear() === year;
  const toEUR = (v, c) => (v == null ? 0 : convert(v, c || BASE_CCY, BASE_CCY, rates) ?? v);

  // Mais e menos-valias: o resultado de cada venda calculado pela Trading 212
  const sells = h.orders.filter((o) => inYear(o.date)).map((o) => ({ ...o, pnlEUR: toEUR(o.pnl, o.pnlCcy) }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const gains = sells.filter((s) => s.pnlEUR > 0).reduce((s, x) => s + x.pnlEUR, 0);
  const losses = sells.filter((s) => s.pnlEUR < 0).reduce((s, x) => s + x.pnlEUR, 0);
  const net = gains + losses;
  const fees = sells.reduce((s, x) => s + toEUR(x.fees, x.pnlCcy), 0);

  // Dividendos estrangeiros: 28% do bruto, menos o imposto retido lá fora (crédito até 15%, a taxa típica das convenções).
  // Dividendos portugueses (EDP, NOS…): a retenção em Portugal é definitiva, não há mais imposto a pagar.
  const instr = await getInstruments();
  const divs = h.dividends.filter((d) => inYear(d.date)).map((d) => {
    const netEUR = d.amountEUR ?? toEUR(d.amount, d.ccy);
    const ccy = d.tickerCcy || instr[d.ticker]?.currencyCode;
    const grossRaw = d.grossPerShare && d.qty && ccy ? convert(d.grossPerShare * d.qty, ccy, BASE_CCY, rates) : null;
    const grossEUR = grossRaw != null && grossRaw >= netEUR ? grossRaw : netEUR;
    const withheld = Math.max(0, grossEUR - netEUR);
    const portuguese = (d.isin || '').startsWith('PT') || /_PT_/.test(d.ticker);
    const credit = portuguese ? withheld : Math.min(withheld, grossEUR * 0.15);
    return { ...d, netEUR, grossEUR, withheld, credit, portuguese, tax: portuguese ? 0 : Math.max(0, grossEUR * 0.28 - credit) };
  });
  const sumBy = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);

  // Juros do dinheiro parado (a Trading 212 paga sem reter imposto em Portugal)
  const interest = h.transactions.filter((t) => inYear(t.date)).reduce((s, t) => s + toEUR(t.amount, t.ccy), 0);

  return {
    configured: true, year, fetchedAt: h.at, missing: h.missing, errors: h.errors,
    sales: { count: sells.length, gains, losses, net, fees, tax: net > 0 ? net * 0.28 : 0,
      list: sells.slice(0, 40).map((s) => ({ date: s.date, ticker: s.ticker, name: s.name, qty: s.qty, pnl: s.pnlEUR })) },
    dividends: { count: divs.length, gross: sumBy(divs, 'grossEUR'), net: sumBy(divs, 'netEUR'), withheld: sumBy(divs, 'withheld'), credit: sumBy(divs, 'credit'), tax: sumBy(divs, 'tax'),
      ptGross: sumBy(divs.filter((d) => d.portuguese), 'grossEUR') },
    interest: { received: interest, tax: interest * 0.28 },
  };
}

// ---------- Assistente financeiro (Claude, via SDK oficial da Anthropic) ----------
// A chave fica na lista de chaves (plataforma "anthropic"). Os dados enviados ao modelo são um
// retrato do património construído aqui: nunca as chaves API.
let AnthropicSDK = null;
async function assistantClient() {
  const k = activeKey('anthropic');
  if (!k) return null;
  AnthropicSDK ||= (await import('@anthropic-ai/sdk')).default;
  return new AnthropicSDK({ apiKey: k.key });
}

const ASSISTANT_SYSTEM = `És o assistente financeiro pessoal do utilizador, dentro da app "Moneta", que ele próprio usa para acompanhar o seu dinheiro.

Quem é o utilizador: vive em Portugal (residente fiscal português), escreve em português de Portugal. Responde sempre em português de Portugal (não do Brasil), de forma direta, calorosa e concisa.

Como responder:
- Baseia-te nos dados do bloco "Dados atuais" e faz as contas por ele, com números concretos (formato português: 1.234,56 €).
- Se faltar um dado para responder bem, diz qual e onde se preenche na app (Definições, Poupança, Impostos…).
- Parágrafos curtos; listas quando ajudam. Evita tabelas grandes. Não repitas os dados todos: usa só os relevantes. Não uses travessões (o carácter —); usa vírgulas, dois pontos ou parênteses.
- A app é só de leitura: não executas ordens nem alteras dados. Se for útil, diz o que o utilizador pode fazer na app.

Contexto fiscal português que deves ter presente (confirma sempre no Portal das Finanças quando o assunto é decisivo):
- Juros, dividendos e mais-valias obtidos através de corretora estrangeira: declarados no anexo J; taxa autónoma de 28%, ou opção pelo englobamento.
- PPR: dedução à coleta de 20% das entregas do ano, até 400 € (menos de 35 anos a 1 de janeiro), 350 € (35–50) ou 300 € (mais de 50); conta para o limite global de deduções; resgates fora das condições legais obrigam a devolver o benefício.
- Crédito à habitação: garantia pública para jovens até aos 35 anos e isenções de IMT/Imposto do Selo na primeira habitação própria e permanente, dentro de limites que mudam todos os anos.

Limites: não és consultor financeiro certificado. Explica opções, riscos, cenários e contas, mas não dês ordens de compra ou venda de títulos concretos nem garantias de rentabilidade. Em decisões grandes (crédito, impostos complexos, vender posições), sugere confirmar com o banco ou um contabilista.`;

const fmt = (n) => n == null || isNaN(n) ? '–' : new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(n);
function ageOnJan1(year) {
  const bd = data.settings.birthDate, by = data.settings.birthYear;
  if (bd) return year - Number(bd.slice(0, 4)) - (bd.slice(5) === '01-01' ? 0 : 1);
  return by ? year - by - 1 : null;
}
async function financialSnapshot() {
  const s = await summary();
  const year = new Date().getFullYear();
  const L = [];
  L.push(`Data de hoje: ${new Date().toISOString().slice(0, 10)}`);
  const age = ageOnJan1(year);
  L.push(`Idade a 1 de janeiro de ${year}: ${age ?? 'desconhecida'}${data.settings.birthDate ? '' : ' (só se conhece o ano de nascimento)'}`);
  L.push(`\nPatrimónio líquido: ${fmt(s.net)} (ativos ${fmt(s.assetsTotal)}, passivos ${fmt(s.liabilities)})`);
  L.push('Distribuição: ' + Object.entries(s.byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(v)} (${(v / s.assetsTotal * 100).toFixed(1)}%)`).join('; '));
  const br = s.broker;
  if (br && br.positions) {
    L.push(`\nTrading 212 (${br.stale ? 'dados em cache' : 'atualizado'}): total ${fmt(br.totalEUR)}, investido ${fmt(br.invested)}, lucro/prejuízo em aberto ${fmt(br.ppl)}, resultado realizado desde sempre ${fmt(br.result)}, dinheiro livre ${fmt(br.free)} (rende juros diários; o utilizador reparte-o pelos objetivos na página Objetivos).`);
    L.push('Posições (ticker | nome | tipo | setor | valor | lucro/prejuízo | dividendos):');
    for (const p of br.positions) {
      const d = p.dividend || {};
      L.push(`- ${p.short} | ${p.name} | ${p.type} | ${p.sector || 'sem setor'} | ${fmt(p.value)} | ${fmt(p.ppl)} (${p.pplPct != null ? p.pplPct.toFixed(1) + '%' : '–'}) | ${d.status === 'paga' ? `paga, ${d.freq || ''}${d.months ? ', normalmente em ' + d.months : ''}` : d.status === 'acumula' ? 'ETF de acumulação' : d.status === 'nao' ? 'não paga' : 'desconhecido'}`);
    }
  } else L.push('\nTrading 212: sem dados (conta não ligada ou erro).');
  const assets = enriched();
  const pprs = assets.filter((a) => a.type === 'ppr');
  if (pprs.length) {
    L.push('\nPPR:');
    for (const a of pprs) {
      const byYear = a.computed ? a.contribByYear : { [year]: a.contribYear || 0 };
      L.push(`- ${a.name} (${a.entity || ''}${a.fundClass ? ', classe ' + a.fundClass : ''}): valor ${fmt(a.value)}, entregue no total ${fmt(a.contribTotal)}, entregas por ano ${JSON.stringify(byYear)}${a.computed ? `, ${a.units?.toFixed(4)} UP, cotação ${a.unitPrice ?? '–'} em ${a.unitPriceDate ?? '–'}` : ' (valor escrito à mão)'}`);
    }
  }
  const others = assets.filter((a) => a.type !== 'ppr');
  if (others.length) {
    L.push('\nOutros ativos e passivos (manuais):');
    for (const a of others) L.push(`- [${a.type}] ${a.name}${a.entity ? ' (' + a.entity + ')' : ''}: ${fmt(a.value)}${a.rate ? `, taxa ${a.rate}%` : ''}`);
  }
  const t = (data.tax || {})[year] || {};
  L.push(`\nImpostos ${year} (introduzidos à mão): taxa de juro do dinheiro livre ${t.interestRate ?? 2.5}%, juros já recebidos ${fmt(t.interestReceived ?? 0)}, dividendos brutos recebidos ${fmt(t.dividendsGross ?? 0)}, retido no estrangeiro ${fmt(t.dividendsWithheld ?? 0)}.`);
  const h = data.history.slice(-12);
  if (h.length) L.push('\nHistórico do património líquido (últimos registos): ' + h.map((x) => `${x.date} ${fmt(x.net)}`).join('; '));
  return L.join('\n');
}

function cleanChat(msgs) {
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > 40) throw new Error('conversa inválida');
  const out = msgs.map((m) => {
    if (!['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) throw new Error('mensagem inválida');
    return { role: m.role, content: m.content.slice(0, 8000) };
  });
  if (out[0].role !== 'user' || out[out.length - 1].role !== 'user') throw new Error('a conversa tem de começar e acabar no utilizador');
  return out;
}

async function assistantChat(req, res) {
  let messages;
  try { messages = cleanChat((await readBody(req)).messages); } catch (e) { return send(res, 400, { error: e.message }); }
  const provider = aiProvider();
  if (!provider) return send(res, 400, { error: 'Falta uma chave para o assistente (Definições → Ligações → Assistente).' });
  if (provider === 'gemini') return geminiChat(messages, res);
  const client = await assistantClient();

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  const out = (o) => res.write(JSON.stringify(o) + '\n');
  let stream = null;
  // Se o browser fechar a ligação a meio, pára o pedido ao modelo
  res.on('close', () => { if (stream && !res.writableEnded) stream.abort(); });
  try {
    const snapshot = await financialSnapshot();
    stream = client.beta.messages.stream({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      output_config: { effort: 'medium' },
      // Se o modelo recusar por segurança, a API tenta automaticamente outro modelo
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system: [
        { type: 'text', text: ASSISTANT_SYSTEM },
        { type: 'text', text: 'Dados atuais do utilizador (gerados pela app agora):\n\n' + snapshot },
      ],
      messages,
    });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') out({ t: 'text', d: ev.delta.text });
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') out({ t: 'error', m: 'O modelo não respondeu a este pedido por razões de segurança.' });
    else if (final.stop_reason === 'max_tokens') out({ t: 'note', m: 'A resposta foi cortada por ser demasiado longa.' });
    out({ t: 'done', usage: { input: final.usage.input_tokens, output: final.usage.output_tokens, cacheRead: final.usage.cache_read_input_tokens || 0 } });
  } catch (e) {
    const A = AnthropicSDK;
    const m = A && e instanceof A.AuthenticationError ? 'A chave da Anthropic é inválida ou foi revogada.'
      : A && e instanceof A.PermissionDeniedError ? 'A chave da Anthropic não tem permissão para este modelo.'
      : A && e instanceof A.RateLimitError ? 'Limite de pedidos da Anthropic atingido. Tenta daqui a pouco.'
      : A && e instanceof A.APIConnectionError ? 'Sem ligação à Anthropic. Verifica a internet.'
      : A && e instanceof A.APIError ? `Erro da Anthropic (${e.status ?? '?'}): ${e.message}`
      : e.name === 'APIUserAbortError' ? null : 'Erro: ' + e.message;
    if (m) out({ t: 'error', m });
  }
  res.end();
}

// ---------- Assistente com Google Gemini (chave gratuita do Google AI Studio) ----------
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
let geminiModel = null; // escolhido uma vez: o "flash" mais recente que a chave consegue usar
async function pickGeminiModel(key) {
  if (geminiModel) return geminiModel;
  try {
    const r = await fetch(`${GEMINI_API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    const list = r.ok ? (await r.json()).models || [] : [];
    const flash = list
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ name: m.name.replace(/^models\//, ''), v: Number((m.name.match(/^models\/gemini-(\d+(?:\.\d+)?)-flash$/) || [])[1]) }))
      .filter((m) => m.v)
      .sort((a, b) => b.v - a.v);
    geminiModel = flash[0]?.name || 'gemini-2.5-flash';
  } catch { geminiModel = 'gemini-2.5-flash'; }
  return geminiModel;
}

async function geminiChat(messages, res) {
  const key = activeKey('gemini').key;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  const out = (o) => res.write(JSON.stringify(o) + '\n');
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
  try {
    const [snapshot, model] = [await financialSnapshot(), await pickGeminiModel(key)];
    const r = await fetch(`${GEMINI_API}/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: ASSISTANT_SYSTEM + '\n\nDados atuais do utilizador (gerados pela app agora):\n\n' + snapshot }] },
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      }),
    });
    if (!r.ok) {
      const msg = (await r.json().catch(() => ({}))).error?.message || '';
      throw new Error(r.status === 400 && /API key/i.test(msg) ? 'A chave do Gemini é inválida.'
        : r.status === 403 ? 'A chave do Gemini não tem acesso a este modelo.'
        : r.status === 429 ? 'Chegaste ao limite gratuito do Gemini. Tenta mais tarde.'
        : `Erro do Gemini (${r.status}): ${msg.slice(0, 200)}`);
    }
    let buf = '', usage = null, finish = null;
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));
        const cand = ev.candidates?.[0];
        for (const p of cand?.content?.parts || []) if (p.text && !p.thought) out({ t: 'text', d: p.text });
        if (cand?.finishReason) finish = cand.finishReason;
        if (ev.usageMetadata) usage = ev.usageMetadata;
      }
    }
    if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') out({ t: 'error', m: 'O Gemini não respondeu a este pedido por razões de segurança.' });
    else if (finish === 'MAX_TOKENS') out({ t: 'note', m: 'A resposta foi cortada por ser demasiado longa.' });
    out({ t: 'done', usage: { input: usage?.promptTokenCount || 0, output: usage?.candidatesTokenCount || 0, cacheRead: usage?.cachedContentTokenCount || 0 } });
  } catch (e) {
    if (e.name !== 'AbortError') out({ t: 'error', m: e.message.startsWith('fetch failed') ? 'Sem ligação ao Gemini. Verifica a internet.' : e.message });
  }
  res.end();
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

const ASSET_FIELDS = ['type', 'name', 'entity', 'value', 'notes', 'contribYear', 'contribTotal', 'rate', 'fundClass', 'unitPrice', 'unitPriceDate'];
const NUM_FIELDS = ['value', 'contribYear', 'contribTotal', 'rate', 'unitPrice'];
function cleanAsset(body) {
  const a = {};
  for (const f of ASSET_FIELDS) if (body[f] !== undefined) a[f] = body[f];
  for (const f of NUM_FIELDS) if (a[f] !== undefined) a[f] = a[f] === '' || a[f] === null ? null : Number(a[f]);
  return a;
}
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function cleanMovement(b) {
  const amount = Number(b.amount);
  let units = b.units === '' || b.units == null ? null : Number(b.units);
  const price = b.price === '' || b.price == null ? null : Number(b.price);
  if (!isDate(b.date)) throw new Error('data inválida');
  if (!(amount > 0)) throw new Error('montante inválido');
  // O Save & Grow não tem comissão de subscrição: unidades = montante / valor da UP nesse dia.
  if (!(units > 0) && price > 0) units = amount / price;
  if (!(units > 0)) throw new Error('indica o número de unidades ou o valor da UP nesse dia');
  return { id: crypto.randomUUID(), date: b.date, amount, units, price: price || amount / units, note: String(b.note || '').slice(0, 200) };
}

const server = http.createServer(async (req, res) => {
  // Bloqueia pedidos de outros sites (DNS rebinding / CSRF)
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1'].includes(host)) return send(res, 403, { error: 'host não permitido' });
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return send(res, 403, { error: 'origem não permitida' });

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, publicState());
    if (p === '/api/summary' && req.method === 'GET') return send(res, 200, await summary());
    if (p === '/api/broker/refresh' && req.method === 'POST') { await getBroker(true); return send(res, 200, await summary()); }

    if (p === '/api/assets' && req.method === 'POST') {
      const body = await readBody(req);
      const a = cleanAsset(body);
      if (!a.name || !a.type) return send(res, 400, { error: 'nome e tipo são obrigatórios' });
      const now = new Date().toISOString();
      if (body.id) {
        const i = data.assets.findIndex((x) => x.id === body.id);
        if (i < 0) return send(res, 404, { error: 'não encontrado' });
        const prev = data.assets[i];
        data.assets[i] = { ...prev, ...a, updatedAt: now };
      } else {
        data.assets.push({ id: crypto.randomUUID(), ...a, createdAt: now, updatedAt: now });
      }
      save();
      return send(res, 200, publicState());
    }
    // Entregas de um PPR/fundo
    const mvAdd = p.match(/^\/api\/assets\/([\w-]+)\/movements$/);
    if (mvAdd && req.method === 'POST') {
      const a = data.assets.find((x) => x.id === mvAdd[1]);
      if (!a) return send(res, 404, { error: 'não encontrado' });
      let m;
      try { m = cleanMovement(await readBody(req)); } catch (e) { return send(res, 400, { error: e.message }); }
      (a.movements ||= []).push(m);
      a.movements.sort((x, y) => x.date.localeCompare(y.date));
      a.updatedAt = new Date().toISOString();
      save();
      return send(res, 200, publicState());
    }
    const mvDel = p.match(/^\/api\/assets\/([\w-]+)\/movements\/([\w-]+)$/);
    if (mvDel && req.method === 'DELETE') {
      const a = data.assets.find((x) => x.id === mvDel[1]);
      if (!a) return send(res, 404, { error: 'não encontrado' });
      a.movements = (a.movements || []).filter((m) => m.id !== mvDel[2]);
      save();
      return send(res, 200, publicState());
    }
    // Cotação (valor da UP)
    const px = p.match(/^\/api\/assets\/([\w-]+)\/price$/);
    if (px && req.method === 'POST') {
      const a = data.assets.find((x) => x.id === px[1]);
      if (!a) return send(res, 404, { error: 'não encontrado' });
      const b = await readBody(req);
      const price = Number(b.price);
      if (!(price > 0)) return send(res, 400, { error: 'cotação inválida' });
      a.unitPrice = price;
      a.unitPriceDate = isDate(b.date) ? b.date : new Date().toISOString().slice(0, 10);
      (a.priceHistory ||= []).push({ date: a.unitPriceDate, price });
      a.updatedAt = new Date().toISOString();
      save();
      return send(res, 200, publicState());
    }

    const del = p.match(/^\/api\/assets\/([\w-]+)$/);
    if (del && req.method === 'DELETE') {
      data.assets = data.assets.filter((x) => x.id !== del[1]);
      save();
      return send(res, 200, publicState());
    }

    if (p === '/api/sectors' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.ticker !== 'string' || !b.ticker) return send(res, 400, { error: 'ticker em falta' });
      const sector = String(b.sector || '').trim().slice(0, 60);
      data.sectors ||= {};
      if (sector) data.sectors[b.ticker] = sector; else delete data.sectors[b.ticker];
      save();
      for (const c of [brokerCache, ibkrCache]) if (c?.value?.positions) for (const x of c.value.positions) x.sector = sectorOf(x.ticker, x.short);
      return send(res, 200, { ok: true });
    }

    // Estimativa do IRS dos investimentos a partir do histórico da Trading 212
    if (p === '/api/tax/estimate' && req.method === 'GET') {
      const year = Number(url.searchParams.get('year')) || new Date().getFullYear();
      try { return send(res, 200, await taxEstimate(year, url.searchParams.get('refresh') === '1')); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }

    // Dados fiscais por ano (introduzidos à mão quando não há acesso ao histórico)
    if (p === '/api/tax' && req.method === 'POST') {
      const b = await readBody(req);
      const year = String(b.year || '');
      if (!/^\d{4}$/.test(year)) return send(res, 400, { error: 'ano inválido' });
      const FIELDS = ['interestRate', 'interestReceived', 'dividendsGross', 'dividendsWithheld', 'gains', 'losses'];
      const cur = ((data.tax ||= {})[year] ||= {});
      for (const f of FIELDS) if (b[f] !== undefined) cur[f] = b[f] === '' || b[f] === null ? null : Number(b[f]);
      save();
      return send(res, 200, { ok: true, tax: data.tax });
    }

    if (p === '/api/assistant/chat' && req.method === 'POST') return assistantChat(req, res);

    const lg = p.match(/^\/api\/logo\/([\w.-]{1,12})$/);
    if (lg && req.method === 'GET') {
      const logo = await getLogo(decodeURIComponent(lg[1]));
      if (!logo) return send(res, 404, { error: 'sem logótipo' });
      res.writeHead(200, { 'Content-Type': logo.type, 'Cache-Control': 'max-age=604800' });
      return res.end(logo.buf);
    }

    // ----- Ligações às corretoras: testar e depois guardar -----
    if (p === '/api/connections/test' && req.method === 'POST') {
      const b = await readBody(req);
      if (!BROKERS.includes(b.platform)) return send(res, 400, { error: 'corretora desconhecida' });
      const cred = { platform: b.platform, key: String(b.key || '').trim(), secret: String(b.secret || '').trim(), env: b.env === 'demo' ? 'demo' : 'live' };
      if (!cred.key) return send(res, 400, { error: 'Cola a chave primeiro.' });
      if (b.platform === 'ibkr' && !cred.secret) return send(res, 400, { error: 'Falta o ID do relatório Flex.' });
      try {
        const result = await CONN_TESTS[b.platform](cred);
        for (const [id, t] of connTests) if (Date.now() - t.at > 15 * 60_000) connTests.delete(id);
        const testId = crypto.randomUUID();
        connTests.set(testId, { cred, result, at: Date.now() });
        return send(res, 200, { ok: true, testId, result });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }
    if (p === '/api/connections' && req.method === 'POST') {
      const b = await readBody(req);
      const t = connTests.get(String(b.testId || ''));
      if (!t || Date.now() - t.at > 15 * 60_000) return send(res, 400, { error: 'Testa a ligação outra vez antes de guardar.' });
      connTests.delete(b.testId);
      const now = new Date().toISOString();
      const k = { id: crypto.randomUUID(), platform: t.cred.platform, label: String(b.label || '').trim().slice(0, 60) || PLATFORMS[t.cred.platform],
        env: t.cred.env, key: t.cred.key, secret: t.cred.secret, createdAt: now, updatedAt: now,
        summary: { ...t.result, at: now } };
      data.keys.push(k);
      data.activeKeys[k.platform] = k.id; // a ligação nova passa a ser a usada
      if (BROKERS.includes(k.platform)) resetBroker();
      save();
      return send(res, 200, { ...publicState(), savedId: k.id });
    }

    // ----- Chaves API -----
    if (p === '/api/keys' && req.method === 'POST') {
      const b = await readBody(req);
      if (!PLATFORMS[b.platform]) return send(res, 400, { error: 'plataforma desconhecida' });
      const key = String(b.key || '').trim(), secret = String(b.secret || '').trim();
      if (!key) return send(res, 400, { error: 'a chave é obrigatória' });
      const now = new Date().toISOString();
      const k = { id: crypto.randomUUID(), platform: b.platform, label: String(b.label || '').trim().slice(0, 60) || 'Chave',
        env: b.env === 'demo' ? 'demo' : 'live', key, secret, createdAt: now, updatedAt: now };
      data.keys.push(k);
      if (!activeKey(b.platform) || b.activate) data.activeKeys[b.platform] = k.id;
      if (AI_PROVIDERS.includes(b.platform) && (b.activate || !aiProvider())) data.settings.aiProvider = b.platform;
      if (activeKey(b.platform).id === k.id) resetBroker();
      save();
      return send(res, 200, publicState());
    }
    const kAct = p.match(/^\/api\/keys\/([\w-]+)\/activate$/);
    if (kAct && req.method === 'POST') {
      const k = data.keys.find((x) => x.id === kAct[1]);
      if (!k) return send(res, 404, { error: 'não encontrada' });
      data.activeKeys[k.platform] = k.id;
      if (AI_PROVIDERS.includes(k.platform)) data.settings.aiProvider = k.platform; // "Usar" também escolhe o modelo do assistente
      resetBroker(); save();
      return send(res, 200, publicState());
    }
    const kId = p.match(/^\/api\/keys\/([\w-]+)$/);
    if (kId && req.method === 'POST') {
      const k = data.keys.find((x) => x.id === kId[1]);
      if (!k) return send(res, 404, { error: 'não encontrada' });
      const b = await readBody(req);
      if (typeof b.label === 'string' && b.label.trim()) k.label = b.label.trim().slice(0, 60);
      if (b.env) k.env = b.env === 'demo' ? 'demo' : 'live';
      if (typeof b.key === 'string' && b.key.trim()) k.key = b.key.trim();
      if (typeof b.secret === 'string' && b.secret.trim()) k.secret = b.secret.trim();
      if (b.clearSecret) k.secret = '';
      k.updatedAt = new Date().toISOString();
      if (activeKey(k.platform)?.id === k.id) resetBroker();
      save();
      return send(res, 200, publicState());
    }
    if (kId && req.method === 'DELETE') {
      const k = data.keys.find((x) => x.id === kId[1]);
      if (!k) return send(res, 404, { error: 'não encontrada' });
      const wasActive = activeKey(k.platform)?.id === k.id;
      data.keys = data.keys.filter((x) => x.id !== k.id);
      if (wasActive) { delete data.activeKeys[k.platform]; resetBroker(); }
      save();
      return send(res, 200, publicState());
    }

    // ----- Objetivos (casa, fundo de emergência, PPR, outros) -----
    if (p === '/api/goals' && req.method === 'POST') {
      const b = await readBody(req);
      const over = allocError({ [b.id || '__novo']: cleanAlloc(b.alloc) });
      if (over) return send(res, 400, { error: over });
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return send(res, 400, { error: 'o nome é obrigatório' });
      const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
      const g = {
        name, kind: ['casa', 'emergencia', 'ppr', 'outro'].includes(b.kind) ? b.kind : 'outro',
        target: num(b.target), saved: num(b.saved), monthly: num(b.monthly),
        deadline: /^\d{4}-\d{2}$/.test(b.deadline || '') ? b.deadline : '',
        note: String(b.note || '').trim().slice(0, 160), primary: Boolean(b.primary),
        alloc: cleanAlloc(b.alloc),
      };
      if (g.primary) for (const x of data.goals) x.primary = false;
      const now = new Date().toISOString();
      if (b.id) {
        const x = data.goals.find((y) => y.id === b.id);
        if (!x) return send(res, 404, { error: 'não encontrado' });
        const changes = describeGoalChange(x, g);
        Object.assign(x, g, { updatedAt: now });
        if (changes.length) logGoal(x, changes.join(' · '));
      } else {
        const ng = { id: crypto.randomUUID(), ...g, createdAt: now, updatedAt: now };
        logGoal(ng, ['Objetivo criado', ...describeAlloc({}, g.alloc)].join(' · '));
        data.goals.push(ng);
      }
      if (!data.goals.some((x) => x.primary) && data.goals.length) data.goals[0].primary = true;
      recordGoalHistory(); // o valor de hoje passa logo a refletir a alteração
      save();
      return send(res, 200, publicState());
    }
    // Repartir o dinheiro livre por vários objetivos de uma vez: { alloc: { goalId: { fonte: € } } }
    if (p === '/api/goals/alloc' && req.method === 'POST') {
      const b = await readBody(req);
      const next = {};
      for (const g of data.goals) if (b.alloc && Object.hasOwn(b.alloc, g.id)) next[g.id] = cleanAlloc(b.alloc[g.id]);
      const over = allocError(next);
      if (over) return send(res, 400, { error: over });
      for (const g of data.goals) if (next[g.id]) {
        const lines = describeAlloc(g.alloc, next[g.id]);
        g.alloc = next[g.id];
        if (lines.length) logGoal(g, 'Repartir · ' + lines.join(' · '));
      }
      recordGoalHistory();
      save();
      return send(res, 200, publicState());
    }
    const gDel = p.match(/^\/api\/goals\/([\w-]+)$/);
    if (gDel && req.method === 'DELETE') {
      data.goals = data.goals.filter((x) => x.id !== gDel[1]);
      if (!data.goals.some((x) => x.primary) && data.goals.length) data.goals[0].primary = true;
      save();
      return send(res, 200, publicState());
    }

    // ----- Recursos -----
    if (p === '/api/resources' && req.method === 'POST') {
      const b = await readBody(req);
      const title = String(b.title || '').trim().slice(0, 140);
      const url = String(b.url || '').trim();
      if (!title) return send(res, 400, { error: 'o título é obrigatório' });
      if (url && !isHttpUrl(url)) return send(res, 400, { error: 'o link tem de começar por http:// ou https://' });
      const fields = { title, url, category: String(b.category || 'Outro').trim().slice(0, 40), note: String(b.note || '').trim().slice(0, 1000) };
      if (b.id) {
        const r = data.resources.find((x) => x.id === b.id);
        if (!r) return send(res, 404, { error: 'não encontrado' });
        Object.assign(r, fields, { updatedAt: new Date().toISOString() });
      } else data.resources.unshift({ id: crypto.randomUUID(), ...fields, createdAt: new Date().toISOString() });
      save();
      return send(res, 200, publicState());
    }
    const rDel = p.match(/^\/api\/resources\/([\w-]+)$/);
    if (rDel && req.method === 'DELETE') {
      data.resources = data.resources.filter((x) => x.id !== rDel[1]);
      save();
      return send(res, 200, publicState());
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.birthYear !== undefined) data.settings.birthYear = b.birthYear ? Number(b.birthYear) : null;
      if (b.birthDate !== undefined) {
        data.settings.birthDate = isDate(b.birthDate) ? b.birthDate : null;
        if (data.settings.birthDate) data.settings.birthYear = Number(b.birthDate.slice(0, 4));
      }
      if (b.t212) {
        const t = data.settings.t212;
        if (b.t212.env) t.env = b.t212.env === 'demo' ? 'demo' : 'live';
        if (typeof b.t212.key === 'string' && b.t212.key.trim()) t.key = b.t212.key.trim();
        if (typeof b.t212.secret === 'string' && b.t212.secret.trim()) t.secret = b.t212.secret.trim();
        if (b.t212.clear) { t.key = ''; t.secret = ''; }
        accountInfo = null; brokerCache = null; instruments = null;
      }
      save();
      return send(res, 200, publicState());
    }

    // Ficheiros estáticos
    if (req.method === 'GET') {
      const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
      if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'proibido' });
      return fs.readFile(file, (err, buf) => {
        if (err) return send(res, 404, { error: 'não encontrado' });
        // no-cache: o browser confirma sempre se há versão nova (evita ver a app desatualizada)
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Moneta a correr em  http://localhost:${PORT}\n`);
});
