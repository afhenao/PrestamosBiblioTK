import jwt from "jsonwebtoken";

// Lee la cookie que emite InicioSesionBiblioTK (las cookies no distinguen puerto)
export function verificarSesion(req, res, next) {
  const token = req.cookies?.token_acceso;

  if (!token) {
    return res.status(401).json({ message: "No hay una sesión activa" });
  }

  try {
    const { sub, email, rol } = jwt.verify(token, process.env.JWT_SECRET);
    req.sesion = { id: Number(sub), email, rol };
    return next();
  } catch {
    return res.status(401).json({ message: "La sesión expiró" });
  }
}
