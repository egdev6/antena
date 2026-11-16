import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const notesFile = new URL('../docs/releases/v0.16.0.md', import.meta.url);
const notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : '';
const section = title => notes.split(`### ${title}\n`)[1]?.split(/\n### /)[0] ?? '';
const novedades = section('Novedades');
const mejoras = section('Mejoras');
const correcciones = section('Correcciones');
const importante = section('Importante');
const limitaciones = section('Limitaciones conocidas');
const instalacion = section('Instalación y actualización');
const agradecimientos = section('Agradecimientos');
const obs = novedades.split('\n').find(line => line.includes('OBS Studio')) ?? '';
const copia = novedades.split('\n').find(line => line.includes('Copia de la configuración')) ?? '';
const soloMeld = limitaciones.split('\n').find(line => line.includes('Solo con Meld')) ?? '';

test('S1: la versión presenta OBS experimental y la copia completa', () => {
  assert.match(notes, /## antena 0\.16\.0 — OBS Studio \(experimental\) y copia completa de tu configuración/i);
  assert.match(obs, /elige OBS en \*\*Conexiones › Programa de emisión\*\*/i);
  assert.match(limitaciones, /la compatibilidad con OBS es experimental/i);
});

test('S1: OBS permite controlar escenas, fuentes, filtros, medios y audio con medidores', () => {
  assert.match(obs, /cambiar de escena/i);
  assert.match(obs, /mostrar u ocultar fuentes/i);
  assert.match(obs, /activar filtros y controlar medios y audio/i);
  assert.match(obs, /los medidores de audio se ven en vivo desde el dock/i);
});

test('S1: OBS permite emitir con sesión automática y grabar', () => {
  assert.match(obs, /inicia y detén la emisión con sesión automática/i);
  assert.match(obs, /graba, también con «Grabar al empezar el directo»/i);
  assert.match(importante, /controlas la emisión real; la grabación también es real/i);
});

test('S1: la copia ZIP incluye configuración y medios, con historial opcional', () => {
  assert.match(copia, /\*\*Ajustes › General › Copia de la configuración\*\*/);
  assert.match(copia, /exporta un archivo `\.zip` con alertas, widgets, overlays y archivos multimedia/i);
  assert.match(copia, /puedes incluir los directos pasados; la casilla está marcada por defecto/i);
});

test('S1: la importación muestra una vista previa, hace copia y aplica o revierte', () => {
  assert.match(copia, /al importar, revisa la vista previa/i);
  assert.match(copia, /crea una copia de seguridad automática/i);
  assert.match(copia, /aplica configuración, medios y directos conjuntamente, o revierte los cambios si falla/i);
  assert.match(limitaciones, /un reintento de guardado coincida con una importación fallida, la retención podría eliminar un directo antiguo/i);
});

test('S1: las credenciales de las conexiones no se exportan y las copias locales son privadas', () => {
  assert.match(importante, /las credenciales de tus conexiones no se exportan/i);
  assert.match(importante, /tokens, contraseñas y claves de acceso/i);
  assert.match(importante, /las copias locales de seguridad pueden contener credenciales; mantenlas privadas/i);
});

test('S1: el historial puede contener datos del chat y se avisa de archivos omitidos', () => {
  assert.match(importante, /el historial puede incluir nombres y mensajes del chat; comparte el ZIP con cuidado/i);
  assert.match(limitaciones, /la exportación omite archivos con nombres no seguros o que superan sus límites de tamaño y te avisa/i);
});

test('S1: OBS y Meld reales no se validaron en Windows antes de publicar', () => {
  assert.match(limitaciones, /no se ha validado con OBS ni Meld reales en Windows antes de publicar esta versión/i);
  assert.match(limitaciones, /https:\/\/github\.com\/egdev6\/antena\/issues\/190/);
});

test('S1: la lista de funciones exclusivas de Meld no se atribuye a OBS', () => {
  assert.match(soloMeld, /^- \*\*Solo con Meld:\*\* /);
  assert.match(soloMeld, /los clips, las capturas y otros comandos de Meld, salvo los de emisión y grabación/i);
  assert.match(soloMeld, /los eventos de widgets \(como el confeti\)/i);
  assert.match(soloMeld, /las propiedades de la API v2/i);
  assert.match(soloMeld, /las llamadas en bruto y las escenas preparadas/i);
  assert.match(soloMeld, /el dock dentro del panel de chat de Meld/i);
  assert.match(soloMeld, /con OBS puedes abrir el dock como ventana flotante/i);
});

test('S1: Meld conserva su comportamiento y los alias permanentes', () => {
  assert.match(importante, /Meld sigue funcionando como hasta ahora/i);
  assert.match(importante, /se mantienen de forma permanente los alias `\/api\/meld\*` y `meld_\*`/i);
});

test('S1: el instalador sigue sin firma de código de Windows', () => {
  assert.match(limitaciones, /el instalador no está firmado con un certificado de Windows/i);
  assert.match(limitaciones, /SmartScreen avisa de «editor desconocido»/i);
  assert.match(limitaciones, /Más información › Ejecutar de todas formas/);
});

test('S1: los textos neutrales y las acciones exclusivas se explican', () => {
  assert.match(mejoras, /panel, el dock y los mensajes ahora dicen «programa de emisión»/i);
  assert.match(mejoras, /acciones exclusivas de Meld aparecen desactivadas con una explicación/i);
  assert.match(mejoras, /acciones exclusivas guardadas se omiten sin detener el resto de la lista/i);
  assert.match(mejoras, /si OBS está conectado, la API también rechaza estas acciones con una explicación y código 409/i);
});

test('S1: las integraciones disponen de nombres genéricos de API y MCP', () => {
  assert.match(mejoras, /rutas `\/api\/program\*` y herramientas MCP `programa_\*` con nombres neutrales/i);
});

test('S1: el dock usa tres columnas desde 768 px y Directo alinea sus elementos', () => {
  assert.match(mejoras, /tres columnas a partir de 768 px, tanto en horizontal como en vertical/i);
  assert.match(mejoras, /en Directo las columnas se alinean con las tarjetas y la línea de estado ordena mejor sus avisos/i);
});

test('S1: la vista previa de chat cambia de lugar y muestra ejemplos', () => {
  assert.match(mejoras, /la vista previa del widget de chat se ha trasladado de Directo a Chat/i);
  assert.match(mejoras, /muestra mensajes de ejemplo incluso sin actividad/i);
});

test('S1: se corrigen las variantes nuevas de chat sin alterar las existentes', () => {
  assert.match(correcciones, /las nuevas variantes de chat empiezan con el CSS personalizado vacío/i);
  assert.match(correcciones, /las variantes existentes no se modifican/i);
});

test('S1: el arreglo del arranque describe el bloqueo de reparación y el reintento', () => {
  assert.match(correcciones, /en Windows se podía interrumpir el arranque cuando otro proceso estaba liberando el bloqueo de reparación de la identidad de la instalación/i);
  assert.match(correcciones, /antena reintenta si el bloqueo sigue temporalmente ocupado/i);
});

test('S1: las subidas multimedia simultáneas con el mismo nombre se corrigen', () => {
  assert.match(correcciones, /las subidas simultáneas de archivos multimedia con el mismo nombre ya no fallan por coincidir en el tiempo/i);
});

test('S1: el README incluye una guía para configurar OBS', () => {
  assert.match(mejoras, /en el README encontrarás una guía para configurar OBS/i);
});

test('S1: la instalación y actualización conservan las instrucciones anteriores', () => {
  assert.match(instalacion, /si vienes de la 0\.9\.0 o anterior, instalas por primera vez o tienes la 0\.14\.0 y no se abre el panel/i);
  assert.match(instalacion, /antena_0\.16\.0_x64-setup\.exe/);
  assert.match(instalacion, /sin permisos de administrador, y encima de una versión anterior, sin desinstalar/i);
  assert.match(instalacion, /si ya tienes la 0\.10\.0 o posterior y puedes abrir el panel/i);
  assert.match(instalacion, /Buscar actualizaciones.*Descargar y reiniciar/i);
  assert.match(instalacion, /tus datos se conservan/i);
  assert.match(instalacion, /%APPDATA%\\es\.egdev\.antena/);
});

test('S1: el enlace técnico está fijado al commit del rango', () => {
  assert.match(notes, /https:\/\/github\.com\/egdev6\/antena\/compare\/v0\.15\.0\.\.\.254fea78ea5bce1ed0f9373fb53d82b828ee129d\)/);
});

test('S1: los agradecimientos solo atribuyen participación acreditada', () => {
  assert.match(agradecimientos, /\[@egdev6\]\(https:\/\/github\.com\/egdev6\)/);
  assert.match(agradecimientos, /propuesto, informado y desarrollado/i);
  assert.doesNotMatch(agradecimientos, /\b(?:probado|revisado)\b/i);
});
