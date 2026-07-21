import { Routes } from '@angular/router';
import { LayoutComponent } from './rh/layout/layout';
import { DashboardComponent } from './rh/dashboard/dashboard';
import { ConcentradoComponent } from './rh/concentrado/concentrado';
import { EtapaComponent } from './rh/etapa/etapa';
import { ExpedienteComponent } from './rh/expediente/expediente';
import { CandidateFormComponent } from '../portal/candidate-form/candidate-form';
import { SolicitudComponent } from '../portal/solicitud/solicitud';
import { EmpleosComponent } from '../portal/empleos/empleos';
import { PortalComponent } from '../portal/portal/portal';
import { BolsaComponent } from '../portal/bolsa/bolsa';
import { EvaluacionLiderazgoComponent } from '../portal/evaluacion-liderazgo/evaluacion-liderazgo';
import { EvaluacionAptitudesComponent } from '../portal/evaluacion-aptitudes/evaluacion-aptitudes';
import { LoginComponent } from './rh/login/login';
import { authGuard } from './core/guards/auth.guard';
import { UsuariosComponent } from './rh/usuarios/usuarios';
import { HistorialComponent } from './rh/historial/historial';
import { VacantesComponent } from './rh/vacantes/vacantes';
import { DuplicadosComponent } from './rh/duplicados/duplicados';
import { PapeleraComponent } from './rh/papelera/papelera';
import { ContactadosComponent } from './rh/contactados/contactados';
import { DestacadosComponent } from './rh/destacados/destacados';
import { EnRiesgoComponent } from './rh/enriesgo/enriesgo';
import { GuiaEvaluacionComponent } from './rh/guia-evaluacion/guia-evaluacion';
import { ResultadosEvaluacionComponent } from './rh/resultados-evaluacion/resultados-evaluacion';
import { HorariosComponent } from './rh/horarios/horarios';

export const routes: Routes = [
  {
    path: 'app',
    component: LayoutComponent,
    canActivate: [authGuard], // <-- Nuestro "cadenero" validando la sesión en Firebase
    children: [
      { path: 'dashboard', component: DashboardComponent },
      { path: 'concentrado', component: ConcentradoComponent },
      { path: 'destacados', component: DestacadosComponent },
      { path: 'en-riesgo', component: EnRiesgoComponent },
      { path: 'etapa/:etapaId', component: EtapaComponent },
      { path: 'usuarios', component: UsuariosComponent },
      { path: 'historial', component: HistorialComponent },
      { path: 'vacantes',  component: VacantesComponent },
      { path: 'duplicados', component: DuplicadosComponent },
      { path: 'contactados', component: ContactadosComponent },
      { path: 'guia-evaluacion', component: GuiaEvaluacionComponent },
      { path: 'resultados-evaluacion', component: ResultadosEvaluacionComponent },
      { path: 'horarios', component: HorariosComponent },
      { path: 'papelera',   component: PapeleraComponent },
      { path: 'expediente/:id', component: ExpedienteComponent },
      { path: 'kanban', redirectTo: 'dashboard', pathMatch: 'full' },
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' }
    ]
  },
  
  { path: 'unete', component: CandidateFormComponent },
  { path: 'empleos', component: EmpleosComponent },
  { path: 'portal', component: PortalComponent },
  { path: 'bolsa', component: BolsaComponent },
  { path: 'evaluacion/:id', component: EvaluacionLiderazgoComponent },
  { path: 'evaluar-aptitudes/:id', component: EvaluacionAptitudesComponent },
  { path: 'solicitud/:id', component: SolicitudComponent },
  { path: 'solicitud',     component: SolicitudComponent },
  { path: 'login', component: LoginComponent },
  { path: '', redirectTo: 'unete', pathMatch: 'full' },
  { path: '**', redirectTo: 'unete' }
];