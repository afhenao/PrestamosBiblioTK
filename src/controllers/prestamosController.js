import pool from "../config/db.js";
import { copiarPrestamosAReportes } from "../config/esquema.js";
import { notificar } from "../utils/notificar.js";
import {
  actualizarVencidos,
  avisarVencidos,
  buscarReporte,
  columnasReporte,
  comoTexto,
  DIAS_PRESTAMO,
  estadosEnCurso,
  LUGAR_RECOGIDA,
  liberarMaterial,
  MAX_PRESTAMOS_PENDIENTES,
  sincronizarReporte,
} from "../utils/prestamos.js";

function rechazo(status, cuerpo) {
  return { status, cuerpo };
}

// Reglas antes de aceptar una solicitud. Devuelve { status, cuerpo } si no se puede, o null
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

  // Las solicitudes que esperan aprobación también cuentan para el máximo
  const [[pendientes]] = await conexion.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(estado = 'VENCIDO'), 0) AS vencidos
     FROM prestamos WHERE usuario_id = ? AND estado IN ${estadosEnCurso}`,
    [usuarioId],
  );

  if (Number(pendientes.vencidos) > 0) {
    return rechazo(409, {
      message: "Tienes préstamos vencidos: devuélvelos antes de pedir otro.",
    });
  }

  if (Number(pendientes.total) >= MAX_PRESTAMOS_PENDIENTES) {
    return rechazo(409, {
      message: `Ya tienes ${MAX_PRESTAMOS_PENDIENTES} préstamos o solicitudes en curso, el máximo permitido. Devuelve o cancela uno para pedir otro.`,
    });
  }

  // FOR UPDATE: si dos personas piden el mismo material a la vez, la segunda espera
  // a que termine la primera y ya lo encuentra apartado
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
     WHERE material_id = ? AND estado IN ${estadosEnCurso}`,
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

// El lector solo deja la solicitud: el material queda apartado, pero no se puede recoger
// hasta que un bibliotecario la apruebe (PUT /Prestamos/:id/aprobacion)
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
    const vencidos = await actualizarVencidos(conexion);

    const problema = await revisarSolicitud(conexion, req.sesion.id, materialId);

    if (problema) {
      await conexion.rollback();
      return res.status(problema.status).json(problema.cuerpo);
    }

    // fecha_prestamo guarda por ahora la fecha de la solicitud (ordena y filtra la tabla);
    // al aprobar pasa a ser la fecha de entrega y desde ahí corren los días del préstamo
    const [resultado] = await conexion.query(
      `INSERT INTO prestamos
       (usuario_id, material_id, fecha_solicitud, fecha_prestamo, estado)
       VALUES (?, ?, NOW(), NOW(), 'SOLICITADO')`,
      [req.sesion.id, materialId],
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

    // Solo después del commit: lo ven los bibliotecarios (para aprobarla) y el lector
    avisarVencidos(vencidos);
    notificar("prestamo.solicitado", {
      prestamoId: prestamo.prestamoId,
      usuarioId: prestamo.usuarioId,
      usuarioNombre: prestamo.usuarioNombre,
      materialTitulo: prestamo.materialTitulo,
    });

    return res.status(201).json({
      message: "Solicitud registrada",
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
      dias: DIAS_PRESTAMO,
    });
  } catch (error) {
    return next(error);
  }
}

// Bloquea el préstamo para responder la solicitud. Devuelve { prestamo } o { status, cuerpo }
async function buscarSolicitud(conexion, prestamoId) {
  const [[prestamo]] = await conexion.query(
    `SELECT id, material_id AS materialId, estado FROM prestamos WHERE id = ? FOR UPDATE`,
    [prestamoId],
  );

  if (!prestamo) {
    return rechazo(404, { message: "No se encontró la solicitud" });
  }

  if (prestamo.estado !== "SOLICITADO") {
    const motivos = {
      RECHAZADO: "Esta solicitud ya fue rechazada.",
      CANCELADO: "El lector canceló esta solicitud.",
    };

    return rechazo(409, {
      message: motivos[prestamo.estado] ?? "Esta solicitud ya fue aprobada.",
    });
  }

  return { prestamo };
}

// Aprobar: el préstamo empieza ahora (los días corren desde la aprobación) y el lector ya
// puede recoger el libro físico
export async function aprobarPrestamo(req, res, next) {
  const prestamoId = Number(req.params.id);

  if (!Number.isInteger(prestamoId) || prestamoId <= 0) {
    return res.status(404).json({ message: "No se encontró la solicitud" });
  }

  let conexion;

  try {
    conexion = await pool.getConnection();
    await conexion.beginTransaction();

    const resultado = await buscarSolicitud(conexion, prestamoId);

    if (!resultado.prestamo) {
      await conexion.rollback();
      return res.status(resultado.status).json(resultado.cuerpo);
    }

    await conexion.query(
      `UPDATE prestamos
       SET estado = 'ACTIVO', fecha_respuesta = NOW(), fecha_prestamo = NOW(),
           fecha_devolucion_esperada = DATE_ADD(NOW(), INTERVAL ? DAY)
       WHERE id = ?`,
      [DIAS_PRESTAMO, prestamoId],
    );

    await sincronizarReporte(conexion, prestamoId);
    const reporte = await buscarReporte(conexion, prestamoId);
    await conexion.commit();

    notificar("prestamo.aprobado", {
      prestamoId,
      usuarioId: reporte.usuarioId,
      usuarioNombre: reporte.usuarioNombre,
      materialTitulo: reporte.materialTitulo,
      fechaDevolucionEsperada: reporte.fechaDevolucionEsperada,
      lugarRecogida: LUGAR_RECOGIDA,
    });

    return res.json({ message: "Préstamo aprobado", prestamo: reporte });
  } catch (error) {
    await conexion?.rollback().catch(() => undefined);
    return next(error);
  } finally {
    conexion?.release();
  }
}

