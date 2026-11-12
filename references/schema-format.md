# Formatos de er-diagram-skill

## schema.json

Lo producen `extract-oracle.js`, `from-ddl.js` y `select-tables.js`. También lo puede escribir el agente a mano.

```json
{
  "source": "Oracle esquema VENTAS",
  "extracted": "2026-11-12",
  "tables": [
    {
      "n": "VEN_PEDIDOS_DETALLE",
      "cm": "Líneas de cada pedido",
      "cols": [
        { "n": "ID_PEDIDO", "t": "NUMBER(12)", "nn": true, "pk": 1, "fk": 1, "cm": "" },
        { "n": "LINEA", "t": "NUMBER(5)", "nn": true, "pk": 1, "cm": "" },
        { "n": "SKU", "t": "VARCHAR2(30)", "nn": false, "uq": 1, "cm": "Código del producto" }
      ]
    }
  ],
  "fks": [
    { "n": "VEN_PD_PED_FK", "ch": "VEN_PEDIDOS_DETALLE", "chc": ["ID_PEDIDO"],
      "pa": "VEN_PEDIDOS", "pac": ["ID"], "del": "CASCADE" }
  ],
  "views": ["VEN_V_VENTAS_DIARIAS"]
}
```

| Campo | Significado |
|---|---|
| `source` | Texto de la cabecera: de dónde salió el esquema. |
| `extracted` | Fecha ISO `AAAA-MM-DD` de la extracción. |
| `tables[].n` | Nombre exacto de la tabla. Es la clave que usan todos los demás campos. |
| `tables[].cm` | Comentario de la tabla; `""` si no hay. |
| `cols[].t` | Tipo legible: `VARCHAR2(50)`, `NUMBER(18,6)`, `NVARCHAR(MAX)`… |
| `cols[].nn` | `true` si la columna es NOT NULL. |
| `cols[].pk` / `fk` / `uq` | `1` si la columna forma parte de la PK, de alguna FK o de un UNIQUE. Si no aplica, se omite. |
| `fks[].ch` / `chc` | Tabla hija (la que guarda la FK) y sus columnas, en orden. |
| `fks[].pa` / `pac` | Tabla padre (la referenciada) y sus columnas, en el mismo orden que `chc`. |
| `fks[].del` | `CASCADE`, `SET NULL` o `""` (sin regla o `NO ACTION`). |
| `views` | Nombres de vistas: se listan en el panel, pero no se dibujan. |

Notas:

- **FK compuestas**: van con varias columnas en `chc`/`pac`. No las separes en varias FK.
- **FK hacia tablas que no están en `tables`**: se descartan al generar. `select-tables.js` y los extractores las reportan como FK fuera del alcance.

## diagram.config.json

Lo propone `init-config.js` y lo ajusta el agente.

```json
{
  "title": "Modelo de Datos de la Tienda",
  "modules": [
    { "id": "ventas",     "name": "Ventas",     "match": "^VEN_" },
    { "id": "inventario", "name": "Inventario", "match": "^INV_|^ALM_" },
    { "id": "clientes",   "name": "Clientes",   "tables": ["CLI_CLIENTES", "CLI_DIRECCIONES"] },
    { "id": "otros",      "name": "Catálogos y sistema", "match": ".*" }
  ],
  "hubs": ["GEN_ESTADOS"],
  "hubsLabel": "Estados"
}
```

- **`title`**: el nombre de la página y su `<title>`. Usa el nombre completo del sistema tal como lo dice el usuario.
- **`modules`**: se evalúan **en orden**. Cada tabla cae en el primer módulo cuya lista `tables` la incluya; si no, en el primero cuya expresión regular `match` coincida (sin distinguir mayúsculas).
  - Un `".*"` al final sirve de cajón de sastre. Las tablas que no caen en ningún módulo van a "Otros".
  - La paleta tiene 12 colores: a partir del módulo 13 se repiten.
  - Los ids solo admiten letras, números, `-` y `_`.
- **`hubs`**: tablas muy referenciadas cuyas FK se ocultan por defecto. Se muestran con un interruptor.
  - `init-config.js` propone las tablas referenciadas por al menos 8 FK y por al menos el 25 % del número de tablas. Ajusta ese porcentaje con `--hub-share 0.15`.
- **`hubsLabel`**: el texto del interruptor, que se muestra como "FK a {hubsLabel}".
