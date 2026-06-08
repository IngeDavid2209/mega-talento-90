import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from '../../core/services/toast.service';

/**
 * Componente global de toasts + modal de confirmación.
 * Se monta una sola vez en app.html — escucha al ToastService.
 *
 * Diseño: navy + dorado, slide desde arriba a la derecha, ícono
 * según tipo. Modal de confirmación centrado con backdrop oscuro.
 */
@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './toast-container.component.html',
  styleUrl: './toast-container.component.css'
})
export class ToastContainerComponent {
  toast = inject(ToastService);
}
