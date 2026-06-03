import { Component, inject, ViewChild, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, NgForm } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate';
import { subirACloudinary } from '../../app/core/services/cloudinary';
import { PuestosService } from '../../app/core/services/puestos.service';

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

  archivoCV: File | null = null;
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

  // Variables para capturar los textos manuales
  otraCiudad = '';
  otroPuesto = '';

  ciudades = [
    'La Piedad',
    'Santa Ana',
    'Zamora',
    'Morelia',
    'Yurécuaro',
    'Otro'
  ];

  puestos = [
    'Vendedor',
    'Cajero',
    'Auxiliar de Almacén',
    'Chofer Repartidor',
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

  onFileSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      if (file.size > 5000000) {
        alert('El archivo es muy pesado. El tamaño máximo permitido es de 5MB.');
        event.target.value = ''; 
        this.archivoCV = null;
        return;
      }
      this.archivoCV = file;
    }
  }

  async onSubmit() {
    console.log("A. Botón presionado...");

    if (this.talentoForm && this.talentoForm.valid) {
      this.subiendo = true;
      let urlDelPDF = '';

      try {
        if (this.archivoCV) {
          console.log("A.1 Subiendo CV a Cloudinary...");
          urlDelPDF = await subirACloudinary(this.archivoCV, 'cvs');
          console.log("A.2 Archivo subido con éxito. URL generada.");
        }

        // Determinamos el valor final: si es "Otro", usamos la variable manual
        const ciudadFinal = this.candidate.ciudad === 'Otro' ? this.otraCiudad : this.candidate.ciudad;
        const puestoFinal = this.candidate.puesto === 'Otro' ? this.otroPuesto : this.candidate.puesto;

        const datosCandidatoCompleto = {
          ...this.candidate,
          ciudad: ciudadFinal,
          puesto: puestoFinal,
          cvUrl: urlDelPDF, 
          status: 'nuevo',  
          createdAt: new Date() 
        };

        console.log("B. Mandando paquete estructurado al servicio...", datosCandidatoCompleto);
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
    this.otraCiudad = '';
    this.otroPuesto = '';
    this.archivoCV = null;
    
    if (this.talentoForm) {
      this.talentoForm.resetForm();
    }
  }
}