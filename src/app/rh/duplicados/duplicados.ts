import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS } from '../../core/models/proceso.model';

interface Grupo {
  /** Criterio que los agrupó: 'telefono' o 'nombre' */
  motivo: 'telefono' | 'nombre';
  valor: string;
  candidatos: any[];
}

@Component({
  selector: 'app-duplicados',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './duplicados.html',
  styleUrl: './duplicados.css'
})
export class DuplicadosComponent implements OnInit, OnDestroy {
  private candidateService = inject(CandidateService);
  private router = inject(Router);
  private ngZone = inject(NgZone);

  todos: any[] = [];
  grupos: Grupo[] = [];
  cargando = true;
  procesando = false;
  private unsub: any;

  // Modal de confirmación
  confirmacion: { titulo: string; mensaje: string; accion: () => Promise<void> } | null = null;

  ngOnInit() {
    this.unsub = this.candidateService.listenToCandidates((datos) => {
      this.ngZone.run(() => {
        this.todos = datos;
        this.detectarDuplicados();
        this.cargando = false;
      });
    });
  }

  ngOnDestroy() {
    if (this.unsub) this.unsub();
  }

  /** Agrupa candidatos por teléfono (10 dígitos exactos) y por nombre normalizado */
  private detectarDuplicados() {
    const porTelefono = new Map<string, any[]>();
    const porNombre = new Map<string, any[]>();

    for (const c of this.todos) {
      const tel = (c.telefono || '').replace(/\D/g, '');
      if (tel.length >= 10) {
        if (!porTelefono.has(tel)) porTelefono.set(tel, []);
        porTelefono.get(tel)!.push(c);
      }
      const nom = this.normalizarNombre(c.nombre);
      if (nom.length >= 5) {
        if (!porNombre.has(nom)) porNombre.set(nom, []);
        porNombre.get(nom)!.push(c);
      }
    }

    const grupos: Grupo[] = [];
    // Filtrar solo los que tienen 2+ candidatos
    for (const [valor, candidatos] of porTelefono.entries()) {
      if (candidatos.length > 1) {
        grupos.push({
          motivo: 'telefono',
          valor,
          candidatos: this.ordenarPorFecha(candidatos)
        });
      }
    }
    // Evitar mostrar el mismo grupo dos veces (si el mismo set ya salió por teléfono)
    const yaIncluidos = new Set<string>();
    grupos.forEach(g => g.candidatos.forEach(c => yaIncluidos.add(c.id)));
    for (const [valor, candidatos] of porNombre.entries()) {
      if (candidatos.length > 1) {
        // Solo agregar si al menos uno NO está ya en un grupo por teléfono
        const algunoNuevo = candidatos.some(c => !yaIncluidos.has(c.id));
        if (algunoNuevo) {
          grupos.push({
            motivo: 'nombre',
            valor,
            candidatos: this.ordenarPorFecha(candidatos)
          });
        }
      }
    }

    // Ordenar grupos por # de duplicados desc
    grupos.sort((a, b) => b.candidatos.length - a.candidatos.length);
    this.grupos = grupos;
  }

  private ordenarPorFecha(lista: any[]): any[] {
    return [...lista].sort((a, b) => {
      const da = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
      const db = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
      return da.getTime() - db.getTime(); // el más viejo primero
    });
  }

  private normalizarNombre(s: string): string {
    return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // ====== Acciones ======

  /**
   * FUSIONAR es lo que casi siempre se quiere aquí, no "conservar uno".
   *
   * Los duplicados de esta base no son gente que se postuló dos veces: son un
   * registro del bot de WhatsApp y otro del formulario del portal para la misma
   * persona, a veces creados en el mismo minuto. Cada uno trae lo que al otro le
   * falta —el del bot los documentos que llegaron por chat, el del portal el CV
   * y la fuente—, así que quedarse con uno tira medio expediente.
   *
   * La fusión solo rellena huecos: nada de lo que ya tiene el registro que se
   * conserva se pisa. El otro va a la Papelera, de donde se puede restaurar.
   */
  pedirFusionar(grupo: Grupo, conservar: any) {
    const otros = grupo.candidatos.filter(c => c.id !== conservar.id);
    this.confirmacion = {
      titulo: `Fusionar en el registro de ${conservar.nombre}`,
      mensaje:
        `Se juntará todo en este registro: de ${otros.length === 1 ? 'el otro' : `los otros ${otros.length}`} ` +
        `se toma únicamente lo que aquí falte (CV, documentos de WhatsApp, teléfono, fuente…), ` +
        `más su bitácora y su historial de etapas. Nada de lo que ya tiene este registro se pierde. ` +
        `${otros.length === 1 ? 'El otro registro se va' : 'Los otros se van'} a la Papelera y se ${otros.length === 1 ? 'puede' : 'pueden'} restaurar.`,
      accion: async () => {
        for (const c of otros) {
          await this.candidateService.fusionarCandidatos(conservar.id, c.id);
        }
      }
    };
  }

  pedirConservar(grupo: Grupo, conservar: any) {
    const otros = grupo.candidatos.filter(c => c.id !== conservar.id);
    this.confirmacion = {
      titulo: `Conservar solo a ${conservar.nombre}`,
      mensaje:
        `Se mandarán a la Papelera los otros ${otros.length} registro(s) SIN recuperar sus datos: ` +
        `si alguno traía el CV o documentos que este no tiene, se quedan en la Papelera con él. ` +
        `Si lo que quieres es juntarlos, usa Fusionar.`,
      accion: async () => {
        for (const c of otros) {
          await this.candidateService.eliminarCandidato(c.id);
        }
      }
    };
  }

  pedirBorrarUno(c: any) {
    this.confirmacion = {
      titulo: `Eliminar registro de ${c.nombre}`,
      mensaje: `Se eliminará permanentemente este candidato del sistema. Esta acción no se puede deshacer.`,
      accion: async () => {
        await this.candidateService.eliminarCandidato(c.id);
      }
    };
  }

  cancelarConfirmacion() {
    this.confirmacion = null;
  }

  async ejecutarConfirmacion() {
    if (!this.confirmacion) return;
    this.procesando = true;
    try {
      await this.confirmacion.accion();
      this.confirmacion = null;
    } catch (e) {
      console.error('Error al procesar:', e);
    } finally {
      this.procesando = false;
    }
  }

  // ====== Helpers para template ======

  abrirExpediente(c: any) {
    this.router.navigate(['/app/expediente', c.id]);
  }

  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'Sin fecha';
    const d = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  nombreEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.title || id || '—';
  }

  colorEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.color || '#94a3b8';
  }

  formatearTelefono(tel: string): string {
    // 3521004832 → 352 100 4832
    const t = (tel || '').replace(/\D/g, '');
    if (t.length !== 10) return tel || '—';
    return `${t.slice(0,3)} ${t.slice(3,6)} ${t.slice(6)}`;
  }
}
