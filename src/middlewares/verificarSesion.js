import { createHash } from "node:crypto";
import pool from "../config/db.js";

// Lee la cookie que emite InicioSesionBiblioTK (las cookies no distinguen puerto). Solo trae un
// valor aleatorio: el usuario y su rol se buscan en la tabla sesiones (que crea InicioSesionBiblioTK),
// así que cerrar sesión la invalida de verdad y el rol nunca pasa por el navegador
export async function verificarSesion(req, res, next) {
  // Lo que responde un servicio con sesión es privado: no puede quedar en la caché del navegador
  res.set("Cache-Control", "no-store");

  const token = req.cookies?.token_acceso;

  if (typeof token !== "string" || !token) {
    return res.status(401).json({ message: "No hay una sesión activa" });
  }

  let sesion;

  try {
    const [filas] = await pool.query(
      `SELECT u.id, u.email, u.rol FROM sesiones s
       JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.token_hash = ? AND s.expira > NOW()
       LIMIT 1`,
      [createHash("sha256").update(token).digest("hex")],
    );
    sesion = filas[0];
  } catch (error) {
    return next(error);
  }

  if (!sesion) {
    return res.status(401).json({ message: "La sesión expiró" });
  }

  req.sesion = { id: sesion.id, email: sesion.email, rol: sesion.rol };
  return next();
}
