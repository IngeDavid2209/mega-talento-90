import { Injectable, signal } from '@angular/core';

/**
 * Modo "Capital Humano": muestra a los candidatos de forma anónima
 * (iniciales + ID corto) en lugar del nombre completo. Sirve para
 * reducir sesgos al evaluar (no ver el nombre/género/origen).
 *
 * El expediente individual SÍ muestra el nombre real (es necesario
 * para contactar al candidato); el modo afecta solo listas/tarjetas.
 *
 * La preferencia se guarda en localStorage por dispositivo del usuario.
 */
@Injectable({ providedIn: 'root' })
export class CapitalHumanoService {
  private readonly STORAGE_KEY = 'mt-capital-humano';

  /** Estado reactivo: true cuando el modo anónimo está activado */
  activo = signal<boolean>(this.leerPreferencia());

  toggle(): void {
    const nuevo = !this.activo();
    this.activo.set(nuevo);
    this.guardarPreferencia(nuevo);
  }

  activar(): void {
    this.activo.set(true);
    this.guardarPreferencia(true);
  }

  desactivar(): void {
    this.activo.set(false);
    this.guardarPreferencia(false);
  }

  /**
   * Devuelve el nombre a mostrar según el modo:
   * - Modo normal: el nombre completo del candidato
   * - Modo anónimo: "AB-3F8C" (iniciales + sufijo del ID)
   */
  displayName(candidato: any): string {
    if (!candidato) return '';
    if (!this.activo()) return candidato.nombre || '—';
    const iniciales = this.iniciales(candidato.nombre);
    const sufijo = (candidato.id || '').slice(-4).toUpperCase() || '----';
    return `${iniciales}-${sufijo}`;
  }

  /** Cuando se necesitan SOLO iniciales (para avatares, etc.) */
  iniciales(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }

  private leerPreferencia(): boolean {
    try {
      return localStorage.getItem(this.STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }
  private guardarPreferencia(v: boolean): void {
    try {
      localStorage.setItem(this.STORAGE_KEY, v ? '1' : '0');
    } catch {}
  }
}
