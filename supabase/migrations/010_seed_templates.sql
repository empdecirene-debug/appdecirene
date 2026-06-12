delete from product_templates;
do $$ declare tid uuid; begin
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Leñero','Almacenaje','90x40x110 cm',1.45,true,7109,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Caño','30x30x2mm',700.0,2.0,0),(tid,'Varilla','10mm',310.0,1.0,1),(tid,'Tejido Electrosoldado','1.7x1.1m',120.0,1.0,2),(tid,'Pintura','1 litro',1675.0,0.33,3),(tid,'Tapas Caño','30x30',30.0,4.0,4);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,4.0,0),(tid,(select id from labor_rates where rol='Aprendiz'),'Aprendiz',125.0,8.0,1);
end $$;
do $$ declare tid uuid; begin
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Parrilla móvil','Cocina','',1.45,true,8996,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Varilla','10mm',254.0,5.0,0),(tid,'Ángulo','1 1/4x1/8',754.0,1.0,1),(tid,'Manivela y cadena','',2100.0,1.0,2),(tid,'Pomela','Serie N3',90.0,2.0,3);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,4.0,0),(tid,(select id from labor_rates where rol='Aprendiz'),'Aprendiz',125.0,4.0,1);
end $$;
do $$ declare tid uuid; begin
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Parrilla fija','Cocina','',1.4,true,4304,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Varilla','10mm',254.0,5.0,0),(tid,'Ángulo','1 1/4x1/8',754.0,1.0,1);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,3.0,0);
end $$;
do $$ declare tid uuid; begin
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Quemador','Cocina','',1.45,true,4162,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Varilla','14mm',455.0,4.0,0);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,3.0,0);
end $$;
do $$ declare tid uuid; begin
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Sacabotas','Accesorios','6 pares',1.4,true,3597,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Planchuela','1 1/4x1/8',340.0,1.0,0),(tid,'Ángulo','1 1/4x1/8',754.0,1.0,1),(tid,'Pintura','0.1lt',1675.0,0.03,2);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,3.0,0),(tid,(select id from labor_rates where rol='Aprendiz'),'Aprendiz',125.0,3.0,1);
end $$;
do $$ declare tid uuid; begin
  insert into product_templates (nombre,categoria,dimensiones,multiplicador,es_estandar,precio_referencia,activo)
  values ('Chispero','Estufa','1.20 x 0.60 m',1.5,true,4958,true) returning id into tid;
  insert into template_material_lines (template_id,descripcion,dimension,costo_unit,cantidad,display_order) values (tid,'Tejido electrosoldado','',80.0,1.0,0),(tid,'Angulo','3/4x1/8',325.0,1.0,1),(tid,'Pintura y gastos','',500.0,1.0,2);
  insert into template_labor_lines (template_id,labor_rate_id,rol,costo_hora,horas,display_order) values (tid,(select id from labor_rates where rol='Jefe de taller'),'Jefe de taller',350.0,4.0,0),(tid,(select id from labor_rates where rol='Aprendiz'),'Aprendiz',125.0,8.0,1);
end $$;
