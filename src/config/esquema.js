import pool from "./db.js";

const estadosPrestamo = "ENUM('ACTIVO','DEVUELTO','VENCIDO','CANCELADO')";

// reportes guarda, por cada préstamo, una copia de los datos del usuario y del material.
// Es la fuente de la tabla de préstamos y del PDF del bibliotecario, y no pierde historial:
// prestamos tiene ON DELETE CASCADE, pero aquí prestamo_id pasa a NULL y la fila se queda
const crearTablaReportes = `
  CREATE TABLE IF NOT EXISTS reportes (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    prestamo_id INT UNSIGNED NULL,
    usuario_id INT UNSIGNED NULL,
    usuario_nombre VARCHAR(101) NULL,
    usuario_email VARCHAR(100) NULL,
    usuario_cc VARCHAR(15) NULL,
    usuario_celular VARCHAR(15) NULL,
    material_id INT UNSIGNED NULL,
    material_titulo VARCHAR(150) NULL,
    material_autor VARCHAR(100) NULL,
    material_tipo VARCHAR(20) NULL,
    material_isbn VARCHAR(20) NULL,
    fecha_prestamo DATETIME NULL,
    fecha_devolucion_esperada DATETIME NULL,
    fecha_devolucion_real DATETIME NULL,
    fecha_cancelacion DATETIME NULL,
    cancelado_por VARCHAR(20) NULL,
    estado ${estadosPrestamo} NOT NULL DEFAULT 'ACTIVO',
    observaciones VARCHAR(255) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_reportes_prestamo (prestamo_id),
    KEY idx_reportes_usuario (usuario_id),
    KEY idx_reportes_estado (estado),
    CONSTRAINT fk_reportes_prestamos FOREIGN KEY (prestamo_id)
      REFERENCES prestamos (id) ON DELETE SET NULL ON UPDATE CASCADE
  ) ENGINE=InnoDB`;

// Copia los datos del usuario y del material de cada préstamo que todavía no tenga reporte.
// Sirve para los préstamos creados antes de la tabla (o a mano, desde HeidiSQL)
export const copiarPrestamosAReportes = `
  INSERT INTO reportes
    (prestamo_id, usuario_id, usuario_nombre, usuario_email, usuario_cc, usuario_celular,
     material_id, material_titulo, material_autor, material_tipo, material_isbn,
     fecha_prestamo, fecha_devolucion_esperada, fecha_devolucion_real, fecha_cancelacion,
     cancelado_por, estado, observaciones)
  SELECT p.id, u.id, CONCAT_WS(' ', u.nombres, u.apellidos), u.email, u.cc, u.celular,
         m.id, m.titulo, m.autor, m.tipo_material, m.isbn,
         p.fecha_prestamo, p.fecha_devolucion_esperada, p.fecha_devolucion_real,
         p.fecha_cancelacion, p.cancelado_por, p.estado, p.observaciones
  FROM prestamos p
  JOIN usuarios u ON u.id = p.usuario_id
  JOIN materiales m ON m.id = p.material_id
  LEFT JOIN reportes r ON r.prestamo_id = p.id
  WHERE r.id IS NULL`;

// Cancelar un préstamo necesita el estado CANCELADO y saber cuándo y quién lo canceló
// ("usuario" o "admin"). Las BD creadas antes no lo tienen: se agrega solo, una vez
const columnasCancelacion = [
  { nombre: "fecha_cancelacion", definicion: "DATETIME NULL DEFAULT NULL AFTER fecha_devolucion_real" },
  { nombre: "cancelado_por", definicion: "VARCHAR(20) NULL DEFAULT NULL AFTER fecha_cancelacion" },
];

async function asegurarCancelacion(tabla) {
  const [columnas] = await pool.query(
    `SELECT COLUMN_NAME AS nombre, COLUMN_TYPE AS tipo FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tabla],
  );
  const tipos = new Map(columnas.map((columna) => [columna.nombre, columna.tipo]));

  if (!String(tipos.get("estado")).includes("'CANCELADO'")) {
    await pool.query(
      `ALTER TABLE ${tabla} MODIFY estado ${estadosPrestamo} NOT NULL DEFAULT 'ACTIVO'`,
    );
    console.log(`${tabla}.estado ahora acepta CANCELADO`);
  }

  for (const columna of columnasCancelacion) {
    if (!tipos.has(columna.nombre)) {
      await pool.query(`ALTER TABLE ${tabla} ADD COLUMN ${columna.nombre} ${columna.definicion}`);
      console.log(`Columna ${tabla}.${columna.nombre} agregada`);
    }
  }
}

export async function asegurarTablaReportes() {
  try {
    await pool.query(crearTablaReportes);
    await asegurarCancelacion("prestamos");
    await asegurarCancelacion("reportes");
    const [resultado] = await pool.query(copiarPrestamosAReportes);

    if (resultado.affectedRows > 0) {
      console.log(`Se copiaron ${resultado.affectedRows} préstamos a la tabla reportes`);
    }
  } catch (error) {
    console.error("No se pudo preparar la tabla reportes:", error.message);
    throw error;
  }
}
