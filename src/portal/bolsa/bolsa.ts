import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';

@Component({
  selector: 'app-bolsa',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './bolsa.html',
  styleUrl: './bolsa.css'
})
export class BolsaComponent implements OnInit, OnDestroy {

  year = new Date().getFullYear();
  menuMovilAbierto = false;

  private estiloHtmlOriginal = '';
  private estiloBodyOriginal = '';

  ngOnInit() {
    // El styles.css global pone overflow:hidden y height:100vh en html/body
    // para que el back-office sea pantalla completa. Aquí necesitamos scroll.
    this.estiloHtmlOriginal = document.documentElement.style.cssText;
    this.estiloBodyOriginal = document.body.style.cssText;
    document.documentElement.style.cssText = 'overflow: auto !important; height: auto !important; width: auto !important;';
    document.body.style.cssText = 'overflow: auto !important; height: auto !important; width: auto !important;';
  }

  ngOnDestroy() {
    document.documentElement.style.cssText = this.estiloHtmlOriginal;
    document.body.style.cssText = this.estiloBodyOriginal;
  }

  irInicio() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.menuMovilAbierto = false;
  }

  irACTA() {
    const el = document.getElementById('bolsa-cta');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.menuMovilAbierto = false;
  }

  irAPortal() {
    this.menuMovilAbierto = false;
    // Usar Router en lugar de href para no perder el SPA
  }
}
