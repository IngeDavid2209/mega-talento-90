/**
 * PRUEBAS DEL HORARIO DEDUCIDO (puerto TS).
 *
 * Corre:  npx tsx tools/probar-horario.ts
 *
 * Los casos y los resultados esperados son LOS MISMOS que en
 * `BOT-RH/scripts/probar-horario-deducido.js` y `probar-confirmados.js`. La misma
 * regla vive en dos repos porque los dos tienen que aplicarla y son servicios
 * distintos; esta prueba es el candado contra la deriva: si alguien cambia el
 * criterio de bloque, la bolsa semanal o el corte de semana en un repo y no en el
 * otro, aquí falla y el número de la pantalla deja de coincidir con el del bot.
 *
 * Lógica pura: no toca la base.
 */
import * as h from '../src/agente-horarios/horario-deducido';

let fallos = 0;
const ok = (t: string, c: boolean) => { if (!c) fallos++; console.log(`${c ? '  ok ' : '  XX '} ${t}`); };
const eq = (t: string, real: any, esp: any) => {
  const c = JSON.stringify(real) === JSON.stringify(esp);
  if (!c) fallos++;
  console.log(`${c ? '  ok ' : '  XX '} ${t}: ${JSON.stringify(real)}${c ? '' : ` (esperaba ${JSON.stringify(esp)})`}`);
};
const dia = (fecha: string, entrada: string, salida = '18:00') => ({ fecha, marcas: [entrada, salida] });

// ══════════════════════════════════════════════════════════════════
console.log('\n── Bloques de 30 min: los dos criterios ──────────────');
eq('costumbre 07:25 -> 07:00 (sesgado al temprano)', h.aHora(h.bloqueDeCostumbre(h.aMinutos('07:25'))), '07:00');
eq('cercano   07:25 -> 07:30', h.aHora(h.bloqueMasCercano(h.aMinutos('07:25'))), '07:30');
eq('los dos coinciden en 07:10', h.aHora(h.bloqueMasCercano(h.aMinutos('07:10'))), '07:00');
eq('06:13 -> 06:00 (Zamora Canindo real)', h.aHora(h.bloqueMasCercano(h.aMinutos('06:13'))), '06:00');
eq('23:50 -> 00:00 (no se desborda)', h.aHora(h.bloqueMasCercano(h.aMinutos('23:50'))), '00:00');

// ══════════════════════════════════════════════════════════════════
console.log('\n── La semana corta en MIÉRCOLES (igual que el portal) ──');
eq('mié 01-jul es inicio de su propia semana', h.inicioSemana('2026-07-01'), '2026-07-01');
eq('mar 07-jul cierra esa semana', h.inicioSemana('2026-07-07'), '2026-07-01');
eq('mié 08-jul YA es otra semana', h.inicioSemana('2026-07-08'), '2026-07-08');
eq('dom 05-jul pertenece a la del 01', h.inicioSemana('2026-07-05'), '2026-07-01');

// ══════════════════════════════════════════════════════════════════
console.log('\n── Deducir el horario de la persona, no de la sucursal ──');
const casiOcho = [
  dia('2026-07-01', '07:52'), dia('2026-07-02', '08:07'), dia('2026-07-03', '07:55'),
  dia('2026-07-04', '08:04'), dia('2026-07-06', '07:58'), dia('2026-07-07', '08:02'),
];
const ded = h.deducirHorario(casiOcho);
eq('entrada deducida', ded.entrada, '08:00');
eq('salida deducida', ded.salida, '18:00');
ok('es confiable (un solo horario la describe)', ded.confiable === true);
eq('usó los 6 días', ded.diasUsados, 6);

// Mediana, NO promedio: un día atípico no debe correr el horario.
eq('un día a las 13:30 NO mueve el horario', h.deducirHorario([
  dia('2026-07-01', '08:02'), dia('2026-07-02', '08:03'), dia('2026-07-03', '07:58'),
  dia('2026-07-04', '08:01'), dia('2026-07-06', '08:00'), dia('2026-07-07', '13:30'),
]).entrada, '08:00');

// ══════════════════════════════════════════════════════════════════
console.log('\n── Días de UNA sola marca: no se sabe qué son ─────────');
const unaMarca = h.clasificarDia({ fecha: '2026-07-02', marcas: ['08:05'] });
eq('una marca = marca_faltante', [unaMarca.tipo, unaMarca.entrada], ['marca_faltante', null]);
eq('cero marcas = sin_marca', h.clasificarDia({ fecha: '2026-07-02', marcas: [] }).tipo, 'sin_marca');
const partido = h.clasificarDia({ fecha: '2026-07-01', marcas: ['08:03', '14:00', '15:30', '19:02'] });
eq('turno partido: entrada = primera', h.aHora(partido.entrada), '08:03');
eq('turno partido: salida = última', h.aHora(partido.salida), '19:02');

// ══════════════════════════════════════════════════════════════════
console.log('\n── Lecturas duplicadas del lector ────────────────────');
const doble = h.clasificarDia({ fecha: '2026-07-01', marcas: ['08:00', '08:03'] });
eq('dos lecturas a 3 min = UNA marca', [doble.tipo, doble.marcas], ['marca_faltante', 1]);
const jornada = h.clasificarDia({ fecha: '2026-07-01', marcas: ['08:00', '08:02', '18:00', '18:01'] });
eq('jornada con doble lectura en cada extremo', [jornada.tipo, jornada.marcas], ['completo', 2]);
eq('salida correcta (no 08:02)', h.aHora(jornada.salida), '18:00');

