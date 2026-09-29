-- =====================================================================
-- DEPARTAMENTOS EN UNA SOLA ESCRITURA (29/09/2026)
--
-- El sembrado de los reportes semanales (tools/sembrar-departamentos.js,
-- 18/08/2026) copió los departamentos tal como venían: "Sistemas", "Almacen",
-- "Telemarketing"… Y el portal los guarda en MAYÚSCULAS. Resultado: al mover a
-- alguien a "Sistemas" quedaba en "SISTEMAS", y el reporte los pintaba como dos
-- secciones distintas — parecía que el cambio de departamento no funcionaba.
--
-- Se dejan todos en mayúsculas y sin espacios de sobra. Idempotente.
-- =====================================================================

UPDATE empleados
   SET departamento = upper(regexp_replace(btrim(departamento), '\s+', ' ', 'g'))
 WHERE departamento IS NOT NULL
   AND departamento <> upper(regexp_replace(btrim(departamento), '\s+', ' ', 'g'));

UPDATE empleados SET departamento = NULL WHERE departamento IS NOT NULL AND btrim(departamento) = '';
