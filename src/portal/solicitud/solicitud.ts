import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate';
import {
  SolicitudElectronica, solicitudVacia,
  ESTADOS_CIVILES, NIVELES_ESCOLARIDAD, TURNOS
} from '../../app/core/models/solicitud.model';

@Component({
  selector: 'app-solicitud',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './solicitud.html',
  styleUrl: './solicitud.css'
})
export class SolicitudComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private candidateService = inject(CandidateService);

  ESTADOS_CIVILES = ESTADOS_CIVILES;
  NIVELES_ESCOLARIDAD = NIVELES_ESCOLARIDAD;
  TURNOS = TURNOS;

  candidatoId: string | null = null;
  cargando = true;
  enviando = false;
  yaEnviada = false;

  // Datos del candidato existente (si llegó por link)
  candidato: any = null;

  // Datos del wizard
  solicitud: SolicitudElectronica = solicitudVacia();
  paso = 1;
  TOTAL_PASOS = 8;

  // Feedback
  modal: { tipo: 'exito' | 'error'; titulo: string; mensaje: string } | null = null;

  async ngOnInit() {
    this.candidatoId = this.route.snapshot.paramMap.get('id');

    if (this.candidatoId) {
      // Buscar al candidato para autocompletar lo que ya se sabe
      try {
        const todos = await this.candidateService.getCandidates() as any[];
        this.candidato = todos.find(c => c.id === this.candidatoId);
        if (this.candidato) {
          // Pre-llenar lo que ya tenemos
          this.solicitud.datosPersonales.nombre = this.candidato.nombre || '';
          this.solicitud.contacto.telefono = this.candidato.telefono || '';
          this.solicitud.domicilio.ciudad = this.candidato.ciudad || '';
          this.solicitud.puestoDeseado.puesto = this.candidato.puesto || '';

          // Si ya envió solicitud, mostrar mensaje
          if (this.candidato.solicitudElectronica?.enviadaAt) {
            this.yaEnviada = true;
          }
        }
      } catch (e) {
        console.error('Error al cargar candidato:', e);
      }
    }
    this.cargando = false;
  }

  // ===== Navegación =====
  siguiente() {
    if (this.paso < this.TOTAL_PASOS) {
      this.paso++;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
  anterior() {
    if (this.paso > 1) {
      this.paso--;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
  irAPaso(n: number) {
    if (n >= 1 && n <= this.TOTAL_PASOS) {
      this.paso = n;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  get progresoPorcentaje(): number {
    return Math.round((this.paso / this.TOTAL_PASOS) * 100);
  }

  agregarEmpleo() {
    if (this.solicitud.experiencia.length < 3) {
      this.solicitud.experiencia.push({
        empresa: '', puesto: '', fechaInicio: '', fechaFin: '',
        jefeDirecto: '', telefonoJefe: '', sueldoMensual: '', motivoSalida: ''
      });
    }
  }

  quitarEmpleo(idx: number) {
    if (this.solicitud.experiencia.length > 1) {
      this.solicitud.experiencia.splice(idx, 1);
    }
  }

  // ===== Validación mínima por paso =====
  pasoValido(p: number): boolean {
    const s = this.solicitud;
    switch (p) {
      case 1: return !!(s.datosPersonales.nombre && s.datosPersonales.fechaNacimiento && s.datosPersonales.sexo);
      case 2: return !!(s.identificacion.curp && s.identificacion.curp.length >= 10);
      case 3: return !!(s.domicilio.calle && s.domicilio.colonia && s.domicilio.ciudad && s.domicilio.estado);
      case 4: return !!(s.contacto.telefono && s.contacto.telefono.length >= 10);
      case 5: return !!s.escolaridad.nivelMaximo;
      case 6: return s.experiencia.length > 0 && !!s.experiencia[0].empresa;
      case 7: return !!(s.referencias[0].nombre && s.referencias[0].telefono);
      case 8: return !!(s.puestoDeseado.puesto && s.aceptaAvisoPrivacidad && s.aceptaVeracidad);
      default: return false;
    }
  }

  // ===== Envío =====
  async enviar() {
    if (!this.pasoValido(8)) {
      this.modal = {
        tipo: 'error',
        titulo: 'Datos incompletos',
        mensaje: 'Por favor revisa que hayas completado todos los campos obligatorios y aceptado el aviso de privacidad.'
      };
      return;
    }

    this.enviando = true;
    try {
      const payload = {
        ...this.solicitud,
        enviadaAt: new Date()
      };

      if (this.candidatoId && this.candidato) {
        // Asociar la solicitud al candidato existente
        await this.candidateService.updateCandidate(this.candidatoId, {
          solicitudElectronica: payload,
          // Actualizar nombre y teléfono por si el candidato los corrigió
          nombre: this.solicitud.datosPersonales.nombre,
          telefono: this.solicitud.contacto.telefono
        }, { marcarActividad: false }); // acción del candidato, no seguimiento de RH
      } else {
        // Sin candidato previo: validar duplicados antes de crear
        const duplicado = await this.candidateService.buscarDuplicado(
          this.solicitud.contacto.telefono,
          this.solicitud.datosPersonales.nombre
        );
        if (duplicado) {
          this.modal = {
            tipo: 'error',
            titulo: 'Ya estás postulado/a',
            mensaje: 'Detectamos que ya hay un candidato registrado con ese nombre o teléfono. Capital Humano de Mega Dulces ya tiene tus datos y te contactará pronto.'
          };
          this.enviando = false;
          return;
        }
        await this.candidateService.createCandidate({
          nombre: this.solicitud.datosPersonales.nombre,
          telefono: this.solicitud.contacto.telefono,
          ciudad: this.solicitud.domicilio.ciudad,
          puesto: this.solicitud.puestoDeseado.puesto,
          fuente: 'Solicitud electrónica',
          solicitudElectronica: payload
        });
      }

      this.modal = {
        tipo: 'exito',
        titulo: '¡Solicitud enviada!',
        mensaje: 'Tu información se envió correctamente. Capital Humano de Mega Dulces te contactará pronto para los siguientes pasos.'
      };
      this.yaEnviada = true;
    } catch (e) {
      console.error('Error al enviar solicitud:', e);
      this.modal = {
        tipo: 'error',
        titulo: 'No pudimos enviar tu solicitud',
        mensaje: 'Hubo un problema al guardar tu información. Verifica tu conexión e intenta de nuevo en unos momentos.'
      };
    } finally {
      this.enviando = false;
    }
  }

  cerrarModal() { this.modal = null; }

  /** Sanitiza dígitos para campos numéricos (teléfono, NSS, CP, etc.) */
  soloNumeros(valor: string, maxLength?: number): string {
    let v = (valor || '').replace(/\D/g, '');
    if (maxLength) v = v.slice(0, maxLength);
    return v;
  }

  /** CURP: 18 chars, alfanuméricos en mayúsculas */
  sanitizarCurp(valor: string): string {
    return (valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 18);
  }

  /** RFC: 13 chars max, alfanumérico mayúsculas */
  sanitizarRfc(valor: string): string {
    return (valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 13);
  }
}