// ══════════════════════════════════════════════════════════════════
console.log('\n── Bolsa semanal: solo cuenta el EXCEDENTE ───────────');
const junto = h.analizarPersona([
  dia('2026-07-01', '07:52'), dia('2026-07-02', '08:07'), dia('2026-07-03', '08:21'),
  dia('2026-07-04', '07:58'), dia('2026-07-06', '08:02'), dia('2026-07-07', '08:00'),
]);
eq('deduce 08:00', junto.horario.entrada, '08:00');
eq('atraso bruto: 7+21+2 = 30', junto.retardos!.atrasoMin, 30);
eq('retardo real = 30 - 15 de bolsa', junto.retardos!.retardoRealMin, 15);
ok('no devuelve retardos si no pudo deducir',
  h.analizarPersona([dia('2026-07-01', '08:00')]).retardos === null);

// ══════════════════════════════════════════════════════════════════
// EL CASO MARCO, DE MORELIA: la razón de que exista `horarios_confirmados`.
console.log('\n── El caso Marco: 09:22 todos los días ───────────────');
const marco = [
  dia('2026-07-01', '09:22'), dia('2026-07-02', '09:24'), dia('2026-07-03', '09:20'),
  dia('2026-07-06', '09:23'), dia('2026-07-07', '09:21'), dia('2026-07-08', '09:22'),
  dia('2026-07-09', '09:25'), dia('2026-07-10', '09:19'),
];
const sinConfirmar = h.deducirHorario(marco);
ok('la deducción se declara AMBIGUA (no decide en silencio)', sinConfirmar.bloqueAmbiguo === true);
eq('y elige el más cercano: 09:30', sinConfirmar.entrada, '09:30');
const como0900 = h.analizarPersona(marco, { bloqueConocido: '09:00' });
const como0930 = h.analizarPersona(marco, { bloqueConocido: '09:30' });
ok('si su horario fuera 09:00, acumula retardo', como0900.retardos!.retardoRealMin > 100);
eq('si su horario es 09:30, su retardo es 0', como0930.retardos!.retardoRealMin, 0);
eq('el mismo número que el bot reporta para 09:00', como0900.retardos!.retardoRealMin, 146);
ok('confirmado deja de ser ambiguo', como0930.horario.bloqueConfirmado === true && como0930.horario.bloqueAmbiguo === false);
eq('el impacto mostrado = el retardo aplicado',
  h.impactoDeOpcion(marco, '09:00').retardoRealMin, como0900.retardos!.retardoRealMin);

// ══════════════════════════════════════════════════════════════════
console.log('\n── Un fijo NO se mide por cercanía día con día ────────');
const impuntual = [
  dia('2026-07-01', '07:35'), dia('2026-07-02', '07:33'), dia('2026-07-03', '07:38'),
  dia('2026-07-06', '07:31'), dia('2026-07-07', '07:36'),
];
const con0700 = h.analizarPersona(impuntual, { bloqueConocido: '07:00' });
eq('atraso bruto contra 07:00', con0700.retardos!.atrasoMin, 35 + 33 + 38 + 31 + 36);
ok('el retardo real es el excedente, no cero',
  con0700.retardos!.retardoRealMin === con0700.retardos!.atrasoMin - 15 * con0700.retardos!.semanas.length);

// ══════════════════════════════════════════════════════════════════
console.log('\n── Rotativo: dos turnos, cada día contra el suyo ──────');
const rot = [
  dia('2026-07-01', '07:22'), dia('2026-07-02', '07:20'), dia('2026-07-03', '07:25'),
  dia('2026-07-06', '15:02'), dia('2026-07-07', '15:01'), dia('2026-07-08', '14:58'),
  dia('2026-07-09', '07:23'), dia('2026-07-10', '15:00'),
];
const rotDed = h.deducirHorario(rot);
eq('detecta dos turnos', rotDed.turnos.length, 2);
eq('es rotativo, no fijo', rotDed.tipo, 'rotativo');
const turnos = rotDed.turnos.filter((t): t is string => !!t);
ok('con la mañana a las 07:00 hay retardo',
  (h.impactoDeOpcion(rot, '07:00', { base: turnos, original: '07:30' }).retardoRealMin || 0) > 0);
eq('con 07:30 no lo hay (llegan antes)',
  h.impactoDeOpcion(rot, '07:30', { base: turnos, original: '07:30' }).retardoRealMin, 0);

// ══════════════════════════════════════════════════════════════════
console.log('\n── Faltas: solo en los días laborales DE ESA PERSONA ──');
// Trabaja mié/jue/vie durante 3 semanas. El lunes no es su día: un lunes sin
// marcas es descanso, no falta.
const parcial: h.DiaCrudo[] = [];
for (const semana of ['2026-07-01', '2026-07-08', '2026-07-15']) {
  const base = new Date(`${semana}T12:00:00Z`);
  for (const off of [0, 1, 2]) {                       // mié, jue, vie
    const d = new Date(base.getTime() + off * 86400000).toISOString().slice(0, 10);
    parcial.push(dia(d, '08:00'));
  }
}
const pa = h.analizarPersona(parcial);
eq('sus días laborales son mié(3) jue(4) vie(5)', pa.horario.diasLaborales, [3, 4, 5]);
// Se agrega un lunes vacío: no debe contar como falta.
const conLunes = parcial.concat([{ fecha: '2026-07-20', marcas: [] }]);   // lunes
eq('un lunes sin marcas NO es falta', h.analizarPersona(conLunes).retardos!.faltas, 0);
// Pero un miércoles vacío sí.
eq('un miércoles sin marcas SÍ es falta',
  h.analizarPersona(parcial.concat([{ fecha: '2026-07-22', marcas: [] }])).retardos!.faltas, 1);

console.log(fallos ? `\n✗ ${fallos} prueba(s) fallaron\n` : '\n✓ Todas las pruebas pasaron\n');
process.exit(fallos ? 1 : 0);
