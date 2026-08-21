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
import { rolGuard } from './core/guards/rol.guard';
import { UsuariosComponent } from './rh/usuarios/usuarios';
import { HistorialComponent } from './rh/historial/historial';
import { VacantesComponent } from './rh/vacantes/vacantes';
import { DuplicadosComponent } from './rh/duplicados/duplicados';
import { PapeleraComponent } from './rh/papelera/papelera';
import { ContactadosComponent } from './rh/contactados/contactados';
import { CvArmadosComponent } from './rh/cv-armados/cv-armados';
import { DestacadosComponent } from './rh/destacados/destacados';
import { EnRiesgoComponent } from './rh/enriesgo/enriesgo';
import { ReingresosComponent } from './rh/reingresos/reingresos';
import { GuiaEvaluacionComponent } from './rh/guia-evaluacion/guia-evaluacion';
import { ResultadosEvaluacionComponent } from './rh/resultados-evaluacion/resultados-evaluacion';
import { HorariosComponent } from './rh/horarios/horarios';
import { PromotorasComponent } from './rh/promotoras/promotoras';
import { AgenteHorariosComponent } from './rh/agente-horarios/agente-horarios';
import { KpiComponent } from './rh/kpi/kpi';
import { RequisicionesComponent } from './rh/requisiciones/requisiciones';
import { PermanenciaComponent } from './rh/permanencia/permanencia';
import { RequisicionPublicaComponent } from '../portal/requisicion/requisicion';
import { NoRecontratablesComponent } from './rh/no-recontratables/no-recontratables';

export const routes: Routes = [
  {
    path: 'app',
    component: LayoutComponent,
    canActivate: [authGuard], // <-- Nuestro "cadenero" validando la sesión en Firebase
    children: [
      { path: 'dashboard', component: DashboardComponent },
      { path: 'concentrado', component: ConcentradoComponent },
      { path: 'kpi', component: KpiComponent }, // tablero operativo (contactos, tiempos, cobertura)
      { path: 'requisiciones', component: RequisicionesComponent }, // lo que cada sucursal pide
      { path: 'permanencia', component: PermanenciaComponent },     // ¿el contratado sigue a los 90 días?
      { path: 'destacados', component: DestacadosComponent },
      { path: 'ya-trabajaron', component: ReingresosComponent },
      { path: 'en-riesgo', component: EnRiesgoComponent },
      { path: 'etapa/:etapaId', component: EtapaComponent },
      { path: 'usuarios', component: UsuariosComponent },
      { path: 'historial', component: HistorialComponent },
      { path: 'vacantes',  component: VacantesComponent },
      { path: 'duplicados', component: DuplicadosComponent },
      { path: 'contactados', component: ContactadosComponent },
      { path: 'cv-armados', component: CvArmadosComponent }, // los CV que armó el bot por WhatsApp
      { path: 'guia-evaluacion', component: GuiaEvaluacionComponent },
      { path: 'resultados-evaluacion', component: ResultadosEvaluacionComponent },
      { path: 'horarios', component: HorariosComponent },
      // Promotoría vive aparte del personal de planta y se reparte a mano: la
      // ve el administrador y quien tenga el rol de Promotoría. El cadenero
      // evita que escribir la URL alcance para entrar.
      {
        path: 'promotoras',
        component: PromotorasComponent,
        canActivate: [rolGuard('promotoria')],
      },
      { path: 'agente-horarios', component: AgenteHorariosComponent },
      { path: 'no-recontratables', component: NoRecontratablesComponent }, // lista negra + alerta de reingresos
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
  // La liga que se le manda a los encargados para pedir personal, sin sesión.
  { path: 'pedir-personal', component: RequisicionPublicaComponent },
  { path: 'solicitud/:id', component: SolicitudComponent },
  { path: 'solicitud',     component: SolicitudComponent },
  { path: 'login', component: LoginComponent },
  { path: '', redirectTo: 'unete', pathMatch: 'full' },
  { path: '**', redirectTo: 'unete' }
];