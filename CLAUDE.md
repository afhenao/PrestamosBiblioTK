# PrestamosBiblioTK — Servicio de préstamos y reportes

Parte del sistema BiblioTK (ver `../CLAUDE.md`). Registra las solicitudes de préstamo de los lectores, su aprobación o rechazo por el bibliotecario, las devoluciones, y genera la tabla y el PDF de reportes. Lo consumen `BiblioTK-front-user` (rol `usuario`) y `BiblioTK-front-admin` (rol `admin`).

- **Puerto:** 3005 (`PORT` en `.env`)
- **Arranque:** `npm run dev` (`node --watch src/app.js`). Antes de conectar, `revisarEntorno()` (`src/config/entorno.js`) avisa si falta el archivo `.env` o alguna de `DB_USER`, `DB_NAME` (solo nombra las que faltan). Solo levanta el servidor si `testConnection()` funciona y `asegurarTablaReportes()` pudo crear/revisar la tabla `reportes`.
- **Docker:** `Dockerfile` (node:24-alpine, solo dependencias de producción, usuario `node`, sin `.env`: la configuración llega por variables de entorno). Se orquesta desde `../InfraBiblioTK` (Compose y Kubernetes).
- **Error `auth_gssapi_client`:** MariaDB lo responde cuando el usuario de `DB_USER` no existe o llega vacío (simula el login con el método de otra cuenta). Casi siempre es un `.env` que falta, mal nombrado o con otro usuario.
- **Dependencias clave:** express 5, mysql2, cookie-parser, cors, dotenv y **pdfkit** (el PDF se arma en el servidor). Versiones fijas, sin `^`. `jsonwebtoken` sigue en `package.json`, pero ya no se usa.
- **Variables (`.env`, ver `.env.example`):** `PORT=3005`, `DB_*`, `ALLOWED_ORIGIN_*` (uno por front; si no hay ninguno se aceptan 5172, 5173, 5174 y 5145) y, opcional, `LUGAR_RECOGIDA`. Lo más simple: copiar el `.env` de MaterialesBiblioTK y cambiar `PORT` a 3005.

## Estructura

- `src/app.js` — express + `cookieParser()` + CORS con `credentials: true` + router en `/PrestamosBiblioTK` + middleware de errores (JSON mal formado → 400; resto → 500 genérico)
- `src/config/db.js` — pool mysql2 y `testConnection()`
- `src/config/esquema.js` — `CREATE TABLE IF NOT EXISTS reportes` al arrancar; en `prestamos` y `reportes` agrega los estados `SOLICITADO`/`RECHAZADO` y las columnas `fecha_solicitud`, `fecha_respuesta`, `fecha_cancelacion` y `cancelado_por` si faltan (`asegurarColumnas`), y copia a `reportes` los préstamos que no tengan fila (`copiarPrestamosAReportes`, el mismo `INSERT … SELECT` que usa el alta)
- `src/middlewares/verificarSesion.js` — igual que en Perfil/Materiales: busca la sesión de la cookie `token_acceso` en la tabla `sesiones` (`JWT_SECRET` ya no se usa) y deja `req.sesion = { id, email, rol }`; respuestas con `Cache-Control: no-store`
- `src/middlewares/verificarRol.js` — `verificarRol("usuario" | "admin")`, 403 con otro rol
- `src/utils/prestamos.js` — reglas (`DIAS_PRESTAMO = 15`, `MAX_PRESTAMOS_PENDIENTES = 3`, `LUGAR_RECOGIDA`), `estadosEnCurso` (`SOLICITADO`, `ACTIVO`, `VENCIDO`: ocupan el material y cuentan para el máximo), `actualizarVencidos`, `avisarVencidos`, `liberarMaterial`, `sincronizarReporte`, `resumir`. `actualizarVencidos` devuelve los préstamos que acaban de vencer (los bloquea con `FOR UPDATE` para no avisar dos veces): con una conexión, quien llama avisa con `avisarVencidos` después de su commit; sin conexión, abre una transacción corta y avisa solo
- `src/utils/notificar.js` — avisa a NotificacionesBiblioTK después del commit, sin esperar respuesta: `prestamo.solicitado`, `prestamo.aprobado`, `prestamo.rechazado`, `prestamo.cancelado`, `prestamo.devuelto` y `prestamo.vencido` (los ven el bibliotecario y el lector dueño). Opcionales: `NOTIFICACIONES_URL` y `NOTIFICACIONES_CLAVE`
- `src/utils/reportePdf.js` — PDF A4 horizontal con pdfkit: encabezado, tarjetas de resumen, tabla con cabecera repetida en cada hoja y "Página X de Y"
- `src/controllers/prestamosController.js` — `crearPrestamo` (solicitud), `listarMisPrestamos`, `aprobarPrestamo`, `rechazarPrestamo`, `registrarDevolucion`, `cancelarMiPrestamo`, `cancelarPrestamo`
- `src/controllers/reportesController.js` — `listarReportes`, `descargarReportePdf`

## Tabla `reportes`

Una fila por préstamo con una **copia** de los datos del usuario (`usuario_nombre`, `usuario_email`, `usuario_cc`, `usuario_celular`) y del material (`material_titulo`, `material_autor`, `material_tipo`, `material_isbn`), más fechas, `estado` y `observaciones`. Es la fuente de la tabla de préstamos y del PDF del bibliotecario.

