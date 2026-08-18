# -*- coding: utf-8 -*-
# api/tools/parsear-reportes.py
#
# Extrae de los reportes semanales (ReporteSemMD.rpt en PDF) el mapeo:
#   reporte -> DEPARTAMENTO -> (codigo_reloj, nombre_completo)
#
# Es la unica fuente que tenemos del acomodo por departamento y de los nombres
# completos: nuestra base solo trae los apodos del reloj.
#
# El texto plano del PDF sale desordenado (el .rpt es de dos columnas), asi que
# se reconstruye por COORDENADAS. Columnas calibradas contra los PDFs reales:
#   codigo (Clv):  x ~ 10
#   nombre:        x entre 20 y 168
#   dias/horas:    x >= 170   (se ignoran para el nombre)
#   DEPTO:         "DEPTO:" en x~11; su codigo en x~87; su nombre en x~96+
#
# Uso:  python tools/parsear-reportes.py "C:\ruta\a\cotejo-docs" [--json salida.json]
# Solo LEE los PDFs.

import sys, os, json
import pymupdf

# Palabras del encabezado que NUNCA son parte de un nombre (evita que la cabecera
# repetida en cada pagina se pegue como continuacion del ultimo empleado).
STOP = {'Clv', 'Nombre', 'Retardos', 'Fecha:', 'Hora:', 'Asistencia', 'del:', 'al:',
        'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO', 'LUNES', 'MARTES', 'MIERCOLE',
        'MIERCOLES', 'Desayunos', 'Comidas'}
import re as _re
RE_FECHA = _re.compile(r'^\d{1,2}/\d{1,2}/\d{2,4}$')

def agrupar_filas(words, tol=3):
    """Agrupa palabras por renglon (y aproximada). Devuelve [(y,[(x,texto)])]."""
    filas = []
    for w in sorted(words, key=lambda w: (round(w[1]), w[0])):
        x0, y0, txt = w[0], w[1], w[4]
        if filas and abs(filas[-1][0] - y0) <= tol:
            filas[-1][1].append((x0, txt))
        else:
            filas.append((y0, [(x0, txt)]))
    return filas

def es_entero(s):
    return s.isdigit()

def columnas_de(page):
    """Ubica las columnas leyendo donde caen 'Clv' y 'JUEVES' en el encabezado.
    Los reportes de sucursal van corridos ~18px vs los de comidas, asi que los
    umbrales NO pueden ser fijos."""
    x_clv, x_dia = 12, 170
    for w in page.get_text('words'):
        if w[4] == 'Clv':
            x_clv = w[0]
        elif w[4] == 'JUEVES':
            x_dia = w[0]
    # codigo: pegado al margen; nombre: entre el codigo y la primera columna de dia
    return x_clv + 10, x_dia - 8   # (x_cod_max, x_nom_max)

def parsear_pdf(ruta):
    doc = pymupdf.open(ruta)
    titulo, rango = '', ''
    departamentos = []              # [{'codigo','nombre','gente':[(clv,nombre)]}]
    dep = None

    for pi, page in enumerate(doc):
        x_cod_max, x_nom_max = columnas_de(page)
        filas = agrupar_filas(page.get_text('words'))
        for y, ws in filas:
            ws.sort()
            texto_linea = ' '.join(t for _, t in ws)

            # Titulo del reporte: lo primero centrado arriba de la pagina 1.
            if pi == 0 and not titulo and y < 8 and len(texto_linea) > 3 \
               and 'Clv' not in texto_linea and 'Fecha' not in texto_linea:
                titulo = texto_linea
            if 'Asistencia del:' in texto_linea and not rango:
                rango = texto_linea.replace('Asistencia ', '').strip()

            # Encabezado de departamento.
            if any(t == 'DEPTO:' for _, t in ws):
                cod = ''
                nombre_words = []
                for x, t in ws:
                    if t == 'DEPTO:':
                        continue
                    if es_entero(t) and not nombre_words:
                        cod = t            # el numero pegado despues de DEPTO: es su codigo
                    else:
                        nombre_words.append(t)
                dep = {'codigo': cod, 'nombre': ' '.join(nombre_words).strip() or '(sin nombre)', 'gente': []}
                departamentos.append(dep)
                continue

            # Fila de empleado: un codigo en el margen izquierdo.
            cod_emp = None
            nombre_words = []
            for x, t in ws:
                if x <= x_cod_max and es_entero(t) and cod_emp is None:
                    cod_emp = t
                elif (x_cod_max < x <= x_nom_max and t not in STOP
                      and not RE_FECHA.match(t) and ':' not in t and t not in ('-', '0')):
                    # ':' descarta las horas (la columna del dia empieza a veces a
                    # pocos px del encabezado y se colaba en el nombre).
                    nombre_words.append((x, t))
            if cod_emp is not None:
                nombre = ' '.join(t for _, t in sorted(nombre_words)).strip()
                if dep is None:
                    dep = {'codigo': '', 'nombre': '(sin nombre)', 'gente': []}
                    departamentos.append(dep)
                dep['gente'].append([cod_emp, nombre])
            elif nombre_words and dep and dep['gente']:
                # Continuacion del nombre (se partio en dos renglones): se pega al
                # ultimo empleado, siempre que no traiga horas (esas van en x>=170).
                cont = ' '.join(t for _, t in sorted(nombre_words)).strip()
                if cont and not any(':' in t for _, t in nombre_words):
                    dep['gente'][-1][1] = (dep['gente'][-1][1] + ' ' + cont).strip()

    doc.close()
    # Limpieza: quita filas cuyo "nombre" quedo vacio (eran solo horas sueltas).
    for d in departamentos:
        d['gente'] = [(c, n) for c, n in d['gente'] if n]
    departamentos = [d for d in departamentos if d['gente']]
    return {'archivo': os.path.basename(ruta), 'titulo': titulo, 'rango': rango,
            'departamentos': departamentos}

def main():
    if len(sys.argv) < 2:
        print('Uso: python tools/parsear-reportes.py <carpeta> [--json salida.json]')
        sys.exit(1)
    carpeta = sys.argv[1]
    salida = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None

    resultados = []
    for f in sorted(os.listdir(carpeta)):
        if f.lower().endswith('.pdf'):
            resultados.append(parsear_pdf(os.path.join(carpeta, f)))

    total = 0
    for r in resultados:
        gente = sum(len(d['gente']) for d in r['departamentos'])
        total += gente
        print(f"\n===== {r['archivo']} =====")
        print(f"  titulo: {r['titulo']}  ·  {r['rango']}  ·  {gente} personas")
        for d in r['departamentos']:
            print(f"  DEPTO {d['codigo'] or '?'} · {d['nombre']}  ({len(d['gente'])})")
            for clv, nom in d['gente']:
                print(f"     {clv:>4}  {nom}")
    print(f"\nTOTAL personas en todos los reportes: {total}")

    if salida:
        with open(salida, 'w', encoding='utf-8') as fh:
            json.dump(resultados, fh, ensure_ascii=False, indent=2)
        print(f"JSON escrito en {salida}")

if __name__ == '__main__':
    main()
