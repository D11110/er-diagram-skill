---
name: er-diagram-skill
description: Genera un diagrama entidad-relación (ER) interactivo de una base de datos, en un solo archivo HTML. Toma el esquema del diccionario de Oracle (solo SELECT por sqlplus), de un script DDL (Oracle, SQL Server, PostgreSQL, MySQL) o de un modelo EF Core. Lista las tablas encontradas para que el usuario elija cuáles diagramar (o las filtre con patrones tipo LIKE '%VEN%') y las agrupa por módulos, con búsqueda, zoom y panel de columnas y FK. Úsalo siempre que pidan un diagrama ER, un modelo de datos, un "modelo entidad-relación", "diagramar la base", "ver las tablas y sus relaciones" o "documentar el esquema". También cuando Toad Data Modeler, SQL Developer Data Modeler u otra herramienta de modelado falle o no esté disponible.
---

# er-diagram-skill: diagrama ER interactivo desde el esquema real

Este skill produce **un archivo `.html` autocontenido** con el diagrama ER de las tablas que elija el usuario. Incluye:

- tablas agrupadas por módulo, columnas PK/FK y líneas pata de gallo;
- búsqueda, filtro por módulo y vista "solo llaves / todas las columnas";
- zoom y arrastre;
- un panel con el comentario, las columnas y las relaciones de la tabla elegida.

Funciona en tema claro y oscuro y en teléfono. El layout lo calcula **elkjs** (ELK layered) en el navegador.

Todo el trabajo pesado lo hacen los scripts de Node en `scripts/`. Tu rol como agente es:

1. elegir la fuente del esquema;
2. **mostrarle al usuario qué tablas hay y dejar que decida**;
3. darles nombres de negocio a los módulos;
4. verificar y entregar.

No dibujes nada a mano.

## Paso 0: preparar (una vez por máquina)

```bash
cd <carpeta-del-skill>/scripts && npm install      # instala elkjs 0.9.3, la única dependencia
```

Requisitos:

- Node 18 o superior.
- Para Oracle en vivo, `sqlplus` en el PATH.
- Playwright solo si quieres las capturas de verificación (opcional).

Trabaja en una carpeta de trabajo (`<trabajo>/`) **fuera del repositorio del usuario**: los archivos intermedios no deben aparecer en su control de versiones.

## Paso 1: extraer el inventario completo

Pregúntale al usuario de dónde sale el esquema, o dedúcelo. De mejor a peor fidelidad:

1. **Base Oracle en vivo.** Refleja la realidad: FK, comentarios y tablas que no están en el código.
2. **DDL.** Puede venir de `dotnet ef dbcontext script`, de un export de la herramienta de base de datos o de los scripts del repo.
3. **Configuraciones EF leídas a mano**, como último recurso.

### 1a. Oracle en vivo

Conectarse a una base es una acción sensible. Antes de hacerlo, confirma con el usuario que autoriza consultar el diccionario en modo solo lectura, y en qué ambiente. Algunos entornos bloquean la conexión hasta que el usuario la aprueba explícitamente.

```bash
# con la cadena de un appsettings.json de .NET (USER ID=..;PASSWORD=..;DATA SOURCE=..)
node scripts/extract-oracle.js --appsettings <ruta>/appsettings.json --key DefaultConnection --out <trabajo>/schema-full.json

# o con una variable de entorno usuario/clave@descriptor; --owner para leer el esquema de otro dueño
node scripts/extract-oracle.js --conn-env ORA_CONN [--owner VENTAS] --out <trabajo>/schema-full.json
```

Qué hace el script:

- Solo ejecuta `SELECT` sobre las vistas `USER_*`, o sobre `ALL_*` si usas `--owner`.
- Le pasa la contraseña a sqlplus por stdin y la tacha en cualquier error.
- Borra sus temporales al terminar.

**No imprimas, copies ni incrustes la cadena de conexión.** El HTML final solo lleva metadatos: nombres, tipos y comentarios.

Si el esquema es enorme (miles de tablas), prefiltra ya en SQL con `--like "%VEN%"` o `--not-like "TMP%"`.

Si falla, lee la línea `ERROR:`:

