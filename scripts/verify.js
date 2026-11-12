#!/usr/bin/env node
/* Verifica el diagrama antes de entregarlo.
   1) Layout (siempre, sin navegador): corre ELK en node para cada vista (llaves/todas, hubs on/off, cada módulo)
      y comprueba que no haya tablas encimadas ni líneas que no arranquen/terminen en el borde de su tabla.
   2) Navegador (opcional, --html + --shots): abre el HTML con Playwright en escritorio claro/oscuro y teléfono,
      selecciona la tabla más conectada, toma capturas y reporta errores de consola y scroll horizontal.

   Uso: node verify.js --schema schema.json [--config diagram.config.json] [--html modelo-er.html --shots carpeta] */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./lib/schema');
const { resolve } = require('./lib/resolve');
const core = require('./lib/er-core.js');

const args = S.parseArgs(process.argv.slice(2), { schema: 'string', config: 'string', html: 'string', shots: 'string' });
if (!args.schema) { console.error('Uso: node verify.js --schema schema.json [--config cfg.json] [--html archivo.html --shots carpeta]'); process.exit(1); }
let ELK;
try { ELK = require(require.resolve('elkjs/lib/elk.bundled.js', { paths: [__dirname] })); }
catch { console.error('ERROR: falta elkjs. Corre "npm install" en la carpeta scripts del skill.'); process.exit(1); }

const schema = JSON.parse(fs.readFileSync(args.schema, 'utf8'));
const cfg = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : { modules: [] };
const { data } = resolve(schema, cfg);
const measure = (s, k) => s.length * (k === 'title' ? 7.6 : k === 'type' ? 6.6 : 7.3); // aproximación conservadora de IBM Plex

const onBorder = ([x, y], n, tol = 2) =>
  x >= n.x - tol && x <= n.x + n.w + tol && y >= n.y - tol && y <= n.y + n.h + tol &&
  (Math.abs(x - n.x) < tol || Math.abs(x - n.x - n.w) < tol || Math.abs(y - n.y) < tol || Math.abs(y - n.y - n.h) < tol);

(async () => {
  const elk = new ELK();
  const views = [];
  for (const mode of ['keys', 'all']) for (const hubs of [false, true]) views.push({ mode, hubs, focus: null });
  if (data.modules.length > 1) for (const m of data.modules) views.push({ mode: 'keys', hubs: false, focus: m.id });
  let problems = 0;
  for (const opts of views) {
    const { graph, pairs } = core.buildGraph(data, opts, measure);
    const L = core.extract(await elk.layout(graph));
    let bad = 0, missing = 0, overlaps = 0;
    for (const e of pairs.values()) {
      const pts = L.edges[e.id];
      if (!pts || pts.length < 2) { missing++; continue; }
      if (!onBorder(pts[0], L.nodes[e.pa]) || !onBorder(pts[pts.length - 1], L.nodes[e.ch])) bad++;
    }
    const ns = Object.values(L.nodes);
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i], b = ns[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
    }
    problems += bad + missing + overlaps;
    const label = `${opts.mode}${opts.hubs ? '+hubs' : ''}${opts.focus ? ' módulo=' + opts.focus : ''}`;
    console.log(`${bad + missing + overlaps ? 'FALLA' : 'ok   '} ${label.padEnd(28)} ${Math.round(L.width)}x${Math.round(L.height)} tablas=${ns.length} líneas=${pairs.size} sinRuta=${missing} fueraDeBorde=${bad} encimadas=${overlaps}`);
  }

  if (args.html && args.shots) {
    let chromium;
    try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); }
    catch { console.log('Playwright no está disponible (instálalo o define PLAYWRIGHT_PATH); se omiten las capturas.'); return finish(problems); }
    fs.mkdirSync(args.shots, { recursive: true });
    const url = 'file:///' + path.resolve(args.html).replace(/\\/g, '/');
    const deg = {};
    for (const f of data.fks) if (!data.hubs.includes(f.pa)) { deg[f.pa] = (deg[f.pa] || 0) + 1; deg[f.ch] = (deg[f.ch] || 0) + 1; }
    const busiest = Object.entries(deg).sort((a, b) => b[1] - a[1])[0];
    const browser = await chromium.launch();
    const errors = [];
    const shot = async (name, viewport, colorScheme, pick) => {
      const ctx = await browser.newContext({ viewport, colorScheme });
      const p = await ctx.newPage();
      p.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
      p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
      await p.goto(url);
      await p.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
      if (pick) { await p.fill('#q', pick); await p.dispatchEvent('#q', 'change'); await p.waitForTimeout(600); }
      if (await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) errors.push(`${name}: hay scroll horizontal`);
      const file = path.join(args.shots, `${name}.png`);
      await p.screenshot({ path: file });
      console.log(`captura: ${file}`);
      await ctx.close();
    };
    await shot('escritorio-claro', { width: 1440, height: 900 }, 'light');
    await shot('escritorio-oscuro-seleccion', { width: 1440, height: 900 }, 'dark', busiest && busiest[0]);
    await shot('telefono', { width: 400, height: 820 }, 'light', busiest && busiest[0]);
    await browser.close();
    if (errors.length) { console.log('Problemas en navegador:\n' + errors.join('\n')); problems += errors.length; }
    else console.log('Navegador: sin errores de consola ni scroll horizontal.');
  }
  finish(problems);
})().catch(e => { console.error(e); process.exit(1); });

function finish(problems) {
  console.log(problems ? `RESULTADO: ${problems} problema(s)` : 'RESULTADO: todo bien');
  process.exitCode = problems ? 2 : 0;
}
