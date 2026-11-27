// Validação da interface com Playwright.
// Arranca um servidor Moneta descartável (porta livre, cópia dos dados SEM chaves API, numa pasta temporária),
// dá à página uma carteira fictícia e percorre todas as páginas em ecrã largo e telemóvel.
// Uso: node scripts/validar.mjs   (sai com código 1 se alguma verificação falhar)
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.validacao');
const VIEWS = ['visao', 'investimentos', 'impostos', 'poupanca', 'objetivos', 'assistente', 'recursos'];
const SIZES = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'telemovel', width: 375, height: 812, isMobile: true }];

// Carteira fictícia: só para exercitar a página de Investimentos sem tocar na corretora
const FAKE_POSITIONS = [
  { ticker: 'AAA_US_EQ', short: 'AAA', name: 'Alpha Tech Inc.', type: 'STOCK', sector: 'Tecnologia', quantity: 10.5, averagePrice: 100, currentPrice: 120, priceCcy: 'USD', value: 1160, ppl: 190, pplPct: 19.6, dividend: { status: 'paga', freq: 'trimestral', months: 'mar · jun · set · dez' } },
  { ticker: 'BBB_EQ', short: 'BBB', name: 'Beta Saúde SA', type: 'STOCK', sector: 'Saúde', quantity: 20, averagePrice: 40, currentPrice: 35, priceCcy: 'EUR', value: 700, ppl: -100, pplPct: -12.5, dividend: { status: 'nao' } },
  { ticker: 'CCCa_EQ', short: 'CCC', isin: 'XX0000000CCC', broker: 't212', name: 'iShares Core MSCI World UCITS ETF (Acc)', type: 'ETF', sector: 'Diversificado (ETF)', quantity: 5.25, averagePrice: 90, currentPrice: 100, priceCcy: 'EUR', value: 525, ppl: 52.5, pplPct: 11.1, dividend: { status: 'acumula' } },
  { ticker: 'DDD_EQ', short: 'DDD', name: 'Delta Ouro ETC', type: 'ETF', sector: 'Ouro e matérias-primas', quantity: 1, averagePrice: 300, currentPrice: 290, priceCcy: 'EUR', value: 290, ppl: -10, pplPct: -3.3, dividend: { status: 'desconhecido' } },
];
const FAKE_BROKER = { currency: 'EUR', total: 3181.7, free: 506.7, invested: 2542.5, ppl: 132.5, result: -20, totalEUR: 3181.7, freeEUR: 506.7, positions: FAKE_POSITIONS, fetchedAt: new Date().toISOString() };
// IBKR fictícia (extrato de ontem): CCC também está na Trading 212 (mesmo ISIN), EEE só aqui, e dinheiro em euros e dólares
const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const FAKE_IBKR_POSITIONS = [
  { ticker: 'ibkr:1001', broker: 'ibkr', short: 'CCC', isin: 'XX0000000CCC', name: 'ISHARES CORE MSCI WORLD', type: 'ETF', sector: 'Diversificado (ETF)', quantity: 3, averagePrice: 90, currentPrice: 100, priceCcy: 'EUR', value: 300, ppl: 30, pplPct: 11.1, dividend: { status: 'acumula' } },
  { ticker: 'ibkr:1002', broker: 'ibkr', short: 'EEE', isin: 'XX0000000EEE', name: 'Epsilon Energia', type: 'STOCK', sector: 'Energia', quantity: 40, averagePrice: 10.5, currentPrice: 10, priceCcy: 'EUR', value: 400, ppl: -20, pplPct: -4.8, dividend: { status: 'paga', freq: 'anual', months: 'mai' } },
];
const FAKE_IBKR = { broker: 'ibkr', currency: 'EUR', total: 1238, totalEUR: 1238, free: 538, freeEUR: 538, invested: 690, ppl: 10,
  cash: [{ ccy: 'EUR', amount: 150, eur: 150 }, { ccy: 'USD', amount: 420, eur: 388 }], positions: FAKE_IBKR_POSITIONS,
  statementDate: localYmd(new Date(Date.now() - 864e5)), fxDate: localYmd(new Date(Date.now() - 864e5)), fetchedAt: new Date().toISOString() };
const FAKE_IBKR_KEY = { id: 'fake-ibkr', platform: 'ibkr', label: 'IBKR (teste)', env: 'live', hint: '••••0000', hasSecret: true, active: true, createdAt: new Date().toISOString() };
const ALL_ROWS = FAKE_POSITIONS.length + 1; // CCC junta-se numa linha; EEE é a linha a mais

