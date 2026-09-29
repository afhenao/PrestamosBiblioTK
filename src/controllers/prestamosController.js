import pool from "../config/db.js";
import { copiarPrestamosAReportes } from "../config/esquema.js";
import {
  actualizarVencidos,
  buscarReporte,
  columnasReporte,
  comoTexto,
  DIAS_PRESTAMO,
  LUGAR_RECOGIDA,
  MAX_PRESTAMOS_PENDIENTES,
  sincronizarReporte,
} from "../utils/prestamos.js";

function rechazo(status, cuerpo) {
  return { status, cuerpo };
}

// Reglas antes de prestar. Devuelve { status, cuerpo } si no se puede, o null
async function revisarSolicitud(conexion, usuarioId, materialId) {
  const [[usuario]] = await conexion.query(
    "SELECT activo FROM usuarios WHERE id = ? LIMIT 1",
    [usuarioId],
  );

  if (!usuario) {
    return rechazo(404, { message: "No se encontró tu cuenta." });
  }

  if (!usuario.activo) {
    return rechazo(403, {
      message: "Tu cuenta está inactiva: acércate a la biblioteca para reactivarla.",
    });
  }

  const [[pendientes]] = await conexion.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(estado = 'VENCIDO'), 0) AS vencidos
     FROM prestamos WHERE usuario_id = ? AND estado IN ('ACTIVO', 'VENCIDO')`,
    [usuarioId],
  );

  if (Number(pendientes.vencidos) > 0) {
    return rechazo(409, {
      message: "Tienes préstamos vencidos: devuélvelos antes de pedir otro.",
    });
  }

  if (Number(pendientes.total) >= MAX_PRESTAMOS_PENDIENTES) {
    return rechazo(409, {
      message: `Ya tienes ${MAX_PRESTAMOS_PENDIENTES} préstamos activos, el máximo permitido. Devuelve uno para pedir otro.`,
    });
  }

  // FOR UPDATE: si dos personas piden el mismo material a la vez, la segunda espera
  // a que termine la primera y ya lo encuentra prestado
  const [[material]] = await conexion.query(
    "SELECT id, disponible FROM materiales WHERE id = ? FOR UPDATE",
    [materialId],
  );

  if (!material) {
    return rechazo(404, {
      campo: "materialId",
      message: "Ese material ya no está en el catálogo.",
    });
  }

  const [[{ ocupado }]] = await conexion.query(
    `SELECT COUNT(*) AS ocupado FROM prestamos
     WHERE material_id = ? AND estado IN ('ACTIVO', 'VENCIDO')`,
    [materialId],
  );

  if (!material.disponible || Number(ocupado) > 0) {
    return rechazo(409, {
      campo: "materialId",
      message: "Este material ya no está disponible para préstamo.",
    });
  }

  return null;
}

export async function crearPrestamo(req, res, next) {
  const materialId = Number(req.body?.materialId);

  if (!Number.isInteger(materialId) || materialId <= 0) {
    return res
      .status(400)
      .json({ campo: "materialId", message: "Elige un material del catálogo." });
  }

  let conexion;

  try {
    conexion = await pool.getConnection();
    await conexion.beginTransaction();
    await actualizarVencidos(conexion);

    const problema = await revisarSolicitud(conexion, req.sesion.id, materialId);

    if (problema) {
      await conexion.rollback();
      return res.status(problema.status).json(problema.cuerpo);
    }

    const [resultado] = await conexion.query(
      `INSERT INTO prestamos
       (usuario_id, material_id, fecha_prestamo, fecha_devolucion_esperada, estado)
       VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), 'ACTIVO')`,
      [req.sesion.id, materialId, DIAS_PRESTAMO],
    );

    await conexion.query("UPDATE materiales SET disponible = 0 WHERE id = ?", [
      materialId,
    ]);

    // El reporte copia los datos del usuario y del material en la misma transacción
    await conexion.query(`${copiarPrestamosAReportes} AND p.id = ?`, [
      resultado.insertId,
    ]);

    const prestamo = await buscarReporte(conexion, resultado.insertId);
    await conexion.commit();

    return res.status(201).json({
      message: "Préstamo registrado",
      prestamo,
      recogida: LUGAR_RECOGIDA,
    });
  } catch (error) {
    await conexion?.rollback().catch(() => undefined);
    return next(error);
  } finally {
    conexion?.release();
  }
}

export async function listarMisPrestamos(req, res, next) {
  try {
    await actualizarVencidos();

    const [prestamos] = await pool.query(
      `SELECT ${columnasReporte} FROM reportes
       WHERE usuario_id = ?
       ORDER BY fecha_prestamo DESC, id DESC`,
      [req.sesion.id],
    );

    return res.json({
      prestamos,
      recogida: LUGAR_RECOGIDA,
      maximo: MAX_PRESTAMOS_PENDIENTES,
    });
  } catch (error) {
    return next(error);
  }
}

export async function registrarDevolucion(req, res, next) {
  const prestamoId = Number(req.params.id);
  const observaciones = comoTexto(req.body?.observaciones);

  if (!Number.isInteger(prestamoId) || prestamoId <= 0) {
    return res.status(404).json({ message: "No se encontró el préstamo" });
  }

  if (observaciones.length > 255) {
    return res.status(400).json({
      campo: "observaciones",
      message: "Las observaciones deben tener máximo 255 caracteres.",
    });
  }

  let conexion;

  try {
    conexion = await pool.getConnection();
    await conexion.beginTransaction();

    const [[prestamo]] = await conexion.query(
      "SELECT id, material_id AS materialId, estado FROM prestamos WHERE id = ? FOR UPDATE",
      [prestamoId],
    );

    if (!prestamo) {
      await conexion.rollback();
      return res.status(404).json({ message: "No se encontró el préstamo" });
    }

    if (prestamo.estado === "DEVUELTO" || prestamo.estado === "CANCELADO") {
      await conexion.rollback();
      return res.status(409).json({
        message:
          prestamo.estado === "DEVUELTO"
            ? "Este préstamo ya estaba registrado como devuelto."
            : "Este préstamo fue cancelado: no hay nada que devolver.",
      });
    }

    await conexion.query(
      `UPDATE prestamos
       SET estado = 'DEVUELTO', fecha_devolucion_real = NOW(),
           observaciones = COALESCE(?, observaciones)
       WHERE id = ?`,
      [observaciones || null, prestamoId],
    );

    // El material vuelve a estar disponible (salvo que tuviera otro préstamo pendiente)
    await conexion.query(
      `UPDATE materiales SET disponible = 1
       WHERE id = ? AND NOT EXISTS (
         SELECT 1 FROM prestamos WHERE material_id = ? AND estado IN ('ACTIVO', 'VENCIDO')
       )`,
      [prestamo.materialId, prestamo.materialId],
    );

    await sincronizarReporte(conexion, prestamoId);
    const reporte = await buscarReporte(conexion, prestamoId);
    await conexion.commit();

    return res.json({ message: "Devolución registrada", prestamo: reporte });
  } catch (error) {
    await conexion?.rollback().catch(() => undefined);
    return next(error);
  } finally {
    conexion?.release();
  }
}

// quien: "usuario" cancela solo sus préstamos ACTIVO (un VENCIDO ya implica tener el libro:
// hay que devolverlo); "admin" cancela cualquier préstamo ACTIVO o VENCIDO, con motivo opcional
async function cancelar(req, res, next, quien) {
  const prestamoId = Number(req.params.id);
  const motivo = comoTexto(req.body?.motivo);

  if (!Number.isInteger(prestamoId) || prestamoId <= 0) {
    return res.status(404).json({ message: "No se encontró el préstamo" });
  }

  if (motivo.length > 255) {
    return res.status(400).json({
      campo: "motivo",
      message: "El motivo debe tener máximo 255 caracteres.",
    });
  }

  let conexion;

  try {
    conexion = await pool.getConnection();
    await conexion.beginTransaction();
    await actualizarVencidos(conexion);

    const [[prestamo]] = await conexion.query(
      `SELECT id, usuario_id AS usuarioId, material_id AS materialId, estado
       FROM prestamos WHERE id = ? FOR UPDATE`,
      [prestamoId],
    );

    // A un lector, el préstamo de otra persona le responde igual que uno que no existe
    if (!prestamo || (quien === "usuario" && prestamo.usuarioId !== req.sesion.id)) {
      await conexion.rollback();
      return res.status(404).json({ message: "No se encontró el préstamo" });
    }

    if (prestamo.estado === "DEVUELTO" || prestamo.estado === "CANCELADO") {
      await conexion.rollback();
      return res.status(409).json({
        message:
          prestamo.estado === "DEVUELTO"
            ? "Este préstamo ya fue devuelto: no se puede cancelar."
            : "Este préstamo ya estaba cancelado.",
      });
    }

    if (quien === "usuario" && prestamo.estado === "VENCIDO") {
      await conexion.rollback();
      return res.status(409).json({
        message: `Este préstamo está vencido y ya no se puede cancelar: devuelve el libro en ${LUGAR_RECOGIDA}.`,
      });
    }

    await conexion.query(
      `UPDATE prestamos
       SET estado = 'CANCELADO', fecha_cancelacion = NOW(), cancelado_por = ?,
           observaciones = COALESCE(?, observaciones)
       WHERE id = ?`,
      [quien, motivo || null, prestamoId],
    );

    // El material vuelve a estar disponible para los demás lectores
    await conexion.query(
      `UPDATE materiales SET disponible = 1
       WHERE id = ? AND NOT EXISTS (
         SELECT 1 FROM prestamos WHERE material_id = ? AND estado IN ('ACTIVO', 'VENCIDO')
       )`,
      [prestamo.materialId, prestamo.materialId],
    );

    await sincronizarReporte(conexion, prestamoId);
    const reporte = await buscarReporte(conexion, prestamoId);
    await conexion.commit();

    return res.json({ message: "Préstamo cancelado", prestamo: reporte });
  } catch (error) {
    await conexion?.rollback().catch(() => undefined);
    return next(error);
  } finally {
    conexion?.release();
  }
}

export function cancelarMiPrestamo(req, res, next) {
  return cancelar(req, res, next, "usuario");
}

export function cancelarPrestamo(req, res, next) {
  return cancelar(req, res, next, "admin");
}