| Error | Causa probable |
|---|---|
| `ORA-12560` / `ORA-12154` | El descriptor o el TNS |
| `ORA-01017` | Las credenciales |
| `0 tablas` | Los filtros, o los permisos del usuario |

### 1b. DDL o EF Core

Lee `references/efcore-ddl.md` y luego:

```bash
node scripts/from-ddl.js --in esquema.sql [--in mas.sql] --source "Modelo EF Core (AppDbContext)" --out <trabajo>/schema-full.json
```

## Paso 2: mostrar las tablas y que el usuario elija

```bash
node scripts/select-tables.js --schema <trabajo>/schema-full.json --list --list-file <trabajo>/tablas.txt
```

El script imprime los totales y **los grupos por prefijo con su número de tablas**. Si hay pocas tablas, imprime también la lista completa con el número de columnas, las FK y el comentario de cada una.

**Muéstrale al usuario ese inventario** (los grupos por prefijo, más la lista si es corta) y pregúntale qué quiere diagramar. Por ejemplo:

- **Uno o varios grupos**: `--like "VEN_%" --like "INV_%"`.
- **Todo lo que contenga una palabra**: `--like "%PEDIDO%"`.
- **Todo menos algo**: `--not-like "%_LOG" --not-like "TMP%"`.
- **Una lista exacta**: `--tables A,B,C`, o `--tables-file` con un archivo de una tabla por línea. Sirve la misma `tablas.txt` editada; las líneas con `#` se ignoran.

Cómo se interpretan los patrones:

- **`%` es comodín y `_` es literal**, sin distinción de mayúsculas. Así `VEN_%` significa "empieza con VEN_", que es como lo lee la gente.
- No hay comodín de un solo carácter.

Si una selección deja FK apuntando a tablas que quedaron fuera, ofrece `--with-parents`: agrega esas tablas padre (un nivel) para que el diagrama no quede con relaciones cortadas.

```bash
node scripts/select-tables.js --schema <trabajo>/schema-full.json --like "VEN_%" --with-parents --out <trabajo>/schema.json
```

Revisa el resumen antes de seguir: cuántas tablas y FK quedaron y qué FK cruzan el borde de la selección. Si el usuario quiere todo el inventario, copia `schema-full.json` a `schema.json`.

## Paso 3: módulos y hubs

```bash
node scripts/init-config.js --schema <trabajo>/schema.json --title "Modelo de Datos de <Sistema>" --out <trabajo>/diagram.config.json
```

El script propone dos cosas:

- **Módulos**: agrupa las tablas por el prefijo del nombre. Si un grupo es muy grande, lo divide por la segunda palabra.
- **Hubs**: tablas que reciben muchas FK, como estados, catálogos o usuarios.

**Edita la configuración.** La propuesta es mecánica; el formato completo está en `references/schema-format.md`.

- Renombra los módulos con nombres de negocio, en el idioma del usuario: "Ventas", "Inventario", no "Ven".
- Junta los grupos que son lo mismo con nombres distintos. Usa expresiones regulares con alternativas o listas `tables`.
- Deja entre 4 y 10 módulos. Con más, los colores dejan de distinguirse.
- Deja como hubs solo los catálogos transversales y ponles un `hubsLabel` legible.
  - Sin ocultar los hubs, más de la mitad de las líneas pueden converger en 2 o 3 tablas y el diagrama no se lee.
  - El usuario puede mostrarlas con el interruptor de la página.

## Paso 4: generar

```bash
node scripts/build.js --schema <trabajo>/schema.json --config <trabajo>/diagram.config.json --out <trabajo>/modelo-er.html [--inline-elk]
```

- **`--inline-elk`**: incrusta elkjs (unos 1.5 MB) para que el archivo funcione sin internet. Sin esta opción, elkjs se carga de `cdn.jsdelivr.net`.
- **Fuentes**: las IBM Plex vienen de Google Fonts. Sin red, la página usa fuentes del sistema y el layout se ajusta solo.
- **`--fragment`**: úsalo solo para plataformas que ponen su propio `<html>/<head>/<body>`, como las páginas o artifacts que publican algunos agentes.

## Paso 5: verificar antes de entregar

