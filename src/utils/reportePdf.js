import PDFDocument from "pdfkit";

// Mismos colores del tema de bibliotk-ui (pine, sand, honey, clay)
const colores = {
  pino: "#143229",
  pinoTexto: "#2f5d4e",
  arena: "#f6f2ea",
  linea: "#ddd2bd",
  crema: "#fdfbf7",
  tinta: "#0b221c",
  tintaSuave: "#4f6259",
  arcilla: "#a3402f",
  miel: "#875824",
};

const estados = {
  SOLICITADO: { etiqueta: "Por aprobar", color: colores.miel },
  ACTIVO: { etiqueta: "Activo", color: colores.pinoTexto },
  VENCIDO: { etiqueta: "Vencido", color: colores.arcilla },
  DEVUELTO: { etiqueta: "Devuelto", color: colores.tintaSuave },
  CANCELADO: { etiqueta: "Cancelado", color: colores.miel },
  RECHAZADO: { etiqueta: "Rechazado", color: colores.arcilla },
};

const canceladoPor = {
  usuario: "por el usuario",
  admin: "por el bibliotecario",
};

function fueSolicitud(fila) {
  return (
    fila.estado === "SOLICITADO" ||
    fila.estado === "RECHAZADO" ||
    (fila.estado === "CANCELADO" && Boolean(fila.fechaSolicitud) && !fila.fechaRespuesta)
  );
}

const tipos = { LIBRO: "Libro", REVISTA: "Revista", NOVELA: "Novela" };

const formatoFecha = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const formatoGenerado = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeStyle: "short",
});

// Las fuentes estándar del PDF no traen los espacios finos que usa Intl ("5:20 p. m.")
function sinEspaciosEspeciales(texto) {
  return texto.replace(/[  ]/g, " ");
}

function fecha(valor) {
  if (!valor) return "—";
  const dato = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(dato.getTime()) ? "—" : formatoFecha.format(dato);
}

// Los filtros llegan como AAAA-MM-DD: se reordenan sin pasar por zonas horarias
function fechaFiltro(texto) {
  const [anio, mes, dia] = texto.split("-");
  return `${dia}/${mes}/${anio}`;
}

function describirFiltros({ estado, desde, hasta, buscar }) {
  const partes = [`Estado: ${estado ? estados[estado].etiqueta.toLowerCase() : "todos"}`];

  if (desde && hasta) partes.push(`del ${fechaFiltro(desde)} al ${fechaFiltro(hasta)}`);
  else if (desde) partes.push(`desde el ${fechaFiltro(desde)}`);
  else if (hasta) partes.push(`hasta el ${fechaFiltro(hasta)}`);

  if (buscar) partes.push(`búsqueda: «${buscar}»`);

  return partes.join("  ·  ");
}

// Cada celda es una lista de líneas con su estilo; los anchos se escalan al ancho de la hoja
const columnas = [
  { titulo: "#", ancho: 22, celda: (_fila, indice) => [{ texto: String(indice + 1), suave: true }] },
  {
    titulo: "Usuario",
    ancho: 150,
    celda: (fila) => [
      { texto: fila.usuarioNombre || "Usuario eliminado", negrita: true },
      fila.usuarioCc && { texto: `C.C. ${fila.usuarioCc}`, suave: true },
      fila.usuarioEmail && { texto: fila.usuarioEmail, suave: true },
    ],
  },
  {
    titulo: "Material",
    ancho: 170,
    celda: (fila) => [
      { texto: fila.materialTitulo || "—", negrita: true },
      fila.materialAutor && { texto: fila.materialAutor, suave: true },
      fila.materialIsbn && { texto: `ISBN ${fila.materialIsbn}`, suave: true },
    ],
  },
  {
    titulo: "Tipo",
    ancho: 48,
    celda: (fila) => [{ texto: tipos[fila.materialTipo] ?? fila.materialTipo ?? "—" }],
  },
  {
    titulo: "Prestado",
    ancho: 56,
    // Nunca aprobado (esperando, rechazado o cancelado antes de aprobarse): es la fecha de la solicitud
    celda: (fila) => [
      { texto: fecha(fila.fechaPrestamo) },
      fueSolicitud(fila) && {
        texto: "solicitud",
        suave: true,
      },
    ],
  },
  {
    titulo: "Devolver antes de",
    ancho: 62,
    celda: (fila) => [{ texto: fecha(fila.fechaDevolucionEsperada) }],
  },
  { titulo: "Devuelto", ancho: 56, celda: (fila) => [{ texto: fecha(fila.fechaDevolucionReal) }] },
  {
    titulo: "Estado",
    ancho: 62,
    celda: (fila) => [
      {
        texto: estados[fila.estado]?.etiqueta ?? fila.estado,
        negrita: true,
        color: estados[fila.estado]?.color,
      },
      // Quién canceló y cuándo, debajo del estado
      fila.estado === "CANCELADO" &&
        canceladoPor[fila.canceladoPor] && {
          texto: canceladoPor[fila.canceladoPor],
          suave: true,
        },
      fila.estado === "CANCELADO" &&
        fila.fechaCancelacion && { texto: fecha(fila.fechaCancelacion), suave: true },
      fila.estado === "RECHAZADO" &&
        fila.fechaRespuesta && { texto: fecha(fila.fechaRespuesta), suave: true },
    ],
  },
  {
    titulo: "Observaciones",
    ancho: 112,
    celda: (fila) => [{ texto: fila.observaciones || "—", suave: !fila.observaciones }],
  },
];

