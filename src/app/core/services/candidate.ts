import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';
import { subirACloudinary } from './cloudinary';

/**
 * Servicio de candidatos. Antes hablaba con Firestore; ahora con la API
 * (Postgres). Se conservan las MISMAS firmas públicas para no tocar los
 * componentes. Los `listenTo*` (antes onSnapshot en vivo) ahora hacen polling.
 */
@Injectable({ providedIn: 'root' })
export class CandidateService {
  private api = inject(ApiService);

  /** Intervalo de refresco para los listeners (ms). */
  private readonly POLL_MS = 8000;

  /** Helper de polling: llama a fetchFn de inmediato y cada POLL_MS. Devuelve unsubscribe. */
  private poll(fetchFn: () => Promise<void>): () => void {
    let activo = true;
    const tick = async () => { if (activo) { try { await fetchFn(); } catch (e) { console.warn('poll:', e); } } };
    tick();
    const id = setInterval(tick, this.POLL_MS);
    return () => { activo = false; clearInterval(id); };
  }

  async createCandidate(candidateData: any) {
    return this.api.post('/candidatos', candidateData);
  }

  /** Antes reindexaba `telefonos`; en Postgres el anti-duplicado es por consulta. */
  async backfillTelefonos(): Promise<number> {
    return 0;
  }

  /**
   * Los candidatos POSTULADOS: los que tienen CV o los que RH ya avanzó de etapa.
   * El bot crea la fila con el primer mensaje, así que la tabla también tiene
   * conversaciones a medias —gente que apenas está contestando—; esas NO son
   * postulaciones y el API las deja fuera por omisión.
   *
   * `enProceso: true` las trae. Solo dos pantallas lo necesitan: Contactados
   * (su tema es a quién ya contactó el bot) y Duplicados (el duplicado típico es
   * la fila del bot sin CV más la del portal con CV).
   */
  async getCandidates(opciones: { enProceso?: boolean } = {}): Promise<any[]> {
    return this.api.get<any[]>('/candidatos', opciones.enProceso ? { enProceso: 1 } : undefined);
  }

  /** KPI de fases: tiempo promedio (horas) por etapa a partir del historial de transiciones. */
  async getKpiFases(): Promise<{ fases: { etapa: string; n: number; avgHoras: number; minHoras: number; maxHoras: number }[]; total: number }> {
    return this.api.get('/candidatos/kpi-fases');
  }

  async getCandidatesIncluyendoBorrados(): Promise<any[]> {
    const [vivos, borrados] = await Promise.all([
      this.api.get<any[]>('/candidatos'),
      this.api.get<any[]>('/candidatos/papelera/borrados')
    ]);
    return [...(vivos || []), ...(borrados || [])];
  }

  listenToCandidates(callback: (candidatos: any[]) => void, opciones: { enProceso?: boolean } = {}) {
    const params = opciones.enProceso ? { enProceso: 1 } : undefined;
    return this.poll(async () => callback(await this.api.get<any[]>('/candidatos', params)));
  }

  listenToCandidatosBorrados(callback: (candidatos: any[]) => void) {
    return this.poll(async () => callback(await this.api.get<any[]>('/candidatos/papelera/borrados')));
  }

  async updateCandidate(id: string, data: any, opts: { marcarActividad?: boolean } = {}) {
    const q = opts.marcarActividad === false ? '?marcarActividad=false' : '';
    await this.api.patch(`/candidatos/${id}${q}`, data);
    return true;
  }

  /** Sube un documento del expediente a Cloudinary (no cambia con la migración). */
  async uploadDocument(file: File, candidateId: string): Promise<string> {
    return subirACloudinary(file, `expedientes/${candidateId}`);
  }

  async eliminarCandidato(id: string): Promise<void> {
    await this.api.delete(`/candidatos/${id}`);
  }

  /**
   * Junta dos registros de la misma persona en `conservarId`: del absorbido solo
   * se toma lo que al otro le falte, y el absorbido se va a la Papelera (se
   * puede restaurar). Ver api/src/candidatos.ts para las reglas de la mezcla.
   */
  async fusionarCandidatos(conservarId: string, absorberId: string): Promise<any> {
    return this.api.post(`/candidatos/${conservarId}/fusionar`, { absorberId });
  }

  /**
   * Marca (o desmarca) a alguien como NO RECONTRATABLE. El motivo es
   * obligatorio al marcar: sin él, la decisión no se puede sostener después.
   * Ver api/src/candidatos.ts.
   */
  async marcarNoRecontratable(id: string, marcar: boolean, motivo?: string): Promise<any> {
    return this.api.post(`/candidatos/${id}/no-recontratable`, { marcar, motivo });
  }

  /** La lista negra: quiénes están marcados. */
  async getNoRecontratables(): Promise<any[]> {
    return this.api.get<any[]>('/candidatos/lista/no-recontratables');
  }

  /** Manda a spam (o saca de spam) a un candidato. */
  async marcarSpam(id: string, marcar: boolean, motivo?: string): Promise<any> {
    return this.api.post(`/candidatos/${id}/spam`, { marcar, motivo });
  }

  /** Los que están en spam (no aparecen en la lista de candidatos). */
  async getSpam(): Promise<any[]> {
    return this.api.get<any[]>('/candidatos/lista/spam');
  }

  /**
   * Quién de los que están en proceso AHORA coincide con alguien marcado. Es lo
   * que evita que un reingreso vetado se cuele: una lista que hay que ir a
   * consultar no detiene a nadie.
   */
  async getAlertasReingreso(): Promise<{ total: number; alertas: any[] }> {
    return this.api.get('/candidatos/alertas/reingresos');
  }

  async cerrarSeguimiento(id: string): Promise<void> {
    await this.api.post(`/candidatos/${id}/cierre-seguimiento`);
  }

  async restaurarCandidato(id: string): Promise<void> {
    await this.api.post(`/candidatos/${id}/restaurar`);
  }

  async eliminarCandidatoDefinitivo(id: string): Promise<void> {
    await this.api.delete(`/candidatos/${id}/definitivo`);
  }

  /** Anti-duplicado por teléfono (flujo público /unete). */
  async buscarDuplicado(telefono: string, nombre?: string): Promise<any | null> {
    const tel = (telefono || '').replace(/\D/g, '');
    if (tel.length < 10) return null;
    try {
      // Se manda el nombre: el duplicado solo bloquea si teléfono Y nombre
      // coinciden (evita falsos "ya estás postulado" por teléfonos compartidos).
      return await this.api.get('/candidatos/duplicado', { telefono: tel, nombre: nombre || '' });
    } catch (e) {
      console.warn('buscarDuplicado:', e);
      return null;
    }
  }

  async getCandidateById(id: string): Promise<any | null> {
    try {
      return await this.api.get(`/candidatos/${id}`);
    } catch {
      return null;
    }
  }

  listenToCandidate(id: string, callback: (candidato: any) => void, onError?: (error: any) => void) {
    return this.poll(async () => {
      try {
        callback(await this.api.get(`/candidatos/${id}`));
      } catch (e: any) {
        if (onError) onError({ code: e?.status === 404 ? 'not-found' : 'error' });
      }
    });
  }
}
