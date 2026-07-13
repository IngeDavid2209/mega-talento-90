import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CandidateService } from '../../core/services/candidate';
import { ETAPAS } from '../../core/models/proceso.model';
import { urlWhatsApp } from '../../core/models/puestos.model';
import { ToastService } from '../../core/services/toast.service';
import * as XLSX from 'xlsx';

/**
 * Reporte de COBERTURA DE CONTACTO por WhatsApp.
 *
 * Clasifica a todos los candidatos del portal en dos grupos:
 *   - CONTACTADOS: tuvieron conversación con el bot de reclutamiento (BOT-RH).
 *   - NO CONTACTADOS: entraron por el formulario web u otra fuente y el bot
 *     todavía no ha cruzado mensaje con ellos.
 *
 * La señal es 100% data del portal (colección `candidates` en Firestore):
 * el bot marca sus registros con `origen: 'whatsapp-bot'`,
 * `fuente: 'WhatsApp (bot RH)'` y, al completar el registro, `completadoPorBot: true`.
 * La lista de `fuentes` del formulario /unete NO incluye "WhatsApp", así que
 * buscar "whatsapp" en `fuente` no genera falsos positivos.
 */
@Component({
  selector: 'app-contactados',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './contactados.html',
  styleUrl: './contactados.css'
})
export class ContactadosComponent implements OnInit, OnDestroy {
  private candidateService = inject(CandidateService);
  private router = inject(Router);
  private ngZone = inject(NgZone);
  private toast = inject(ToastService);

  cargando = true;
  todos: any[] = [];

  // Listas filtradas por el buscador (lo que se muestra en pantalla)
  contactados: any[] = [];
  noContactados: any[] = [];

  // Totales GLOBALES (sin filtrar) para las tarjetas de resumen y la cobertura
  totalGlobal = 0;
  totalContactados = 0;
  totalNo = 0;
  cobertura = 0; // % de candidatos contactados

  termino = '';
  // La lista pendiente arranca abierta (es la accionable); la de contactados plegada.
  abierto = { contactados: false, no: true };

  private unsub: any;

  ngOnInit() {
    this.unsub = this.candidateService.listenToCandidates(datos => {
      this.ngZone.run(() => {
        this.todos = datos;
        this.clasificar();
        this.cargando = false;
      });
    });
  }

  ngOnDestroy() {
    if (this.unsub) this.unsub();
  }

  /** ¿Este candidato ya tuvo contacto por WhatsApp con el bot? */
  esContactado(c: any): boolean {
    const origen = String(c?.origen || '').toLowerCase();
    const fuente = String(c?.fuente || '').toLowerCase();
    return c?.completadoPorBot === true
      || origen === 'whatsapp-bot'
      || origen === 'whatsapp'
      || fuente.includes('whatsapp');
  }

  clasificar() {
    // Totales globales (no dependen del buscador)
    this.totalGlobal = this.todos.length;
    this.totalContactados = this.todos.filter(c => this.esContactado(c)).length;
    this.totalNo = this.totalGlobal - this.totalContactados;
    this.cobertura = this.totalGlobal
      ? Math.round((this.totalContactados / this.totalGlobal) * 100)
      : 0;

    // Listas visibles (aplicando el buscador)
    const t = this.termino.trim().toLowerCase();
    const coincide = (c: any) => !t
      || (c.nombre || '').toLowerCase().includes(t)
      || (c.telefono || '').toLowerCase().includes(t)
      || (c.puesto || '').toLowerCase().includes(t)
      || (c.ciudad || c.sucursal || '').toLowerCase().includes(t);

    const filtrados = this.todos.filter(coincide);
    this.contactados = filtrados.filter(c => this.esContactado(c)).sort(this.porFechaDesc);
    this.noContactados = filtrados.filter(c => !this.esContactado(c)).sort(this.porFechaDesc);
  }

  private porFechaDesc = (a: any, b: any) => {
    const da = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
    const db = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
    return db.getTime() - da.getTime();
  };

  toggle(seccion: 'contactados' | 'no') {
    this.abierto[seccion] = !this.abierto[seccion];
  }

  // ====== Acciones ======

  abrirExpediente(c: any) {
    this.router.navigate(['/app/expediente', c.id]);
  }

  /** Abre WhatsApp con el mensaje de primer contacto (para la lista pendiente). */
  contactar(c: any) {
    const url = urlWhatsApp(c);
    if (!url) {
      this.toast.alerta(
        `El teléfono (${c.telefono || 'vacío'}) no es válido. Corrígelo en el expediente para poder enviar WhatsApp.`,
        `Teléfono de ${c.nombre || 'este candidato'} inválido`
      );
      return;
    }
    window.open(url, '_blank');
  }

  exportarExcel() {
    const fila = (c: any) => ({
      'Fecha registro': this.formatearFecha(c.createdAt),
      'Nombre': c.nombre || '',
      'Teléfono': c.telefono || '',
      'Puesto': c.puesto || '',
      'Ciudad / Sucursal': c.ciudad || c.sucursal || '',
      'Fuente': c.fuente || '',
      'Etapa': this.nombreEtapa(c.status)
    });
    const libro = XLSX.utils.book_new();
    const contactados = this.todos.filter(c => this.esContactado(c)).sort(this.porFechaDesc).map(fila);
    const pendientes = this.todos.filter(c => !this.esContactado(c)).sort(this.porFechaDesc).map(fila);
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(contactados), 'Contactados');
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(pendientes), 'No contactados');
    XLSX.writeFile(libro, 'Contacto_WhatsApp_MegaTalento.xlsx');
  }

  // ====== Helpers de presentación ======

  formatearFecha(timestamp: any): string {
    if (!timestamp) return 'Sin fecha';
    const d = typeof timestamp?.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  formatearTelefono(tel: string): string {
    const t = (tel || '').replace(/\D/g, '').slice(-10);
    if (t.length !== 10) return tel || '—';
    return `${t.slice(0, 3)} ${t.slice(3, 6)} ${t.slice(6)}`;
  }

  nombreEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.title || id || '—';
  }

  colorEtapa(id: string): string {
    return ETAPAS.find(e => e.id === id)?.color || '#94a3b8';
  }

  getInitials(nombre: string): string {
    if (!nombre) return '?';
    return nombre.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
  }
}