// Rechazar: la solicitud se cierra con un motivo opcional y el material vuelve al catálogo
export async function rechazarPrestamo(req, res, next) {
  const prestamoId = Number(req.params.id);
  const motivo = comoTexto(req.body?.motivo);

  if (!Number.isInteger(prestamoId) || prestamoId <= 0) {
    return res.status(404).json({ message: "No se encontró la solicitud" });
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

    const resultado = await buscarSolicitud(conexion, prestamoId);

    if (!resultado.prestamo) {
      await conexion.rollback();
      return res.status(resultado.status).json(resultado.cuerpo);
    }

    await conexion.query(
      `UPDATE prestamos
       SET estado = 'RECHAZADO', fecha_respuesta = NOW(),
           observaciones = COALESCE(?, observaciones)
       WHERE id = ?`,
      [motivo || null, prestamoId],
    );

    await liberarMaterial(conexion, resultado.prestamo.materialId);
    await sincronizarReporte(conexion, prestamoId);
    const reporte = await buscarReporte(conexion, prestamoId);
    await conexion.commit();

    notificar("prestamo.rechazado", {
      prestamoId,
      usuarioId: reporte.usuarioId,
      usuarioNombre: reporte.usuarioNombre,
      materialTitulo: reporte.materialTitulo,
      motivo: motivo || null,
    });

    return res.json({ message: "Solicitud rechazada", prestamo: reporte });
  } catch (error) {
    await conexion?.rollback().catch(() => undefined);
    return next(error);
  } finally {
    conexion?.release();
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

    // Solo se devuelve lo que se entregó: un préstamo aprobado (ACTIVO) o vencido
    if (prestamo.estado !== "ACTIVO" && prestamo.estado !== "VENCIDO") {
      const motivos = {
        DEVUELTO: "Este préstamo ya estaba registrado como devuelto.",
        CANCELADO: "Este préstamo fue cancelado: no hay nada que devolver.",
        SOLICITADO: "Esta solicitud todavía no se aprueba: el libro no se ha entregado.",
        RECHAZADO: "Esta solicitud fue rechazada: no hay nada que devolver.",
      };

      await conexion.rollback();
      return res.status(409).json({ message: motivos[prestamo.estado] });
    }

    await conexion.query(
      `UPDATE prestamos
       SET estado = 'DEVUELTO', fecha_devolucion_real = NOW(),
           observaciones = COALESCE(?, observaciones)
       WHERE id = ?`,
      [observaciones || null, prestamoId],
    );

    await liberarMaterial(conexion, prestamo.materialId);
    await sincronizarReporte(conexion, prestamoId);
    const reporte = await buscarReporte(conexion, prestamoId);
    await conexion.commit();

    notificar("prestamo.devuelto", {
      prestamoId,
      usuarioId: reporte.usuarioId,
      usuarioNombre: reporte.usuarioNombre,
      materialTitulo: reporte.materialTitulo,
    });

    return res.json({ message: "Devolución registrada", prestamo: reporte });
  } catch (error) {
    await conexion?.rollback().catch(() => undefined);
    return next(error);
  } finally {
    conexion?.release();
  }
}

// quien: "usuario" cancela solo lo suyo que siga SOLICITADO o ACTIVO (un VENCIDO ya implica
// tener el libro: hay que devolverlo); "admin" cancela cualquier préstamo ACTIVO o VENCIDO, con
// motivo opcional (una solicitud sin aprobar se rechaza, no se cancela)
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
    const vencidos = await actualizarVencidos(conexion);

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

    const cerrados = {
      DEVUELTO: "Este préstamo ya fue devuelto: no se puede cancelar.",
      CANCELADO: "Este préstamo ya estaba cancelado.",
      RECHAZADO: "Esta solicitud ya fue rechazada.",
    };

    if (cerrados[prestamo.estado]) {
      await conexion.rollback();
      return res.status(409).json({ message: cerrados[prestamo.estado] });
    }

    if (quien === "usuario" && prestamo.estado === "VENCIDO") {
      await conexion.rollback();
      return res.status(409).json({
        message: `Este préstamo está vencido y ya no se puede cancelar: devuelve el libro en ${LUGAR_RECOGIDA}.`,
      });
    }

    if (quien === "admin" && prestamo.estado === "SOLICITADO") {
      await conexion.rollback();
      return res.status(409).json({
        message: "Esta solicitud todavía no se aprueba: recházala en vez de cancelarla.",
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
    await liberarMaterial(conexion, prestamo.materialId);
    await sincronizarReporte(conexion, prestamoId);
    const reporte = await buscarReporte(conexion, prestamoId);
    await conexion.commit();

    avisarVencidos(vencidos);
    notificar("prestamo.cancelado", {
      prestamoId,
      usuarioId: reporte.usuarioId,
      usuarioNombre: reporte.usuarioNombre,
      materialTitulo: reporte.materialTitulo,
      canceladoPor: quien,
      solicitud: prestamo.estado === "SOLICITADO",
      motivo: quien === "admin" ? motivo || null : null,
    });

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
