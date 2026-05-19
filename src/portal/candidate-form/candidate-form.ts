import { Component, inject, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, NgForm } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate'; // Manteniendo tu ruta
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

  // Variables para la gestión del archivo CV
  archivoCV: File | null = null;
  subiendo = false; // Estado para deshabilitar botones durante la carga

  // Estructura exacta de los inputs de texto/select
  candidate = {
    nombre: '',
    telefono: '',
    ciudad: '',    // Ciudad de interés
    puesto: '',    // Puesto solicitado
    fuente: ''     // Dónde se enteró
  };

  // Listas desplegables oficiales para los selectores
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

  // 1. Captura y valida el archivo PDF seleccionado
  onFileSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      // Validación estricta de peso máximo (5MB = 5,000,000 bytes)
      if (file.size > 5000000) {
        alert('El archivo es muy pesado. El tamaño máximo permitido es de 5MB.');
        event.target.value = ''; // Limpia el input físicamente
        this.archivoCV = null;
        return;
      }
      this.archivoCV = file;
    }
  }

  // 2. Procesa la subida del CV (si existe) y crea el registro del candidato
  async onSubmit() {
    console.log("A. Botón presionado...");
    
    if (this.talentoForm && this.talentoForm.valid) {
      this.subiendo = true;
      let urlDelPDF = '';

      try {
        // Si el candidato adjuntó un archivo, lo subimos primero a Storage
        if (this.archivoCV) {
          console.log("A.1 Subiendo CV a Firebase Storage...");
          const storage = getStorage();
          const nombreUnico = `${new Date().getTime()}_${this.archivoCV.name}`;
          const storageRef = ref(storage, `cvs/${nombreUnico}`);
          
          await uploadBytes(storageRef, this.archivoCV);
          urlDelPDF = await getDownloadURL(storageRef);
          console.log("A.2 Archivo subido con éxito. URL generada.");
        }

        // Estructuramos el paquete final fusionando tus variables con las del sistema
        const datosCandidatoCompleto = {
          ...this.candidate,
          cvUrl: urlDelPDF, // Link al PDF (cadena vacía si no subió nada)
          status: 'nuevo',  // Todo registro entra directo a la primera columna
          createdAt: new Date() // Marca de tiempo para ordenarlos cronológicamente
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

  // 3. Limpia el estado completo del componente tras un envío exitoso
  resetForm() {
    this.candidate = {
      nombre: '',
      telefono: '',
      ciudad: '',
      puesto: '',
      fuente: ''
    };
    this.archivoCV = null;
    if (this.talentoForm) {
      this.talentoForm.resetForm();
    }
  }
}