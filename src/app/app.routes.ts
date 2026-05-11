import { Routes } from '@angular/router';
import { LayoutComponent } from './rh/layout/layout';
import { DashboardComponent } from './rh/dashboard/dashboard';
import { KanbanComponent } from './rh/kanban/kanban';
import { CandidateFormComponent } from '../portal/candidate-form/candidate-form';
import { LoginComponent } from './rh/login/login';
import { authGuard } from './core/guards/auth.guard'; 
import { UsuariosComponent } from './rh/usuarios/usuarios';

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
      { path: 'kanban', component: KanbanComponent },
      { path: 'usuarios', component: UsuariosComponent },
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' }
    ]
  },
  
  { path: 'unete', component: CandidateFormComponent },
  
  { path: 'login', component: LoginComponent },
  
  { path: '', redirectTo: 'unete', pathMatch: 'full' },
  
  { path: '**', redirectTo: 'unete' }
];