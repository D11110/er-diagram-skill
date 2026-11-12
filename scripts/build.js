#!/usr/bin/env node
/* Genera el diagrama ER interactivo (un solo .html) a partir de schema.json + diagram.config.json.

   Uso: node build.js --schema schema.json [--config diagram.config.json] --out modelo-er.html [--inline-elk] [--fragment]
     --inline-elk  incrusta elkjs (~1.5 MB) para que funcione sin internet; si no, se carga de cdn.jsdelivr.net.
     --fragment    sin <!doctype>/<html>/<head>/<body>: para plataformas que envuelven la página (p. ej. artifacts de Claude). */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./lib/schema');
const { resolve } = require('./lib/resolve');

const args = S.parseArgs(process.argv.slice(2), { schema: 'string', config: 'string', out: 'string', 'inline-elk': 'bool', fragment: 'bool' });
if (!args.schema || !args.out) { console.error('Uso: node build.js --schema schema.json [--config diagram.config.json] --out archivo.html [--inline-elk] [--fragment]'); process.exit(1); }

const schema = JSON.parse(fs.readFileSync(args.schema, 'utf8'));
const cfg = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : { title: 'Modelo de datos', modules: [] };
const { data, warnings } = resolve(schema, cfg);
for (const w of warnings) console.warn('AVISO: ' + w);

const tpl = fs.readFileSync(path.join(__dirname, '..', 'assets', 'template.html'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, 'lib', 'er-core.js'), 'utf8');
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const json = JSON.stringify(data).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');

let elkTag = '<script src="https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js"></script>';
if (args['inline-elk']) {
  let elkPath;
  try { elkPath = require.resolve('elkjs/lib/elk.bundled.js', { paths: [__dirname] }); }
  catch { console.error('ERROR: no está instalado elkjs. Corre "npm install" en la carpeta scripts del skill.'); process.exit(1); }
  elkTag = '<script>' + fs.readFileSync(elkPath, 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>';
}

const [head, body] = tpl.split('<!--NGS:BODY-->');
if (body === undefined) throw new Error('La plantilla no tiene el marcador <!--NGS:BODY-->');
const fill = s => s.split('__TITLE__').join(escHtml(data.title))
  .replace('<!--NGS:ELK-->', () => elkTag)
  .replace('/*NGS:CORE*/', () => core)
  .replace('/*NGS:DATA*/', () => json);

let html;
if (args.fragment) html = fill(head) + fill(body);
else {
  html = '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    fill(head).replace(/<meta name="claude:viewport-fit-sides"[^>]*>\n?/, '') + '</head>\n<body>\n' + fill(body) + '</body>\n</html>\n';
}
if (/NGS:(CORE|DATA|ELK)|__TITLE__/.test(html.replace(core, '').replace(json, ''))) throw new Error('Quedó un marcador sin reemplazar');
fs.writeFileSync(args.out, html);
console.log(`módulos: ${data.modules.map(m => `${m.name}=${data.tables.filter(t => t.m === m.id).length}`).join(', ')}`);
console.log(`hubs ocultos por defecto: ${data.hubs.join(', ') || 'ninguno'}`);
console.log(`escrito: ${args.out} (${(html.length / 1024).toFixed(0)} KB${args['inline-elk'] ? ', elkjs incrustado' : ', elkjs por CDN'}${args.fragment ? ', fragmento' : ''})`);
