import { Router } from "express";
import {
  cancelarMiPrestamo,
  cancelarPrestamo,
  crearPrestamo,
  listarMisPrestamos,
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

// Lector (rol usuario): pide préstamos, consulta los suyos y cancela los que siguen activos
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

// Bibliotecario (rol admin): tabla de préstamos, devoluciones, cancelaciones y reporte en PDF
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