function dataFile() {
  const dir = process.env.MONETA_DATA ? path.resolve(process.env.MONETA_DATA)
    : process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Moneta')
    : path.join(os.homedir(), '.moneta');
  return path.join(dir, 'patrimonio.json');
}

// Cópia dos dados sem nenhuma chave: o servidor de teste nunca fala com a Trading 212, IBKR, Anthropic ou Google
function sanitizedDataDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moneta-validar-'));
  let data = {};
  try { data = JSON.parse(fs.readFileSync(dataFile(), 'utf8')); } catch {}
  data.keys = []; data.activeKeys = {};
  // Histórico fictício nos objetivos (só nesta cópia) para testar a linha do caminho real
  const ago = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  for (const g of data.goals || []) g.hist = [{ d: ago(20), v: 0 }, { d: ago(10), v: 50 }, { d: ago(3), v: 120 }];
  if (data.settings?.t212) data.settings.t212 = { env: 'live' };
  fs.writeFileSync(path.join(tmp, 'patrimonio.json'), JSON.stringify(data));
  return tmp;
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().once('error', rej).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer() {
  const port = await freePort(), dir = sanitizedDataDir();
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), MONETA_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(url + '/api/state')).ok) return { url, proc, dir }; } catch {}
    if (proc.exitCode != null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  throw new Error('O servidor de teste não arrancou.\n' + log.slice(-800));
}

