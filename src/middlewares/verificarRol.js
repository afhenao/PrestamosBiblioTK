const mensajes = {
  usuario: "Solo los lectores pueden pedir préstamos desde su cuenta.",
  admin: "Solo un bibliotecario puede administrar los préstamos y sus reportes.",
};

// Va después de verificarSesion: deja pasar solo al rol indicado
export function verificarRol(rol) {
  return (req, res, next) => {
    if (req.sesion?.rol !== rol) {
      return res.status(403).json({
        message: mensajes[rol] ?? "No tienes permiso para esta acción.",
      });
    }

    return next();
  };
}
