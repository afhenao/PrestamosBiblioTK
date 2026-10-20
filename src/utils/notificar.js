// Avisa a NotificacionesBiblioTK (siempre después del commit). No se espera la respuesta: si el
// servicio no está, solo queda en la consola y la operación sigue. En Docker/Kubernetes,
// NOTIFICACIONES_URL apunta al servicio interno y NOTIFICACIONES_CLAVE es la clave compartida
const urlNotificaciones =
  process.env.NOTIFICACIONES_URL?.trim() || "http://localhost:3006/NotificacionesBiblioTK";

export function notificar(tipo, datos) {
  const clave = process.env.NOTIFICACIONES_CLAVE?.trim();

  fetch(`${urlNotificaciones}/interno/eventos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(clave && { "x-clave-interna": clave }),
    },
    body: JSON.stringify({ tipo, datos }),
    signal: AbortSignal.timeout(3000),
  })
    .then((respuesta) => {
      if (!respuesta.ok) {
        console.warn(`NotificacionesBiblioTK respondió ${respuesta.status} al evento ${tipo}`);
      }
    })
    .catch((error) => {
      console.warn(`No se pudo avisar ${tipo} a NotificacionesBiblioTK: ${error.message}`);
    });
}
