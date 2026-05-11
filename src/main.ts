import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app'; // ¡Aquí estaba el detalle!
import { appConfig } from './app/app.config';

// Y se lo pasamos correctamente a la función de arranque
bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));