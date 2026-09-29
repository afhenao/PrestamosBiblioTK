import { existsSync } from "node:fs";
import path from "node:path";

// Sin estas variables el servicio no puede funcionar (DB_PASSWORD sí puede ir vacía)
const obligatorias = ["DB_USER", "DB_NAME", "JWT_SECRET"];

// dotenv/config solo lee el archivo ".env" de la carpeta desde la que se arranca;
// ".env.example" es la plantilla que se sube a git y nunca se carga.
// Solo se nombran las variables que faltan, nunca se muestran valores
export function revisarEntorno() {
  const faltantes = obligatorias.filter((clave) => !process.env[clave]?.trim());

  if (faltantes.length === 0) return true;

  const rutaEnv = path.resolve(".env");

  if (!existsSync(rutaEnv)) {
    console.error(`No existe ${rutaEnv}.`);
    console.error(
      'dotenv solo lee ".env" (no ".env.example"): copia el .env de MaterialesBiblioTK en esta carpeta y cambia PORT a 3005.',
    );
  } else {
    console.error(`Faltan variables en ${rutaEnv}: ${faltantes.join(", ")}.`);
    console.error("Usa los mismos valores de MaterialesBiblioTK (DB_* y JWT_SECRET).");
  }

  return false;
}