const tamanoTexto = 8.5;
const relleno = 5;

function estiloLinea(doc, linea) {
  return doc
    .font(linea.negrita ? "Helvetica-Bold" : "Helvetica")
    .fontSize(tamanoTexto)
    .fillColor(linea.color ?? (linea.suave ? colores.tintaSuave : colores.tinta));
}

function lineasDe(columna, fila, indice) {
  return columna.celda(fila, indice).filter(Boolean);
}

function altoCelda(doc, lineas, ancho) {
  return lineas.reduce(
    (total, linea) =>
      total + estiloLinea(doc, linea).heightOfString(linea.texto, { width: ancho }),
    0,
  );
}

function dibujarEncabezado(doc, { filtros, resumen, generadoEn, izquierda, anchoUtil }) {
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(colores.miel)
    .text("BIBLIOTK", izquierda, doc.page.margins.top, { characterSpacing: 2 });
  doc
    .font("Helvetica-Bold")
    .fontSize(24)
    .fillColor(colores.tinta)
    .text("Reporte de préstamos", izquierda, doc.y + 4);
  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor(colores.tintaSuave)
    .text(
      `Generado el ${sinEspaciosEspeciales(formatoGenerado.format(generadoEn))}  ·  ${describirFiltros(filtros)}`,
      izquierda,
      doc.y + 4,
      { width: anchoUtil },
    );

  const tarjetas = [
    ["Total", resumen.total, colores.tinta],
    ["Por aprobar", resumen.solicitados, colores.miel],
    ["Activos", resumen.activos, colores.pinoTexto],
    ["Vencidos", resumen.vencidos, colores.arcilla],
    ["Devueltos", resumen.devueltos, colores.tintaSuave],
    ["Cancelados", resumen.cancelados, colores.miel],
    ["Rechazados", resumen.rechazados, colores.arcilla],
  ];
  const arriba = doc.y + 14;
  // Todas en una fila, repartidas en el ancho de la hoja
  const anchoTarjeta = (anchoUtil - 10 * (tarjetas.length - 1)) / tarjetas.length;
  const altoTarjeta = 46;

  tarjetas.forEach(([etiqueta, valor, color], indice) => {
    const x = izquierda + indice * (anchoTarjeta + 10);
    doc.roundedRect(x, arriba, anchoTarjeta, altoTarjeta, 10).fill(colores.arena);
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(colores.tintaSuave)
      .text(etiqueta, x + 12, arriba + 9, { width: anchoTarjeta - 24 });
    doc
      .font("Helvetica-Bold")
      .fontSize(16)
      .fillColor(color)
      .text(String(valor), x + 12, arriba + 21, { width: anchoTarjeta - 24 });
  });

  return arriba + altoTarjeta + 18;
}

