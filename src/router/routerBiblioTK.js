import { Router } from "express";
import {
  aprobarPrestamo,
  cancelarMiPrestamo,
  cancelarPrestamo,
  crearPrestamo,
  listarMisPrestamos,
  rechazarPrestamo,
  registrarDevolucion,
} from "../controllers/prestamosController.js";
import {
  descargarReportePdf,
  listarReportes,
} from "../controllers/reportesController.js";
import { verificarRol } from "../middlewares/verificarRol.js";
import { verificarSesion } from "../middlewares/verificarSesion.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ message: "Servicio de préstamos activo" });
});

// Lector (rol usuario): solicita préstamos, consulta los suyos y cancela los que siguen
// solicitados o activos
router.post("/Prestamos", verificarSesion, verificarRol("usuario"), crearPrestamo);
router.get(
  "/Prestamos/mios",
  verificarSesion,
  verificarRol("usuario"),
  listarMisPrestamos,
);
router.put(
  "/Prestamos/mios/:id/cancelacion",
  verificarSesion,
  verificarRol("usuario"),
  cancelarMiPrestamo,
);

// Bibliotecario (rol admin): aprueba o rechaza solicitudes, registra devoluciones y
// cancelaciones, y descarga el reporte en PDF
router.put(
  "/Prestamos/:id/aprobacion",
  verificarSesion,
  verificarRol("admin"),
  aprobarPrestamo,
);
router.put(
  "/Prestamos/:id/rechazo",
  verificarSesion,
  verificarRol("admin"),
  rechazarPrestamo,
);
router.put(
  "/Prestamos/:id/devolucion",
  verificarSesion,
  verificarRol("admin"),
  registrarDevolucion,
);
router.put(
  "/Prestamos/:id/cancelacion",
  verificarSesion,
  verificarRol("admin"),
  cancelarPrestamo,
);
router.get("/Reportes", verificarSesion, verificarRol("admin"), listarReportes);
router.get("/Reportes/pdf", verificarSesion, verificarRol("admin"), descargarReportePdf);

export default router;
