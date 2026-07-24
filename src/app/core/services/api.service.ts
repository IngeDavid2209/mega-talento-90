import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { API_URL, TOKEN_KEY } from './api-config';

/**
 * Cliente HTTP hacia el backend. Adjunta el JWT (si hay sesión) y devuelve
 * Promesas para encajar con los servicios existentes (que son async).
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  private headers(): HttpHeaders {
    const token = localStorage.getItem(TOKEN_KEY);
    let h = new HttpHeaders({ 'Content-Type': 'application/json' });
    if (token) h = h.set('Authorization', `Bearer ${token}`);
    return h;
  }

  private url(path: string): string {
    return `${API_URL}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  get<T = any>(path: string, params?: Record<string, any>): Promise<T> {
    let hp = new HttpParams();
    for (const k of Object.keys(params || {})) {
      const v = (params as any)[k];
      if (v !== undefined && v !== null) hp = hp.set(k, String(v));
    }
    return firstValueFrom(this.http.get<T>(this.url(path), { headers: this.headers(), params: hp }));
  }

  post<T = any>(path: string, body: any = {}): Promise<T> {
    return firstValueFrom(this.http.post<T>(this.url(path), body, { headers: this.headers() }));
  }

  patch<T = any>(path: string, body: any = {}): Promise<T> {
    return firstValueFrom(this.http.patch<T>(this.url(path), body, { headers: this.headers() }));
  }

  put<T = any>(path: string, body: any = {}): Promise<T> {
    return firstValueFrom(this.http.put<T>(this.url(path), body, { headers: this.headers() }));
  }

  delete<T = any>(path: string): Promise<T> {
    return firstValueFrom(this.http.delete<T>(this.url(path), { headers: this.headers() }));
  }
}
