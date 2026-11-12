#!/usr/bin/env node
/* Lista las tablas encontradas y deja elegir cuáles entran al diagrama.

   1) Inventario, para mostrárselo al usuario:
        node select-tables.js --schema schema-full.json --list [--list-file tablas.txt]
      Imprime los totales, los grupos por prefijo (primer segmento del nombre) con su número de tablas y FK internas
      y, si son pocas, la lista completa. Con --list-file escribe la lista completa (nombre, columnas, FK, comentario).

   2) Selección:
        node select-tables.js --schema schema-full.json --like "%VEN%" [--like "INV_%"] [--not-like "%_LOG"] \
          [--tables A,B] [--tables-file elegidas.txt] [--with-parents] --out schema.json
      - %: cualquier secuencia. _: literal. No distingue mayúsculas. --like y --not-like se pueden repetir o separar por comas.
      - --tables / --tables-file: nombres exactos; siempre entran, aunque los excluya un --not-like.
      - --with-parents: agrega las tablas a las que apuntan las FK de la selección (un nivel), para que no queden líneas colgando.
      Las FK hacia tablas que quedaron fuera se reportan y no se dibujan. */
'use strict';
const fs = require('fs');
const S = require('./lib/schema');

let args;
try {
  args = S.parseArgs(process.argv.slice(2), {
    schema: 'string', list: 'bool', 'list-file': 'string', like: 'list', 'not-like': 'list', tables: 'list', 'tables-file': 'string', 'with-parents': 'bool', out: 'string',
  });
  S.checkLike(args.like, 'like'); S.checkLike(args['not-like'], 'not-like');
} catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
if (!args.schema) { console.error('Uso: node select-tables.js --schema schema-full.json (--list | --like ... --out schema.json)'); process.exit(1); }
const full = JSON.parse(fs.readFileSync(args.schema, 'utf8'));

// ---------- inventario ----------
if (args.list) {
  const cols = full.tables.reduce((a, t) => a + t.cols.length, 0);
  console.log(`Inventario (${full.source}): ${full.tables.length} tablas, ${cols} columnas, ${full.fks.length} FK, ${full.views.length} vistas`);
  const group = n => n.split('_')[0] + (n.includes('_') ? '_' : '');
  const g = new Map();
  for (const t of full.tables) {
    const k = group(t.n);
    if (!g.has(k)) g.set(k, { n: 0, fk: 0 });
    g.get(k).n++;
  }
  for (const f of full.fks) if (group(f.ch) === group(f.pa)) g.get(group(f.ch)).fk++;
  const rows = [...g].sort((a, b) => b[1].n - a[1].n);
  console.log('\nPor prefijo (patrón sugerido · tablas · FK internas):');
  for (const [k, v] of rows) console.log(`  ${(k.endsWith('_') ? k + '%' : k).padEnd(24)} ${String(v.n).padStart(5)} tablas  ${String(v.fk).padStart(5)} FK`);
  const fkOut = {}, fkIn = {};
  for (const f of full.fks) { fkOut[f.ch] = (fkOut[f.ch] || 0) + 1; fkIn[f.pa] = (fkIn[f.pa] || 0) + 1; }
  const line = t => `${t.n}\t${t.cols.length} cols\t${fkOut[t.n] || 0} FK→\t${fkIn[t.n] || 0} ←FK\t${t.cm || ''}`;
  if (args['list-file']) {
    fs.writeFileSync(args['list-file'], full.tables.map(line).join('\n') + '\n');
    console.log(`\nLista completa: ${args['list-file']}`);
  }
  if (full.tables.length <= 120) console.log('\n' + full.tables.map(line).join('\n'));
  else if (!args['list-file']) console.log(`\n(${full.tables.length} tablas: usa --list-file para la lista completa)`);
  process.exit(0);
}

// ---------- selección ----------
if (!args.out) { console.error('ERROR: falta --out (o usa --list para ver el inventario)'); process.exit(1); }
let explicit = args.tables || [];
if (args['tables-file']) {
  explicit = explicit.concat(fs.readFileSync(args['tables-file'], 'utf8').split(/\r?\n/).map(l => l.split('\t')[0].trim()).filter(l => l && !l.startsWith('#')));
}
const byUpper = new Map(full.tables.map(t => [t.n.toUpperCase(), t.n]));
const unknown = explicit.filter(n => !byUpper.has(n.toUpperCase()));
if (unknown.length) console.warn(`AVISO: no existen en el esquema (${unknown.length}): ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? '…' : ''}`);
if (!args.like && !explicit.length && !args['not-like']) { console.error('ERROR: indica --like, --not-like, --tables o --tables-file'); process.exit(1); }

const pick = S.matcher({ like: args.like, notLike: args['not-like'], tables: explicit });
const chosen = new Set(full.tables.filter(t => pick(t.n)).map(t => t.n));
const added = [];
if (args['with-parents']) {
  for (const f of full.fks) if (chosen.has(f.ch) && !chosen.has(f.pa)) { chosen.add(f.pa); added.push(f.pa); }
}
const viewPick = S.matcher({ like: args.like, notLike: args['not-like'], tables: [] });
const schema = S.finalize({
  source: full.source,
  extracted: full.extracted,
  tables: full.tables.filter(t => chosen.has(t.n)),
  fks: full.fks,
  views: args.like ? full.views.filter(viewPick) : [],
});
if (!schema.tables.length) { console.error('ERROR: la selección quedó vacía. Revisa los patrones (recuerda: % es comodín y _ es literal).'); process.exit(1); }
S.writeJson(args.out, schema);
console.log(S.summary(schema));
if (added.length) console.log(`agregadas por --with-parents (${added.length}): ${[...new Set(added)].join(', ')}`);
console.log(`escrito: ${args.out}`);
