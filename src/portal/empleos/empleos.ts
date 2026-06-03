import { Component, inject, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { PuestosService, Puesto } from '../../app/core/services/puestos.service';

@Component({
  selector: 'app-empleos',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './empleos.html',
  styleUrl: './empleos.css'
})
export class EmpleosComponent implements OnInit, OnDestroy {
  private puestosService = inject(PuestosService);
  private ngZone = inject(NgZone);

  puestos: Puesto[] = [];
  cargando = true;
  private unsub: any;

  ngOnInit() {
    this.unsub = this.puestosService.listar((lista) => {
      this.ngZone.run(() => {
        // Solo mostrar las activas (visibles públicamente)
        this.puestos = lista.filter(p => p.activo);
        this.cargando = false;
      });
    });
  }

  ngOnDestroy() {
    if (this.unsub) this.unsub();
  }
}
