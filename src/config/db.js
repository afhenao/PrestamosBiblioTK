import mysql from "mysql2/promise";
import "dotenv/config";

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export async function testConnection() {
  try {
    await pool.query("SELECT 1");
    console.log("Conexión a BD exitosa");
  } catch (error) {
    console.error("Error al conectar a la BD:", error.message);

    // MariaDB pide auth_gssapi_client cuando el usuario de DB_USER no existe (o llega vacío)
    if (String(error.message).includes("auth_gssapi_client")) {
      console.error(
        "MariaDB no reconoce el usuario de DB_USER: usa el mismo DB_USER y DB_PASSWORD que MaterialesBiblioTK.",
      );
    }

    throw error;
  }
}

export default pool;