- `prestamo_id` → `prestamos.id` con `ON DELETE SET NULL` (UNIQUE): como `prestamos` borra en cascada al borrar un usuario o un material, la fila de `reportes` se queda y el historial no se pierde.
- Al borrar una cuenta, `PerfilBiblioTK` deja en NULL los datos personales de sus filas (usuario_id, nombre, correo, cédula, celular): el historial queda anónimo.
- Todo cambio de un préstamo se copia en la misma transacción (`sincronizarReporte`).

## Endpoints (`/PrestamosBiblioTK`)

| Método | Ruta | Rol | Respuesta |
|---|---|---|---|
| GET | `/health` | pública | `{ message }` |
| POST | `/Prestamos` | `usuario` | Body `{ materialId }` → 201 `{ message, prestamo, recogida }` (la solicitud, `SOLICITADO`) |
| GET | `/Prestamos/mios` | `usuario` | `{ prestamos, recogida, maximo, dias }` (filas de `reportes` del usuario) |
| PUT | `/Prestamos/mios/:id/cancelacion` | `usuario` | Cancela su solicitud o su préstamo `ACTIVO` → `{ message, prestamo }` |
| PUT | `/Prestamos/:id/aprobacion` | `admin` | `SOLICITADO` → `ACTIVO` → `{ message, prestamo }` |
| PUT | `/Prestamos/:id/rechazo` | `admin` | Body `{ motivo? }`: `SOLICITADO` → `RECHAZADO` → `{ message, prestamo }` |
| PUT | `/Prestamos/:id/devolucion` | `admin` | Body `{ observaciones? }` → `{ message, prestamo }` |
| PUT | `/Prestamos/:id/cancelacion` | `admin` | Body `{ motivo? }`: cancela un préstamo `ACTIVO`/`VENCIDO` → `{ message, prestamo }` |
| GET | `/Reportes` | `admin` | `?estado&desde&hasta&buscar` → `{ reportes, resumen, filtros }` |
| GET | `/Reportes/pdf` | `admin` | mismos filtros → `application/pdf` (`reporte-prestamos-AAAA-MM-DD.pdf`) |

`prestamo` y cada elemento de `reportes` usan camelCase (`prestamoId`, `usuarioNombre`, `materialTitulo`, `fechaDevolucionEsperada`…). `recogida` es el lugar donde se retira el libro físico ("el Poli, baños P40, sexto piso"); el lector solo debe ir cuando su solicitud está aprobada.

## Estados

```
SOLICITADO ──aprobar──▶ ACTIVO ──vence──▶ VENCIDO
    │                     │                 │
    ├─rechazar─▶ RECHAZADO └──── devolver ───┴──▶ DEVUELTO
    └─el lector cancela─▶ CANCELADO ◀── cancelar (lector: ACTIVO; bibliotecario: ACTIVO/VENCIDO)
```

- La solicitud **aparta el material** (`disponible = 0`) y cuenta para el máximo de 3, así dos lectores no piden el mismo libro.
- Mientras está `SOLICITADO`, `fecha_prestamo` es la fecha de la solicitud (para ordenar y filtrar) y no hay `fecha_devolucion_esperada`. Al aprobar, `fecha_prestamo` pasa a ser la de entrega y la devolución queda a 15 días desde ahí.
- Una solicitud sin aprobar se **rechaza**, no se cancela (el bibliotecario recibe 409 si intenta cancelarla). Rechazar, cancelar o devolver liberan el material si no tiene otro préstamo en curso (`liberarMaterial`).

### POST /Prestamos (transacción)

1. `materialId` entero > 0, si no → 400 `{ campo: "materialId" }`.
2. Marca como `VENCIDO` lo que ya pasó su fecha (en `prestamos` y `reportes`).
3. Cuenta inactiva (`usuarios.activo = 0`) → 403. Con préstamos `VENCIDO` → 409. Con 3 en curso (`SOLICITADO`/`ACTIVO`/`VENCIDO`) → 409.
4. `SELECT … FOR UPDATE` del material: si no existe → 404; si `disponible = 0` o ya tiene un préstamo o solicitud en curso → 409. Dos pedidos simultáneos del mismo material: el segundo recibe 409.
5. `INSERT` en `prestamos` (`SOLICITADO`, `fecha_solicitud = fecha_prestamo = NOW()`), `disponible = 0` y copia a `reportes`. Avisa `prestamo.solicitado`.

### PUT /Prestamos/:id/aprobacion y /rechazo

Bloquean el préstamo (`FOR UPDATE`); si no está `SOLICITADO` → 409 (ya aprobado, rechazado o cancelado por el lector). Aprobar: `ACTIVO`, `fecha_respuesta = fecha_prestamo = NOW()`, devolución a 15 días; avisa `prestamo.aprobado` con el lugar de recogida. Rechazar: `RECHAZADO`, `fecha_respuesta = NOW()`, motivo (máx. 255) en `observaciones`, libera el material; avisa `prestamo.rechazado`.

### PUT /Prestamos/:id/devolucion

Solo `ACTIVO` o `VENCIDO` (lo demás → 409). `DEVUELTO` + `fecha_devolucion_real = NOW()` + observaciones (máx. 255), el material vuelve a `disponible = 1` (si no tiene otro préstamo en curso) y se sincroniza `reportes`.

## Problemas conocidos

- `VENCIDO` se calcula al leer (cualquier GET o POST de este servicio): no hay tarea programada.
- Las reglas (15 días, máximo 3) son constantes en `src/utils/prestamos.js`, no configurables por la interfaz.
- Es un repositorio nuevo: todavía sin `git init`, commits ni remoto.
