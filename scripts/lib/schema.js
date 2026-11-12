// Utilidades compartidas: argumentos de línea de comandos y formato schema.json.
'use strict';
const fs = require('fs');

function parseArgs(argv, spec) {
  // spec: { nombre: 'string' | 'bool' | 'list' }. Acepta --nombre valor y --flag.
  // 'list' se puede repetir y también acepta valores separados por comas.
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Argumento inesperado: ${a}`);
    const key = a.slice(2);
    if (!(key in spec)) throw new Error(`Opción desconocida: --${key}. Válidas: ${Object.keys(spec).map(k => '--' + k).join(' ')}`);
    if (spec[key] === 'bool') { out[key] = true; continue; }
    if (i + 1 >= argv.length) throw new Error(`Falta el valor de --${key}`);
    const v = argv[++i];
    if (spec[key] === 'list') out[key] = (out[key] || []).concat(v.split(',').map(s => s.trim()).filter(Boolean));
    else out[key] = v;
  }
  return out;
}

/* Patrones estilo SQL LIKE para elegir tablas: % = cualquier secuencia (incluso vacía).
   El guion bajo se toma LITERAL (VEN_% significa "empieza con VEN_"), porque así lo lee la gente;
   no hay comodín de un solo carácter. No distingue mayúsculas. */
const LIKE_OK = /^[A-Za-z0-9_$#%]+$/;
function checkLike(patterns, opt) {
  for (const p of patterns || []) if (!LIKE_OK.test(p)) throw new Error(`Patrón inválido en --${opt}: "${p}" (solo letras, números, _ $ # y %)`);
  return patterns || [];
}
function likeToRegex(p) {
  return new RegExp('^' + p.split('%').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
}
// Devuelve n => bool. Una tabla entra si está en `tables` o coincide con algún `like` y con ningún `notLike`.
// Sin `like` ni `tables` entran todas (menos las excluidas).
function matcher({ like = [], notLike = [], tables = [] } = {}) {
  const inc = like.map(likeToRegex), exc = notLike.map(likeToRegex);
  const explicit = new Set(tables.map(t => t.toUpperCase()));
  return n => {
    if (explicit.has(n.toUpperCase())) return true;
    if (exc.some(r => r.test(n))) return false;
    if (!inc.length) return explicit.size === 0;
    return inc.some(r => r.test(n));
  };
}

/* Formato schema.json (ver references/schema-format.md):
   { source, extracted, tables: [{ n, cm, cols: [{ n, t, nn, pk, fk, uq, cm }] }],
     fks: [{ n, ch, chc: [], pa, pac: [], del }], views: [] } */

// Parsea el spool "T|C|P|U|F|V" que producen las consultas de diccionario.
function fromPipeLines(text, source) {
  const lines = text.split(/\r?\n/).filter(l => /^[TCPUFV]\|/.test(l));
  const tables = new Map(), fks = new Map(), views = [];
  for (const l of lines) {
    const p = l.split('|');
    switch (p[0]) {
      case 'T': tables.set(p[1], { n: p[1], cm: (p[2] || '').trim(), cols: [], idx: {} }); break;
      case 'C': {
        const t = tables.get(p[1]); if (!t) break;
        t.idx[p[2]] = t.cols.length;
        t.cols.push({ n: p[2], t: p[3], nn: p[4] === 'N', cm: (p[6] || '').trim() });
        break;
      }
      case 'P': case 'U': {
        const t = tables.get(p[1]); const c = t && t.cols[t.idx[p[2]]]; if (!c) break;
        if (p[0] === 'P') c.pk = 1; else c.uq = 1;
        break;
      }
      case 'F': {
        const [, name, ch, chc, pa, pac, , del] = p;
        if (!fks.has(name)) fks.set(name, { n: name, ch, chc: [], pa, pac: [], del: !del || del === 'NO ACTION' ? '' : del });
        const f = fks.get(name); f.chc.push(chc); f.pac.push(pac);
        const t = tables.get(ch); const c = t && t.cols[t.idx[chc]]; if (c) c.fk = 1;
        break;
      }
      case 'V': views.push(p[1]); break;
    }
  }
  return finalize({ source, tables: [...tables.values()], fks: [...fks.values()], views });
}

// Limpia índices internos, descarta FKs hacia tablas fuera del alcance y ordena.
function finalize(s) {
  const names = new Set(s.tables.map(t => t.n));
  // Solo se reportan las FK que cruzan el borde de la selección (un extremo dentro y otro fuera).
  const dropped = s.fks.filter(f => names.has(f.ch) !== names.has(f.pa));
  const out = {
    source: s.source || 'desconocido',
    extracted: s.extracted || new Date().toISOString().slice(0, 10),
    tables: s.tables.map(({ idx, ...t }) => t).sort((a, b) => a.n.localeCompare(b.n)),
    fks: s.fks.filter(f => names.has(f.ch) && names.has(f.pa)),
    views: [...new Set(s.views || [])].sort(),
  };
  if (dropped.length) out.outOfScopeFks = dropped.map(f => `${f.n}: ${f.ch} -> ${f.pa}`);
  return out;
}

function summary(s) {
  const cols = s.tables.reduce((a, t) => a + t.cols.length, 0);
  const lines = [`tablas=${s.tables.length} columnas=${cols} fks=${s.fks.length} vistas=${s.views.length}`];
  const noPk = s.tables.filter(t => !t.cols.some(c => c.pk)).map(t => t.n);
  if (noPk.length) lines.push(`sin PK (${noPk.length}): ${noPk.join(', ')}`);
  if (s.outOfScopeFks && s.outOfScopeFks.length) lines.push(`FKs hacia tablas fuera del alcance, omitidas (${s.outOfScopeFks.length}): ${s.outOfScopeFks.slice(0, 8).join('; ')}${s.outOfScopeFks.length > 8 ? '…' : ''}`);
  return lines.join('\n');
}

function writeJson(path, obj) { fs.writeFileSync(path, JSON.stringify(obj)); }

module.exports = { parseArgs, checkLike, likeToRegex, matcher, fromPipeLines, finalize, summary, writeJson };
