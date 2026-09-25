import { Injectable } from '@angular/core';

/**
 * EL PERIODO QUE RH ELIGIÓ, UNO SOLO PARA TODA LA SECCIÓN (25/09/2026).
 *
 * Vivía dentro de `<app-asistencia-resumen>` y en la página de Horarios, cada
 * uno con su copia. El componente se desmonta al pasar a Empleados o a Cruces,
 * y al volver `ngOnInit` reescribía las fechas a "los últimos 30 días con dato";
 * la importación del reloj hacía lo mismo. Resultado: RH fijaba del 1 al 7, se
 * asomaba a otra pestaña o a otra plaza, y el periodo ya era otro —justo cuando
 * lo que se quería era comparar el MISMO rango entre plazas o departamentos—.
 *
 * Ahora el periodo vive aquí (y en `sessionStorage`, para que un F5 tampoco lo
 * pierda). El autoajuste a los datos de la plaza solo corre cuando todavía no
 * hay periodo elegido en la sesión.
 */
@Injectable({ providedIn: 'root' })
export class PeriodoAsistenciaService {
  private readonly CLAVE = 'mt90.asistencia.periodo';
  private _desde = '';
  private _hasta = '';

  constructor() {
    try {
      const crudo = sessionStorage.getItem(this.CLAVE);
      const p = crudo ? JSON.parse(crudo) : null;
      const ok = (f: any) => typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f);
      if (p && ok(p.desde) && ok(p.hasta) && p.desde <= p.hasta) {
        this._desde = p.desde;
        this._hasta = p.hasta;
      }
    } catch { /* sin storage (modo privado): el periodo vive solo en memoria */ }
  }

  get desde(): string { return this._desde; }
  get hasta(): string { return this._hasta; }
  /** ¿RH ya eligió (o se ajustó) un periodo en esta sesión? */
  get elegido(): boolean { return !!this._desde && !!this._hasta; }

  fijar(desde: string, hasta: string) {
    if (!desde || !hasta) return;
    this._desde = desde;
    this._hasta = hasta;
    try { sessionStorage.setItem(this.CLAVE, JSON.stringify({ desde, hasta })); } catch { /* ídem */ }
  }
}
