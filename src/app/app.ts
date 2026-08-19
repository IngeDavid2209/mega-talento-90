import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastContainerComponent } from './shared/toast-container/toast-container.component';
import { UpdateCheckerService } from './core/services/update-checker.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToastContainerComponent],
  template: `
    <router-outlet></router-outlet>
    <app-toast-container></app-toast-container>
  `,
})
export class AppComponent implements OnInit {
  private updateChecker = inject(UpdateCheckerService);

  ngOnInit(): void {
    // Auto-actualización GLOBAL: arranca aquí (raíz) y no solo en el back-office,
    // para que también las páginas públicas (ligas del bot: encuestas,
    // evaluación) se recarguen solas a la versión nueva. Así ningún usuario
    // tiene que refrescar a mano. El servicio ignora el modo dev.
    this.updateChecker.iniciar();
  }
}
