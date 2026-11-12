#!/usr/bin/env node
/* Propone un diagram.config.json a partir de schema.json: módulos por prefijo de nombre y tablas "hub"
   (catálogos muy referenciados cuyas FKs se ocultan por defecto). Es un punto de partida: renombra los
   módulos con nombres de negocio y ajusta los grupos antes de generar el diagrama.

   Uso: node init-config.js --schema schema.json --title "Modelo de datos de X" --out diagram.config.json */
'use strict';
const fs = require('fs');
const S = require('./lib/schema');
const args = S.parseArgs(process.argv.slice(2), { schema: 'string', title: 'string', out: 'string', 'hub-share': 'string' });
if (!args.schema || !args.out) { console.error('Uso: node init-config.js --schema schema.json --title "..." --out diagram.config.json'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(args.schema, 'utf8'));
const names = data.tables.map(t => t.n);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Prefijo común por tokens (p. ej. "VEN_").
const toks = names.map(n => n.split('_'));
let common = 0;
while (toks.every(t => t.length > common + 1 && t[common] === toks[0][common])) common++;
const prefix = toks[0].slice(0, common).map(x => x + '_').join('');

function groupBy(list, depth) {
  const g = new Map();
  for (const n of list) {
    const rest = n.slice(prefix.length).split('_');
    const key = rest.slice(0, depth).join('_');
    if (!g.has(key)) g.set(key, []);
    g.get(key).push(n);
  }
  return g;
}
const big = Math.max(8, Math.ceil(names.length * 0.35));
let groups = [];
for (const [key, list] of groupBy(names, 1)) {
  if (list.length > big) for (const [k2, l2] of groupBy(list, 2)) groups.push([k2, l2]);
  else groups.push([key, list]);
}
const others = groups.filter(([, l]) => l.length < 2).flatMap(([, l]) => l);
groups = groups.filter(([, l]) => l.length >= 2).sort((a, b) => b[1].length - a[1].length);
const human = k => k.toLowerCase().split('_').map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
const modules = groups.map(([k, l]) => ({ id: k.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: human(k), match: `^${esc(prefix + k)}(_|$)`, _tablas: l.length }));
if (others.length) modules.push({ id: 'otros', name: 'Otros', match: '.*', _tablas: others.length });
if (modules.length > 12) console.warn(`AVISO: ${modules.length} módulos; la paleta tiene 12 colores. Agrupa algunos.`);

// Hubs: tablas referenciadas por muchas FKs.
const share = Number(args['hub-share'] || 0.25);
const inDeg = {};
for (const f of data.fks) inDeg[f.pa] = (inDeg[f.pa] || 0) + 1;
const hubs = Object.entries(inDeg).filter(([, c]) => c >= Math.max(8, names.length * share)).sort((a, b) => b[1] - a[1]).map(([n]) => n);

const cfg = {
  title: args.title || 'Modelo de datos',
  modules,
  hubs,
  hubsLabel: hubs.length ? hubs.map(h => human(h.slice(prefix.length).split('_').pop())).join(' e ') : '',
};
fs.writeFileSync(args.out, JSON.stringify(cfg, null, 2));
console.log(`prefijo común: "${prefix}"`);
console.log(`módulos (${modules.length}): ${modules.map(m => `${m.name}=${m._tablas}`).join(', ')}`);
console.log(`hubs (FKs ocultas por defecto): ${hubs.map(h => `${h}(${inDeg[h]})`).join(', ') || 'ninguno'}`);
console.log(`escrito: ${args.out} — revisa nombres de módulos y "hubsLabel" antes de generar.`);
