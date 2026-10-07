import { Component, inject, ViewChild, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, NgForm } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate';
import { subirACloudinary } from '../../app/core/services/cloudinary';
import { PuestosService, Puesto, dedupPuestos } from '../../app/core/services/puestos.service';
import { sucursalPorId, ciudadesUnicas } from '../../app/core/models/sucursales.model';

type TipoCV = 'pdf' | 'fotos';

/**
 * Site key de reCAPTCHA v2 (Google).
 * IMPORTANTE: Esta es la clave PÚBLICA de prueba de Google — siempre pasa.
 * Para producción real, registra el dominio en https://www.google.com/recaptcha/admin
 * (elige "reCAPTCHA v2 · Casilla 'No soy un robot'") y reemplaza este valor.
 */
const RECAPTCHA_SITE_KEY = '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI';

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
  private ngZone = inject(NgZone);
  private unsubPuestos: any;

  // El candidato debe entregar CV: o un PDF o dos fotos (frente y reverso)
  tipoCV: TipoCV = 'pdf';
  archivoPDF: File | null = null;
  fotoFrente: File | null = null;
  fotoReverso: File | null = null;
  // Previews locales (data URL) para que el candidato vea lo que sube
  previewFrente = '';
  previewReverso = '';

  // Licencia de manejo (obligatoria si el puesto es Chofer o Logística)
  licencia: File | null = null;
  previewLicencia = '';

  // reCAPTCHA v2 ("No soy un robot")
  captchaToken = '';
  private captchaWidgetId: number | null = null;
  private intentoRenderCaptcha = 0;

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
    // desde /rh/vacantes). El dropdown es la copia EXACTA de la bolsa de trabajo
    // (/empleos): mismas vacantes con activo=true, en el mismo orden, sin fallback
    // hardcoded. Si el admin oculta una vacante, desaparece al instante de ambas.
    this.unsubPuestos = this.puestosService.listar((lista) => {
      this.puestosFull = dedupPuestos(lista.filter(p => p.activo));
      this.aplicarQueryPuesto();
    });

    // Aplicar el query param también al instante por si la lista ya está cargada
    this.aplicarQueryPuesto();

    // Cargar el script de reCAPTCHA y renderizar el widget
    this.cargarRecaptcha();
  }

  ngOnDestroy() {
    if (this.unsubPuestos) this.unsubPuestos();
  }

  /** Inyecta el script de Google reCAPTCHA si no está cargado y luego renderiza */
  private cargarRecaptcha() {
    const win = window as any;
    // Si ya está cargado, solo renderizar
    if (win.grecaptcha && typeof win.grecaptcha.render === 'function') {
      setTimeout(() => this.renderizarRecaptcha(), 50);
      return;
    }
    // Si el script ya está siendo cargado por otra parte de la app, esperar
    if (document.getElementById('recaptcha-script')) {
      setTimeout(() => this.cargarRecaptcha(), 200);
      return;
    }
    const script = document.createElement('script');
    script.id = 'recaptcha-script';
    script.src = 'https://www.google.com/recaptcha/api.js?onload=megaTalentoOnRecaptchaLoad&render=explicit';
    script.async = true;
    script.defer = true;
    // Callback global que Google invoca cuando el script termina de cargar
    win.megaTalentoOnRecaptchaLoad = () => this.renderizarRecaptcha();
    document.head.appendChild(script);
  }

  /** Renderiza el widget en el contenedor #captcha-container del template */
  private renderizarRecaptcha() {
    const win = window as any;
    if (this.captchaWidgetId !== null) return; // ya renderizado
    const contenedor = document.getElementById('captcha-container');
    if (!contenedor || !win.grecaptcha?.render) {
      // El DOM aún no tiene el contenedor; reintentar unas cuantas veces
      if (this.intentoRenderCaptcha < 20) {
        this.intentoRenderCaptcha++;
        setTimeout(() => this.renderizarRecaptcha(), 150);
      }
      return;
    }
    // En pantallas estrechas (≤400px) el widget normal de 304px no cabe,
    // por eso usamos la versión 'compact' (164×144) que Google ofrece nativa.
    const esMobileEstrecho = window.innerWidth <= 400;
    this.captchaWidgetId = win.grecaptcha.render(contenedor, {
      sitekey: RECAPTCHA_SITE_KEY,
      size: esMobileEstrecho ? 'compact' : 'normal',
      callback: (token: string) => {
        this.ngZone.run(() => this.captchaToken = token);
      },
      'expired-callback': () => {
        this.ngZone.run(() => this.captchaToken = '');
      },
      'error-callback': () => {
        this.ngZone.run(() => this.captchaToken = '');
      }
    });
  }

  /** Resetea el widget para que el usuario pueda volver a pasar la prueba */
  private resetearRecaptcha() {
    const win = window as any;
    if (this.captchaWidgetId !== null && win.grecaptcha?.reset) {
      win.grecaptcha.reset(this.captchaWidgetId);
    }
    this.captchaToken = '';
  }

  /**
   * Si vienen desde la cartelera /empleos con ?puesto=X, pre-seleccionar el
   * puesto. Si X no existe en la lista activa de Firestore (porque la admin
   * lo desactivó después de compartir el link), simplemente dejamos el
   * dropdown vacío para que el candidato elija uno de los disponibles.
   */
  private aplicarQueryPuesto() {
    const puestoQuery = this.route.snapshot.queryParamMap.get('puesto');
    if (!puestoQuery) return;
    const match = this.puestosDisponibles.find(p => p.toLowerCase() === puestoQuery.toLowerCase());
    if (match) {
      this.candidate.puesto = match;
    }
  }

  // Ciudades del catálogo de sucursales (se mantienen sincronizadas solas).
  ciudades = ciudadesUnicas();

  /**
   * Vacantes activas cargadas EN VIVO desde Firestore (mismo origen que la
   * bolsa /empleos). De aquí se derivan los puestos disponibles por ciudad.
   */
  puestosFull: Puesto[] = [];

  /**
   * Puestos visibles en el dropdown. Si el candidato ya eligió ciudad, solo se
   * muestran los puestos con una sucursal en esa ciudad. Las vacantes antiguas
   * sin sucursales asignadas se muestran en todas las ciudades (para no
   * ocultarlas mientras se reconfiguran). Los nombres se deduplican.
   */
  get puestosDisponibles(): string[] {
    const ciudad = this.candidate.ciudad;
    const disponibles = this.puestosFull.filter(p =>
      !ciudad || this.puestoEnCiudad(p, ciudad)
    );
    return Array.from(new Set(disponibles.map(p => p.nombre)));
  }

  private puestoEnCiudad(p: Puesto, ciudad: string): boolean {
    // Vacante antigua sin sucursales asignadas: visible en todas las ciudades.
    if (!Array.isArray(p.sucursalIds) || !p.sucursalIds.length) return true;
    return p.sucursalIds.some(id => sucursalPorId(id)?.ciudad === ciudad);
  }

  /** Al cambiar de ciudad, si el puesto elegido ya no aplica, se limpia. */
  onCiudadChange() {
    if (this.candidate.puesto && !this.puestosDisponibles.includes(this.candidate.puesto)) {
      this.candidate.puesto = '';
      this.onPuestoChange();
    }
  }

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

  /** Algunos puestos requieren licencia de manejo obligatoriamente */
  get requiereLicencia(): boolean {
    return this.candidate.puesto === 'Chofer' || this.candidate.puesto === 'Logística';
  }

  /** Cuando cambia el puesto, si ya no requiere licencia limpiamos lo que se hubiera subido */
  onPuestoChange() {
    if (!this.requiereLicencia) {
      this.licencia = null;
      this.previewLicencia = '';
    }
  }

  /** Selección del archivo de licencia (foto o PDF) */
  onLicenciaSelected(event: any) {
    const file = event.target.files[0] as File | undefined;
    if (!file) return;

    if (file.size > 5_000_000) {
      this.modal = {
        tipo: 'error',
        titulo: 'Archivo muy pesado',
        mensaje: 'La licencia supera los 5 MB. Comprime el PDF o reduce la calidad de la foto.'
      };
      event.target.value = '';
      return;
    }

    const name = file.name.toLowerCase();
    if (!name.endsWith('.pdf') && !/\.(jpe?g|png|webp|heic)$/.test(name)) {
      this.modal = {
        tipo: 'error',
        titulo: 'Formato incorrecto',
        mensaje: 'Sube tu licencia en PDF o como foto (JPG, PNG, WEBP o HEIC).'
      };
      event.target.value = '';
      return;
    }

    this.licencia = file;
    if (file.type.startsWith('image/')) {
      this.leerComoDataUrl(file).then(url => this.previewLicencia = url);
    } else {
      this.previewLicencia = '';
    }
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
    if (this.requiereLicencia && !this.licencia) {
      this.modal = {
        tipo: 'error',
        titulo: 'Falta tu licencia',
        mensaje: `Para postularte como ${this.candidate.puesto} es obligatorio adjuntar foto o PDF de tu licencia de manejo vigente.`
      };
      return;
    }
    if (!this.captchaToken) {
      this.modal = {
        tipo: 'error',
        titulo: 'Verificación pendiente',
        mensaje: 'Marca la casilla "No soy un robot" antes de enviar tu solicitud.'
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
          mensaje: 'Detectamos que ya enviaste tu información anteriormente. Capital Humano de Mega Dulces ya tiene tus datos y te contactará pronto. No es necesario enviar otra postulación.'
        };
        this.subiendo = false;
        return;
      }

      // Subida del CV (1 archivo si es PDF, 2 si son fotos) y, si aplica, la licencia.
      // Todo en paralelo para que sea rápido aunque sean 3 archivos.
      const subidas: Promise<string>[] = [];
      const indices: { cv?: number; cvReverso?: number; licencia?: number } = {};
      if (this.tipoCV === 'pdf' && this.archivoPDF) {
        indices.cv = subidas.length;
        subidas.push(subirACloudinary(this.archivoPDF, 'cvs'));
      } else if (this.tipoCV === 'fotos' && this.fotoFrente && this.fotoReverso) {
        indices.cv = subidas.length;
        subidas.push(subirACloudinary(this.fotoFrente, 'cvs'));
        indices.cvReverso = subidas.length;
        subidas.push(subirACloudinary(this.fotoReverso, 'cvs'));
      }
      if (this.requiereLicencia && this.licencia) {
        indices.licencia = subidas.length;
        subidas.push(subirACloudinary(this.licencia, 'licencias'));
      }
      const urls = await Promise.all(subidas);
      const cvUrl = indices.cv !== undefined ? urls[indices.cv] : '';
      const cvUrlReverso = indices.cvReverso !== undefined ? urls[indices.cvReverso] : '';
      const licenciaUrl = indices.licencia !== undefined ? urls[indices.licencia] : '';

      const puestoFinal = this.candidate.puesto;

      const datosCandidatoCompleto: any = {
        ...this.candidate,
        puesto: puestoFinal,
        cvUrl,
        cvFormato: this.tipoCV,
        status: 'filtro_inicial',
        createdAt: new Date()
      };
      if (cvUrlReverso) datosCandidatoCompleto.cvUrlReverso = cvUrlReverso;
      if (licenciaUrl) datosCandidatoCompleto.licenciaUrl = licenciaUrl;

      await this.candidateService.createCandidate(datosCandidatoCompleto);
      // El aviso al bot de WhatsApp lo hace ahora la API al guardar la postulación
      // (antes lo pedía el navegador directo al bot, sin llave). [RH.0.6]

      this.modal = {
        tipo: 'exito',
        titulo: '¡Solicitud enviada!',
        mensaje: 'Se ha enviado tu información correctamente. Capital Humano de Mega Dulces te contactará pronto.'
      };
      this.resetForm();
    } catch (error: any) {
      console.error('ERROR CRÍTICO EN EL PROCESO DE REGISTRO:', error);
      const code = error?.code || '';
      let mensaje = 'Hubo un problema al procesar tu información. Por favor, intenta de nuevo en unos momentos.';
      if (code === 'permission-denied') {
        mensaje = 'Permiso denegado al guardar. Si el problema persiste, contacta a Capital Humano por WhatsApp.';
      } else if (code === 'unavailable' || code === 'network-request-failed' || /network/i.test(error?.message || '')) {
        mensaje = 'Sin conexión a internet. Revisa tu red y vuelve a intentar.';
      } else if (error?.message?.toLowerCase().includes('cloudinary')) {
        mensaje = 'No se pudo subir tu archivo. Revisa que el CV o licencia no supere 5 MB y vuelve a intentar.';
      } else if (error?.message) {
        mensaje = error.message;
      }
      this.modal = {
        tipo: 'error',
        titulo: 'No pudimos enviar tu solicitud',
        mensaje
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
    this.tipoCV = 'pdf';
    this.archivoPDF = null;
    this.fotoFrente = null;
    this.fotoReverso = null;
    this.licencia = null;
    this.previewLicencia = '';
    this.previewFrente = '';
    this.previewReverso = '';
    this.resetearRecaptcha();

    if (this.talentoForm) {
      this.talentoForm.resetForm();
    }
  }
}
