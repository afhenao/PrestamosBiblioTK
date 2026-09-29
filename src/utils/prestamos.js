import pool from "../config/db.js";
import { copiarPrestamosAReportes } from "../config/esquema.js";

// Reglas del préstamo: cambiar aquí si la biblioteca decide otros valores
export const DIAS_PRESTAMO = 15;
export const MAX_PRESTAMOS_PENDIENTES = 3;
export const LUGAR_RECOGIDA =
  process.env.LUGAR_RECOGIDA?.trim() || "el Poli, baños P40, sexto piso";

export const columnasReporte = `id, prestamo_id AS prestamoId, usuario_id AS usuarioId,
  usuario_nombre AS usuarioNombre, usuario_email AS usuarioEmail, usuario_cc AS usuarioCc,
  usuario_celular AS usuarioCelular, material_id AS materialId,
  material_titulo AS materialTitulo, material_autor AS materialAutor,
  material_tipo AS materialTipo, material_isbn AS materialIsbn,
  fecha_prestamo AS fechaPrestamo, fecha_devolucion_esperada AS fechaDevolucionEsperada,
  fecha_devolucion_real AS fechaDevolucionReal, fecha_cancelacion AS fechaCancelacion,
  cancelado_por AS canceladoPor, estado, observaciones`;

export function comoTexto(valor) {
  return typeof valor === "string" || typeof valor === "number"
    ? String(valor).trim()
    : "";
}

// VENCIDO no lo marca nadie a mano: se actualiza antes de cada lectura, en las dos tablas
export async function actualizarVencidos(conexion = pool) {
  await conexion.query(
    `UPDATE prestamos SET estado = 'VENCIDO'
     WHERE estado = 'ACTIVO' AND fecha_devolucion_esperada < NOW()`,
  );
  await conexion.query(
    `UPDATE reportes SET estado = 'VENCIDO'
     WHERE estado = 'ACTIVO' AND fecha_devolucion_esperada < NOW()`,
  );
}

// Crea el reporte del préstamo si no existe y le copia su estado y fechas actuales
export async function sincronizarReporte(conexion, prestamoId) {
  await conexion.query(`${copiarPrestamosAReportes} AND p.id = ?`, [prestamoId]);
  await conexion.query(
    `UPDATE reportes r JOIN prestamos p ON p.id = r.prestamo_id
     SET r.estado = p.estado,
         r.fecha_devolucion_esperada = p.fecha_devolucion_esperada,
         r.fecha_devolucion_real = p.fecha_devolucion_real,
         r.fecha_cancelacion = p.fecha_cancelacion,
         r.cancelado_por = p.cancelado_por,
         r.observaciones = p.observaciones
     WHERE r.prestamo_id = ?`,
    [prestamoId],
  );
}

export async function buscarReporte(conexion, prestamoId) {
  const [filas] = await conexion.query(
    `SELECT ${columnasReporte} FROM reportes WHERE prestamo_id = ? LIMIT 1`,
    [prestamoId],
  );
  return filas[0] ?? null;
}

export function resumir(reportes) {
  const resumen = {
    total: reportes.length,
    activos: 0,
    vencidos: 0,
    devueltos: 0,
    cancelados: 0,
  };

  for (const reporte of reportes) {
    if (reporte.estado === "ACTIVO") resumen.activos += 1;
    else if (reporte.estado === "VENCIDO") resumen.vencidos += 1;
    else if (reporte.estado === "DEVUELTO") resumen.devueltos += 1;
    else if (reporte.estado === "CANCELADO") resumen.cancelados += 1;
  }

  return resumen;
}
