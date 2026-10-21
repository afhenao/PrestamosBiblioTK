import pool from "../config/db.js";
import {
  actualizarVencidos,
  columnasReporte,
  comoTexto,
  resumir,
} from "../utils/prestamos.js";
import { generarReportePdf } from "../utils/reportePdf.js";

const estadosValidos = ["SOLICITADO", "ACTIVO", "VENCIDO", "DEVUELTO", "CANCELADO", "RECHAZADO"];

// AAAA-MM-DD que además exista en el calendario (2026-02-31 no pasa)
function esFechaValida(texto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const fecha = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().startsWith(texto);
}

// Filtros opcionales: ?estado=SOLICITADO|ACTIVO|…&desde=AAAA-MM-DD&hasta=AAAA-MM-DD&buscar=texto
function leerFiltros(query = {}) {
  const estado = comoTexto(query.estado).toUpperCase();
  const desde = comoTexto(query.desde);
  const hasta = comoTexto(query.hasta);

  return {
    estado: estadosValidos.includes(estado) ? estado : "",
    desde: esFechaValida(desde) ? desde : "",
    hasta: esFechaValida(hasta) ? hasta : "",
    buscar: comoTexto(query.buscar).slice(0, 100),
  };
}

async function consultarReportes({ estado, desde, hasta, buscar }) {
  const condiciones = [];
  const valores = [];

  if (estado) {
    condiciones.push("estado = ?");
    valores.push(estado);
  }

  if (desde) {
    condiciones.push("fecha_prestamo >= ?");
    valores.push(`${desde} 00:00:00`);
  }

  if (hasta) {
    condiciones.push("fecha_prestamo < DATE_ADD(?, INTERVAL 1 DAY)");
    valores.push(hasta);
  }

  if (buscar) {
    const patron = `%${buscar.replace(/[\\%_]/g, "\\$&")}%`;
    condiciones.push(
      `(usuario_nombre LIKE ? OR usuario_email LIKE ? OR usuario_cc LIKE ?
        OR material_titulo LIKE ? OR material_autor LIKE ? OR material_isbn LIKE ?)`,
    );
    valores.push(patron, patron, patron, patron, patron, patron);
  }

  const donde = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";
  const [filas] = await pool.query(
    `SELECT ${columnasReporte} FROM reportes ${donde}
     ORDER BY fecha_prestamo DESC, id DESC`,
    valores,
  );
  return filas;
}

function fechaParaArchivo(fecha) {
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getDate()).padStart(2, "0");
  return `${fecha.getFullYear()}-${mes}-${dia}`;
}

export async function listarReportes(req, res, next) {
  try {
    await actualizarVencidos();
    const filtros = leerFiltros(req.query);
    const reportes = await consultarReportes(filtros);

    return res.json({ reportes, resumen: resumir(reportes), filtros });
  } catch (error) {
    return next(error);
  }
}

export async function descargarReportePdf(req, res, next) {
  try {
    await actualizarVencidos();
    const filtros = leerFiltros(req.query);
    const reportes = await consultarReportes(filtros);
    const generadoEn = new Date();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="reporte-prestamos-${fechaParaArchivo(generadoEn)}.pdf"`,
    );

    generarReportePdf(res, reportes, {
      filtros,
      resumen: resumir(reportes),
      generadoEn,
    });
  } catch (error) {
    return next(error);
  }
}
