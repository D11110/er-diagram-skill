#!/usr/bin/env node
/* Convierte uno o varios scripts DDL (.sql) a schema.json, sin conectarse a ninguna base.
   Entiende CREATE TABLE, ALTER TABLE ... ADD [CONSTRAINT] PRIMARY KEY / FOREIGN KEY / UNIQUE,
   restricciones en línea (PRIMARY KEY, NOT NULL, REFERENCES), COMMENT ON TABLE/COLUMN y CREATE VIEW.
   Funciona con DDL de Oracle, de SQL Server ([dbo].[Tabla], GO) y con el que genera
   `dotnet ef dbcontext script` / `dotnet ef migrations script`. Ignora PL/SQL, INSERT, GRANT, etc.

   Uso: node from-ddl.js --in esquema.sql [--in otro.sql] [--source "texto"] --out schema-full.json
   Para quedarte con una parte de las tablas, usa después select-tables.js. */
'use strict';
const fs = require('fs');
const S = require('./lib/schema');

const argv = process.argv.slice(2);
const inputs = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--in') { inputs.push(argv[i + 1]); argv.splice(i, 2); i--; }
const args = S.parseArgs(argv, { source: 'string', out: 'string' });
if (!inputs.length || !args.out) { console.error('Uso: node from-ddl.js --in archivo.sql [--in ...] [--source "texto"] --out schema-full.json'); process.exit(1); }

// ---------- léxico ----------
function stripComments(sql) {
  let out = '', i = 0, q = null;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (q) { out += c; if (c === q) { if (n === q) { out += n; i += 2; continue; } q = null; } i++; continue; }
    if (c === "'" || c === '"') { q = c; out += c; i++; continue; }
    if (c === '-' && n === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; out += ' '; continue; }
    out += c; i++;
  }
  return out;
}
// Separa sentencias por ';', por líneas con solo '/' (SQL*Plus) o 'GO' (SQL Server), respetando comillas.
function statements(sql) {
  const res = []; let cur = '', q = null;
  const lines = sql.split(/\r?\n/);
  for (const line of lines) {
    if (!q && /^\s*(\/|GO)\s*$/i.test(line)) { if (cur.trim()) res.push(cur); cur = ''; continue; }
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = null; cur += c; continue; }
      if (c === "'") { q = c; cur += c; continue; }
      if (c === ';') { if (cur.trim()) res.push(cur); cur = ''; continue; }
      cur += c;
    }
    cur += '\n';
  }
  if (cur.trim()) res.push(cur);
  return res.map(s => s.trim()).filter(Boolean);
}
// Divide por comas de primer nivel (fuera de paréntesis y comillas).
function splitTop(s) {
  const parts = []; let depth = 0, cur = '', q = null;
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
const unq = s => s.trim().replace(/^[\["`]|[\]"`]$/g, '');
// [esquema].[tabla] | "ESQ"."TABLA" | tabla  -> TABLA (sin esquema)
const nameOf = s => { const parts = s.trim().split('.').map(unq); return parts[parts.length - 1]; };
const colList = s => s.replace(/^\(|\)$/g, '').split(',').map(x => unq(x)).filter(Boolean);
const NAME = String.raw`(?:\[[^\]]+\]|"[^"]+"|\x60[^\x60]+\x60|[\w$#]+)(?:\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|\x60[^\x60]+\x60|[\w$#]+))*`;
const STOP = /\b(NOT|NULL|DEFAULT|CONSTRAINT|PRIMARY|REFERENCES|UNIQUE|CHECK|GENERATED|IDENTITY|COLLATE|ENABLE|DISABLE|AS|ENCRYPT|SPARSE|ROWGUIDCOL)\b/i;

// ---------- modelo ----------
const tables = new Map(); // CLAVE MAYÚSCULA -> tabla
const fks = []; const views = [];
const T = n => tables.get(nameOf(n).toUpperCase());
let anon = 0;

function addConstraint(t, def) {
  let m, name = null;
  const cm = def.match(new RegExp(`^CONSTRAINT\\s+(${NAME})\\s+`, 'i'));
  if (cm) { name = nameOf(cm[1]); def = def.slice(cm[0].length); }
  if ((m = def.match(/^PRIMARY\s+KEY(?:\s+(?:CLUSTERED|NONCLUSTERED))?\s*(\([^)]*\))/i))) {
    for (const c of colList(m[1])) { const col = t.find(c); if (col) col.pk = 1; }
  } else if ((m = def.match(/^UNIQUE(?:\s+(?:CLUSTERED|NONCLUSTERED))?\s*(\([^)]*\))/i))) {
    for (const c of colList(m[1])) { const col = t.find(c); if (col) col.uq = 1; }
  } else if ((m = def.match(new RegExp(`^FOREIGN\\s+KEY\\s*(\\([^)]*\\))\\s*REFERENCES\\s+(${NAME})\\s*(\\([^)]*\\))?(.*)$`, 'is')))) {
    const del = (m[4].match(/ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION|RESTRICT)/i) || [])[1];
    fks.push({ n: name || `FK_${t.n}_${++anon}`, ch: t.n, chc: colList(m[1]), pa: nameOf(m[2]), pac: m[3] ? colList(m[3]) : null, del: del && !/NO\s+ACTION|RESTRICT/i.test(del) ? del.toUpperCase().replace(/\s+/g, ' ') : '' });
  }
}