```bash
node scripts/verify.js --schema <trabajo>/schema.json --config <trabajo>/diagram.config.json \
  [--html <trabajo>/modelo-er.html --shots <trabajo>/capturas]
```

- **Layout (siempre, sin navegador).** Recorre todas las vistas y falla si hay tablas encimadas o líneas que no nacen y terminan en el borde de su tabla. Si falla, no entregues. Revisa la configuración (un módulo vacío, una expresión mal escrita) o reporta el caso.
- **Capturas (si hay Playwright).** Instálalo con `npm i playwright` o apunta `PLAYWRIGHT_PATH=<ruta>/node_modules/playwright`, y agrega `--html` y `--shots`. Obtienes capturas de escritorio en tema claro, en tema oscuro con una tabla seleccionada y en teléfono, además de los errores de consola.
  - **Mira las capturas**: los módulos deben leerse, la selección debe verse y el panel no debe quedar cortado.
  - Haz una sola pasada de correcciones; no entres en un ciclo.

## Paso 6: entregar

- **Siempre**: la ruta absoluta del `.html`. Se abre con doble clic en cualquier navegador.
- **Si tu entorno puede publicar páginas**: genera además una versión con `--fragment` y publícala.
- **Resumen final, en pocas líneas**:
  - de dónde salió el esquema;
  - qué tablas entraron y con qué filtro;
  - totales de tablas, columnas, FK y vistas;
  - qué FK quedaron ocultas como hubs;
  - las tablas sin relaciones;
  - las limitaciones de la fuente (por ejemplo, desde EF Core no aparecen las tablas que no están mapeadas).

## Por qué está hecho así (para cuando algo se salga del guion)

- **Diccionario en vez de herramientas de modelado.** Los asistentes de ingeniería inversa de algunas herramientas fallan con versiones o clientes que no coinciden. Las vistas del diccionario (`*_TABLES`, `*_TAB_COLUMNS`, `*_CONSTRAINTS`, `*_CONS_COLUMNS`) son estables, y sus `*_COMMENTS` vuelven útil el panel.
- **El usuario elige las tablas.** Un esquema de base suele mezclar varios sistemas, y un diagrama de cientos de tablas no sirve para nada. Por eso se lista primero y se filtra después.
- **Aristas en el ancestro común.** Con `hierarchyHandling: INCLUDE_CHILDREN`, ELK devuelve los puntos de cada arista relativos al nodo donde se declaró. Por eso `lib/er-core.js` declara cada arista en el módulo compartido o en la raíz, y suma el desplazamiento al extraer. Si cambias eso, `verify.js` lo detecta como "fueraDeBorde".
- **Una línea por par de tablas.** Si dos tablas tienen varias FK entre sí, se dibuja una sola línea y el tooltip las lista todas.
- **Medir con las fuentes reales.** La página espera a `document.fonts.load` antes de calcular el layout. Si mide con la fuente de respaldo, las cajas quedan angostas.
- **"Solo llaves" por defecto.** Con todas las columnas, 70 tablas miden unos 4500×7000 px. Con solo las llaves miden la mitad, y el panel muestra el resto.
- **Filtro por módulo.** Recalcula el layout con el módulo y sus vecinas directas, que aparecen con borde punteado.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `scripts/extract-oracle.js` | Diccionario de Oracle → `schema-full.json` |
| `scripts/from-ddl.js` | DDL o `dotnet ef` → `schema-full.json` |
| `scripts/select-tables.js` | Inventario (`--list`) y selección (`--like`, `--not-like`, `--tables`, `--with-parents`) → `schema.json` |
| `scripts/init-config.js` | Propone `diagram.config.json` (módulos y hubs) |
| `scripts/build.js` | Genera el `.html` |
| `scripts/verify.js` | Verifica el layout y, opcionalmente, toma capturas |
| `scripts/lib/` | Grafo ELK compartido entre node y el navegador, la configuración y utilidades |
| `assets/template.html` | La página: estilos, interacción y paleta de 12 colores por módulo |
| `references/schema-format.md` | Formato de `schema.json` y `diagram.config.json` |
| `references/efcore-ddl.md` | Cómo obtener el esquema de EF Core o de un DDL |
| `examples/tienda.sql` + `tienda.config.json` | Ejemplo para probar sin base de datos |
