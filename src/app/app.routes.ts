import { Routes } from '@angular/router';
import { LayoutComponent } from './rh/layout/layout';
import { DashboardComponent } from './rh/dashboard/dashboard';
import { KanbanComponent } from './rh/kanban/kanban';
import { CandidateFormComponent } from '../portal/candidate-form/candidate-form';
import { LoginComponent } from './rh/login/login';
import { authGuard } from './core/guards/auth.guard'; 
import { UsuariosComponent } from './rh/usuarios/usuarios';

export const routes: Routes = [
  // EL MUNDO PRIVADO DE RH
  {
    path: 'app',
    component: LayoutComponent,
    canActivate: [authGuard], // ¡AQUÍ ESTÁ VIGILANDO!
    children: [
      { path: 'dashboard', component: DashboardComponent },
      { path: 'kanban', component: KanbanComponent },
      
      // CONECTAMOS LA NUEVA RUTA AQUÍ
      { path: 'usuarios', component: UsuariosComponent },
      
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' }
    ]
  },
  
  // EL MUNDO DE LOS CANDIDATOS
  { path: 'unete', component: CandidateFormComponent },
  
  // LA PUERTA DE RECURSOS HUMANOS
  { path: 'login', component: LoginComponent },
  
  // RUTAS COMODÍN
  { path: '', redirectTo: 'unete', pathMatch: 'full' },
  { path: '**', redirectTo: 'unete' }
];