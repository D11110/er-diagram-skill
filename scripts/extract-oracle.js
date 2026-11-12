#!/usr/bin/env node
/* Extrae el esquema de Oracle (solo SELECT sobre el diccionario) y escribe schema.json.

   Uso:
     node extract-oracle.js --appsettings <ruta appsettings.json> [--key DefaultConnection] [--owner ESQUEMA] [--like "%VEN%"] --out schema-full.json
     node extract-oracle.js --conn-env ORA_CONN [--owner ESQUEMA] [--like ...] [--not-like ...] --out schema-full.json
       (ORA_CONN = usuario/clave@descriptor)

   - Requiere sqlplus en el PATH (Oracle Client o Instant Client con SQL*Plus).
   - La contraseña nunca se imprime: se pasa a sqlplus por stdin.
   - Sin --owner usa las vistas USER_* (esquema del usuario que conecta); con --owner usa ALL_* filtrando ese dueño.
   - --like / --not-like (repetibles o separados por comas) prefiltran en SQL. % es comodín y _ es literal.
     Lo normal es extraer todo, listar con select-tables.js y dejar que el usuario elija; prefiltra solo en esquemas enormes. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./lib/schema');

let args;
try {
  args = S.parseArgs(process.argv.slice(2), {
    appsettings: 'string', key: 'string', 'conn-env': 'string', like: 'list', 'not-like': 'list', owner: 'string', out: 'string', source: 'string', keep: 'bool',
  });
  S.checkLike(args.like, 'like'); S.checkLike(args['not-like'], 'not-like');
} catch (e) { fail(e.message); }
if (!args.out) fail('Falta --out <schema.json>');
if (args.owner && !/^[A-Za-z0-9_$#]+$/.test(args.owner)) fail('--owner solo admite letras, números, _ $ #');

// ---------- cadena de conexión ----------
function fromAppsettings(file, key) {
  // Lee appsettings*.json tolerando comentarios // y comas finales (JSON de .NET).
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => !l.trim().startsWith('//'));
  const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`);
  const m = lines.join('\n').match(re);
  if (!m) fail(`No se encontró la clave "${key}" activa en ${file}`);
  const parts = {};
  for (const kv of m[1].split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim().toUpperCase().replace(/\s+/g, ' ')] = kv.slice(i + 1).trim();
  }
  const user = parts['USER ID'] || parts['USER'] || parts['UID'];
  const pw = parts['PASSWORD'] || parts['PWD'];
  const ds = parts['DATA SOURCE'] || parts['DATASOURCE'];
  if (!user || !pw || !ds) fail(`La cadena "${key}" no trae USER ID, PASSWORD y DATA SOURCE (user=${!!user} pw=${!!pw} ds=${!!ds})`);
  return { conn: `${user}/"${pw}"@${ds}`, user, secret: pw, label: ds.replace(/\s+/g, '') };
}
let C;
if (args.appsettings) C = fromAppsettings(args.appsettings, args.key || 'DefaultConnection');
else if (args['conn-env']) {
  const v = process.env[args['conn-env']];
  if (!v) fail(`La variable de entorno ${args['conn-env']} está vacía`);
  const m = v.match(/^([^/]+)\/(.*)@(.+)$/);
  if (!m) fail(`${args['conn-env']} debe tener la forma usuario/clave@descriptor`);
  C = { conn: `${m[1]}/"${m[2].replace(/^"|"$/g, '')}"@${m[3]}`, user: m[1], secret: m[2], label: m[3] };
} else fail('Indica --appsettings <archivo> o --conn-env <VARIABLE>');

// ---------- SQL de diccionario ----------
function buildSql(spool) {
  const A = args.owner ? 'all' : 'user';
  const O = args.owner ? args.owner.toUpperCase() : null;
  const own = a => (O ? ` and ${a}.owner='${O}'` : '');
  const same = (a, b) => (O ? ` and ${a}.owner=${b}.owner` : '');
  const pat = p => `'${p.toUpperCase().replace(/_/g, '\\_')}' escape '\\'`;
  const like = col => {
    let s = '';
    if (args.like && args.like.length) s += ` and (${args.like.map(p => `upper(${col}) like ${pat(p)}`).join(' or ')})`;
    for (const p of args['not-like'] || []) s += ` and upper(${col}) not like ${pat(p)}`;
    return s;
  };
  const clean = e => `replace(replace(replace(${e},chr(13),' '),chr(10),' '),'|','/')`;
  return `set pagesize 0 feedback off heading off verify off echo off termout off trimspool on linesize 32767 long 32767
spool "${spool}"
select 'T|'||t.table_name||'|'||${clean('c.comments')}
  from ${A}_tables t left join ${A}_tab_comments c on c.table_name=t.table_name${same('c', 't')}
 where t.table_name not like 'BIN$%'${own('t')}${like('t.table_name')} order by t.table_name;
select 'C|'||c.table_name||'|'||c.column_name||'|'||
       c.data_type||case when c.data_type in ('VARCHAR2','NVARCHAR2','CHAR','NCHAR','RAW') then '('||c.char_length||')'
                         when c.data_type='NUMBER' and c.data_precision is not null then '('||c.data_precision||case when c.data_scale>0 then ','||c.data_scale end||')' end
       ||'|'||c.nullable||'|'||c.column_id||'|'||${clean('cc.comments')}
  from ${A}_tab_columns c
  join ${A}_tables t on t.table_name=c.table_name${same('t', 'c')}
  left join ${A}_col_comments cc on cc.table_name=c.table_name and cc.column_name=c.column_name${same('cc', 'c')}
 where c.table_name not like 'BIN$%'${own('c')}${like('c.table_name')} order by c.table_name, c.column_id;
select case k.constraint_type when 'P' then 'P' else 'U' end||'|'||k.table_name||'|'||cc.column_name||'|'||cc.position||'|'||k.constraint_name
  from ${A}_constraints k join ${A}_cons_columns cc on cc.constraint_name=k.constraint_name${same('cc', 'k')}
 where k.constraint_type in ('P','U')${own('k')}${like('k.table_name')} order by k.table_name, k.constraint_name, cc.position;
select 'F|'||k.constraint_name||'|'||k.table_name||'|'||ch.column_name||'|'||pk.table_name||'|'||pc.column_name||'|'||ch.position||'|'||k.delete_rule
  from ${A}_constraints k
  join ${A}_cons_columns ch on ch.constraint_name=k.constraint_name${same('ch', 'k')}
  join ${A}_constraints pk on pk.constraint_name=k.r_constraint_name and pk.owner=k.r_owner
  join ${A}_cons_columns pc on pc.constraint_name=pk.constraint_name and pc.owner=pk.owner and pc.position=ch.position
 where k.constraint_type='R'${own('k')}${like('k.table_name')}
 order by k.table_name, k.constraint_name, ch.position;
select 'V|'||v.view_name from ${A}_views v where 1=1${own('v')}${like('v.view_name')} order by v.view_name;
spool off
`;
}

// ---------- ejecución ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'er-diagram-'));
const spool = path.join(tmp, 'schema.txt');
const sqlFile = path.join(tmp, 'extract.sql');
fs.writeFileSync(sqlFile, buildSql(spool), 'ascii');
const r = spawnSync('sqlplus', ['-S', '-L', '/nolog'], {
  input: `whenever sqlerror exit failure\nconnect ${C.conn}\n@"${sqlFile}"\nexit\n`,
  env: { ...process.env, NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8' },
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000,
});
const redact = s => String(s || '').split(C.secret).join('***');
if (r.error) fail(r.error.code === 'ENOENT' ? 'No se encontró sqlplus en el PATH. Instala Oracle Client/Instant Client con SQL*Plus.' : redact(r.error.message));
const out = redact(r.stdout) + redact(r.stderr);
const oraErr = out.match(/(ORA-\d{5}[^\n]*|SP2-\d{4}[^\n]*|TNS-\d{5}[^\n]*)/);
if (r.status !== 0 || oraErr || !fs.existsSync(spool)) fail(`sqlplus falló: ${oraErr ? oraErr[1] : out.trim().slice(0, 600) || 'sin salida'}`);

const label = args.source || `Oracle ${args.owner ? 'esquema ' + args.owner.toUpperCase() : 'esquema ' + C.user.toUpperCase()}`;
const schema = S.fromPipeLines(fs.readFileSync(spool, 'utf8'), label);
if (!args.keep) fs.rmSync(tmp, { recursive: true, force: true });
if (!schema.tables.length) fail('La consulta no devolvió tablas. Revisa --like/--not-like/--owner y los permisos del usuario.');
S.writeJson(args.out, schema);
console.log(S.summary(schema));
console.log(`escrito: ${args.out}`);

function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }
