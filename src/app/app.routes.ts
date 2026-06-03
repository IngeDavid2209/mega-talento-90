import { Routes } from '@angular/router';
import { LayoutComponent } from './rh/layout/layout';
import { DashboardComponent } from './rh/dashboard/dashboard';
import { EtapaComponent } from './rh/etapa/etapa';
import { ExpedienteComponent } from './rh/expediente/expediente';
import { CandidateFormComponent } from '../portal/candidate-form/candidate-form';
import { SolicitudComponent } from '../portal/solicitud/solicitud';
import { EmpleosComponent } from '../portal/empleos/empleos';
import { LoginComponent } from './rh/login/login';
import { authGuard } from './core/guards/auth.guard';
import { UsuariosComponent } from './rh/usuarios/usuarios';
import { HistorialComponent } from './rh/historial/historial';
import { VacantesComponent } from './rh/vacantes/vacantes';

export const routes: Routes = [
  // ==========================================
  // 🛡️ EL MUNDO PRIVADO DE RH (PROTEGIDO)
  // ==========================================
  {
    path: 'app',
    component: LayoutComponent,
    canActivate: [authGuard], // <-- Nuestro "cadenero" validando la sesión en Firebase
    children: [
      { path: 'dashboard', component: DashboardComponent },

      // Cada etapa del proceso es ahora su propia vista (accesible desde el menú)
      { path: 'etapa/:etapaId', component: EtapaComponent },

      { path: 'usuarios', component: UsuariosComponent },
      { path: 'historial', component: HistorialComponent },
      { path: 'vacantes',  component: VacantesComponent },

      // Expediente del candidato (conserva menú y seguridad)
      { path: 'expediente/:id', component: ExpedienteComponent },

      // Compatibilidad: el viejo embudo redirige al dashboard
      { path: 'kanban', redirectTo: 'dashboard', pathMatch: 'full' },

      { path: '', redirectTo: 'dashboard', pathMatch: 'full' }
    ]
  },
  
  { path: 'unete', component: CandidateFormComponent },

  // Cartelera pública de vacantes
  { path: 'empleos', component: EmpleosComponent },

  // Solicitud de empleo electrónica (público, con o sin ID de candidato)
  { path: 'solicitud/:id', component: SolicitudComponent },
  { path: 'solicitud',     component: SolicitudComponent },

  { path: 'login', component: LoginComponent },

  { path: '', redirectTo: 'unete', pathMatch: 'full' },

  { path: '**', redirectTo: 'unete' }
  // (Se eliminó la ruta duplicada de historial que estaba aquí al final)
];