# Esquema desde EF Core o desde un script DDL (sin conectarse a la base)

Usa esta vía en cualquiera de estos casos:

- no hay acceso a la base;
- el usuario no autoriza la conexión;
- la fuente de verdad es el código.

## Opción A: que EF Core genere el DDL (la más fiel al modelo)

EF Core puede emitir el `CREATE TABLE` de todo su modelo sin tocar la base:

```bash
# una vez, si no está la herramienta
dotnet tool install --global dotnet-ef

# DDL del modelo actual (no hace falta tener migraciones)
dotnet ef dbcontext script --project <ProyectoDelDbContext> --startup-project <ProyectoWeb> \
  --context <NombreDelDbContext> --output schema-ef.sql
```

Tropiezos frecuentes:

- **Falta el paquete de diseño.** El proyecto de inicio necesita `Microsoft.EntityFrameworkCore.Design`. Si no lo tiene, pide permiso antes de agregarlo, o usa la opción B.
- **El startup falla al construir el host** (servicios externos, jobs en segundo plano, secretos ausentes). Agrega una `IDesignTimeDbContextFactory<TContext>` mínima, con un connection string ficticio, en una copia de trabajo. No la agregues al repositorio sin permiso.
- **Un IDE abierto tiene bloqueados los `obj/`.** Compila con una carpeta de artefactos aparte: `dotnet build --artifacts-path <tmp>`.
- **Hay migraciones.** En ese caso también sirve `dotnet ef migrations script --idempotent -o schema-ef.sql`.

Después conviértelo a `schema-full.json`:

```bash
node scripts/from-ddl.js --in schema-ef.sql --source "Modelo EF Core (<NombreDelDbContext>)" --out schema-full.json
```

## Opción B: un script DDL que ya exista

Sirve cualquier `.sql` con `CREATE TABLE`, por ejemplo:

- el export de Toad o de SQL Developer;
- los scripts del repositorio;
- `pg_dump --schema-only`;
- `mysqldump --no-data`;
- el script generado desde SSMS.

```bash
node scripts/from-ddl.js --in tablas.sql --in constraints.sql --out schema-full.json
```

`from-ddl.js` entiende:

- `CREATE TABLE` con restricciones en línea (`PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `REFERENCES`) y de tabla;
- `ALTER TABLE ... ADD [CONSTRAINT]`, incluidos `WITH CHECK ADD` y `ADD (…, …)`;
- `COMMENT ON TABLE` y `COMMENT ON COLUMN`;
- `CREATE VIEW`;
- los separadores `;`, `/` (SQL\*Plus) y `GO`;
- nombres con `[corchetes]`, `"comillas"` o `` `backticks` ``, con o sin prefijo de esquema.

Todo lo demás se descarta: PL/SQL, INSERT, GRANT, índices, etc.

Después de convertir:

1. Revisa el resumen que imprime: tablas, FK y tablas sin PK. Si falta una FK que esperabas, revisa cómo está escrita en el script.
2. Sigue con `select-tables.js --list` para que el usuario elija qué tablas diagramar.

## Opción C: leer las configuraciones de EF a mano (último recurso)

Úsala si no se puede compilar y tampoco hay DDL.

1. Lee el `DbContext` y las clases `IEntityTypeConfiguration<T>`. Lo que importa está en:
   - `ToTable` y `HasKey`;
   - `Property(...).HasColumnName / HasColumnType / IsRequired`;
   - `HasOne / WithMany / HasForeignKey / HasPrincipalKey`.
2. Escribe `schema-full.json` directamente con el formato de `references/schema-format.md`.

Esta vía tiene dos limitaciones, y hay que avisárselas al usuario en la entrega:

- las relaciones por convención no siempre aparecen en `HasForeignKey`;
- las tablas que no están mapeadas en EF no salen.