function dibujarCabeceraTabla(doc, y, { izquierda, anchos, anchoUtil }) {
  const opciones = (indice) => ({
    width: anchos[indice] - relleno * 2,
    characterSpacing: 0.3,
  });
  doc.font("Helvetica-Bold").fontSize(7.5);
  const alto =
    Math.max(
      ...columnas.map((columna, indice) =>
        doc.heightOfString(columna.titulo.toUpperCase(), opciones(indice)),
      ),
    ) +
    relleno * 2;

  doc.rect(izquierda, y, anchoUtil, alto).fill(colores.pino);

  let x = izquierda;
  columnas.forEach((columna, indice) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .fillColor(colores.crema)
      .text(columna.titulo.toUpperCase(), x + relleno, y + relleno, opciones(indice));
    x += anchos[indice];
  });

  return y + alto;
}

function numerarPaginas(doc, { izquierda, anchoUtil }) {
  const { start, count } = doc.bufferedPageRange();

  for (let pagina = start; pagina < start + count; pagina += 1) {
    doc.switchToPage(pagina);
    const margenInferior = doc.page.margins.bottom;
    // Sin margen inferior mientras se escribe el pie: si no, pdfkit abre una hoja nueva
    doc.page.margins.bottom = 0;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(colores.tintaSuave)
      .text(
        `BiblioTK  ·  Reporte de préstamos  ·  Página ${pagina - start + 1} de ${count}`,
        izquierda,
        doc.page.height - margenInferior + 12,
        { width: anchoUtil, align: "center", lineBreak: false },
      );
    doc.page.margins.bottom = margenInferior;
  }
}

// Escribe el PDF directamente en `destino` (la respuesta HTTP)
export function generarReportePdf(destino, reportes, { filtros, resumen, generadoEn }) {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 36,
    bufferPages: true,
    info: {
      Title: "Reporte de préstamos",
      Author: "BiblioTK",
      Subject: "Préstamos de material bibliográfico",
    },
  });
  doc.pipe(destino);

  const izquierda = doc.page.margins.left;
  const anchoUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const escala = anchoUtil / columnas.reduce((suma, columna) => suma + columna.ancho, 0);
  const anchos = columnas.map((columna) => columna.ancho * escala);
  const medidas = { izquierda, anchos, anchoUtil };
  const limiteInferior = () => doc.page.height - doc.page.margins.bottom;

  let y = dibujarEncabezado(doc, { filtros, resumen, generadoEn, izquierda, anchoUtil });
  y = dibujarCabeceraTabla(doc, y, medidas);

  if (reportes.length === 0) {
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(colores.tintaSuave)
      .text("No hay préstamos con los filtros elegidos.", izquierda, y + 16, {
        width: anchoUtil,
        align: "center",
      });
  }

  reportes.forEach((fila, indice) => {
    const celdas = columnas.map((columna) => lineasDe(columna, fila, indice));
    const alto =
      Math.max(
        ...celdas.map((lineas, i) => altoCelda(doc, lineas, anchos[i] - relleno * 2)),
      ) +
      relleno * 2;

    // La fila no se parte entre hojas: si no cabe, pasa entera a la siguiente con su cabecera
    if (y + alto > limiteInferior()) {
      doc.addPage();
      y = dibujarCabeceraTabla(doc, doc.page.margins.top, medidas);
    }

    if (indice % 2 === 1) {
      doc.rect(izquierda, y, anchoUtil, alto).fill(colores.arena);
    }

    let x = izquierda;
    celdas.forEach((lineas, i) => {
      let yLinea = y + relleno;

      for (const linea of lineas) {
        const opciones = { width: anchos[i] - relleno * 2 };
        estiloLinea(doc, linea).text(linea.texto, x + relleno, yLinea, opciones);
        yLinea += doc.heightOfString(linea.texto, opciones);
      }

      x += anchos[i];
    });

    y += alto;
    doc
      .moveTo(izquierda, y)
      .lineTo(izquierda + anchoUtil, y)
      .lineWidth(0.5)
      .strokeColor(colores.linea)
      .stroke();
  });

  numerarPaginas(doc, { izquierda, anchoUtil });
  doc.end();
}
