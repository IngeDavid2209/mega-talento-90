import { Component, inject, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, NgForm } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { CandidateService } from '../../app/core/services/candidate'; // Ajusta la ruta si es necesario

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

  // 1. Aquí actualizamos las variables exactas que te pidieron
  candidate = {
    nombre: '',
    telefono: '',
    ciudad: '',    // CIUDAD EN DONDE TE INTERESA TRABAJAR
    puesto: '',    // PUESTO
    fuente: ''     // DONDE TE ENTERASTE DE LA VACANTE
  };

  // 2. Opciones para las listas desplegables (Puedes editar estas listas como gustes)
 ciudades = [
    'La Piedad',
    'Santa Ana',
    'Morelia',
    'Yurécuaro'
  ];

  puestos = [
    'Vendedor',
    'Cajero',
    'Auxiliar de Almacén',
    'Chofer Repartidor',
    'Gerente de Sucursal',
    'Personal Administrativo',
    'Anaquelista'
  ];

  fuentes = [
    'Facebook / Redes Sociales',
    'Lona o cartel en sucursal',
    'Recomendación de un amigo/familiar',
    'Feria de empleo',
    'Otro'
  ];

  onSubmit() {
    console.log("A. Botón presionado...");
    
    if (this.talentoForm && this.talentoForm.valid) {
      console.log("B. Mandando paquete al servicio...");
      
      this.candidateService.createCandidate(this.candidate)
        .then(() => {
          console.log("C. Alerta de éxito disparada.");
          alert('¡Gracias! Tu solicitud para Mega Talento 90 ha sido recibida.');
          this.resetForm(); 
        })
        .catch((error) => {
          console.error('ERROR CRÍTICO AL GUARDAR:', error);
          alert('Hubo un error al enviar tu solicitud. Intenta de nuevo.');
        });
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
    if (this.talentoForm) {
      this.talentoForm.resetForm();
    }
  }
}