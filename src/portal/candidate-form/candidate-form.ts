import { Component, inject, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, NgForm } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate'; 
import { getStorage, ref, uploadBytes, getDownloadURL } from '@angular/fire/storage';

@Component({
  selector: 'app-candidate-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './candidate-form.html',
  styleUrl: './candidate-form.css'
})
export class CandidateFormComponent {
  @ViewChild('talentoForm') talentoForm!: NgForm;
  private candidateService = inject(CandidateService);
  
  archivoCV: File | null = null;
  subiendo = false; 

  candidate = {
    nombre: '',
    telefono: '',
    ciudad: '',    
    puesto: '',    
    fuente: ''     
  };

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
          console.log("A.1 Subiendo CV a Firebase Storage...");
          const storage = getStorage();
          const nombreUnico = `${new Date().getTime()}_${this.archivoCV.name}`;
          const storageRef = ref(storage, `cvs/${nombreUnico}`);

          await uploadBytes(storageRef, this.archivoCV);
          urlDelPDF = await getDownloadURL(storageRef);
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

        console.log("C. Alerta de éxito disparada.");
        alert('¡Gracias! Tu solicitud para Mega Talento 90 ha sido recibida de manera exitosa.');
        this.resetForm();
      } catch (error) {
        console.error('ERROR CRÍTICO EN EL PROCESO DE REGISTRO:', error);
        alert('Hubo un error al procesar o enviar tu solicitud. Por favor, intenta de nuevo.');
      } finally {
        this.subiendo = false;
      }
    }
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