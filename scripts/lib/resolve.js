// Aplica diagram.config.json a schema.json: asigna módulo a cada tabla y valida hubs.
'use strict';
function resolve(schema, cfg) {
  const warnings = [];
  const mods = (cfg.modules || []).map((m, i) => ({
    id: String(m.id || 'm' + i).replace(/[^A-Za-z0-9_-]/g, '-'),
    name: m.name || m.id || 'Módulo ' + (i + 1),
    re: m.match ? new RegExp(m.match, 'i') : null,
    set: m.tables ? new Set(m.tables.map(x => x.toUpperCase())) : null,
  }));
  const ids = new Set();
  for (const m of mods) { if (ids.has(m.id)) throw new Error(`Id de módulo repetido: ${m.id}`); ids.add(m.id); }
  let other = null;
  const tables = schema.tables.map(t => {
    const N = t.n.toUpperCase();
    let m = mods.find(x => x.set && x.set.has(N)) || mods.find(x => x.re && x.re.test(t.n));
    if (!m) { if (!other) { other = { id: 'otros', name: mods.length ? 'Otros' : 'Tablas', re: null, set: null }; mods.push(other); } m = other; }
    return { ...t, m: m.id };
  });
  const used = new Set(tables.map(t => t.m));
  const modules = mods.filter(m => used.has(m.id)).map((m, i) => ({ id: m.id, name: m.name, color: i % 12 }));
  for (const m of mods) if (!used.has(m.id)) warnings.push(`El módulo "${m.name}" no tiene tablas; se omite.`);
  if (modules.length > 12) warnings.push(`${modules.length} módulos: los colores se repiten a partir del 13.`);
  const names = new Set(tables.map(t => t.n));
  const hubs = (cfg.hubs || []).filter(h => { if (!names.has(h)) { warnings.push(`Hub "${h}" no existe en el esquema; se ignora.`); return false; } return true; });
  return {
    data: {
      title: cfg.title || 'Modelo de datos',
      hubsLabel: cfg.hubsLabel || hubs.join(', '),
      source: schema.source, extracted: schema.extracted,
      modules, hubs, tables, fks: schema.fks, views: schema.views || [],
    },
    warnings,
  };
}
module.exports = { resolve };
