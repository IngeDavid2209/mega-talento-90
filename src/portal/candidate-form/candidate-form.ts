import { Component, inject, ViewChild, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, NgForm } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate';
import { subirACloudinary } from '../../app/core/services/cloudinary';
import { PuestosService } from '../../app/core/services/puestos.service';

type TipoCV = 'pdf' | 'fotos';

@Component({
  selector: 'app-candidate-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './candidate-form.html',
  styleUrl: './candidate-form.css'
})
export class CandidateFormComponent implements OnInit, OnDestroy {
  @ViewChild('talentoForm') talentoForm!: NgForm;
  private candidateService = inject(CandidateService);
  private puestosService = inject(PuestosService);
  private route = inject(ActivatedRoute);
  private unsubPuestos: any;

  // El candidato debe entregar CV: o un PDF o dos fotos (frente y reverso)
  tipoCV: TipoCV = 'pdf';
  archivoPDF: File | null = null;
  fotoFrente: File | null = null;
  fotoReverso: File | null = null;
  // Previews locales (data URL) para que el candidato vea lo que sube
  previewFrente = '';
  previewReverso = '';

  subiendo = false;
  // Modal de feedback dentro de la app (reemplaza alert() nativo del browser)
  modal: { tipo: 'exito' | 'error'; titulo: string; mensaje: string } | null = null;

  candidate = {
    nombre: '',
    telefono: '',
    ciudad: '',
    puesto: '',
    fuente: ''
  };

  ngOnInit() {
    // Cargar los puestos activos en vivo desde Firestore (los que se administran
    // desde /app/vacantes). Si el admin agrega o cambia uno, el dropdown se actualiza.
    this.unsubPuestos = this.puestosService.listar((lista) => {
      const activos = lista.filter(p => p.activo).map(p => p.nombre);
      // Si la lista de Firestore aún está vacía (carga inicial), mantén el fallback
      // estático del array `puestos` que ya está declarado abajo.
      if (activos.length > 0) {
        this.puestos = [...activos, 'Otro'];
      }
      this.aplicarQueryPuesto();
    });

    // Aplicar el query param también al instante por si la lista ya está cargada
    this.aplicarQueryPuesto();
  }

  ngOnDestroy() {
    if (this.unsubPuestos) this.unsubPuestos();
  }

  /** Si vienen desde la cartelera /empleos con ?puesto=X, pre-seleccionar el puesto */
  private aplicarQueryPuesto() {
    const puestoQuery = this.route.snapshot.queryParamMap.get('puesto');
    if (!puestoQuery) return;
    const match = this.puestos.find(p => p.toLowerCase() === puestoQuery.toLowerCase());
    if (match) {
      this.candidate.puesto = match;
    } else {
      this.candidate.puesto = 'Otro';
      this.otroPuesto = puestoQuery;
    }
  }

  // Variable para capturar el puesto manual cuando se elige "Otro"
  otroPuesto = '';

  ciudades = [
    'La Piedad',
    'Santa Ana',
    'Zamora',
    'Morelia',
    'Yurécuaro'
  ];

  puestos = [
    'Vendedor',
    'Cajero',
    'Auxiliar de Almacén',
    'Chofer',
    'Logística',
    'Gerente de Sucursal',
    'Personal Administrativo',
    'Anaquelista',
    'Otro'
  ];

  fuentes = [
    'Facebook / Redes Sociales',
    'Lona o cartel en sucursal',
    'Recomendación de un amigo/familiar',
    'Feria de empleo',
    'Otro'
  ];

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

  /** Selección de archivo según el slot (pdf / frente / reverso) */
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

    // Validación de extensión por slot
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

  /** El CV está completo si el modo PDF tiene su archivo, o si en fotos tiene frente y reverso */
  get cvCompleto(): boolean {
    if (this.tipoCV === 'pdf') return !!this.archivoPDF;
    return !!this.fotoFrente && !!this.fotoReverso;
  }

  async onSubmit() {
    if (!this.talentoForm || !this.talentoForm.valid) return;
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

    this.subiendo = true;

    try {
      // Antes de subir nada, verificar que no esté repetido
      const duplicado = await this.candidateService.buscarDuplicado(
        this.candidate.telefono,
        this.candidate.nombre
      );
      if (duplicado) {
        this.modal = {
          tipo: 'error',
          titulo: 'Ya estás postulado/a',
          mensaje: 'Detectamos que ya enviaste tu información anteriormente. Nuestro equipo de Reclutamiento ya tiene tus datos y te contactará pronto. No es necesario enviar otra postulación.'
        };
        this.subiendo = false;
        return;
      }

      // Subida del CV (1 archivo si es PDF, 2 si son fotos)
      let cvUrl = '';
      let cvUrlReverso = '';
      if (this.tipoCV === 'pdf' && this.archivoPDF) {
        cvUrl = await subirACloudinary(this.archivoPDF, 'cvs');
      } else if (this.tipoCV === 'fotos' && this.fotoFrente && this.fotoReverso) {
        // Subimos ambas en paralelo para que sea más rápido
        const [frente, reverso] = await Promise.all([
          subirACloudinary(this.fotoFrente, 'cvs'),
          subirACloudinary(this.fotoReverso, 'cvs')
        ]);
        cvUrl = frente;
        cvUrlReverso = reverso;
      }

      // Si el puesto es "Otro", usamos el texto manual del candidato
      const puestoFinal = this.candidate.puesto === 'Otro' ? this.otroPuesto : this.candidate.puesto;

      const datosCandidatoCompleto: any = {
        ...this.candidate,
        puesto: puestoFinal,
        cvUrl,
        cvFormato: this.tipoCV,
        status: 'nuevo',
        createdAt: new Date()
      };
      if (cvUrlReverso) datosCandidatoCompleto.cvUrlReverso = cvUrlReverso;

      await this.candidateService.createCandidate(datosCandidatoCompleto);

      this.modal = {
        tipo: 'exito',
        titulo: '¡Solicitud enviada!',
        mensaje: 'Se ha enviado tu información correctamente. Nuestro equipo de Reclutamiento te contactará pronto.'
      };
      this.resetForm();
    } catch (error) {
      console.error('ERROR CRÍTICO EN EL PROCESO DE REGISTRO:', error);
      this.modal = {
        tipo: 'error',
        titulo: 'No pudimos enviar tu solicitud',
        mensaje: 'Hubo un problema al procesar tu información. Por favor, intenta de nuevo en unos momentos.'
      };
    } finally {
      this.subiendo = false;
    }
  }

  cerrarModal() {
    this.modal = null;
  }

  resetForm() {
    this.candidate = {
      nombre: '',
      telefono: '',
      ciudad: '',
      puesto: '',
      fuente: ''
    };
    this.otroPuesto = '';
    this.tipoCV = 'pdf';
    this.archivoPDF = null;
    this.fotoFrente = null;
    this.fotoReverso = null;
    this.previewFrente = '';
    this.previewReverso = '';

    if (this.talentoForm) {
      this.talentoForm.resetForm();
    }
  }
}
