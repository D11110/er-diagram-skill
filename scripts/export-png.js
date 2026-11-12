#!/usr/bin/env node
/* Exporta el diagrama ya generado (el .html de build.js) a PNG de alta resolución, sin abrir el navegador a mano.
   Usa Playwright (Chromium) y la misma función del botón "Exportar PNG" de la página, así que el resultado es idéntico.

   Uso:
     node export-png.js --html modelo-er.html --out modelo-er.png [--scale 2] [--theme light|dark]
                        [--mode keys|all] [--hubs] [--module ID|nombre[,otro]] [--each-module]
     --scale        multiplicador de resolución (1 a 4, por defecto 2). Si la imagen pasa de 16384 px por lado
                    o de 100 Mpx, se reduce sola y se avisa.
     --theme        light (por defecto, ideal para documentos) o dark.
     --mode         keys = solo llaves (por defecto) | all = todas las columnas.
     --hubs         incluye las FK a los catálogos comunes (ocultas por defecto).
     --module       exporta solo ese módulo (id o nombre); con varios, un PNG por módulo.
     --each-module  exporta el diagrama completo y además un PNG por cada módulo.
   Con varios PNG, --out es la base del nombre: modelo-er.png -> modelo-er.png, modelo-er-<modulo>.png, ...

   Requiere Playwright: npm i -D playwright && npx playwright install chromium (o define PLAYWRIGHT_PATH
   con la ruta a un node_modules/playwright ya instalado). Necesita internet para incrustar las fuentes IBM Plex;
   sin internet sale con las fuentes del sistema. */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./lib/schema');

let args;
try {
  args = S.parseArgs(process.argv.slice(2), {
    html: 'string', out: 'string', scale: 'string', theme: 'string', mode: 'string', hubs: 'bool', module: 'list', 'each-module': 'bool',
  });
} catch (e) { fail(e.message); }
if (!args.html || !args.out) fail('Uso: node export-png.js --html modelo-er.html --out modelo-er.png [--scale 2] [--theme light|dark] [--mode keys|all] [--hubs] [--module ID] [--each-module]');
if (!fs.existsSync(args.html)) fail(`No existe ${args.html}`);
const scale = args.scale ? Number(args.scale) : 2;
if (!(scale >= 0.5 && scale <= 4)) fail('--scale debe estar entre 0.5 y 4');
const theme = args.theme || 'light';
if (!['light', 'dark'].includes(theme)) fail('--theme debe ser light o dark');
const mode = args.mode || 'keys';
if (!['keys', 'all'].includes(mode)) fail('--mode debe ser keys o all');

let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); }
catch { fail('Falta Playwright. Instálalo (npm i -D playwright && npx playwright install chromium) o define PLAYWRIGHT_PATH.'); }

const slug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const warnings = [];
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text()); });
  page.on('pageerror', e => warnings.push(e.message));
  try {
    await page.goto('file:///' + path.resolve(args.html).replace(/\\/g, '/'));
    await page.waitForFunction(() => window.erDiagram && document.getElementById('busy').hidden, null, { timeout: 120000 })
      .catch(() => { throw new Error('La página no terminó de acomodar el diagrama. ¿El HTML se generó con una versión del skill que trae "Exportar PNG"? Vuelve a correr build.js.'); });
    const modules = await page.evaluate(() => window.erDiagram.modules);

    let jobs;
    if (args['each-module']) jobs = [null, ...modules.map(m => m.id)];
    else if (args.module && args.module.length) jobs = args.module;
    else jobs = [null];

    const outBase = args.out.replace(/\.png$/i, '');
    const fileFor = job => {
      if (jobs.length === 1) return outBase + '.png';
      if (job === null) return outBase + '.png';
      const m = modules.find(x => x.id.toLowerCase() === String(job).toLowerCase() || x.name.toLowerCase() === String(job).toLowerCase());
      return `${outBase}-${slug(m ? m.id : job)}.png`;
    };
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });

    for (const job of jobs) {
      await page.evaluate(o => window.erDiagram.setView(o), { mode, hubs: !!args.hubs, module: job });
      const [download, info] = await Promise.all([
        page.waitForEvent('download', { timeout: 300000 }),
        page.evaluate(o => window.erDiagram.downloadPng(o), { scale, theme }),
      ]);
      const file = fileFor(job);
      await download.saveAs(file);
      const reduced = info.scale < scale - 1e-6 ? `, escala reducida a ${info.scale.toFixed(2)}× por el límite del navegador` : '';
      console.log(`escrito: ${file} (${info.width}x${info.height} px, ${(info.bytes / 1048576).toFixed(1)} MB${reduced})`);
    }
  } finally {
    await browser.close();
  }
  const fontWarn = warnings.find(w => /fuentes/.test(w));
  if (fontWarn) console.log('AVISO: ' + fontWarn);
})().catch(e => fail(e.message || String(e)));

function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }
