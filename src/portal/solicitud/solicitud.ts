import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate';
import { subirACloudinary } from '../../app/core/services/cloudinary';

type TipoCV = 'pdf' | 'fotos';

/**
 * /solicitud/:id — Página para que un candidato que YA está registrado (le llegó
 * un link personalizado) suba su CV, que es lo único que faltaba. No es un
 * formulario de datos: solo el CV (PDF o dos fotos), misma mecánica que /unete.
 * Sin :id no hay a quién asociar el archivo, así que se redirige a /unete.
 */
@Component({
  selector: 'app-solicitud',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './solicitud.html',
  styleUrl: './solicitud.css'
})
export class SolicitudComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private candidateService = inject(CandidateService);

  candidatoId: string | null = null;
  cargando = true;
  enviando = false;
  yaEnviada = false;        // el candidato ya tiene CV registrado
  noEncontrado = false;     // el link no corresponde a ningún candidato
  candidato: any = null;

  // ===== CV — misma mecánica que /unete: PDF o dos fotos (frente y reverso) =====
  tipoCV: TipoCV = 'pdf';
  archivoPDF: File | null = null;
  fotoFrente: File | null = null;
  fotoReverso: File | null = null;
  previewFrente = '';
  previewReverso = '';

  // Feedback
  modal: { tipo: 'exito' | 'error'; titulo: string; mensaje: string } | null = null;

  async ngOnInit() {
    this.candidatoId = this.route.snapshot.paramMap.get('id');

    // Sin link personalizado no hay a quién asociarle el CV: se manda al
    // formulario completo /unete, que recoge datos + CV de candidatos nuevos.
    if (!this.candidatoId) {
      this.router.navigate(['/unete']);
      return;
    }

    try {
      this.candidato = await this.candidateService.getCandidateById(this.candidatoId);
      if (!this.candidato) {
        this.noEncontrado = true;
      } else if (this.candidato.cvUrl) {
        // Ya nos había mandado su CV antes.
        this.yaEnviada = true;
      }
    } catch (e) {
      console.error('Error al cargar candidato:', e);
      this.noEncontrado = true;
    }
    this.cargando = false;
  }

  // ===== CV =====

  /** El CV está completo si hay PDF, o si hay frente y reverso. */
  get cvCompleto(): boolean {
    if (this.tipoCV === 'pdf') return !!this.archivoPDF;
    return !!this.fotoFrente && !!this.fotoReverso;
  }

  /** Cambiar entre PDF y Fotos limpia los archivos de la otra modalidad */
  cambiarTipoCV(tipo: TipoCV) {
    if (this.tipoCV === tipo) return;
    this.tipoCV = tipo;
    this.archivoPDF = null;
    this.fotoFrente = null;
    this.fotoReverso = null;
    this.previewFrente = '';
    this.previewReverso = '';
  }

  /** Selección de archivo del CV según el slot (pdf / frente / reverso) */
  onFileSelected(event: any, slot: 'pdf' | 'frente' | 'reverso') {
    const file = event.target.files[0] as File | undefined;
    if (!file) return;

    // Límite de 5 MB por archivo
    if (file.size > 5_000_000) {
      this.modal = {
        tipo: 'error',
        titulo: 'Archivo muy pesado',
        mensaje: 'El archivo supera los 5 MB. Comprime o reduce la calidad y vuelve a intentarlo.'
      };
      event.target.value = '';
      return;
    }

    const name = file.name.toLowerCase();
    if (slot === 'pdf' && !name.endsWith('.pdf')) {
      this.modal = {
        tipo: 'error',
        titulo: 'Formato incorrecto',
        mensaje: 'En este modo solo se acepta PDF. Si vas a subir fotos, cambia a la opción "Fotos del CV".'
      };
      event.target.value = '';
      return;
    }
    if (slot !== 'pdf' && !/\.(jpe?g|png|webp|heic)$/.test(name)) {
      this.modal = {
        tipo: 'error',
        titulo: 'Formato incorrecto',
        mensaje: 'Sube una foto en JPG, PNG, WEBP o HEIC.'
      };
      event.target.value = '';
      return;
    }

    if (slot === 'pdf') {
      this.archivoPDF = file;
    } else if (slot === 'frente') {
      this.fotoFrente = file;
      this.leerComoDataUrl(file).then(url => this.previewFrente = url);
    } else {
      this.fotoReverso = file;
      this.leerComoDataUrl(file).then(url => this.previewReverso = url);
    }
  }

  private leerComoDataUrl(file: File): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
  }

  // ===== Envío =====
  async enviar() {
    if (!this.candidatoId || !this.candidato) return;
    if (!this.cvCompleto) {
      this.modal = {
        tipo: 'error',
        titulo: 'Falta tu CV',
        mensaje: this.tipoCV === 'pdf'
          ? 'Es obligatorio adjuntar tu CV en PDF.'
          : 'Es obligatorio subir las DOS fotos de tu CV: frente y reverso.'
      };
      return;
    }

    this.enviando = true;
    try {
      // Subir el CV a Cloudinary (1 archivo si es PDF, 2 si son fotos).
      const subidas: Promise<string>[] = [];
      const indices: { cv?: number; cvReverso?: number } = {};
      if (this.tipoCV === 'pdf' && this.archivoPDF) {
        indices.cv = subidas.length;
        subidas.push(subirACloudinary(this.archivoPDF, 'cvs'));
      } else if (this.tipoCV === 'fotos' && this.fotoFrente && this.fotoReverso) {
        indices.cv = subidas.length;
        subidas.push(subirACloudinary(this.fotoFrente, 'cvs'));
        indices.cvReverso = subidas.length;
        subidas.push(subirACloudinary(this.fotoReverso, 'cvs'));
      }
      const urls = await Promise.all(subidas);
      const cvUrl = indices.cv !== undefined ? urls[indices.cv] : '';
      const cvUrlReverso = indices.cvReverso !== undefined ? urls[indices.cvReverso] : '';

      const updateData: any = { cvUrl, cvFormato: this.tipoCV };
      if (cvUrlReverso) updateData.cvUrlReverso = cvUrlReverso;

      // Acción del candidato, no seguimiento de RH → no marcar actividad.
      await this.candidateService.updateCandidate(this.candidatoId, updateData, { marcarActividad: false });

      this.modal = {
        tipo: 'exito',
        titulo: '¡CV recibido!',
        mensaje: 'Recibimos tu CV correctamente. Capital Humano de Mega Dulces te contactará pronto para los siguientes pasos.'
      };
      this.yaEnviada = true;
    } catch (e: any) {
      console.error('Error al enviar el CV:', e);
      let mensaje = 'Hubo un problema al guardar tu CV. Verifica tu conexión e intenta de nuevo en unos momentos.';
      if (/cloudinary/i.test(e?.message || '')) {
        mensaje = 'No se pudo subir tu CV. Revisa que el archivo no supere 5 MB y vuelve a intentar.';
      }
      this.modal = {
        tipo: 'error',
        titulo: 'No pudimos recibir tu CV',
        mensaje
      };
    } finally {
      this.enviando = false;
    }
  }

  cerrarModal() { this.modal = null; }
}
