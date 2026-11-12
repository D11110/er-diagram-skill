/* Núcleo del diagrama ER: armado del grafo ELK y extracción de coordenadas absolutas.
   Corre igual en el navegador (global ErCore) y en node (module.exports), para poder verificar el layout.
   Espera DATA con: tables[].m (id de módulo), modules[] ({id,name,color}), hubs[] (tablas hub).

   Detalles que importan (aprendidos a golpes):
   - hierarchyHandling INCLUDE_CHILDREN para que los módulos sean nodos compuestos y las aristas crucen entre ellos.
   - Cada arista se declara en el ancestro común más bajo (el módulo si ambas tablas están en él, si no la raíz);
     ELK devuelve sus puntos relativos a ese contenedor, y extract() los pasa a absolutos sumando el offset.
   - Una sola arista por par (padre, hija): varias FKs entre las mismas tablas se agrupan en el tooltip. */
(function (root) {
  const G = { headerH: 34, rowH: 21, padX: 12, iconW: 28, gapType: 18, footH: 21, minW: 170, moduleTop: 34, modulePad: 18 };

  function visibleRows(t, mode) {
    if (mode === 'all') return { rows: t.cols, hidden: 0 };
    const rows = t.cols.filter(c => c.pk || c.fk);
    return { rows, hidden: t.cols.length - rows.length };
  }

  // measure(text, kind) -> ancho en px; kind: 'title' | 'col' | 'type'
  function nodeSize(t, mode, measure) {
    const { rows, hidden } = visibleRows(t, mode);
    let w = measure(t.n, 'title') + G.padX * 2;
    for (const c of rows) w = Math.max(w, G.padX * 2 + G.iconW + measure(c.n, 'col') + G.gapType + measure(c.t, 'type'));
    const h = G.headerH + rows.length * G.rowH + (hidden ? G.footH : 0) + 4;
    return { w: Math.ceil(Math.max(w, G.minW)), h };
  }

  /* opts: { mode: 'keys'|'all', hubs: bool, focus: moduleId|null }
     Con focus se muestran las tablas del módulo y sus vecinas directas (marcadas ghost, agrupadas aparte). */
  function buildGraph(data, opts, measure) {
    const byName = new Map(data.tables.map(t => [t.n, t]));
    const hubs = new Set(data.hubs || []);
    let fks = data.fks.filter(f => opts.hubs || !hubs.has(f.pa));
    let shown;
    const ghost = new Set();
    if (opts.focus) {
      shown = new Set(data.tables.filter(t => t.m === opts.focus).map(t => t.n));
      fks = fks.filter(f => shown.has(f.ch) || shown.has(f.pa));
      for (const f of fks) for (const n of [f.ch, f.pa]) if (!shown.has(n)) ghost.add(n);
      for (const g of ghost) shown.add(g);
    } else shown = new Set(data.tables.map(t => t.n));

    const pairs = new Map();
    for (const f of fks) {
      const k = f.pa + '>' + f.ch;
      if (!pairs.has(k)) pairs.set(k, { id: 'e' + pairs.size, pa: f.pa, ch: f.ch, fks: [] });
      pairs.get(k).fks.push(f);
    }

    const modNodes = new Map(), nodeMod = {};
    for (const n of shown) {
      const t = byName.get(n);
      const mid = opts.focus && ghost.has(n) ? 'ghost:' + t.m : t.m;
      nodeMod[n] = mid;
      if (!modNodes.has(mid)) {
        modNodes.set(mid, {
          id: 'm:' + mid, children: [], edges: [],
          layoutOptions: { 'elk.padding': `[top=${G.moduleTop},left=${G.modulePad},bottom=${G.modulePad},right=${G.modulePad}]` },
        });
      }
      const sz = nodeSize(t, opts.mode, measure);
      modNodes.get(mid).children.push({ id: n, width: sz.w, height: sz.h });
    }
    const rootEdges = [];
    for (const e of pairs.values()) {
      const edge = { id: e.id, sources: [e.pa], targets: [e.ch] };
      if (nodeMod[e.pa] === nodeMod[e.ch]) modNodes.get(nodeMod[e.pa]).edges.push(edge); else rootEdges.push(edge);
    }
    const graph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.spacing.nodeNode': '28',
        'elk.layered.spacing.nodeNodeBetweenLayers': '56',
        'elk.spacing.edgeNode': '16',
        'elk.spacing.edgeEdge': '8',
        'elk.layered.spacing.edgeNodeBetweenLayers': '20',
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.separateConnectedComponents': 'true',
        'elk.spacing.componentComponent': '48',
        'elk.aspectRatio': '1.6',
        'elk.padding': '[top=24,left=24,bottom=24,right=24]',
      },
      children: [...modNodes.values()],
      edges: rootEdges,
    };
    return { graph, pairs, ghost, shown };
  }

  function extract(res) {
    const nodes = {}, modules = [], edges = {};
    const walkEdges = (container, ox, oy) => {
      for (const e of container.edges || []) {
        const pts = [];
        for (const s of e.sections || []) {
          pts.push([s.startPoint.x + ox, s.startPoint.y + oy]);
          for (const b of s.bendPoints || []) pts.push([b.x + ox, b.y + oy]);
          pts.push([s.endPoint.x + ox, s.endPoint.y + oy]);
        }
        edges[e.id] = pts;
      }
    };
    const rx = res.x || 0, ry = res.y || 0;
    walkEdges(res, rx, ry);
    for (const m of res.children || []) {
      const mx = rx + m.x, my = ry + m.y;
      modules.push({ id: m.id.slice(2), x: mx, y: my, w: m.width, h: m.height });
      for (const c of m.children || []) nodes[c.id] = { x: mx + c.x, y: my + c.y, w: c.width, h: c.height };
      walkEdges(m, mx, my);
    }
    return { nodes, modules, edges, width: res.width, height: res.height };
  }

  const api = { G, visibleRows, nodeSize, buildGraph, extract };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ErCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