function createTable(stmt) {
  const m = stmt.match(new RegExp(`^CREATE\\s+(?:GLOBAL\\s+TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})\\s*\\(`, 'i'));
  if (!m) return;
  // Cuerpo entre el primer '(' y su paréntesis de cierre.
  let i = m[0].length, depth = 1, q = null;
  for (; i < stmt.length && depth; i++) {
    const c = stmt[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === "'") q = c; else if (c === '(') depth++; else if (c === ')') depth--;
  }
  const body = stmt.slice(m[0].length, i - 1);
  const n = nameOf(m[1]);
  const t = { n, cm: '', cols: [], find(c) { return this.cols.find(x => x.n.toUpperCase() === c.toUpperCase()); } };
  tables.set(n.toUpperCase(), t);
  const pending = [];
  for (const part of splitTop(body)) {
    if (/^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|INDEX|KEY)\b/i.test(part)) { pending.push(part); continue; }
    const cm = part.match(new RegExp(`^(${NAME})\\s+(.*)$`, 's'));
    if (!cm) continue;
    const rest = cm[2].replace(/\s+/g, ' ').trim();
    const stop = rest.search(STOP);
    let type = (stop < 0 ? rest : rest.slice(0, stop)).trim().replace(/\s*\(\s*/g, '(').replace(/\s*,\s*/g, ',').replace(/\s*\)/g, ')');
    type = type.replace(/\[|\]/g, '').toUpperCase() || '?';
    const col = { n: unq(cm[1]), t: type, nn: /\bNOT\s+NULL\b/i.test(rest), cm: '' };
    if (/\bPRIMARY\s+KEY\b/i.test(rest)) { col.pk = 1; col.nn = true; }
    if (/\bUNIQUE\b/i.test(rest)) col.uq = 1;
    const ref = rest.match(new RegExp(`REFERENCES\\s+(${NAME})\\s*(\\([^)]*\\))?`, 'i'));
    if (ref) {
      const cn = rest.match(new RegExp(`CONSTRAINT\\s+(${NAME})\\s+REFERENCES`, 'i'));
      fks.push({ n: cn ? nameOf(cn[1]) : `FK_${n}_${++anon}`, ch: n, chc: [col.n], pa: nameOf(ref[1]), pac: ref[2] ? colList(ref[2]) : null, del: '' });
    }
    t.cols.push(col);
  }
  for (const p of pending) addConstraint(t, p);
}

function alterTable(stmt) {
  const m = stmt.match(new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${NAME})\\s+(?:WITH\\s+(?:NO)?CHECK\\s+)?ADD\\s+(.*)$`, 'is'));
  if (!m) return;
  const t = T(m[1]); if (!t) return;
  let def = m[2].trim().replace(/^\(([\s\S]*)\)$/, '$1');
  for (const part of splitTop(def)) addConstraint(t, part.trim());
}

function comment(stmt) {
  let m = stmt.match(new RegExp(`^COMMENT\\s+ON\\s+TABLE\\s+(${NAME})\\s+IS\\s+'((?:[^']|'')*)'`, 'is'));
  if (m) { const t = T(m[1]); if (t) t.cm = m[2].replace(/''/g, "'").replace(/\s+/g, ' ').trim(); return; }
  m = stmt.match(new RegExp(`^COMMENT\\s+ON\\s+COLUMN\\s+(${NAME})\\s+IS\\s+'((?:[^']|'')*)'`, 'is'));
  if (m) {
    const parts = m[1].split('.').map(unq);
    const col = parts.pop(), tn = parts.pop();
    const t = tn && tables.get(tn.toUpperCase()); const c = t && t.find(col);
    if (c) c.cm = m[2].replace(/''/g, "'").replace(/\s+/g, ' ').trim();
  }
}

for (const file of inputs) {
  for (const stmt of statements(stripComments(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')))) {
    if (/^CREATE\s+(?:GLOBAL\s+TEMPORARY\s+)?TABLE\b/i.test(stmt)) createTable(stmt);
    else if (/^ALTER\s+TABLE\b/i.test(stmt)) alterTable(stmt);
    else if (/^COMMENT\s+ON\b/i.test(stmt)) comment(stmt);
    else { const v = stmt.match(new RegExp(`^CREATE\\s+(?:OR\\s+(?:REPLACE|ALTER)\\s+)?(?:FORCE\\s+|NOFORCE\\s+)?(?:MATERIALIZED\\s+)?VIEW\\s+(${NAME})`, 'i')); if (v) views.push(nameOf(v[1])); }
  }
}

// FKs sin columnas destino explícitas apuntan a la PK del padre; nombres de tabla a su forma declarada.
for (const f of fks) {
  const pa = tables.get(f.pa.toUpperCase());
  if (pa) f.pa = pa.n;
  if (!f.pac) f.pac = pa ? pa.cols.filter(c => c.pk).map(c => c.n) : f.chc.slice();
  const ch = tables.get(f.ch.toUpperCase());
  for (const c of f.chc) { const col = ch && ch.find(c); if (col) col.fk = 1; }
}
const list = [...tables.values()];
const schema = S.finalize({
  source: args.source || `Script DDL (${inputs.map(f => require('path').basename(f)).join(', ')})`,
  tables: list.map(({ find, ...t }) => t),
  fks: fks.filter((f, i) => fks.findIndex(g => g.n === f.n && g.ch === f.ch) === i),
  views,
});
if (!schema.tables.length) { console.error('ERROR: no se encontró ningún CREATE TABLE'); process.exit(1); }
S.writeJson(args.out, schema);
console.log(S.summary(schema));
console.log(`escrito: ${args.out}`);