export async function validar({ screenshots = true } = {}) {
  const fails = [], checks = [];
  const ok = (cond, msg) => { checks.push(msg); if (!cond) fails.push(msg); };
  fs.rmSync(OUT, { recursive: true, force: true });
  if (screenshots) fs.mkdirSync(OUT, { recursive: true });
  const srv = await startServer();
  const browser = await chromium.launch();
  try {
    for (const size of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.isMobile, hasTouch: !!size.isMobile, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
      // Dá à página a carteira fictícia (o servidor de teste não tem chaves)
      await page.route('**/api/state', async (route) => {
        const r = await route.fetch(); const j = await r.json();
        j.settings = { ...j.settings, t212: { ...(j.settings?.t212 || {}), configured: true, env: 'live' } };
        j.keys = [...(j.keys || []), FAKE_IBKR_KEY];
        await route.fulfill({ response: r, json: j });
      });
      await page.route('**/api/summary', async (route) => {
        const r = await route.fetch(); const j = await r.json();
        j.broker = FAKE_BROKER;
        j.ibkr = FAKE_IBKR;
        await route.fulfill({ response: r, json: j });
      });
      await page.goto(srv.url + '/#visao', { waitUntil: 'networkidle' });
      for (const v of VIEWS) {
        const where = `${v} (${size.name})`;
        await page.evaluate((h) => { location.hash = h; }, v);
        await page.waitForTimeout(350);
        const info = await page.evaluate((id) => {
          const el = document.getElementById('v-' + id);
          return { visible: !!el && !el.hidden && el.offsetParent !== null, text: el ? el.innerText.trim().length : 0,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        }, v);
        ok(info.visible, `${where}: a página aparece`);
        ok(info.text > 20, `${where}: a página tem conteúdo`);
        ok(info.overflow <= 1, `${where}: sem scroll para o lado (${info.overflow}px a mais)`);
        if (v === 'investimentos') {
          const tabs = page.locator('.ib-tab');
          ok(await tabs.count() === 3, `${where}: três separadores (Todas, Trading 212, IBKR) (encontrou ${await tabs.count()})`);
          const rows = await page.locator('button.lg-row').count();
          ok(rows === ALL_ROWS, `${where}: "Todas" junta as duas corretoras em ${ALL_ROWS} linhas (encontrou ${rows})`);
          if (rows) {
            await page.locator('button.lg-row').first().click();
            ok(await page.locator('.lg-detail').count() === 1, `${where}: clicar numa linha abre o detalhe`);
          }
          // Cores fixas: cada posição guarda a cor de "Todas" nos separadores de cada corretora
          const colors = () => page.$$eval('button.lg-row', (bs) => Object.fromEntries(bs.map((b) => [b.dataset.open, b.dataset.color])));
          const allColors = await colors();
          // A linha partilhada (CCC) abre com a divisão por corretora
          const sharedRow = page.locator('button.lg-row[data-open="p:XX0000000CCC"]');
          ok(await sharedRow.count() === 1 && /T212 e IBKR/.test(await sharedRow.innerText()), `${where}: CCC aparece numa só linha, "T212 e IBKR"`);
          if (await sharedRow.count()) {
            await sharedRow.click();
            const det = await page.locator('.lg-detail').textContent();
            ok(await page.locator('.lg-detail .lg-split .lg-sp').count() === 2 && /Onde está/.test(det), `${where}: a linha partilhada abre com "Onde está" e uma linha por corretora`);
            ok(/Cada corretora declara o seu lote/.test(det) && /fecho de/.test(det), `${where}: o detalhe diz o fecho da IBKR e a nota de impostos por corretora`);
          }
          ok(/Dinheiro livre nas duas/.test(await page.locator('.lg-rail').textContent()), `${where}: coluna "Corretoras" com "Dinheiro livre nas duas"`);
          // Separador IBKR: só as linhas da IBKR, com as mesmas cores
          await page.locator('.ib-tab[data-broker="ibkr"]').click();
          const ibRows = await page.locator('button.lg-row').count();
          ok(ibRows === FAKE_IBKR_POSITIONS.length, `${where}: o separador IBKR mostra só as ${FAKE_IBKR_POSITIONS.length} posições da IBKR (encontrou ${ibRows})`);
          const ibColors = await colors();
          ok(Object.keys(ibColors).length > 0 && Object.entries(ibColors).every(([k, c]) => allColors[k] === c), `${where}: cada ticker tem a mesma cor em "Todas" e no separador IBKR`);
          ok(/mais 5,25 na T212/.test(await page.locator('button.lg-row[data-open="p:XX0000000CCC"]').innerText()), `${where}: na IBKR, CCC diz "mais 5,25 na T212"`);
          const ibText = await page.locator('#brokerBody').textContent();
          ok(/Preço \(fecho\)/.test(ibText) && /Dinheiro na IBKR/.test(ibText) && /Dólares/.test(ibText), `${where}: IBKR com "Preço (fecho)" e o dinheiro moeda a moeda`);
          ok(await page.locator('.ib-tab[data-broker="ibkr"] .ib-s.warn, .ib-tab[data-broker="ibkr"] .ib-s.err').count() === 0, `${where}: extrato de ontem com a bolinha verde`);
          const tones = await page.evaluate(() => {
            const d = new Date(Date.now() - 10 * 864e5), iso = ymdLocal(d);
            return [brokerFresh({ id: 'ibkr', ok: true, d: { statementDate: iso } }).tone, brokerFresh({ id: 'ibkr', ok: false, d: { error: 'x' } }).tone,
              brokerFresh({ id: 'ibkr', ok: true, d: { statementDate: ymdLocal(new Date()), stale: true } }).tone];
          });
          ok(tones.join() === 'warn,err,warn', `${where}: IBKR fica âmbar sem extrato novo há 2+ dias úteis ou em cache, e vermelha sem dados (${tones.join()})`);
          const ibOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          ok(ibOverflow <= 1, `${where}: separador IBKR sem scroll para o lado (${ibOverflow}px a mais)`);
          if (screenshots) await page.screenshot({ path: path.join(OUT, `${size.name}-investimentos-ibkr.png`), fullPage: true });
          await page.locator('.ib-tab[data-broker="t212"]').click();
          ok(await page.locator('button.lg-row').count() === FAKE_POSITIONS.length, `${where}: o separador Trading 212 mostra só as posições da Trading 212`);
          // Volta a "Todas" com a linha partilhada aberta (para a captura)
          await page.locator('.ib-tab[data-broker="all"]').click();
          if (await sharedRow.count()) await sharedRow.click();
          const allOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          ok(allOverflow <= 1, `${where}: "Todas" com a divisão aberta sem scroll para o lado (${allOverflow}px a mais)`);
        }
        if (v === 'objetivos') {
          ok(await page.locator('.g-money .gm-bar').count() > 0, `${where}: faixa "Dinheiro para objetivos" aparece`);
          const rep = page.getByRole('button', { name: 'Repartir' });
          if (await rep.count()) {
            await rep.click();
            const inp = page.locator('#fAlloc input').first();
            ok(await inp.isVisible(), `${where}: janela "Repartir" abre com campos`);
            await inp.fill('999999');
            ok(/a mais do que tens/.test(await page.locator('#fAlloc .al-left').first().innerText()), `${where}: "Repartir" avisa quando se atribui demais`);
            const saveBtn = page.locator('#fAlloc button[type="submit"]');
            ok(await saveBtn.isDisabled(), `${where}: "Repartir" não deixa guardar mais dinheiro do que existe`);
            await page.locator('#fAlloc').evaluate((f) => f.requestSubmit()); // mesmo forçando o envio, nada é guardado
            await page.waitForTimeout(300);
            ok(await page.locator('#dlgAlloc').evaluate((d) => d.open), `${where}: forçar o envio com dinheiro a mais não fecha nem guarda`);
            if (size.name === 'desktop') { // guardar só no servidor de teste (cópia temporária dos dados)
              for (const i of await page.locator('#fAlloc input').all()) await i.fill(''); // a cópia pode trazer repartições reais
              await inp.fill('506.70');
              await inp.dispatchEvent('input');
              ok(await saveBtn.isEnabled(), `${where}: dá para repartir o dinheiro todo, ao cêntimo (506,70 €)`);
              await inp.fill('506.71');
              ok(await saveBtn.isDisabled(), `${where}: um cêntimo a mais (506,71 €) já não deixa guardar`);
              await inp.fill('');
              await page.locator('#fAlloc [data-rest]').first().click();
              ok(Math.abs(Number(await inp.inputValue()) - 506.7) < 0.001, `${where}: "+ Resto" põe exatamente o que falta (encontrou ${await inp.inputValue()})`);
              await inp.fill('300');
              ok(await saveBtn.isEnabled(), `${where}: com um valor dentro do que existe, "Guardar" volta a ficar ativo`);
              await page.locator('#fAlloc button[type="submit"]').click();
              await page.waitForTimeout(400);
              ok(await page.locator('.g-money .gm-bar span:not(.gm-free)').count() > 0, `${where}: depois de repartir, a faixa mostra a parte do objetivo`);
              ok(/300/.test(await page.locator('.gm-legend').innerText()), `${where}: a legenda mostra os 300 € atribuídos`);
              if (await page.locator('.g-main .g-chart').count())
                ok(await page.locator('.g-main .g-chart path[stroke-width="2.5"]').count() === 1, `${where}: o gráfico do objetivo mostra o caminho real (histórico)`);
              await page.getByRole('button', { name: 'Histórico' }).click();
              ok(await page.locator('#dlgGoalHist').evaluate((d) => d.open), `${where}: a janela "Histórico" abre`);
              ok(await page.locator('#dlgGoalHist .gh-sum').count() === 1, `${where}: o "Histórico" resume a evolução do valor`);
              await page.keyboard.press('Escape');
            } else await page.keyboard.press('Escape');
          }
        }
        if (v === 'recursos') ok(await page.locator('.res-card').count() > 0, `${where}: há cartões de recursos`);
        if (screenshots) await page.screenshot({ path: path.join(OUT, `${size.name}-${v}.png`), fullPage: true });
      }
      // Definições → Ligações → Nova ligação (sem guardar nada)
      await page.evaluate(() => { location.hash = 'visao'; });
      await page.locator('#btnSettings').click();
      await page.locator('#setTabs button[data-t="ligacoes"]').click();
      const novo = page.getByRole('button', { name: '+ Nova ligação' });
      ok(await novo.isVisible(), `ligações (${size.name}): botão "+ Nova ligação" visível`);
      if (await novo.isVisible()) {
        await novo.click();
        ok(await page.locator('.conn-opt').count() >= 2, `ligações (${size.name}): escolher corretora mostra as opções`);
      }
      if (screenshots) await page.screenshot({ path: path.join(OUT, `${size.name}-ligacoes.png`) });
      await page.keyboard.press('Escape');
      ok(errors.length === 0, `${size.name}: sem erros de JavaScript${errors.length ? ': ' + [...new Set(errors)].slice(0, 3).join(' | ') : ''}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.proc.kill();
    fs.rmSync(srv.dir, { recursive: true, force: true });
  }
  return { fails, total: checks.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validar().then(({ fails, total }) => {
    if (fails.length) { console.log(`✗ ${fails.length} de ${total} verificações falharam:\n- ${fails.join('\n- ')}\nCapturas em .validacao/`); process.exit(1); }
    console.log(`✓ ${total} verificações passaram. Capturas em .validacao/`);
  }).catch((e) => { console.error('Erro na validação: ' + e.message); process.exit(1); });
}
