// Hook "Stop" do Claude Code: antes de o Claude dar uma tarefa por terminada, valida a app com o Playwright.
// Só corre quando public/index.html ou server.js mudaram desde a última validação que passou.
// Se falhar, bloqueia o fim da tarefa e devolve ao Claude a lista do que falhou (uma vez; à segunda só avisa).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validar } from './validar.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = path.join(ROOT, '.validacao-ok');
const WATCH = ['public/index.html', 'server.js', 'scripts/validar.mjs'];

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}

const hash = crypto.createHash('sha1');
for (const f of WATCH) { try { hash.update(fs.readFileSync(path.join(ROOT, f))); } catch {} }
const digest = hash.digest('hex');
let last = '';
try { last = fs.readFileSync(STAMP, 'utf8').trim(); } catch {}
if (digest === last) process.exit(0); // nada mudou desde a última validação boa

const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
try {
  const { fails, total } = await validar();
  if (!fails.length) {
    fs.writeFileSync(STAMP, digest);
    out({ systemMessage: `Playwright: ${total} verificações passaram.` });
  }
  const list = fails.map((f) => '- ' + f).join('\n');
  if (input.stop_hook_active) out({ systemMessage: `Playwright: a validação continua a falhar (${fails.length} de ${total}):\n${list}` });
  out({ decision: 'block', reason: `A validação com Playwright falhou (${fails.length} de ${total} verificações). Corrige antes de dar a tarefa por terminada, ou explica ao utilizador porque não dá:\n${list}\nCapturas de ecrã em .validacao/ (usa o agente "validador" para analisar).` });
} catch (e) {
  out({ systemMessage: 'Playwright: não foi possível validar (' + e.message.split('\n')[0] + ').' });
}
