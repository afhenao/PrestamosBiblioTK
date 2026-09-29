import cookieParser from "cookie-parser";
import cors from "cors";
import "dotenv/config";
import express from "express";
import { testConnection } from "./config/db.js";
import { revisarEntorno } from "./config/entorno.js";
import { asegurarTablaReportes } from "./config/esquema.js";
import routerBiblioTK from "./router/routerBiblioTK.js";

const app = express();
const puerto = Number(process.env.PORT) || 3005;

// Mismo criterio que Perfil y Materiales: los orígenes salen de ALLOWED_ORIGIN_* del .env.
// Si no hay ninguno, se aceptan los fronts locales para que el servicio funcione recién clonado
const origenesDelEnv = Object.entries(process.env)
  .filter(([key, value]) => key.startsWith("ALLOWED_ORIGIN_") && value)
  .map(([, origin]) => origin.trim());

const allowedOrigins = origenesDelEnv.length
  ? origenesDelEnv
  : [
      "http://localhost:5172",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5145",
    ];

app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use("/PrestamosBiblioTK", routerBiblioTK);

// Los detalles del error se quedan en la consola: al cliente solo le llega un mensaje genérico
app.use((error, _req, res, _next) => {
  if (error.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({ message: "El cuerpo de la solicitud no es un JSON válido" });
  }

  console.error("Error del servidor:", error);

  if (res.headersSent) return res.end();

  return res.status(500).json({ message: "Error interno del servidor" });
});

async function iniciarServidor() {
  if (!revisarEntorno()) {
    process.exitCode = 1;
    return;
  }

  try {
    await testConnection();
    await asegurarTablaReportes();
    app.listen(puerto, () => {
      console.log(`Servicio de préstamos corriendo en el puerto ${puerto}`);
    });
  } catch {
    process.exitCode = 1;
  }
}

iniciarServidor();
