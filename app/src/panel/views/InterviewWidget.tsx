// Widgets › Entrevista (#277): settings column of the fullscreen interview widget.
// The widget has no settings of its own: it shows the active, approved item of the active interview
// (chosen with POST /api/interviews/select or the MCP tool elegir_entrevista). This column explains
// what appears on screen and how to try it.
export function InterviewSettings() {
  return <>
    <p className="hint">Muestra en pantalla completa el ítem activo de la entrevista activa: la pregunta, su imagen, vídeo local, vídeo de YouTube o tarjeta de post, y la fuente cuando hay media. Solo se ve un ítem aprobado; sin ítem activo, el widget queda vacío y la escena se transparenta.</p>
    <ul className="hint">
      <li>Las notas privadas del presentador nunca salen en pantalla.</li>
      <li>Las imágenes y los vídeos que no son 16:9 se ven enteros, sobre una copia desenfocada.</li>
      <li>En YouTube la tarjeta de la pregunta se retira a los 8 segundos para no tapar los controles del reproductor.</li>
      <li>El avance («3 / 12») no sale en pantalla: se ve solo en el teleprompter.</li>
    </ul>
    <p className="hint mt">Parámetros: <code>?demo</code> (datos de ejemplo de todos los tipos) · <code>?demo&amp;item=3</code> (fija uno) · <code>?tuckMs=8000</code> (milisegundos que dura la tarjeta con YouTube).</p>
  </>;
}
